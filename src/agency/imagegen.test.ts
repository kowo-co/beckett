import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexImageGen, FalMediaGen, OpenRouterImageGen } from "./imagegen.ts";
import type { Logger } from "../types.ts";

const quiet = (() => {
  const q = { info() {}, warn() {}, debug() {}, error() {}, child() { return q; } };
  return q as unknown as Logger;
})();

const savedFalKey = process.env.FAL_KEY;
const savedFalApiKey = process.env.FAL_API_KEY;
const savedBeckettDir = process.env.BECKETT_DIR;
const savedOpenRouterKey = process.env.OPENROUTER_API_KEY;
const savedOpenRouterKeyAlt = process.env.OPENROUTER_KEY;
const savedOpenRouterReferer = process.env.OPENROUTER_REFERER;
const tmpDirs: string[] = [];

afterEach(() => {
  if (savedFalKey === undefined) delete process.env.FAL_KEY;
  else process.env.FAL_KEY = savedFalKey;
  if (savedFalApiKey === undefined) delete process.env.FAL_API_KEY;
  else process.env.FAL_API_KEY = savedFalApiKey;
  if (savedBeckettDir === undefined) delete process.env.BECKETT_DIR;
  else process.env.BECKETT_DIR = savedBeckettDir;
  if (savedOpenRouterKey === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = savedOpenRouterKey;
  if (savedOpenRouterKeyAlt === undefined) delete process.env.OPENROUTER_KEY;
  else process.env.OPENROUTER_KEY = savedOpenRouterKeyAlt;
  if (savedOpenRouterReferer === undefined) delete process.env.OPENROUTER_REFERER;
  else process.env.OPENROUTER_REFERER = savedOpenRouterReferer;
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "beckett-imagegen-"));
  tmpDirs.push(d);
  return d;
}

test("default image generation remains the Codex path and does not need a FAL key", async () => {
  delete process.env.FAL_KEY;
  delete process.env.FAL_API_KEY;
  const dir = tmp();
  const fakeCodex = join(dir, "fake-codex");
  writeFileSync(
    fakeCodex,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'last="${!#}"',
      'out="$(printf \'%s\' "$last" | awk \'/Save the final image to EXACTLY this absolute path/{getline; print; exit}\')"',
      'if [[ -z "$out" ]]; then echo "missing out path" >&2; exit 2; fi',
      'mkdir -p "$(dirname "$out")"',
      "printf 'PNG!' > \"$out\"",
      "printf '%s\\n' \"$out\"",
      "",
    ].join("\n"),
  );
  chmodSync(fakeCodex, 0o755);

  const out = join(dir, "default.png");
  const gen = new CodexImageGen({
    imagesDir: join(dir, "images"),
    logger: quiet,
    codexBin: fakeCodex,
    codexHome: join(dir, "codex-home"),
  });
  const res = await gen.generate({ prompt: "default robot", out });

  expect(res.provider).toBeUndefined();
  expect(res.path).toBe(out);
  expect(res.relocated).toBe(false);
  expect(statSync(out).size).toBe(4);
});

test("Codex image generation renames the output when the bytes don't match the requested --out extension (png->jpg)", async () => {
  const dir = tmp();
  const fakeCodex = join(dir, "lying-codex");
  writeFileSync(
    fakeCodex,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'last="${!#}"',
      'out="$(printf \'%s\' "$last" | awk \'/Save the final image to EXACTLY this absolute path/{getline; print; exit}\')"',
      'if [[ -z "$out" ]]; then echo "missing out path" >&2; exit 2; fi',
      'mkdir -p "$(dirname "$out")"',
      // Real JPEG magic bytes (FF D8 FF ...), even though the caller asked for a .png path —
      // this reproduces the reported bug where a provider's actual bytes don't match --out.
      "printf '\\xff\\xd8\\xffJFIF' > \"$out\"",
      "printf '%s\\n' \"$out\"",
      "",
    ].join("\n"),
  );
  chmodSync(fakeCodex, 0o755);

  const requested = join(dir, "grug-400k.png");
  const gen = new CodexImageGen({
    imagesDir: join(dir, "images"),
    logger: quiet,
    codexBin: fakeCodex,
    codexHome: join(dir, "codex-home"),
  });
  const res = await gen.generate({ prompt: "grug", out: requested });

  expect(res.path).toBe(join(dir, "grug-400k.jpg"));
  expect(existsSync(requested)).toBe(false);
  const bytes = readFileSync(res.path);
  expect(bytes[0]).toBe(0xff);
  expect(bytes[1]).toBe(0xd8);
  expect(bytes[2]).toBe(0xff);
});

test("Codex image generation renames the output when the bytes don't match the requested --out extension (jpg->png)", async () => {
  const dir = tmp();
  const fakeCodex = join(dir, "lying-codex-2");
  writeFileSync(
    fakeCodex,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'last="${!#}"',
      'out="$(printf \'%s\' "$last" | awk \'/Save the final image to EXACTLY this absolute path/{getline; print; exit}\')"',
      'if [[ -z "$out" ]]; then echo "missing out path" >&2; exit 2; fi',
      'mkdir -p "$(dirname "$out")"',
      // Real PNG magic bytes, even though the caller asked for a .jpg path.
      "printf '\\x89PNG\\r\\n\\x1a\\n' > \"$out\"",
      "printf '%s\\n' \"$out\"",
      "",
    ].join("\n"),
  );
  chmodSync(fakeCodex, 0o755);

  const requested = join(dir, "grug.jpg");
  const gen = new CodexImageGen({
    imagesDir: join(dir, "images"),
    logger: quiet,
    codexBin: fakeCodex,
    codexHome: join(dir, "codex-home"),
  });
  const res = await gen.generate({ prompt: "grug", out: requested });

  expect(res.path).toBe(join(dir, "grug.png"));
  expect(existsSync(requested)).toBe(false);
  const bytes = readFileSync(res.path);
  expect([...bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
});

test("Codex image generation rejects a nonzero exit instead of returning an old output", async () => {
  const dir = tmp();
  const fakeCodex = join(dir, "failing-codex");
  const out = join(dir, "existing.png");
  writeFileSync(fakeCodex, "#!/usr/bin/env bash\necho failed >&2\nexit 7\n");
  chmodSync(fakeCodex, 0o755);
  writeFileSync(out, "OLD");
  const gen = new CodexImageGen({
    imagesDir: join(dir, "images"),
    logger: quiet,
    codexBin: fakeCodex,
    codexHome: join(dir, "codex-home"),
  });

  await expect(gen.generate({ prompt: "replace this", out })).rejects.toThrow(
    /failed \(exit 7\)/,
  );
  expect(Bun.file(out).size).toBe(3);
});

test("Codex image generation rejects an unchanged pre-existing output", async () => {
  const dir = tmp();
  const fakeCodex = join(dir, "noop-codex");
  const out = join(dir, "existing.png");
  writeFileSync(fakeCodex, "#!/usr/bin/env bash\nexit 0\n");
  chmodSync(fakeCodex, 0o755);
  writeFileSync(out, "OLD");
  const gen = new CodexImageGen({
    imagesDir: join(dir, "images"),
    logger: quiet,
    codexBin: fakeCodex,
    codexHome: join(dir, "codex-home"),
  });

  await expect(gen.generate({ prompt: "replace this", out })).rejects.toThrow(
    /no fresh image/,
  );
});

test("Codex image generation does not relocate a recent pre-existing sibling", async () => {
  const dir = tmp();
  const fakeCodex = join(dir, "noop-codex");
  const out = join(dir, "existing.png");
  writeFileSync(fakeCodex, "#!/usr/bin/env bash\nexit 0\n");
  chmodSync(fakeCodex, 0o755);
  writeFileSync(out, "OLD");
  writeFileSync(join(dir, "recent-sibling.png"), "UNRELATED");
  const gen = new CodexImageGen({
    imagesDir: join(dir, "images"),
    logger: quiet,
    codexBin: fakeCodex,
    codexHome: join(dir, "codex-home"),
  });

  await expect(gen.generate({ prompt: "replace this", out })).rejects.toThrow(
    /no fresh image/,
  );
  expect(await Bun.file(out).text()).toBe("OLD");
});

test("Codex image generation does not treat touching old bytes as a new image", async () => {
  const dir = tmp();
  const fakeCodex = join(dir, "touch-codex");
  const out = join(dir, "existing.png");
  writeFileSync(
    fakeCodex,
    [
      "#!/usr/bin/env bash",
      'last="${!#}"',
      'out="$(printf \'%s\' "$last" | awk \'/Save the final image to EXACTLY this absolute path/{getline; print; exit}\')"',
      'touch "$out"',
      "",
    ].join("\n"),
  );
  chmodSync(fakeCodex, 0o755);
  writeFileSync(out, "OLD");
  const gen = new CodexImageGen({
    imagesDir: join(dir, "images"),
    logger: quiet,
    codexBin: fakeCodex,
    codexHome: join(dir, "codex-home"),
  });

  await expect(gen.generate({ prompt: "replace this", out })).rejects.toThrow(
    /no fresh image/,
  );
  expect(await Bun.file(out).text()).toBe("OLD");
});

test("fal missing key fails cleanly before any network call", () => {
  delete process.env.FAL_KEY;
  delete process.env.FAL_API_KEY;
  const dir = tmp();
  process.env.BECKETT_DIR = dir;
  expect(
    () => new FalMediaGen({ imagesDir: join(dir, "images"), logger: quiet, fetchImpl: (() => { throw new Error("network"); }) as unknown as typeof fetch }),
  ).toThrow(/FAL key not on box: no FAL_KEY or FAL_API_KEY/);
});

test("fal reads FAL_API_KEY from the Beckett .env file", () => {
  delete process.env.FAL_KEY;
  delete process.env.FAL_API_KEY;
  const dir = tmp();
  process.env.BECKETT_DIR = dir;
  writeFileSync(join(dir, ".env"), "FAL_API_KEY=from-file\n");
  const gen = new FalMediaGen({ imagesDir: join(dir, "images"), logger: quiet });
  expect(gen).toBeDefined();
  expect(String(process.env.FAL_API_KEY)).toBe("from-file");
});

test("CodexImageGen routes fal-ai model slugs through the fal async queue and downloads images", async () => {
  const dir = tmp();
  const calls: Array<{ url: string; method: string; auth?: string; body?: string }> = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push({
      url: u,
      method: init?.method ?? "GET",
      auth: init?.headers instanceof Headers ? init.headers.get("Authorization") ?? undefined : (init?.headers as any)?.Authorization,
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    if (u === "https://queue.fal.run/fal-ai/flux/dev") {
      return Response.json({ request_id: "req-1", status_url: "https://queue.test/status/req-1", response_url: "https://queue.test/result/req-1" });
    }
    if (u === "https://queue.test/status/req-1?logs=1") return Response.json({ status: "COMPLETED" });
    if (u === "https://queue.test/result/req-1") return Response.json({ images: [{ url: "https://cdn.test/out.png" }] });
    if (u === "https://cdn.test/out.png") return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;

  const gen = new CodexImageGen({
    imagesDir: join(dir, "images"),
    logger: quiet,
  });
  // Inject fal settings by constructing the routed provider's env knobs, but keep the public entrypoint
  // as CodexImageGen.generate: this pins the no-regression behavior that only fal-ai/... changes route.
  process.env.FAL_KEY = "fal-test";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    const out = join(dir, "flux.png");
    const res = await gen.generate({ prompt: "a small robot", model: "fal-ai/flux/dev", out, size: "1024x1024" });
    expect(res.provider).toBe("fal");
    expect(res.media).toBe("image");
    expect(res.path).toBe(out);
    expect(statSync(out).size).toBe(3);
    expect(calls[0]).toMatchObject({ method: "POST", url: "https://queue.fal.run/fal-ai/flux/dev", auth: "Key fal-test" });
    expect(JSON.parse(calls[0]!.body!)).toEqual({ prompt: "a small robot", image_size: { width: 1024, height: 1024 } });
  } finally {
    globalThis.fetch = originalFetch;
  }
}, { timeout: 10_000 });

test("fal path renames the downloaded asset when its bytes don't match the requested --out extension (png->jpg)", async () => {
  // Reproduces the reported bug: fal-ai/flux-pro/v1.1 returned JPEG bytes for a --out ...png
  // request, and the CLI reported success for a path whose contents lied about their format.
  const dir = tmp();
  const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
  const fetchImpl = (async (url: string | URL | Request) => {
    const u = String(url);
    if (u === "https://queue.fal.run/fal-ai/flux-pro/v1.1") {
      return Response.json({ request_id: "req-1", status_url: "https://queue.test/status/req-1", response_url: "https://queue.test/result/req-1" });
    }
    if (u === "https://queue.test/status/req-1?logs=1") return Response.json({ status: "COMPLETED" });
    if (u === "https://queue.test/result/req-1") return Response.json({ images: [{ url: "https://cdn.test/out.png" }] });
    if (u === "https://cdn.test/out.png") return new Response(new Uint8Array(jpegBytes), { status: 200 });
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;

  const gen = new CodexImageGen({ imagesDir: join(dir, "images"), logger: quiet });
  process.env.FAL_KEY = "fal-test";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    const requested = join(dir, "grug-400k.png");
    const res = await gen.generate({ prompt: "grug", model: "fal-ai/flux-pro/v1.1", out: requested, size: "1024x1024" });

    expect(res.path).toBe(join(dir, "grug-400k.jpg"));
    expect(existsSync(requested)).toBe(false);
    const bytes = readFileSync(res.path);
    expect(bytes[0]).toBe(0xff);
    expect(bytes[1]).toBe(0xd8);
    expect(bytes[2]).toBe(0xff);
  } finally {
    globalThis.fetch = originalFetch;
  }
}, { timeout: 10_000 });

test("fal path renames the downloaded asset when its bytes don't match the requested --out extension (jpg->png)", async () => {
  const dir = tmp();
  const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
  const fetchImpl = (async (url: string | URL | Request) => {
    const u = String(url);
    if (u === "https://queue.fal.run/fal-ai/flux/dev") {
      return Response.json({ request_id: "req-2", status_url: "https://queue.test/status/req-2", response_url: "https://queue.test/result/req-2" });
    }
    if (u === "https://queue.test/status/req-2?logs=1") return Response.json({ status: "COMPLETED" });
    if (u === "https://queue.test/result/req-2") return Response.json({ images: [{ url: "https://cdn.test/out.bin" }] });
    if (u === "https://cdn.test/out.bin") return new Response(new Uint8Array(pngBytes), { status: 200 });
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;

  const gen = new CodexImageGen({ imagesDir: join(dir, "images"), logger: quiet });
  process.env.FAL_KEY = "fal-test";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    const requested = join(dir, "thing.jpg");
    const res = await gen.generate({ prompt: "grug", model: "fal-ai/flux/dev", out: requested, size: "1024x1024" });

    expect(res.path).toBe(join(dir, "thing.png"));
    expect(existsSync(requested)).toBe(false);
    const bytes = readFileSync(res.path);
    expect([...bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  } finally {
    globalThis.fetch = originalFetch;
  }
}, { timeout: 10_000 });

test("fal video models write video output and failed queue statuses expose fal's error", async () => {
  const dir = tmp();
  const videoFetch = (async (url: string | URL | Request) => {
    const u = String(url);
    if (u === "https://queue.test/fal-ai/bytedance/seedance/text-to-video") {
      return Response.json({ request_id: "vid-1", status_url: "https://queue.test/status/vid-1", response_url: "https://queue.test/result/vid-1" });
    }
    if (u === "https://queue.test/status/vid-1?logs=1") return Response.json({ status: "COMPLETED" });
    if (u === "https://queue.test/result/vid-1") return Response.json({ video: { url: "https://cdn.test/out.mp4" } });
    if (u === "https://cdn.test/out.mp4") return new Response(new Uint8Array([9, 8, 7, 6]), { status: 200 });
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  const out = join(dir, "clip.mp4");
  const gen = new FalMediaGen({ imagesDir: join(dir, "images"), logger: quiet, apiKey: "fal-test", baseUrl: "https://queue.test", fetchImpl: videoFetch, pollIntervalMs: 1 });
  const res = await gen.generate({ prompt: "camera pushes in", model: "fal-ai/bytedance/seedance/text-to-video", media: "video", out });
  expect(res.media).toBe("video");
  expect(res.path).toBe(out);
  expect(statSync(out).size).toBe(4);

  const failFetch = (async (url: string | URL | Request) => {
    const u = String(url);
    if (u === "https://queue.test/fal-ai/bytedance/seedance/text-to-video") {
      return Response.json({ request_id: "bad-1", status_url: "https://queue.test/status/bad-1", response_url: "https://queue.test/result/bad-1" });
    }
    if (u === "https://queue.test/status/bad-1?logs=1") return Response.json({ status: "FAILED", error: "seedance quota exceeded" });
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  const bad = new FalMediaGen({ imagesDir: join(dir, "images"), logger: quiet, apiKey: "fal-test", baseUrl: "https://queue.test", fetchImpl: failFetch, pollIntervalMs: 1 });
  await expect(bad.generate({ prompt: "x", model: "fal-ai/bytedance/seedance/text-to-video", media: "video" })).rejects.toThrow(
    /fal fal-ai\/bytedance\/seedance\/text-to-video failed: seedance quota exceeded/,
  );
});

test("openrouter missing key fails cleanly before any network call", () => {
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_KEY;
  const dir = tmp();
  process.env.BECKETT_DIR = dir;
  expect(
    () =>
      new OpenRouterImageGen({
        imagesDir: join(dir, "images"),
        logger: quiet,
        fetchImpl: (() => {
          throw new Error("network");
        }) as unknown as typeof fetch,
      }),
  ).toThrow(/OPENROUTER_API_KEY or OPENROUTER_KEY/);
});

test("openrouter reads OPENROUTER_API_KEY from the Beckett .env file", () => {
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_KEY;
  const dir = tmp();
  process.env.BECKETT_DIR = dir;
  writeFileSync(join(dir, ".env"), "OPENROUTER_API_KEY=from-file\n");
  const gen = new OpenRouterImageGen({ imagesDir: join(dir, "images"), logger: quiet });
  expect(gen).toBeDefined();
  expect(String(process.env.OPENROUTER_API_KEY)).toBe("from-file");
});

test("CodexImageGen routes openrouter/... model slugs, decodes a base64 image, and does not fall back to Codex", async () => {
  const dir = tmp();
  const calls: Array<{ url: string; method: string; auth?: string; referer?: string; body?: string }> = [];
  const pngBase64 = Buffer.from([1, 2, 3, 4]).toString("base64");
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const headers = init?.headers as Record<string, string> | undefined;
    calls.push({
      url: u,
      method: init?.method ?? "GET",
      auth: headers?.Authorization,
      referer: headers?.["HTTP-Referer"],
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    if (u === "https://openrouter.ai/api/v1/chat/completions") {
      return Response.json({
        choices: [
          {
            message: {
              role: "assistant",
              content: "here you go",
              images: [{ type: "image_url", image_url: { url: `data:image/png;base64,${pngBase64}` } }],
            },
          },
        ],
      });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;

  process.env.OPENROUTER_API_KEY = "sk-or-test";
  process.env.OPENROUTER_REFERER = "https://example.test";
  const gen = new CodexImageGen({ imagesDir: join(dir, "images"), logger: quiet, codexBin: join(dir, "unused-codex") });
  const out = join(dir, "nano-banana.png");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    const res = await gen.generate({
      prompt: "a small robot",
      model: "openrouter/google/gemini-2.5-flash-image",
      out,
    });
    expect(res.provider).toBe("openrouter");
    expect(res.model).toBe("google/gemini-2.5-flash-image");
    expect(res.path).toBe(out);
    expect(statSync(out).size).toBe(4);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      method: "POST",
      url: "https://openrouter.ai/api/v1/chat/completions",
      auth: "Bearer sk-or-test",
      referer: "https://example.test",
    });
    const body = JSON.parse(calls[0]!.body!);
    expect(body).toMatchObject({
      model: "google/gemini-2.5-flash-image",
      messages: [{ role: "user", content: "a small robot" }],
      modalities: ["image", "text"],
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("openrouter image generation downloads a plain result URL when no base64 data URL is returned", async () => {
  const dir = tmp();
  const fetchImpl = (async (url: string | URL | Request) => {
    const u = String(url);
    if (u === "https://openrouter.ai/api/v1/chat/completions") {
      return Response.json({
        choices: [{ message: { images: [{ type: "image_url", image_url: { url: "https://cdn.test/out.png" } }] } }],
      });
    }
    if (u === "https://cdn.test/out.png") return new Response(new Uint8Array([5, 6, 7]), { status: 200 });
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;

  const out = join(dir, "url-result.png");
  const gen = new OpenRouterImageGen({ imagesDir: join(dir, "images"), logger: quiet, apiKey: "sk-or-test", fetchImpl });
  const res = await gen.generate({ prompt: "a cat", model: "openrouter/some/model", out });
  expect(res.url).toBe("https://cdn.test/out.png");
  expect(statSync(out).size).toBe(3);
});

test("openrouter image generation rejects a missing image in the response with the model's text reply", async () => {
  const fetchImpl = (async () => Response.json({ choices: [{ message: { content: "sorry, I can't do that" } }] })) as unknown as typeof fetch;
  const gen = new OpenRouterImageGen({ imagesDir: join(tmp(), "images"), logger: quiet, apiKey: "sk-or-test", fetchImpl });
  await expect(gen.generate({ prompt: "x", model: "openrouter/some/model" })).rejects.toThrow(
    /openrouter some\/model response did not include a generated image/,
  );
});

test("openrouter image generation rejects --ref and --transparent as unsupported", async () => {
  const gen = new OpenRouterImageGen({ imagesDir: join(tmp(), "images"), logger: quiet, apiKey: "sk-or-test" });
  await expect(
    gen.generate({ prompt: "x", model: "openrouter/some/model", refs: ["/tmp/ref.png"] }),
  ).rejects.toThrow(/does not support --ref/);
  await expect(
    gen.generate({ prompt: "x", model: "openrouter/some/model", transparent: true }),
  ).rejects.toThrow(/does not support --transparent/);
});
