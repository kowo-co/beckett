import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  safeFilename,
  downloadAttachments,
  formatAttachmentManifest,
  buildAttachmentContent,
  imageMediaType,
  inlineImageAttachments,
  attachmentPlaceholder,
  MAX_INLINE_IMAGE_BYTES,
  type DownloadedAttachment,
} from "./attachments.ts";
import type { IncomingAttachment } from "../types.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function att(over: Partial<IncomingAttachment> = {}): IncomingAttachment {
  return { id: "1", name: "notes.md", url: "https://cdn.test/notes.md", contentType: "text/markdown", size: 12, ...over };
}

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "beckett-att-"));
}

// ── safeFilename ──────────────────────────────────────────────────────────────

test("safeFilename strips path traversal down to a basename", () => {
  expect(safeFilename("../../etc/passwd")).toBe("passwd");
  expect(safeFilename("/abs/path/x.png")).toBe("x.png");
});

test("safeFilename sanitizes junk but keeps the extension", () => {
  expect(safeFilename("my file!@#.pdf")).toContain(".pdf");
  expect(safeFilename("weird/../name.txt")).toBe("name.txt");
});

test("safeFilename falls back when there's no usable name", () => {
  expect(safeFilename("///")).toBe("file");
  expect(safeFilename("")).toBe("file");
});

// ── downloadAttachments ───────────────────────────────────────────────────────

test("empty list returns empty", async () => {
  const out = await downloadAttachments([], { attachmentsDir: tmp(), messageId: "m1" });
  expect(out).toEqual([]);
});

test("downloads bytes to a per-message dir and reports a local path", async () => {
  const dir = tmp();
  globalThis.fetch = (async () =>
    new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 })) as unknown as typeof fetch;
  const out0 = await downloadAttachments([att({ name: "pic.png", contentType: "image/png", size: 4 })], {
    attachmentsDir: dir,
    messageId: "msg42",
  });
  const r = out0[0]!;
  expect(r.ok).toBe(true);
  if (r.ok) {
    expect(r.localPath).toBe(join(dir, "msg42", "pic.png"));
    expect(existsSync(r.localPath)).toBe(true);
    expect(readFileSync(r.localPath).length).toBe(4);
  }
  rmSync(dir, { recursive: true, force: true });
});

test("rejects an oversized attachment by declared size without fetching", async () => {
  let fetched = false;
  globalThis.fetch = (async () => {
    fetched = true;
    return new Response("x");
  }) as unknown as typeof fetch;
  const out0 = await downloadAttachments([att({ size: 999 })], {
    attachmentsDir: tmp(),
    messageId: "m",
    maxBytes: 100,
  });
  const r = out0[0]!;
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.reason).toContain("too large");
  expect(fetched).toBe(false); // pre-flight reject — never spent a fetch
});

test("rejects by Content-Length before buffering an oversized body", async () => {
  let buffered = false;
  globalThis.fetch = (async () => {
    const res = new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { "content-length": "9999" },
    });
    const orig = res.arrayBuffer.bind(res);
    Object.defineProperty(res, "arrayBuffer", {
      value: async () => {
        buffered = true;
        return orig();
      },
    });
    return res;
  }) as unknown as typeof fetch;
  const out0 = await downloadAttachments([att({ size: 1 })], {
    attachmentsDir: tmp(),
    messageId: "m",
    maxBytes: 100,
  });
  const r = out0[0]!;
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.reason).toContain("too large");
  expect(buffered).toBe(false); // bailed on the header, never read the body
});

test("a fetch error degrades to ok:false, never throws", async () => {
  globalThis.fetch = (async () => new Response("nope", { status: 404 })) as unknown as typeof fetch;
  const out0 = await downloadAttachments([att()], { attachmentsDir: tmp(), messageId: "m" });
  const r = out0[0]!;
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.reason).toContain("404");
});

test("one bad download doesn't sink the others", async () => {
  const dir = tmp();
  globalThis.fetch = (async (url: string) =>
    url.includes("bad")
      ? new Response("", { status: 500 })
      : new Response(new Uint8Array([9]), { status: 200 })) as unknown as typeof fetch;
  const out = await downloadAttachments(
    [att({ id: "a", name: "good.txt", url: "https://cdn.test/good.txt", size: 1 }),
     att({ id: "b", name: "bad.txt", url: "https://cdn.test/bad.txt", size: 1 })],
    { attachmentsDir: dir, messageId: "m" },
  );
  expect(out[0]!.ok).toBe(true);
  expect(out[1]!.ok).toBe(false);
  rmSync(dir, { recursive: true, force: true });
});

// ── formatAttachmentManifest ──────────────────────────────────────────────────

test("manifest is empty for no attachments", () => {
  expect(formatAttachmentManifest([])).toBe("");
});

test("manifest lists local paths for hits and reasons for misses", () => {
  const results: DownloadedAttachment[] = [
    { ok: true, name: "a.png", localPath: "/tmp/x/a.png", contentType: "image/png", size: 2048 },
    { ok: false, name: "b.pdf", url: "https://cdn.test/b.pdf", reason: "timeout" },
  ];
  const out = formatAttachmentManifest(results);
  expect(out).toContain("2 attachments, 1 saved locally");
  expect(out).toContain("/tmp/x/a.png");
  expect(out).toContain("Read:");
  expect(out).toContain("b.pdf");
  expect(out).toContain("timeout");
});

// ── imageMediaType ────────────────────────────────────────────────────────────

test("imageMediaType resolves from the declared content type (and strips a charset suffix)", () => {
  expect(imageMediaType({ name: "x", contentType: "image/png" })).toBe("image/png");
  expect(imageMediaType({ name: "x", contentType: "image/jpeg; charset=binary" })).toBe("image/jpeg");
  expect(imageMediaType({ name: "x", contentType: "application/pdf" })).toBeNull();
});

test("imageMediaType falls back to the filename extension when content type is null", () => {
  expect(imageMediaType({ name: "shot.PNG", contentType: null })).toBe("image/png");
  expect(imageMediaType({ name: "pic.jpeg", contentType: null })).toBe("image/jpeg");
  expect(imageMediaType({ name: "loop.gif", contentType: null })).toBe("image/gif");
  expect(imageMediaType({ name: "notes.txt", contentType: null })).toBeNull();
});

// ── buildAttachmentContent (OPS-31: images become base64 blocks, not just paths) ─

/** A real (tiny) PNG so base64 encoding produces a plausible image block. */
const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);

test("buildAttachmentContent inlines a downloaded image as a base64 image block", async () => {
  globalThis.fetch = (async () => new Response(PNG, { status: 200 })) as unknown as typeof fetch;
  const dir = tmp();
  const downloaded = await downloadAttachments(
    [att({ name: "shot.png", contentType: "image/png", size: PNG.length })],
    { attachmentsDir: dir, messageId: "m1" },
  );
  const { images, manifest } = await buildAttachmentContent(downloaded);
  expect(images).toHaveLength(1);
  expect(images[0]!.type).toBe("image");
  expect(images[0]!.source.media_type).toBe("image/png");
  expect(images[0]!.source.data).toBe(Buffer.from(PNG).toString("base64"));
  expect(manifest).toBe(""); // fully consumed as an image — nothing left for the Read manifest
});

test("buildAttachmentContent routes non-images to the manifest, not an image block", async () => {
  globalThis.fetch = (async () =>
    new Response(new Uint8Array([1, 2, 3]), { status: 200 })) as unknown as typeof fetch;
  const dir = tmp();
  const downloaded = await downloadAttachments(
    [att({ name: "doc.pdf", contentType: "application/pdf", size: 3 })],
    { attachmentsDir: dir, messageId: "m2" },
  );
  const { images, manifest } = await buildAttachmentContent(downloaded);
  expect(images).toHaveLength(0);
  expect(manifest).toContain("doc.pdf");
  expect(manifest).toContain("Read:");
});

test("buildAttachmentContent does NOT inline an oversized image — it degrades to the manifest", async () => {
  // Declared size over the inline cap: rejected before we ever read bytes off disk.
  const downloaded: DownloadedAttachment[] = [
    {
      ok: true,
      name: "huge.png",
      localPath: "/tmp/does-not-matter/huge.png",
      contentType: "image/png",
      size: MAX_INLINE_IMAGE_BYTES + 1,
    },
  ];
  const { images, manifest } = await buildAttachmentContent(downloaded);
  expect(images).toHaveLength(0);
  expect(manifest).toContain("huge.png");
});

test("buildAttachmentContent keeps a failed download as a manifest miss", async () => {
  const downloaded: DownloadedAttachment[] = [
    { ok: false, name: "gone.png", url: "https://cdn.test/gone.png", reason: "fetch 404" },
  ];
  const { images, manifest } = await buildAttachmentContent(downloaded);
  expect(images).toHaveLength(0);
  expect(manifest).toContain("gone.png");
  expect(manifest).toContain("fetch 404");
});

test("buildAttachmentContent caps inlining at 3 images per message — the rest degrade to the manifest", async () => {
  globalThis.fetch = (async () => new Response(PNG, { status: 200 })) as unknown as typeof fetch;
  const dir = tmp();
  const downloaded = await downloadAttachments(
    [1, 2, 3, 4].map((i) =>
      att({ id: String(i), name: `shot${i}.png`, url: `https://cdn.test/shot${i}.png`, contentType: "image/png", size: PNG.length }),
    ),
    { attachmentsDir: dir, messageId: "m-cap" },
  );
  const { images, manifest } = await buildAttachmentContent(downloaded);
  expect(images).toHaveLength(3);
  expect(manifest).toContain("shot4.png");
});

// ── inlineImageAttachments (fetches straight into memory, never writes to disk) ──

test("a png attachment produces a real base64 image content block, not a placeholder string", async () => {
  globalThis.fetch = (async () => new Response(PNG, { status: 200 })) as unknown as typeof fetch;
  const { images, placeholders } = await inlineImageAttachments([
    { name: "shot.png", url: "https://cdn.test/shot.png", contentType: "image/png", size: PNG.length },
  ]);
  expect(images).toHaveLength(1);
  expect(images[0]!.type).toBe("image");
  expect(images[0]!.source.type).toBe("base64");
  expect(images[0]!.source.media_type).toBe("image/png");
  expect(images[0]!.source.data).toBe(Buffer.from(PNG).toString("base64"));
  expect(placeholders).toHaveLength(0);
});

test("a non-image attachment still produces the [file: name] placeholder, never a fetch", async () => {
  let fetchCalled = false;
  globalThis.fetch = (async () => {
    fetchCalled = true;
    return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
  }) as unknown as typeof fetch;
  const { images, placeholders } = await inlineImageAttachments([
    { name: "notes.pdf", url: "https://cdn.test/notes.pdf", contentType: "application/pdf", size: 4 },
  ]);
  expect(images).toHaveLength(0);
  expect(placeholders).toEqual(["[file: notes.pdf]"]);
  expect(fetchCalled).toBe(false); // never spends a CDN round-trip on a type it can't inline
});

test("a failed fetch degrades to the placeholder instead of throwing", async () => {
  globalThis.fetch = (async () => {
    throw new Error("ECONNRESET");
  }) as unknown as typeof fetch;
  const { images, placeholders } = await inlineImageAttachments([
    { name: "shot.png", url: "https://cdn.test/shot.png", contentType: "image/png", size: 4 },
  ]);
  expect(images).toHaveLength(0);
  expect(placeholders).toEqual(["[file: shot.png]"]);
});

test("a non-ok response degrades to the placeholder instead of throwing", async () => {
  globalThis.fetch = (async () => new Response(null, { status: 404 })) as unknown as typeof fetch;
  const { images, placeholders } = await inlineImageAttachments([
    { name: "gone.png", url: "https://cdn.test/gone.png", contentType: "image/png", size: 4 },
  ]);
  expect(images).toHaveLength(0);
  expect(placeholders).toEqual(["[file: gone.png]"]);
});

test("an oversized image is never fetched — it degrades straight to a placeholder with a note", async () => {
  let fetchCalled = false;
  globalThis.fetch = (async () => {
    fetchCalled = true;
    return new Response(PNG, { status: 200 });
  }) as unknown as typeof fetch;
  const { images, placeholders } = await inlineImageAttachments([
    { name: "huge.png", url: "https://cdn.test/huge.png", contentType: "image/png", size: MAX_INLINE_IMAGE_BYTES + 1 },
  ]);
  expect(images).toHaveLength(0);
  expect(placeholders).toEqual(["[file: huge.png (image too large to show)]"]);
  expect(fetchCalled).toBe(false);
});

test("only the first 3 images in a message are inlined — a screenshot dump can't blow up the turn", async () => {
  globalThis.fetch = (async () => new Response(PNG, { status: 200 })) as unknown as typeof fetch;
  const refs = [1, 2, 3, 4, 5].map((i) => ({
    name: `shot${i}.png`,
    url: `https://cdn.test/shot${i}.png`,
    contentType: "image/png",
    size: PNG.length,
  }));
  const { images, placeholders } = await inlineImageAttachments(refs);
  expect(images).toHaveLength(3);
  expect(placeholders).toEqual(["[file: shot4.png]", "[file: shot5.png]"]);
});

test("a mixed message inlines the image and placeholders the rest, never dropping either", async () => {
  globalThis.fetch = (async (url: string) =>
    url.endsWith(".png")
      ? new Response(PNG, { status: 200 })
      : new Response(new Uint8Array([1]), { status: 200 })) as unknown as typeof fetch;
  const { images, placeholders } = await inlineImageAttachments([
    { name: "shot.png", url: "https://cdn.test/shot.png", contentType: "image/png", size: PNG.length },
    { name: "notes.txt", url: "https://cdn.test/notes.txt", contentType: "text/plain", size: 1 },
  ]);
  expect(images).toHaveLength(1);
  expect(placeholders).toEqual(["[file: notes.txt]"]);
});

// ── attachmentPlaceholder (metadata-only, no network) ────────────────────────────

test("attachmentPlaceholder is a bare [file: name] for a non-image", () => {
  expect(attachmentPlaceholder({ name: "notes.pdf", url: "x", contentType: "application/pdf", size: 4 })).toBe(
    "[file: notes.pdf]",
  );
});

test("attachmentPlaceholder flags an oversized image without ever fetching it", () => {
  expect(
    attachmentPlaceholder({ name: "huge.png", url: "x", contentType: "image/png", size: MAX_INLINE_IMAGE_BYTES + 1 }),
  ).toBe("[file: huge.png (image too large to show)]");
});
