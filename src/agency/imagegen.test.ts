import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
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

function recordingLogger() {
  const warnings: Array<[string, Record<string, unknown> | undefined]> = [];
  const q = {
    info() {},
    warn(msg: string, fields?: Record<string, unknown>) {
      warnings.push([msg, fields]);
    },
    debug() {},
    error() {},
    child() {
      return q;
    },
  };
  return { logger: q as unknown as Logger, warnings };
}

test("a missing codex binary falls back to fal (which is credentialed) instead of hard-failing", async () => {
  const dir = tmp();
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_KEY;
  process.env.FAL_KEY = "fal-test";

  const calls: string[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push(u);
    if (u === "https://queue.fal.run/fal-ai/flux-pro/v1.1-ultra") {
      const body = JSON.parse(String(init?.body));
      expect(body).toEqual({ prompt: "a red cube on black", aspect_ratio: "2:3" });
      return Response.json({ images: [{ url: "https://cdn.test/fallback.png" }] });
    }
    if (u === "https://cdn.test/fallback.png") return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 });
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;

  const { logger, warnings } = recordingLogger();
  const gen = new CodexImageGen({
    imagesDir: join(dir, "images"),
    logger,
    codexBin: join(dir, "nonexistent-codex-binary"),
    codexHome: join(dir, "codex-home"),
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    const out = join(dir, "fallback.png");
    const res = await gen.generate({ prompt: "a red cube on black", size: "1024x1536", out });
    expect(res.provider).toBe("fal");
    expect(res.model).toBe("fal-ai/flux-pro/v1.1-ultra");
    expect(statSync(out).size).toBe(4);
    expect(calls).toContain("https://queue.fal.run/fal-ai/flux-pro/v1.1-ultra");
    expect(warnings.some(([msg]) => /codex not found/.test(msg))).toBe(true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("with no fallback provider credentialed, a missing codex binary fails loudly", async () => {
  delete process.env.FAL_KEY;
  delete process.env.FAL_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_KEY;
  const dir = tmp();
  process.env.BECKETT_DIR = dir; // no .env written, so neither fallback provider finds a key
  const gen = new CodexImageGen({
    imagesDir: join(dir, "images"),
    logger: quiet,
    codexBin: join(dir, "nonexistent-codex-binary"),
    codexHome: join(dir, "codex-home"),
  });
  await expect(gen.generate({ prompt: "x" })).rejects.toThrow(/codex not found/);
});

test("fal maps --size to flux-pro/v1.1-ultra's aspect_ratio instead of dropping it", async () => {
  const dir = tmp();
  const calls: Array<{ url: string; body?: string }> = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, body: typeof init?.body === "string" ? init.body : undefined });
    if (u === "https://queue.fal.run/fal-ai/flux-pro/v1.1-ultra") {
      return Response.json({ images: [{ url: "https://cdn.test/ultra.png" }] });
    }
    if (u === "https://cdn.test/ultra.png") return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;

  const gen = new FalMediaGen({ imagesDir: join(dir, "images"), logger: quiet, apiKey: "fal-test", fetchImpl });
  const out = join(dir, "ultra-portrait.png");
  const res = await gen.generate({
    prompt: "vertical portrait phone wallpaper, tall aspect, a red cube on black",
    model: "fal-ai/flux-pro/v1.1-ultra",
    size: "1024x1536",
    out,
  });
  expect(res.path).toBe(out);
  expect(JSON.parse(calls[0]!.body!)).toEqual({
    prompt: "vertical portrait phone wallpaper, tall aspect, a red cube on black",
    aspect_ratio: "2:3",
  });
  // never sends the ignored image_size field for this model
  expect(calls[0]!.body).not.toMatch(/image_size/);
});

test("fal fails loudly, before any network call, when a size can't be mapped to the model's aspect ratios", async () => {
  const dir = tmp();
  let called = false;
  const fetchImpl = (async () => {
    called = true;
    return new Response("should not be reached", { status: 500 });
  }) as unknown as typeof fetch;
  const gen = new FalMediaGen({ imagesDir: join(dir, "images"), logger: quiet, apiKey: "fal-test", fetchImpl });

  await expect(
    gen.generate({ prompt: "x", model: "fal-ai/flux-pro/v1.1-ultra", size: "1000x700" }),
  ).rejects.toThrow(/takes an aspect_ratio, not raw pixels/);
  expect(called).toBe(false);
});

test("fal routes --ref through the default edit model when the requested model has no image input", async () => {
  const dir = tmp();
  const refPath = join(dir, "ref.png");
  writeFileSync(refPath, "REFDATA");

  const calls: Array<{ url: string; method: string; body?: string }> = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? "GET";
    calls.push({ url: u, method, body: typeof init?.body === "string" ? init.body : undefined });
    if (u === "https://rest.alpha.fal.ai/storage/upload/initiate?storage_type=fal-cdn-v3") {
      return Response.json({ file_url: "https://cdn.test/ref.png", upload_url: "https://upload.test/ref.png" });
    }
    if (u === "https://upload.test/ref.png") return new Response(null, { status: 200 });
    if (u === "https://queue.fal.run/fal-ai/flux-pro/kontext") {
      const body = JSON.parse(String(init?.body));
      expect(body.image_url).toBe("https://cdn.test/ref.png");
      return Response.json({ images: [{ url: "https://cdn.test/edited.png" }] });
    }
    if (u === "https://cdn.test/edited.png") return new Response(new Uint8Array([9, 9]), { status: 200 });
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;

  const gen = new FalMediaGen({ imagesDir: join(dir, "images"), logger: quiet, apiKey: "fal-test", fetchImpl });
  const out = join(dir, "edited.png");
  const res = await gen.generate({ prompt: "make it warmer", model: "fal-ai/flux/dev", refs: [refPath], out });
  expect(res.model).toBe("fal-ai/flux-pro/kontext");
  expect(statSync(out).size).toBe(2);
  expect(calls.some((c) => c.url.includes("upload/initiate") && c.method === "POST")).toBe(true);
  expect(calls.some((c) => c.url === "https://upload.test/ref.png" && c.method === "PUT")).toBe(true);
});

test("fal rejects more than one --ref image and a missing --ref file", async () => {
  const dir = tmp();
  const gen = new FalMediaGen({ imagesDir: join(dir, "images"), logger: quiet, apiKey: "fal-test" });
  await expect(
    gen.generate({ prompt: "x", model: "fal-ai/flux/dev", refs: [join(dir, "a.png"), join(dir, "b.png")] }),
  ).rejects.toThrow(/supports exactly one reference image/);
  await expect(
    gen.generate({ prompt: "x", model: "fal-ai/flux/dev", refs: [join(dir, "missing.png")] }),
  ).rejects.toThrow(/reference image not found/);
});
