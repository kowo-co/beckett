/**
 * Beckett — Discord attachment ingestion (`src/discord/attachments.ts`)
 * =======================================================================================
 * Discord messages can carry files — images, .txt, .pdf, .md, anything someone drags in.
 * The gateway captures their refs ({@link IncomingAttachment}); this module pulls the bytes
 * down to a local scratch dir so the parent loop can **Read** them. That's the whole trick:
 * the inject pipeline is text-only and the parent is already multimodal via its Read tool
 * (images render, PDFs paginate, text inlines) — so we don't stream bytes through the prompt,
 * we hand the parent a local path and a one-line manifest and let it decide what to open.
 *
 * Design rules (mirrors the gateway's "dumb pipe, never crash" posture, Spec 05 §7/§9.2):
 *  - **Best-effort, never throws.** A failed/oversized/timed-out download becomes an `error`
 *    entry in the manifest, not an exception — a bad upload must never break message handling.
 *  - **Path-traversal safe.** The Discord filename is untrusted; we sanitize to a basename and
 *    namespace every message under its own `<attachmentsDir>/<messageId>/` dir so two files
 *    named `notes.md` from different messages can't collide or overwrite.
 *  - **Bounded.** A per-file size cap and a fetch timeout keep a hostile/huge upload from
 *    wedging the daemon or filling the disk.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, basename, extname } from "node:path";
import type { IncomingAttachment, Logger, ImageContentBlock, TurnContentBlock } from "../types.ts";

// Re-exported for existing callers/tests — the canonical definitions live in `../types.ts` (the
// frozen contract every module imports FROM, never the reverse) since ReplyContextMessage there
// needs to reference ImageContentBlock too.
export type { ImageContentBlock, TurnContentBlock };

/** Per-file ceiling. Discord's own default upload cap is 25 MiB; we allow a little headroom. */
export const MAX_ATTACHMENT_BYTES = 32 * 1024 * 1024;

/**
 * Per-image ceiling for *inlining* as a base64 image block in the model turn. The Anthropic vision
 * API rejects a single base64 image over ~5 MB, and base64 inflates bytes ~33% — so an image past
 * this cap is NOT inlined; it degrades to a manifest line the harness Read tool can still open
 * (Read downsamples). This is smaller than {@link MAX_ATTACHMENT_BYTES}: we still download big
 * images, we just don't stuff them into the turn as vision input.
 */
export const MAX_INLINE_IMAGE_BYTES = 5 * 1024 * 1024;

/**
 * Per-message ceiling on how many images get inlined as base64 blocks. A person dumping 20
 * screenshots into one message must not blow up the turn — the rest degrade to the manifest
 * (or a plain placeholder, for callers that don't have a Read-able local path) same as any
 * other non-inlinable attachment.
 */
const MAX_INLINE_IMAGES_PER_MESSAGE = 3;

/** The base64 image media types the Anthropic Messages API accepts as `image` content blocks. */
export const SUPPORTED_IMAGE_MEDIA_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
] as const;

/** How long to wait on a single CDN fetch before giving up (best-effort, never hangs). */
const FETCH_TIMEOUT_MS = 30_000;

/** Outcome of trying to localize one attachment. Discriminated on `ok`. */
export type DownloadedAttachment =
  | {
      ok: true;
      name: string; // sanitized basename actually written
      localPath: string; // absolute path the parent can Read
      contentType: string | null;
      size: number; // bytes actually written
    }
  | {
      ok: false;
      name: string; // original (unsanitized) name, for the human-readable manifest
      url: string; // kept so the parent could still fetch it manually if it wants
      reason: string; // why it failed (oversized / fetch error / timeout)
    };

export interface DownloadOptions {
  /** Root dir for downloads; each message gets a `<root>/<messageId>/` subdir. */
  attachmentsDir: string;
  /** The message these belong to — namespaces the subdir + avoids cross-message collisions. */
  messageId: string;
  logger?: Logger;
  /** Override the per-file cap (tests). */
  maxBytes?: number;
}

/**
 * Reduce an untrusted Discord filename to a safe basename. Strips any directory components
 * and characters that have no business in a filename, preserving the extension so the parent's
 * Read tool (and the human) can still tell a `.pdf` from a `.png`. Falls back to `file<ext>`.
 */
export function safeFilename(raw: string): string {
  // basename() kills any `../` or absolute-path games before we ever touch the FS.
  const base = basename(raw).replace(/[^\w.\- ]+/g, "_").trim();
  if (base && base !== "." && base !== "..") return base.slice(0, 200);
  const ext = extname(raw).replace(/[^\w.]+/g, "");
  return `file${ext || ""}`;
}

/**
 * Download every attachment on a message to `<attachmentsDir>/<messageId>/`, best-effort.
 * Returns one result per input (same order), `ok:false` for any that couldn't be localized.
 * Never throws — the caller (the shell pump) must stay alive regardless of a bad upload.
 */
export async function downloadAttachments(
  attachments: IncomingAttachment[],
  opts: DownloadOptions,
): Promise<DownloadedAttachment[]> {
  if (attachments.length === 0) return [];
  const maxBytes = opts.maxBytes ?? MAX_ATTACHMENT_BYTES;
  const destDir = join(opts.attachmentsDir, opts.messageId);

  try {
    await mkdir(destDir, { recursive: true });
  } catch (err) {
    // If we can't even make the dir, fail them all gracefully rather than throwing.
    opts.logger?.warn("could not create attachments dir", { destDir, error: String(err) });
    return attachments.map((a) => ({ ok: false, name: a.name, url: a.url, reason: "no scratch dir" }));
  }

  // Download in parallel — they're independent CDN fetches; one failing must not block the rest.
  return Promise.all(
    attachments.map((a) => downloadOne(a, destDir, maxBytes, opts.logger)),
  );
}

/** Localize a single attachment. Resolves to a result; never rejects. */
async function downloadOne(
  a: IncomingAttachment,
  destDir: string,
  maxBytes: number,
  logger?: Logger,
): Promise<DownloadedAttachment> {
  // Trust Discord's declared size as a cheap pre-flight reject before spending a fetch.
  if (a.size > maxBytes) {
    return { ok: false, name: a.name, url: a.url, reason: `too large (${humanBytes(a.size)} > ${humanBytes(maxBytes)})` };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(a.url, { signal: controller.signal });
    if (!res.ok) {
      return { ok: false, name: a.name, url: a.url, reason: `fetch ${res.status}` };
    }
    // Reject by Content-Length BEFORE buffering the body — a hostile/misconfigured source could
    // declare a small `a.size` but stream a huge body; this stops the OOM before arrayBuffer().
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes) {
      return { ok: false, name: a.name, url: a.url, reason: `too large (${humanBytes(declared)})` };
    }
    const buf = new Uint8Array(await res.arrayBuffer());
    // Re-check against the actual bytes — declared size can lie / be absent.
    if (buf.byteLength > maxBytes) {
      return { ok: false, name: a.name, url: a.url, reason: `too large (${humanBytes(buf.byteLength)})` };
    }
    const filename = safeFilename(a.name);
    const localPath = join(destDir, filename);
    await writeFile(localPath, buf);
    logger?.info("attachment downloaded", { name: filename, bytes: buf.byteLength, type: a.contentType });
    return { ok: true, name: filename, localPath, contentType: a.contentType, size: buf.byteLength };
  } catch (err) {
    const reason = controller.signal.aborted ? "timeout" : String((err as Error).message ?? err);
    logger?.warn("attachment download failed", { name: a.name, reason });
    return { ok: false, name: a.name, url: a.url, reason };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Build the text block appended to the injected message line so the parent SEES the files and
 * knows it can open them. Kept terse and explicit: local paths for the ones we got, a short
 * note for the ones we didn't. Returns "" when there were no attachments (caller appends raw).
 */
export function formatAttachmentManifest(results: DownloadedAttachment[]): string {
  if (results.length === 0) return "";
  const lines = results.map((r) =>
    r.ok
      ? `  • ${r.name} (${r.contentType ?? "unknown type"}, ${humanBytes(r.size)}) → Read: ${r.localPath}`
      : `  • ${r.name} — couldn't fetch (${r.reason}); url: ${r.url}`,
  );
  const got = results.filter((r) => r.ok).length;
  return `[${results.length} attachment${results.length === 1 ? "" : "s"}, ${got} saved locally — use your Read tool to open them:\n${lines.join("\n")}]`;
}

/**
 * Resolve a downloaded attachment to a supported image media type, or null if it isn't an image we
 * can inline as a base64 block. Trusts Discord's declared `contentType` first (stripping any
 * `; charset=…` suffix), then falls back to the filename extension — `.contentType` is null for
 * some uploads, so the extension is the safety net that still catches an obvious `.png`.
 */
export function imageMediaType(a: { name: string; contentType: string | null }): string | null {
  const declared = a.contentType?.toLowerCase().split(";")[0]?.trim();
  if (declared && (SUPPORTED_IMAGE_MEDIA_TYPES as readonly string[]).includes(declared)) {
    return declared;
  }
  switch (extname(a.name).toLowerCase()) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    default:
      return null;
  }
}

/**
 * Turn downloaded attachments into model-turn content. This is the fix for the OPS-27 gap: images are
 * read back off disk and encoded as **base64 image content blocks** so they actually reach the model
 * turn as vision input — rather than only being named in a text manifest and left for the model to
 * (maybe) open with its Read tool. Non-image files, oversized images, failed downloads, and any image
 * we can't read all degrade to a text `manifest` of Read-able paths (the harness Read tool handles
 * those). Best-effort: a per-image read failure drops that one image to the manifest, never the turn.
 */
export async function buildAttachmentContent(
  results: DownloadedAttachment[],
  logger?: Logger,
): Promise<{ images: ImageContentBlock[]; manifest: string }> {
  const images: ImageContentBlock[] = [];
  const forManifest: DownloadedAttachment[] = [];
  for (const r of results) {
    if (!r.ok) {
      forManifest.push(r);
      continue;
    }
    const media = imageMediaType(r);
    if (!media || r.size > MAX_INLINE_IMAGE_BYTES || images.length >= MAX_INLINE_IMAGES_PER_MESSAGE) {
      // Not an inlinable image (wrong type, too big for the vision API, or this message already
      // hit its inline cap) — let the Read tool have it.
      forManifest.push(r);
      continue;
    }
    try {
      const bytes = await readFile(r.localPath);
      if (bytes.byteLength > MAX_INLINE_IMAGE_BYTES) {
        forManifest.push(r);
        continue;
      }
      images.push({
        type: "image",
        source: { type: "base64", media_type: media, data: bytes.toString("base64") },
      });
      logger?.info("inlined image into model turn", { name: r.name, media, bytes: bytes.byteLength });
    } catch (err) {
      logger?.warn("could not read downloaded image for inlining; falling back to manifest", {
        name: r.name,
        err: String(err),
      });
      forManifest.push(r);
    }
  }
  return { images, manifest: formatAttachmentManifest(forManifest) };
}

/** The minimal attachment shape {@link inlineImageAttachments}/{@link attachmentPlaceholder} need. */
interface AttachmentRef {
  name: string;
  url: string;
  contentType: string | null;
  size: number;
}

/**
 * The `[file: name]` placeholder for one attachment, from declared metadata alone (no network).
 * Flags an oversized-but-otherwise-inlinable image with a short note so the person can tell
 * "this was too big to show" apart from "this isn't a picture at all".
 */
export function attachmentPlaceholder(a: AttachmentRef): string {
  if (imageMediaType(a) && a.size > MAX_INLINE_IMAGE_BYTES) {
    return `[file: ${a.name} (image too large to show)]`;
  }
  return `[file: ${a.name}]`;
}

/**
 * Shared conversion used by the gateway's reply-context fetch and the concierge's own
 * message-building path (the two places that used to flatten every attachment to a bare
 * `[file: name]` placeholder): fetch each eligible image straight into memory and hand back a
 * real base64 {@link ImageContentBlock}, never touching disk. Everything else — wrong media
 * type, over the size cap, over the per-message image count, or a failed/timed-out fetch —
 * degrades to the same placeholder text. Best-effort throughout: a bad CDN url must never
 * throw or drop the rest of the message.
 */
export async function inlineImageAttachments(
  attachments: AttachmentRef[],
  logger?: Logger,
): Promise<{ images: ImageContentBlock[]; placeholders: string[] }> {
  const images: ImageContentBlock[] = [];
  const placeholders: string[] = [];
  for (const a of attachments) {
    const media = imageMediaType(a);
    if (!media || a.size > MAX_INLINE_IMAGE_BYTES || images.length >= MAX_INLINE_IMAGES_PER_MESSAGE) {
      placeholders.push(attachmentPlaceholder(a));
      continue;
    }
    const block = await fetchImageBlock(a, media, logger);
    if (block) {
      images.push(block);
    } else {
      placeholders.push(`[file: ${a.name}]`);
    }
  }
  return { images, placeholders };
}

/** Fetch one attachment's bytes straight into memory and encode it — never writes to disk. */
async function fetchImageBlock(
  a: AttachmentRef,
  mediaType: string,
  logger?: Logger,
): Promise<ImageContentBlock | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(a.url, { signal: controller.signal });
    if (!res.ok) return null;
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_INLINE_IMAGE_BYTES) return null;
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength > MAX_INLINE_IMAGE_BYTES) return null;
    return {
      type: "image",
      source: { type: "base64", media_type: mediaType, data: Buffer.from(buf).toString("base64") },
    };
  } catch (err) {
    logger?.warn("image attachment fetch failed; falling back to placeholder", {
      name: a.name,
      err: String((err as Error).message ?? err),
    });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Compact human bytes for logs/manifest (e.g. "240 KB", "1.2 MB"). */
function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
