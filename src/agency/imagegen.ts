/**
 * Image generation (`src/agency/imagegen.ts`)
 * =======================================================================================
 * A cohesive wrapper around the Codex CLI's built-in `image_gen` tool, so Beckett has ONE
 * deterministic way to make an image instead of improvising (in the past it scaffolded a
 * whole `~/projects/imagegen` project instead of just calling Codex).
 *
 * Beckett's Codex is authed via `~/.codex/auth.json` (ChatGPT OAuth) and has the
 * `image_generation` (default) + `imagegenext` features enabled in `~/.codex/config.toml`.
 * We invoke `codex exec` with a tight, scaffold-proof instruction and — the key bit — we
 * VERIFY the file landed at the exact path we asked for, relocating it from Codex's default
 * `generated_images/` dir if it saved there instead. The caller always gets back the one
 * absolute path it asked for, or a hard error. No half-success, no stray projects.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  copyFileSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve, isAbsolute, dirname } from "node:path";
import { homedir } from "node:os";
import { loadEnvFile } from "../config.ts";
import type { Logger } from "../types.ts";

export class ImageGenError extends Error {}

/** Sizes the underlying image tool accepts. `auto` lets the model pick. */
const ALLOWED_SIZES = new Set(["1024x1024", "1536x1024", "1024x1536", "auto"]);
const DEFAULT_SIZE = "1024x1024";
const IMAGE_EXTS = new Set([".png", ".webp", ".jpg", ".jpeg"]);

export interface ImageGenOptions {
  prompt: string;
  /** Absolute or relative file path to save to. Default: <imagesDir>/<ts>-<slug>.png */
  out?: string;
  /** One of ALLOWED_SIZES. Default 1024x1024. */
  size?: string;
  /** Reference image paths to edit / build on (turns this into an edit). */
  refs?: string[];
  /** Ask for a transparent (alpha) background — uses Codex's built-in chroma-key flow. */
  transparent?: boolean;
  /**
   * Optional model override. `fal-ai/...` slugs route to fal.ai, `openrouter/...` slugs route
   * to OpenRouter (e.g. `openrouter/google/gemini-2.5-flash-image`); anything else stays Codex.
   */
  model?: string;
  /** Requested media kind. Defaults to image, except obvious fal video models (e.g. seedance). */
  media?: "image" | "video";
  /** Hard timeout. Default 5 min for Codex; fal uses this as the queue poll deadline. */
  timeoutMs?: number;
}

export interface ImageGenResult {
  path: string;
  bytes: number;
  size: string;
  prompt: string;
  edited: boolean;
  /** True if we had to move the artifact from Codex's default dir to `path`. */
  relocated: boolean;
  /** Backend/provider metadata (omitted for the legacy Codex path). */
  provider?: "fal" | "openrouter";
  model?: string;
  media?: "image" | "video";
  url?: string;
  requestId?: string;
  raw?: unknown;
}

export interface ImageGenDeps {
  /** Where unnamed images go: <beckettDir>/images. */
  imagesDir: string;
  logger: Logger;
  /** Override the codex binary (env BECKETT_CODEX_BIN, else auto-resolved). */
  codexBin?: string;
  /** CODEX_HOME (default ~/.codex) — used to find images Codex saved to its default dir. */
  codexHome?: string;
}

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "image"
  );
}

/** Resolve the codex launcher: explicit override → ~/.local/bin → ~/.bun/bin → PATH. */
function resolveCodexBin(home: string, override?: string): string {
  if (override) return override;
  if (process.env.BECKETT_CODEX_BIN) return process.env.BECKETT_CODEX_BIN;
  for (const c of [join(home, ".local/bin/codex"), join(home, ".bun/bin/codex")]) {
    if (existsSync(c)) return c;
  }
  return "codex"; // fall back to PATH
}

function isFalModel(model: string | undefined): boolean {
  return !!model?.trim().toLowerCase().startsWith("fal-ai/");
}

function isOpenRouterModel(model: string | undefined): boolean {
  return !!model?.trim().toLowerCase().startsWith("openrouter/");
}

function inferFalMedia(model: string, requested?: "image" | "video"): "image" | "video" {
  if (requested) return requested;
  const m = model.toLowerCase();
  return m.includes("video") || m.includes("seedance") ? "video" : "image";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseSize(size: string | undefined): { width: number; height: number } | undefined {
  if (!size || size === "auto") return undefined;
  const m = /^(\d+)x(\d+)$/.exec(size);
  if (!m) return undefined;
  return { width: Number(m[1]), height: Number(m[2]) };
}

type SniffedImageFormat = "png" | "jpeg" | "webp" | "gif";

/** Magic-byte sniff — the only ground truth for what format a file actually is. */
function sniffImageFormat(buf: Buffer): SniffedImageFormat | undefined {
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  ) {
    return "png";
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpeg";
  if (buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") {
    return "webp";
  }
  if (buf.length >= 6 && (buf.toString("ascii", 0, 6) === "GIF87a" || buf.toString("ascii", 0, 6) === "GIF89a")) {
    return "gif";
  }
  return undefined;
}

/** Extension families that count as "already correct" — no need to rename jpg <-> jpeg. */
const EXT_FORMAT_FAMILY: Record<string, SniffedImageFormat> = {
  png: "png",
  jpg: "jpeg",
  jpeg: "jpeg",
  webp: "webp",
  gif: "gif",
};

const CANONICAL_EXT_FOR_FORMAT: Record<SniffedImageFormat, string> = {
  png: "png",
  jpeg: "jpg",
  webp: "webp",
  gif: "gif",
};

/**
 * A provider can hand back bytes in a different format than the extension we were asked to
 * save under (fal.ai in particular: the queue result can be JPEG even when nothing in the
 * request said so). Sniff the file we just wrote and, if its real format doesn't match the
 * requested extension, rename it to the extension that matches — callers must never be handed
 * a path whose contents lie about their own format. Returns the path actually on disk.
 */
function reconcilePathWithBytes(outPath: string, logger: Logger): string {
  const detected = sniffImageFormat(readFileSync(outPath));
  if (!detected) return outPath; // unrecognized bytes (e.g. tests) — nothing to reconcile against

  const dot = outPath.lastIndexOf(".");
  const currentExt = dot >= 0 ? outPath.slice(dot + 1).toLowerCase() : "";
  if (EXT_FORMAT_FAMILY[currentExt] === detected) return outPath;

  const base = dot >= 0 ? outPath.slice(0, dot) : outPath;
  const correctedPath = `${base}.${CANONICAL_EXT_FOR_FORMAT[detected]}`;
  renameSync(outPath, correctedPath);
  logger.warn("image bytes did not match the requested --out extension; renamed to the real format", {
    requested: outPath,
    actual: correctedPath,
    detectedFormat: detected,
  });
  return correctedPath;
}

function extractFalError(json: any, fallback = "unknown fal error"): string {
  if (typeof json?.error === "string") return json.error;
  if (typeof json?.error?.message === "string") return json.error.message;
  if (typeof json?.message === "string") return json.message;
  if (typeof json?.detail === "string") return json.detail;
  if (Array.isArray(json?.detail)) {
    const msg = json.detail
      .map((d: any) => d?.msg ?? d?.message ?? (typeof d === "string" ? d : ""))
      .filter(Boolean)
      .join("; ");
    if (msg) return msg;
  }
  if (Array.isArray(json?.logs)) {
    const last = [...json.logs].reverse().find((l: any) => typeof l?.message === "string" || typeof l === "string");
    if (typeof last === "string") return last;
    if (typeof last?.message === "string") return last.message;
  }
  try {
    const s = JSON.stringify(json);
    if (s && s !== "{}") return s.slice(0, 800);
  } catch {
    /* ignore */
  }
  return fallback;
}

function findAssetUrl(json: any, media: "image" | "video"): string | undefined {
  if (!json || typeof json !== "object") return undefined;
  if (media === "image") {
    if (typeof json?.images?.[0]?.url === "string") return json.images[0].url;
    if (typeof json?.image?.url === "string") return json.image.url;
  } else {
    if (typeof json?.video?.url === "string") return json.video.url;
    if (typeof json?.videos?.[0]?.url === "string") return json.videos[0].url;
  }
  if (typeof json?.url === "string") return json.url;
  return undefined;
}

export interface FalProviderOptions {
  apiKey?: string;
  baseUrl?: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
  fetchImpl?: typeof fetch;
  beckettDir?: string;
}

/** fal.ai async queue backend: submit → poll status → fetch result → download asset. */
export class FalMediaGen {
  private readonly home = homedir();
  private readonly imagesDir: string;
  private readonly logger: Logger;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(deps: ImageGenDeps & FalProviderOptions) {
    this.imagesDir = deps.imagesDir;
    this.logger = deps.logger;
    this.baseUrl = (deps.baseUrl ?? "https://queue.fal.run").replace(/\/+$/, "");
    this.timeoutMs = deps.timeoutMs ?? 900_000;
    this.pollIntervalMs = deps.pollIntervalMs ?? 2_000;
    this.fetchImpl = deps.fetchImpl ?? fetch;

    if (!deps.apiKey) {
      const beckettDir = deps.beckettDir ?? process.env.BECKETT_DIR ?? join(this.home, ".beckett");
      try {
        loadEnvFile(join(beckettDir, ".env"));
      } catch {
        /* missing/unreadable env becomes the clean missing-key error below */
      }
    }
    const key = [deps.apiKey, process.env.FAL_KEY, process.env.FAL_API_KEY].find((v) => v?.trim()) ?? "";
    if (!key.trim()) {
      throw new ImageGenError(
        "FAL key not on box: no FAL_KEY or FAL_API_KEY in ~/.beckett/.env — fal image/video generation is unavailable",
      );
    }
    this.apiKey = key.trim();
  }

  async generate(opts: ImageGenOptions & { model: string }): Promise<ImageGenResult> {
    const prompt = opts.prompt?.trim();
    if (!prompt) throw new ImageGenError("empty prompt");
    const model = opts.model.trim();
    if (!model) throw new ImageGenError("fal model slug is required");
    if (opts.refs?.length) throw new ImageGenError("fal image/video generation does not support --ref yet");
    if (opts.transparent) throw new ImageGenError("fal image/video generation does not support --transparent yet");

    const size = opts.size ?? (inferFalMedia(model, opts.media) === "image" ? DEFAULT_SIZE : "auto");
    if (size !== "auto" && !ALLOWED_SIZES.has(size)) {
      throw new ImageGenError(`bad --size "${size}"; allowed: ${[...ALLOWED_SIZES].join(", ")}`);
    }
    const media = inferFalMedia(model, opts.media);
    const ext = media === "video" ? "mp4" : "png";
    const outPath = opts.out
      ? isAbsolute(opts.out)
        ? opts.out
        : resolve(opts.out)
      : join(this.imagesDir, `${Date.now()}-${slugify(prompt)}.${ext}`);
    mkdirSync(dirname(outPath), { recursive: true });

    const payload: Record<string, unknown> = { prompt };
    const parsedSize = media === "image" ? parseSize(size) : undefined;
    if (parsedSize) payload.image_size = parsedSize;

    this.logger.info("fal gen submit", { model, media, outPath, size });
    const submit = await this.requestJson(`${this.baseUrl}/${model.replace(/^\/+/, "")}`, {
      method: "POST",
      body: JSON.stringify(payload),
    });

    let requestId = String(submit?.request_id ?? submit?.requestId ?? "");
    let statusUrl = typeof submit?.status_url === "string" ? submit.status_url : "";
    let resultUrl = typeof submit?.response_url === "string" ? submit.response_url : "";

    // Some fal-compatible endpoints may return the result synchronously; handle that too.
    let result = findAssetUrl(submit, media) ? submit : undefined;
    const deadline = Date.now() + (opts.timeoutMs ?? this.timeoutMs);

    while (!result) {
      if (!requestId && !statusUrl && !resultUrl) {
        throw new ImageGenError(`fal ${model} response did not include a request id or result URL`);
      }
      if (!statusUrl && requestId) statusUrl = `${this.baseUrl}/${model.replace(/^\/+/, "")}/requests/${requestId}/status`;
      if (!resultUrl && requestId) resultUrl = `${this.baseUrl}/${model.replace(/^\/+/, "")}/requests/${requestId}`;

      if (Date.now() > deadline) {
        throw new ImageGenError(`fal ${model} timed out after ${Math.round((opts.timeoutMs ?? this.timeoutMs) / 1000)}s`);
      }
      if (!statusUrl) {
        if (!resultUrl) throw new ImageGenError(`fal ${model} response did not include a status URL`);
        result = await this.requestJson(resultUrl, { method: "GET" });
        break;
      }

      const sep = statusUrl.includes("?") ? "&" : "?";
      const status = await this.requestJson(`${statusUrl}${sep}logs=1`, { method: "GET" });
      const state = String(status?.status ?? status?.state ?? "").toUpperCase();
      if (state === "FAILED" || state === "ERROR" || state === "CANCELLED") {
        throw new ImageGenError(`fal ${model} failed: ${extractFalError(status)}`);
      }
      if (typeof status?.response_url === "string") resultUrl = status.response_url;
      if (typeof status?.request_id === "string") requestId = status.request_id;
      if (state === "COMPLETED" || state === "SUCCESS" || state === "SUCCEEDED") {
        if (findAssetUrl(status, media)) result = status;
        else {
          if (!resultUrl) throw new ImageGenError(`fal ${model} completed but did not include a result URL`);
          result = await this.requestJson(resultUrl, { method: "GET" });
        }
        break;
      }
      await sleep(this.pollIntervalMs);
    }

    const assetUrl = findAssetUrl(result, media);
    if (!assetUrl) throw new ImageGenError(`fal ${model} result did not include a ${media} URL`);
    await this.downloadAsset(assetUrl, outPath);

    const bytes = statSync(outPath).size;
    if (bytes === 0) {
      rmSync(outPath, { force: true });
      throw new ImageGenError(`fal wrote an empty file at ${outPath}`);
    }
    const finalPath = media === "image" ? reconcilePathWithBytes(outPath, this.logger) : outPath;
    return {
      path: finalPath,
      bytes,
      size,
      prompt,
      edited: false,
      relocated: false,
      provider: "fal",
      model,
      media,
      url: assetUrl,
      requestId: requestId || undefined,
      raw: result,
    };
  }

  private async requestJson(url: string, init: RequestInit): Promise<any> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60_000);
    try {
      const res = await this.fetchImpl(url, {
        ...init,
        headers: {
          Authorization: `Key ${this.apiKey}`,
          "Content-Type": "application/json",
          ...(init.headers ?? {}),
        },
        signal: controller.signal,
      });
      const text = await res.text();
      let json: any;
      try {
        json = text ? JSON.parse(text) : {};
      } catch {
        json = { rawText: text };
      }
      if (!res.ok) throw new ImageGenError(`fal ${res.status} ${res.statusText}: ${extractFalError(json, text.slice(0, 500))}`.trim());
      return json;
    } catch (err) {
      if ((err as Error).name === "AbortError") throw new ImageGenError("fal request timed out after 60s");
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  private async downloadAsset(url: string, outPath: string): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120_000);
    try {
      const res = await this.fetchImpl(url, { method: "GET", signal: controller.signal });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new ImageGenError(`fal asset download ${res.status} ${res.statusText}: ${text.slice(0, 500)}`.trim());
      }
      writeFileSync(outPath, new Uint8Array(await res.arrayBuffer()));
    } catch (err) {
      if ((err as Error).name === "AbortError") throw new ImageGenError("fal asset download timed out after 120s");
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}

function extractOpenRouterError(json: any, fallback = "unknown OpenRouter error"): string {
  if (typeof json?.error?.message === "string") return json.error.message;
  if (typeof json?.message === "string") return json.message;
  try {
    const s = JSON.stringify(json);
    if (s && s !== "{}") return s.slice(0, 800);
  } catch {
    /* ignore */
  }
  return fallback;
}

const MIME_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/webp": "webp",
};

/** First `choices[].message.images[].image_url.url` in an OpenRouter chat-completions response. */
function findOpenRouterImageUrl(json: any): string | undefined {
  const choices = Array.isArray(json?.choices) ? json.choices : [];
  for (const choice of choices) {
    const images = choice?.message?.images;
    if (!Array.isArray(images)) continue;
    for (const img of images) {
      const url = img?.image_url?.url ?? img?.url;
      if (typeof url === "string" && url) return url;
    }
  }
  return undefined;
}

export interface OpenRouterImageProviderOptions {
  apiKey?: string;
  baseUrl?: string;
  referer?: string;
  appTitle?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  beckettDir?: string;
}

/** OpenRouter chat-completions image backend: POST prompt, decode the returned image, save it. */
export class OpenRouterImageGen {
  private readonly home = homedir();
  private readonly imagesDir: string;
  private readonly logger: Logger;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly referer: string;
  private readonly appTitle: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(deps: ImageGenDeps & OpenRouterImageProviderOptions) {
    this.imagesDir = deps.imagesDir;
    this.logger = deps.logger;
    this.baseUrl = (deps.baseUrl ?? "https://openrouter.ai/api/v1").replace(/\/+$/, "");
    this.appTitle = deps.appTitle ?? "Beckett image";
    this.timeoutMs = deps.timeoutMs ?? 180_000;
    this.fetchImpl = deps.fetchImpl ?? fetch;

    if (!deps.apiKey) {
      const beckettDir = deps.beckettDir ?? process.env.BECKETT_DIR ?? join(this.home, ".beckett");
      try {
        loadEnvFile(join(beckettDir, ".env"));
      } catch {
        /* missing/unreadable env becomes the clean missing-key error below */
      }
    }
    const key = [deps.apiKey, process.env.OPENROUTER_API_KEY, process.env.OPENROUTER_KEY].find((v) => v?.trim()) ?? "";
    if (!key.trim()) {
      throw new ImageGenError(
        "OpenRouter key not on box: no OPENROUTER_API_KEY or OPENROUTER_KEY in ~/.beckett/.env — openrouter image generation is unavailable",
      );
    }
    this.apiKey = key.trim();
    this.referer = (deps.referer ?? process.env.OPENROUTER_REFERER ?? "").trim();
  }

  async generate(opts: ImageGenOptions & { model: string }): Promise<ImageGenResult> {
    const prompt = opts.prompt?.trim();
    if (!prompt) throw new ImageGenError("empty prompt");
    if (opts.refs?.length) throw new ImageGenError("openrouter image generation does not support --ref yet");
    if (opts.transparent) throw new ImageGenError("openrouter image generation does not support --transparent yet");
    if (opts.media === "video") throw new ImageGenError("openrouter image generation does not support video yet");

    const model = opts.model.trim().replace(/^openrouter\//i, "");
    if (!model) throw new ImageGenError("openrouter model slug is required (e.g. openrouter/google/gemini-2.5-flash-image)");

    const size = opts.size ?? DEFAULT_SIZE;
    if (size !== "auto" && !ALLOWED_SIZES.has(size)) {
      throw new ImageGenError(`bad --size "${size}"; allowed: ${[...ALLOWED_SIZES].join(", ")}`);
    }

    this.logger.info("openrouter gen submit", { model, size });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let json: any;
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          ...(this.referer ? { "HTTP-Referer": this.referer } : {}),
          "X-Title": this.appTitle,
        },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: prompt }],
          modalities: ["image", "text"],
        }),
        signal: controller.signal,
      });
      const text = await res.text();
      try {
        json = text ? JSON.parse(text) : {};
      } catch {
        json = { rawText: text };
      }
      if (!res.ok) {
        throw new ImageGenError(
          `openrouter ${res.status} ${res.statusText}: ${extractOpenRouterError(json, text.slice(0, 500))}`.trim(),
        );
      }
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        throw new ImageGenError(`openrouter request timed out after ${Math.round(this.timeoutMs / 1000)}s`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }

    const imageUrl = findOpenRouterImageUrl(json);
    if (!imageUrl) {
      throw new ImageGenError(`openrouter ${model} response did not include a generated image`);
    }

    const dataMatch = /^data:([^;]+);base64,(.+)$/s.exec(imageUrl);
    const mimeType = dataMatch?.[1];
    const base64Payload = dataMatch?.[2];
    const ext = (mimeType && MIME_EXT[mimeType.toLowerCase()]) || "png";
    const outPath = opts.out
      ? isAbsolute(opts.out)
        ? opts.out
        : resolve(opts.out)
      : join(this.imagesDir, `${Date.now()}-${slugify(prompt)}.${ext}`);
    mkdirSync(dirname(outPath), { recursive: true });

    if (base64Payload !== undefined) {
      writeFileSync(outPath, Buffer.from(base64Payload, "base64"));
    } else {
      await this.downloadAsset(imageUrl, outPath);
    }

    const bytes = statSync(outPath).size;
    if (bytes === 0) {
      rmSync(outPath, { force: true });
      throw new ImageGenError(`openrouter wrote an empty file at ${outPath}`);
    }
    const finalPath = reconcilePathWithBytes(outPath, this.logger);
    return {
      path: finalPath,
      bytes,
      size,
      prompt,
      edited: false,
      relocated: false,
      provider: "openrouter",
      model,
      media: "image",
      url: dataMatch ? undefined : imageUrl,
      raw: json,
    };
  }

  private async downloadAsset(url: string, outPath: string): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120_000);
    try {
      const res = await this.fetchImpl(url, { method: "GET", signal: controller.signal });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new ImageGenError(`openrouter asset download ${res.status} ${res.statusText}: ${text.slice(0, 500)}`.trim());
      }
      writeFileSync(outPath, new Uint8Array(await res.arrayBuffer()));
    } catch (err) {
      if ((err as Error).name === "AbortError") throw new ImageGenError("openrouter asset download timed out after 120s");
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}

export class CodexImageGen {
  private readonly home = homedir();
  private readonly imagesDir: string;
  private readonly logger: Logger;
  private readonly codexBin: string;
  private readonly codexHome: string;

  constructor(deps: ImageGenDeps) {
    this.imagesDir = deps.imagesDir;
    this.logger = deps.logger;
    this.codexBin = resolveCodexBin(this.home, deps.codexBin);
    this.codexHome = deps.codexHome ?? process.env.CODEX_HOME ?? join(this.home, ".codex");
  }

  async generate(opts: ImageGenOptions): Promise<ImageGenResult> {
    const prompt = opts.prompt?.trim();
    if (!prompt) throw new ImageGenError("empty prompt");

    if (isFalModel(opts.model)) {
      return new FalMediaGen({ imagesDir: this.imagesDir, logger: this.logger }).generate({
        ...opts,
        prompt,
        model: opts.model!.trim(),
      });
    }

    if (isOpenRouterModel(opts.model)) {
      return new OpenRouterImageGen({ imagesDir: this.imagesDir, logger: this.logger }).generate({
        ...opts,
        prompt,
        model: opts.model!.trim(),
      });
    }

    const size = opts.size ?? DEFAULT_SIZE;
    if (!ALLOWED_SIZES.has(size)) {
      throw new ImageGenError(`bad --size "${size}"; allowed: ${[...ALLOWED_SIZES].join(", ")}`);
    }

    // Reference images (edit mode) — must exist.
    const refs = (opts.refs ?? []).map((r) => resolve(r));
    for (const r of refs) if (!existsSync(r)) throw new ImageGenError(`reference image not found: ${r}`);
    const edited = refs.length > 0;

    // Resolve the destination path.
    const outPath = opts.out
      ? isAbsolute(opts.out)
        ? opts.out
        : resolve(opts.out)
      : join(this.imagesDir, `${Date.now()}-${slugify(prompt)}.png`);
    const outDir = dirname(outPath);
    mkdirSync(outDir, { recursive: true });
    const previousOutDigest = existsSync(outPath) ? this.imageDigest(outPath) : null;

    const instruction = this.buildInstruction({ prompt, size, outPath, transparent: !!opts.transparent, edited });

    // Args: bypass sandbox/approvals so it can write the file unattended; suppress the
    // under-development imagegenext warning so stdout stays clean.
    const args = [
      "exec",
      "--dangerously-bypass-approvals-and-sandbox",
      "-c",
      "suppress_unstable_features_warning=true",
    ];
    if (opts.model) args.push("-m", opts.model);
    for (const r of refs) args.push("-i", r);
    args.push(instruction);

    const fallbackDirs = [
      outDir,
      join(outDir, "tmp/imagegen"),
      join(this.codexHome, "generated_images"),
    ];
    const fallbackBaseline = this.snapshotImages(fallbackDirs);
    const startedAt = Date.now() - 2000; // small skew cushion for mtime comparisons

    this.logger.info("image gen start", { outPath, size, refs: refs.length, edited });
    const { code, stdout, stderr } = await this.runCodex(args, outDir, opts.timeoutMs ?? 300_000);
    const tail = (stderr || stdout || "").trim().split("\n").slice(-12).join("\n");
    if (code !== 0) {
      throw new ImageGenError(`codex image generation failed (exit ${code}).\n${tail}`.trim());
    }

    // Find the artifact. Prefer the exact path we asked for; otherwise locate the freshest
    // image Codex produced and relocate it. A pre-existing exact path only counts when this run
    // changed its bytes; otherwise a failed/no-op run that only touched metadata could return an
    // old asset as a brand-new success.
    let relocated = false;
    const currentOutDigest = existsSync(outPath) ? this.imageDigest(outPath) : null;
    const exactIsFresh =
      currentOutDigest !== null &&
      (previousOutDigest === null || currentOutDigest !== previousOutDigest);
    if (!exactIsFresh) {
      const found = this.findFreshImage(
        startedAt,
        fallbackDirs,
        fallbackBaseline,
        new Set([outPath]),
      );
      if (!found) {
        throw new ImageGenError(
          `codex produced no fresh image. No new file at ${outPath} and none found in the default dirs.\n${tail}`.trim(),
        );
      }
      copyFileSync(found, outPath);
      relocated = true;
      this.logger.info("image relocated to requested path", { from: found, to: outPath });
    }

    const bytes = statSync(outPath).size;
    if (bytes === 0) {
      rmSync(outPath, { force: true });
      throw new ImageGenError(`codex wrote an empty file at ${outPath} (exit ${code})`);
    }
    const finalPath = reconcilePathWithBytes(outPath, this.logger);
    return { path: finalPath, bytes, size, prompt, edited, relocated };
  }

  private buildInstruction(p: {
    prompt: string;
    size: string;
    outPath: string;
    transparent: boolean;
    edited: boolean;
  }): string {
    const lines = [
      "You have a built-in `image_gen` tool. Your ONLY task is to produce exactly ONE image",
      "and save it to a specific file. Obey strictly:",
      "- Use the `image_gen` tool. Do NOT write code, do NOT use python/PIL/SVG/HTML/CSS, do NOT",
      "  create any project, directory, or extra files, and do NOT install anything.",
      p.edited
        ? "- Edit/build on the reference image(s) attached to this message to match the description."
        : "- Generate a brand-new image matching the description.",
      "",
      "Description:",
      p.prompt,
      "",
      `Requested dimensions: ${p.size}.`,
    ];
    if (p.transparent) {
      lines.push(
        "Transparent background: produce a PNG with a real transparent alpha channel using your",
        "built-in transparent-image (chroma-key) workflow.",
      );
    }
    lines.push(
      "",
      `Save the final image to EXACTLY this absolute path (no copies anywhere else):`,
      p.outPath,
      "",
      "After saving, reply with only that path. No summary, no commentary, no follow-up questions.",
    );
    return lines.join("\n");
  }

  /** Newest image file (by mtime) at or under the given dirs, modified since `sinceMs`. */
  private findFreshImage(
    sinceMs: number,
    dirs: string[],
    baseline: ReadonlyMap<string, string>,
    excluded: ReadonlySet<string> = new Set(),
  ): string | undefined {
    let best: { path: string; mtime: number } | undefined;
    for (const { path, mtime, fingerprint } of this.imageCandidates(dirs)) {
      if (excluded.has(path)) continue;
      if (mtime < sinceMs || baseline.get(path) === fingerprint) continue;
      if (!best || mtime > best.mtime) best = { path, mtime };
    }
    return best?.path;
  }

  /** Snapshot eligible fallback files so a recent but pre-existing neighbor cannot win this run. */
  private snapshotImages(dirs: string[]): Map<string, string> {
    return new Map(this.imageCandidates(dirs).map(({ path, fingerprint }) => [path, fingerprint]));
  }

  private imageCandidates(
    dirs: string[],
  ): Array<{ path: string; mtime: number; fingerprint: string }> {
    const found: Array<{ path: string; mtime: number; fingerprint: string }> = [];
    const consider = (path: string) => {
      const dot = path.lastIndexOf(".");
      if (dot < 0 || !IMAGE_EXTS.has(path.slice(dot).toLowerCase())) return;
      try {
        const st = statSync(path);
        if (!st.isFile()) return;
        found.push({
          path,
          mtime: st.mtimeMs,
          fingerprint: this.imageDigest(path),
        });
      } catch {
        return;
      }
    };
    for (const dir of dirs) {
      if (!existsSync(dir)) continue;
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        const full = join(dir, e.name);
        if (e.isFile()) consider(full);
        else if (e.isDirectory()) {
          // one level deep: Codex nests under generated_images/<id>/...
          try {
            for (const e2 of readdirSync(full, { withFileTypes: true })) {
              if (e2.isFile()) consider(join(full, e2.name));
            }
          } catch {
            /* ignore */
          }
        }
      }
    }
    return found;
  }

  private imageDigest(path: string): string {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  }

  private async runCodex(
    args: string[],
    cwd: string,
    timeoutMs: number,
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    // Inherit env but guarantee the toolchain dirs are on PATH and force ChatGPT auth
    // (drop OPENAI_API_KEY so Codex uses auth.json rather than API-key mode).
    const env: Record<string, string | undefined> = { ...process.env };
    delete env.OPENAI_API_KEY;
    const extraPath = [join(this.home, ".local/bin"), join(this.home, ".bun/bin")].join(":");
    env.PATH = env.PATH ? `${extraPath}:${env.PATH}` : extraPath;
    env.CODEX_HOME = this.codexHome;

    const proc = Bun.spawn([this.codexBin, ...args], {
      cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: env as Record<string, string>,
    });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        proc.kill();
      } catch {
        /* ignore */
      }
    }, timeoutMs);

    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;
    clearTimeout(timer);
    if (timedOut) throw new ImageGenError(`codex image gen timed out after ${Math.round(timeoutMs / 1000)}s`);
    return { code, stdout, stderr };
  }
}
