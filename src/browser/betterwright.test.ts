import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BrowserLeaseCapExceededError,
  createBetterWrightRuntime,
  type BetterWrightClient,
} from "./betterwright.ts";
import type { BrowserHostSettings, BrowserLease } from "./runtime.ts";
import type { Logger } from "../types.ts";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const quietLog = (() => {
  const logger = { info() {}, warn() {}, debug() {}, error() {}, child() { return logger; } };
  return logger as unknown as Logger;
})();

interface RunCall {
  code: string;
  session: string;
  approvedDownloads: boolean;
  note?: string;
  timeout?: number;
  seq: number;
}

interface FakeResult {
  ok?: boolean;
  result?: unknown;
  error?: string;
  events?: unknown[];
  artifacts?: Array<Record<string, unknown>>;
  pages?: Array<Record<string, unknown>>;
  console?: unknown[];
  durationMs?: number;
  warnings?: unknown[];
  challenges?: unknown[];
  skills?: Array<Record<string, unknown>>;
  pendingCredential?: unknown;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A configurable stand-in for the betterwright client — no real browser. */
class FakeBetterWright implements BetterWrightClient {
  downloadPolicy: "ask" | "allow" | "deny" = "ask";
  closed = false;
  readonly closedSessions: string[] = [];
  readonly calls: RunCall[] = [];
  private seq = 0;

  constructor(
    private readonly handler?: (call: RunCall) => Promise<FakeResult> | FakeResult,
  ) {}

  async run(code: string, options?: { session?: string; approvedDownloads?: boolean; note?: string; timeout?: number }): Promise<unknown> {
    const call: RunCall = {
      code,
      session: options?.session ?? "default",
      approvedDownloads: options?.approvedDownloads ?? false,
      note: options?.note,
      timeout: options?.timeout,
      seq: this.seq++,
    };
    this.calls.push(call);
    const raw = this.handler ? await this.handler(call) : {};
    return {
      ok: raw.ok ?? true,
      result: raw.result ?? null,
      error: raw.error,
      events: raw.events ?? [`${call.session}:evt`],
      artifacts: raw.artifacts ?? [],
      pages: raw.pages ?? [{ url: "about:blank", title: "", active: true }],
      console: raw.console ?? [],
      durationMs: raw.durationMs ?? 1,
      ...(raw.warnings !== undefined ? { warnings: raw.warnings } : {}),
      ...(raw.challenges !== undefined ? { challenges: raw.challenges } : {}),
      ...(raw.skills !== undefined ? { skills: raw.skills } : {}),
      ...(raw.pendingCredential !== undefined ? { pendingCredential: raw.pendingCredential } : {}),
    };
  }

  async closeSession(session?: string): Promise<unknown> {
    this.closedSessions.push(session ?? "default");
    return { ok: true, closed: true, pagesClosed: 0 };
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

let scratch: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "beckett-bw-adapter-"));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function settingsFor(): BrowserHostSettings {
  return {
    profileDir: join(scratch, "profile"),
    artifactsRoot: join(scratch, "artifacts"),
    headless: true,
    viewportWidth: 1440,
    viewportHeight: 900,
    launchTimeoutMs: 30_000,
    actionTimeoutMs: 10_000,
    navigationTimeoutMs: 30_000,
    evalTimeoutMs: 60_000,
    maxOutputChars: 24_000,
  };
}

function leaseFor(runId: string): BrowserLease {
  return {
    runId,
    channelId: null,
    artifactsDir: join(scratch, "artifacts", runId),
    controlToken: "test-control-token-0123456789abcdef0123456789abcdef",
  };
}

test("two leases acquired back to back are both live, each on its own session", async () => {
  const fake = new FakeBetterWright();
  let launchDownloadPolicy: unknown;
  const runtime = createBetterWrightRuntime(settingsFor(), quietLog, {
    createBrowser: (options) => {
      launchDownloadPolicy = options?.downloadPolicy;
      return fake;
    },
  });
  try {
    // `ask` is fixed at worker launch; individual calls carry their own bit.
    expect(launchDownloadPolicy).toBe("ask");
    await runtime.acquire(leaseFor("alpha"));
    await runtime.acquire(leaseFor("beta"));
    expect(runtime.hasLease("alpha")).toBe(true);
    expect(runtime.hasLease("beta")).toBe(true);
    expect(runtime.sessions().sort()).toEqual(["alpha", "beta"]);
    // Each lease warmed its own session — no cross-session bleed.
    const warmSessions = fake.calls.filter((call) => call.code.includes("page.url()")).map((call) => call.session);
    expect(warmSessions.sort()).toEqual(["alpha", "beta"]);
  } finally {
    await runtime.stop();
  }
});

test("constructor receives configured chromiumArgs and an explicit parkBackgroundPages", async () => {
  const fake = new FakeBetterWright();
  let seen: Record<string, unknown> | undefined;
  const settings = { ...settingsFor(), chromiumArgs: ["--disable-gpu"], parkBackgroundPages: false };
  const runtime = createBetterWrightRuntime(settings, quietLog, {
    createBrowser: (options) => { seen = options as Record<string, unknown>; return fake; },
  });
  try {
    expect(seen?.chromiumArgs).toEqual(["--disable-gpu"]);
    expect(seen?.parkBackgroundPages).toBe(false);
  } finally { await runtime.stop(); }
});
test("parkBackgroundPages defaults to an explicit true when settings omit it", async () => {
  const fake = new FakeBetterWright();
  let seen: Record<string, unknown> | undefined;
  const runtime = createBetterWrightRuntime(settingsFor(), quietLog, {
    createBrowser: (options) => { seen = options as Record<string, unknown>; return fake; },
  });
  try {
    expect(seen?.parkBackgroundPages).toBe(true);
    expect("chromiumArgs" in (seen ?? {})).toBe(false);
  } finally { await runtime.stop(); }
});

test("calls within one lease stay strictly ordered", async () => {
  const gate = deferred<void>();
  const fake = new FakeBetterWright(async (call) => {
    if (call.code.includes("FIRST")) await gate.promise;
    return {};
  });
  const runtime = createBetterWrightRuntime(settingsFor(), quietLog, { createBrowser: () => fake });
  try {
    await runtime.acquire(leaseFor("alpha"));
    const first = runtime.evaluate("alpha", "return 'FIRST'");
    const second = runtime.evaluate("alpha", "return 'SECOND'");
    // Second must not reach the client until first resolves — same lane.
    await Bun.sleep(20);
    expect(fake.calls.some((call) => call.code.includes("SECOND"))).toBe(false);
    gate.resolve();
    await Promise.all([first, second]);
    const evalCalls = fake.calls.filter((call) => call.code.includes("return '"));
    expect(evalCalls.map((call) => call.code)).toEqual(["return 'FIRST'", "return 'SECOND'"]);
  } finally {
    await runtime.stop();
  }
});

test("different leases run concurrently instead of queueing behind each other", async () => {
  const gate = deferred<void>();
  const fake = new FakeBetterWright(async (call) => {
    if (call.code.includes("SLOW")) await gate.promise;
    return {};
  });
  const runtime = createBetterWrightRuntime(settingsFor(), quietLog, { createBrowser: () => fake });
  try {
    await runtime.acquire(leaseFor("alpha"));
    await runtime.acquire(leaseFor("beta"));
    const slowAlpha = runtime.evaluate("alpha", "return 'SLOW'");
    // Beta's call completes while alpha is still blocked — lanes are independent.
    const quickBeta = await runtime.evaluate("beta", "return 'QUICK'");
    expect(quickBeta.value).toBeNull();
    expect(fake.calls.some((call) => call.code.includes("QUICK"))).toBe(true);
    gate.resolve();
    await slowAlpha;
  } finally {
    await runtime.stop();
  }
});

test("evaluate threads note and a seconds-converted timeout into run()", async () => {
  const fake = new FakeBetterWright();
  const runtime = createBetterWrightRuntime(settingsFor(), quietLog, { createBrowser: () => fake });
  try {
    await runtime.acquire(leaseFor("opts"));
    await runtime.evaluate("opts", "return 1", undefined, { note: "Checking out", timeoutMs: 120_000 });
    const call = fake.calls.at(-1)!;
    expect(call.note).toBe("Checking out");
    expect(call.timeout).toBe(120); // seconds
    await runtime.evaluate("opts", "return 2");
    const bare = fake.calls.at(-1)!;
    expect(bare.note).toBeUndefined();
    expect(bare.timeout).toBeUndefined();
  } finally { await runtime.stop(); }
});

test("the per-lease event ring does not leak across leases", async () => {
  const fake = new FakeBetterWright((call) => ({ events: [`${call.session}#${call.seq}`] }));
  const runtime = createBetterWrightRuntime(settingsFor(), quietLog, { createBrowser: () => fake });
  try {
    await runtime.acquire(leaseFor("alpha"));
    await runtime.acquire(leaseFor("beta"));
    const a = await runtime.evaluate("alpha", "return 1");
    const b = await runtime.evaluate("beta", "return 2");
    expect((a.events ?? []).every((event) => event.startsWith("alpha#"))).toBe(true);
    expect((b.events ?? []).every((event) => event.startsWith("beta#"))).toBe(true);
    expect((a.events ?? []).some((event) => event.startsWith("beta#"))).toBe(false);
    expect((b.events ?? []).some((event) => event.startsWith("alpha#"))).toBe(false);
  } finally {
    await runtime.stop();
  }
});

test("proof capture is per-lease and lands under each lease's own artifacts dir", async () => {
  const shot = join(scratch, "capture.png");
  writeFileSync(shot, PNG_SIGNATURE);
  const fake = new FakeBetterWright((call) => {
    if (call.code.includes("screenshot(")) {
      return { result: { kind: "proof" }, artifacts: [{ kind: "proof", media: `MEDIA:${shot}` }] };
    }
    return {};
  });
  const runtime = createBetterWrightRuntime(settingsFor(), quietLog, { createBrowser: () => fake });
  try {
    await runtime.acquire(leaseFor("alpha"));
    await runtime.acquire(leaseFor("beta"));
    const alphaProof = await runtime.capture("alpha", "proof-auto");
    const betaProof = await runtime.capture("beta", "proof-auto");
    expect(alphaProof).toContain(join("artifacts", "alpha"));
    expect(betaProof).toContain(join("artifacts", "beta"));
    expect(alphaProof).not.toBe(betaProof);
    expect(readFileSync(alphaProof).subarray(0, 8)).toEqual(PNG_SIGNATURE);
    // The screenshot request rode each lease's own session.
    const shotSessions = fake.calls.filter((call) => call.code.includes("screenshot(")).map((call) => call.session);
    expect(shotSessions.sort()).toEqual(["alpha", "beta"]);
  } finally {
    await runtime.stop();
  }
});

test("the bridge exposes attachFile only for screenshots captured by this lease", async () => {
  const shot = join(scratch, "attach-source.png");
  writeFileSync(shot, Buffer.concat([PNG_SIGNATURE, Buffer.alloc(4)]));
  const fake = new FakeBetterWright((call) => call.code.includes("CAPTURE_ATTACHABLE")
    ? { artifacts: [{ kind: "debug", media: `MEDIA:${shot}` }] }
    : {});
  const runtime = createBetterWrightRuntime(settingsFor(), quietLog, { createBrowser: () => fake });
  try {
    await runtime.acquire(leaseFor("attachable"));
    const captured = await runtime.evaluate("attachable", "return await screenshot('CAPTURE_ATTACHABLE')");
    const source = captured.screenshots?.[0]!;
    await runtime.evaluate("attachable", `return await attachFile('input[type=file]', ${JSON.stringify(source)})`);
    const call = fake.calls.at(-1)!;
    expect(call.code).toContain("const attachFile");
    expect(call.code).toContain(source);
    expect(call.code).toContain(shot);
    expect(call.code).toContain("input.setInputFiles(approvedPath)");
    expect(call.code).toContain("refuses paths outside this run's approved attachment roots");
  } finally {
    await runtime.stop();
  }
});

test("acquiring past the default cap of 3 throws a catchable error rather than hanging", async () => {
  const fake = new FakeBetterWright();
  const runtime = createBetterWrightRuntime(settingsFor(), quietLog, { createBrowser: () => fake });
  try {
    expect(runtime.maxConcurrentLeases).toBe(3);
    await runtime.acquire(leaseFor("one"));
    await runtime.acquire(leaseFor("two"));
    await runtime.acquire(leaseFor("three"));
    let caught: unknown;
    try {
      await runtime.acquire(leaseFor("four"));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(BrowserLeaseCapExceededError);
    expect((caught as BrowserLeaseCapExceededError).cap).toBe(3);
    expect(runtime.hasLease("four")).toBe(false);
    // A slot frees up on release, so the same runtime keeps serving.
    await runtime.release("one", false);
    await runtime.acquire(leaseFor("four"));
    expect(runtime.hasLease("four")).toBe(true);
  } finally {
    await runtime.stop();
  }
});

test("the cap is configurable via BECKETT_BROWSER_MAX_LEASES", async () => {
  const fake = new FakeBetterWright();
  const runtime = createBetterWrightRuntime(settingsFor(), quietLog, {
    createBrowser: () => fake,
    env: { BECKETT_BROWSER_MAX_LEASES: "2" },
  });
  try {
    expect(runtime.maxConcurrentLeases).toBe(2);
    await runtime.acquire(leaseFor("one"));
    await runtime.acquire(leaseFor("two"));
    await expect(runtime.acquire(leaseFor("three"))).rejects.toBeInstanceOf(BrowserLeaseCapExceededError);
  } finally {
    await runtime.stop();
  }
});

test("the kill switch pins the cap to one lease and restores the old busy error", async () => {
  const fake = new FakeBetterWright();
  const runtime = createBetterWrightRuntime(settingsFor(), quietLog, {
    createBrowser: () => fake,
    env: { BECKETT_BROWSER_SINGLE_LEASE: "1" },
  });
  try {
    expect(runtime.maxConcurrentLeases).toBe(1);
    await runtime.acquire(leaseFor("solo"));
    await expect(runtime.acquire(leaseFor("second"))).rejects.toThrow("busy with run solo");
    expect(runtime.hasLease("second")).toBe(false);
  } finally {
    await runtime.stop();
  }
});

test("the kill switch also engages via the singleLease dep override", async () => {
  const fake = new FakeBetterWright();
  const runtime = createBetterWrightRuntime(settingsFor(), quietLog, {
    createBrowser: () => fake,
    singleLease: true,
    // A higher configured cap must not override the kill switch.
    maxLeases: 5,
  });
  try {
    expect(runtime.maxConcurrentLeases).toBe(1);
  } finally {
    await runtime.stop();
  }
});

test("acquire prunes an oversized disposable cache before warming a lease", async () => {
  const settings = settingsFor();
  const defaultDir = join(settings.profileDir, "betterwright", "browser", "profile", "Default");
  mkdirSync(join(defaultDir, "Cache"), { recursive: true });
  writeFileSync(join(defaultDir, "Cache", "large.bin"), Buffer.alloc(256 * 1024));
  writeFileSync(join(defaultDir, "Cookies"), "signed-in");
  const fake = new FakeBetterWright();
  const runtime = createBetterWrightRuntime(settings, quietLog, {
    createBrowser: () => fake,
    maxProfileDiskBytes: 128 * 1024,
  });
  try {
    await runtime.acquire(leaseFor("cache-recovery"));
    expect(existsSync(join(defaultDir, "Cache"))).toBe(false);
    expect(readFileSync(join(defaultDir, "Cookies"), "utf8")).toBe("signed-in");
    const result = await runtime.evaluate("cache-recovery", "return 1");
    expect((result.events ?? []).join("\n")).toContain("profile cache pruned] reclaimed");
  } finally {
    await runtime.stop();
  }
});

test("acquire leaves caches alone below the prune high-water mark", async () => {
  const settings = settingsFor();
  const cache = join(settings.profileDir, "betterwright", "browser", "profile", "Default", "Cache");
  mkdirSync(cache, { recursive: true });
  writeFileSync(join(cache, "small.bin"), Buffer.alloc(32 * 1024));
  const fake = new FakeBetterWright();
  const runtime = createBetterWrightRuntime(settings, quietLog, {
    createBrowser: () => fake,
    maxProfileDiskBytes: 128 * 1024,
  });
  try {
    await runtime.acquire(leaseFor("below-high-water"));
    expect(existsSync(cache)).toBe(true);
    const result = await runtime.evaluate("below-high-water", "return 1");
    expect((result.events ?? []).join("\n")).not.toContain("profile cache pruned");
  } finally {
    await runtime.stop();
  }
});

test("one lease tripping the profile budget does not blind or kill another", async () => {
  let profileSize = 10;
  const fake = new FakeBetterWright();
  const runtime = createBetterWrightRuntime(settingsFor(), quietLog, {
    createBrowser: () => fake,
    measureProfileBytes: async () => profileSize,
    maxProfileGrowthBytes: 100,
    maxProfileBytes: 10_000,
    maxLeases: 5,
  });
  try {
    await runtime.acquire(leaseFor("alpha")); // baseline 10
    profileSize = 200;
    await runtime.acquire(leaseFor("beta")); // baseline 200

    // alpha's growth 200-10 = 190 exceeds its 100-byte allowance → alpha is blocked.
    await expect(runtime.evaluate("alpha", "return 1")).rejects.toThrow("profile storage budget exceeded");
    // beta acquired at 200; growth 0 is within budget → beta keeps working.
    const betaResult = await runtime.evaluate("beta", "return 2");
    expect(betaResult.value).toBeNull();

    // alpha stays tripped; beta is still not blinded by alpha's breach.
    await expect(runtime.evaluate("alpha", "return 3")).rejects.toThrow("profile storage budget exceeded");
    const betaAgain = await runtime.evaluate("beta", "return 4");
    expect(betaAgain.value).toBeNull();
  } finally {
    await runtime.stop();
  }
});

test("disposable cache growth does not trip the per-lease budget, but real profile growth still does", async () => {
  const settings = settingsFor();
  const defaultDir = join(settings.profileDir, "betterwright", "browser", "profile", "Default");
  mkdirSync(defaultDir, { recursive: true });
  writeFileSync(join(defaultDir, "Cookies"), "signed-in");
  const fake = new FakeBetterWright();
  const runtime = createBetterWrightRuntime(settings, quietLog, {
    createBrowser: () => fake,
    // Real measureDirectoryBytes (not injected) so cache exclusion actually runs.
    maxProfileGrowthBytes: 512 * 1024,
    maxProfileBytes: 64 * 1024 * 1024,
  });
  try {
    await runtime.acquire(leaseFor("cache-churn"));

    // A media-heavy page grows disposable Chromium caches well past the 512 KiB growth
    // allowance. This is regenerable churn, not real profile state, so it must not trip.
    mkdirSync(join(defaultDir, "Cache"), { recursive: true });
    writeFileSync(join(defaultDir, "Cache", "media.bin"), Buffer.alloc(4 * 1024 * 1024));
    mkdirSync(join(defaultDir, "Service Worker", "CacheStorage"), { recursive: true });
    writeFileSync(join(defaultDir, "Service Worker", "CacheStorage", "sw.bin"), Buffer.alloc(4 * 1024 * 1024));
    const survived = await runtime.evaluate("cache-churn", "return 1");
    expect(survived.value).toBeNull();

    // A runaway write into real (non-cache) profile state is still bounded and still errors.
    writeFileSync(join(defaultDir, "runaway-state.bin"), Buffer.alloc(4 * 1024 * 1024));
    await expect(runtime.evaluate("cache-churn", "return 2")).rejects.toThrow("profile storage budget exceeded");
    // Authentication state is untouched by the exclusion accounting.
    expect(readFileSync(join(defaultDir, "Cookies"), "utf8")).toBe("signed-in");
  } finally {
    await runtime.stop();
  }
});

test("a multi-GB CacheStorage write survives the lease budget and the next acquire", async () => {
  const settings = settingsFor();
  const defaultDir = join(settings.profileDir, "betterwright", "browser", "profile", "Default");
  mkdirSync(defaultDir, { recursive: true });
  writeFileSync(join(defaultDir, "Cookies"), "signed-in");
  const cacheStorage = join(defaultDir, "Service Worker", "CacheStorage");
  const fake = new FakeBetterWright();
  // Real measureDirectoryBytes so both ceilings are exercised against real files. The
  // ratios stand in for production's 512 MB real-state / 32 GiB whole-footprint pair:
  // the cached asset set is far past the real-state ceiling and well under the disk one.
  const runtime = createBetterWrightRuntime(settings, quietLog, {
    createBrowser: () => fake,
    maxProfileBytes: 256 * 1024,
    maxProfileGrowthBytes: 64 * 1024,
    maxProfileDiskBytes: 32 * 1024 * 1024,
  });
  try {
    await runtime.acquire(leaseFor("model-cache"));

    // A page stages an asset set many times the profile-state ceiling, across both of the
    // stores a WebGPU model runner actually uses. This is exactly what the lane now
    // advertises room for, so it must not trip the lease.
    mkdirSync(cacheStorage, { recursive: true });
    mkdirSync(join(defaultDir, "File System"), { recursive: true });
    writeFileSync(join(cacheStorage, "shard-0.bin"), Buffer.alloc(8 * 1024 * 1024));
    writeFileSync(join(defaultDir, "File System", "shard-1.bin"), Buffer.alloc(8 * 1024 * 1024));
    const survived = await runtime.evaluate("model-cache", "return 1");
    expect(survived.value).toBeNull();

    await runtime.release("model-cache", false);

    // ...and the next lease acquires without the weights being reclaimed first: 16 MiB
    // is under the 70% high-water mark of the 32 MiB whole-footprint ceiling.
    await runtime.acquire(leaseFor("second-run"));
    expect(existsSync(join(cacheStorage, "shard-0.bin"))).toBe(true);
    const next = await runtime.evaluate("second-run", "return 2");
    expect((next.events ?? []).join("\n")).not.toContain("profile cache pruned");

    // Real profile state is still bounded by its own, much smaller ceiling.
    writeFileSync(join(defaultDir, "runaway-state.bin"), Buffer.alloc(1024 * 1024));
    await expect(runtime.evaluate("second-run", "return 3")).rejects.toThrow("profile storage budget exceeded");
  } finally {
    await runtime.stop();
  }
});

test("site storage past the advertised quota still blocks the lease that wrote it", async () => {
  const settings = settingsFor();
  const defaultDir = join(settings.profileDir, "betterwright", "browser", "profile", "Default");
  mkdirSync(join(defaultDir, "File System"), { recursive: true });
  const fake = new FakeBetterWright();
  const runtime = createBetterWrightRuntime(settings, quietLog, {
    createBrowser: () => fake,
    maxProfileDiskBytes: 4 * 1024 * 1024,
  });
  try {
    await runtime.acquire(leaseFor("greedy"));
    // Discounting site storage from the profile-state ceiling would leave it unbounded
    // if the advertised quota did not bind it here. A page gets what it was promised.
    writeFileSync(join(defaultDir, "File System", "runaway.bin"), Buffer.alloc(8 * 1024 * 1024));
    await expect(runtime.evaluate("greedy", "return 1")).rejects.toThrow("storage quota this lane grants");
  } finally {
    await runtime.stop();
  }
});

test("an acquire escalates past the caches when only site storage is left to reclaim", async () => {
  const settings = settingsFor();
  const defaultDir = join(settings.profileDir, "betterwright", "browser", "profile", "Default");
  mkdirSync(join(defaultDir, "File System"), { recursive: true });
  writeFileSync(join(defaultDir, "File System", "weights.bin"), Buffer.alloc(2 * 1024 * 1024));
  writeFileSync(join(defaultDir, "Cookies"), "signed-in");
  const fake = new FakeBetterWright();
  const runtime = createBetterWrightRuntime(settings, quietLog, {
    createBrowser: () => fake,
    maxProfileDiskBytes: 512 * 1024,
  });
  try {
    // Nothing disposable exists to reclaim, so without the escalation this acquire — and
    // every one after it — would fail with the lane permanently over its ceiling.
    await runtime.acquire(leaseFor("recovering"));
    expect(existsSync(join(defaultDir, "File System"))).toBe(false);
    expect(readFileSync(join(defaultDir, "Cookies"), "utf8")).toBe("signed-in");
  } finally {
    await runtime.stop();
  }
});

test("the enforced footprint ceiling is the quota the lane advertised, not the constant", async () => {
  let profileSize = 10;
  const fake = new FakeBetterWright();
  // On a tight host the lane advertises well under its 32 GiB ceiling, and a page that
  // ignores the estimate must be stopped at the number it was actually given: CloakBrowser's
  // switch only changes what a page is told, so this check is what protects the host disk.
  const runtime = createBetterWrightRuntime(settingsFor(), quietLog, {
    createBrowser: () => fake,
    measureProfileBytes: async () => profileSize,
    env: { BECKETT_BROWSER_STORAGE_QUOTA_MIB: "2" },
  });
  try {
    await runtime.acquire(leaseFor("advertised"));
    profileSize = 3 * 1024 * 1024;
    await expect(runtime.evaluate("advertised", "return 1")).rejects.toThrow("storage quota this lane grants");
  } finally {
    await runtime.stop();
  }
});

test("an unset or unusable advertised quota falls back to the lane ceiling", async () => {
  const fake = new FakeBetterWright();
  const runtime = createBetterWrightRuntime(settingsFor(), quietLog, {
    createBrowser: () => fake,
    // A garbage value must not become a tiny ceiling that refuses every lease.
    measureProfileBytes: async () => 4 * 1024 * 1024,
    env: { BECKETT_BROWSER_STORAGE_QUOTA_MIB: "not-a-number" },
  });
  try {
    await runtime.acquire(leaseFor("fallback"));
    const result = await runtime.evaluate("fallback", "return 1");
    expect((result.events ?? []).join("\n")).not.toContain("profile blocked");
  } finally {
    await runtime.stop();
  }
});

test("the whole-footprint ceiling still refuses a lease when caches cannot be reclaimed", async () => {
  let profileSize = 10;
  const fake = new FakeBetterWright();
  const runtime = createBetterWrightRuntime(settingsFor(), quietLog, {
    createBrowser: () => fake,
    measureProfileBytes: async () => profileSize,
    maxProfileDiskBytes: 1_000,
    maxLeases: 5,
  });
  try {
    await runtime.acquire(leaseFor("alpha"));
    // A second live lease blocks the prune, so the oversized profile has nowhere to go.
    profileSize = 5_000;
    await expect(runtime.acquire(leaseFor("beta"))).rejects.toThrow("profile storage budget exceeded");
  } finally {
    await runtime.stop();
  }
});

test("the global profile ceiling binds every lease regardless of its own baseline", async () => {
  let profileSize = 10;
  const fake = new FakeBetterWright();
  const runtime = createBetterWrightRuntime(settingsFor(), quietLog, {
    createBrowser: () => fake,
    measureProfileBytes: async () => profileSize,
    maxProfileGrowthBytes: 10_000,
    maxProfileBytes: 500,
    maxLeases: 5,
  });
  try {
    await runtime.acquire(leaseFor("alpha"));
    // Push the shared profile past the absolute ceiling; the growth allowance is huge,
    // so only the global ceiling can catch this.
    profileSize = 600;
    await expect(runtime.evaluate("alpha", "return 1")).rejects.toThrow("profile storage budget exceeded");
  } finally {
    await runtime.stop();
  }
});

describe("the per-session download approval gate", () => {
  test("approval is sent per call, does not leak, and survives another lease's release", async () => {
    const fake = new FakeBetterWright();
    const runtime = createBetterWrightRuntime(settingsFor(), quietLog, {
      createBrowser: () => fake,
      maxLeases: 5,
    });
    try {
      await runtime.acquire(leaseFor("alpha"));
      await runtime.acquire(leaseFor("beta"));
      runtime.approveDownloads("alpha");
      await runtime.evaluate("alpha", "return 'A'");
      await runtime.evaluate("beta", "return 'B'");

      // Approval is transport metadata on this run, not a mutable worker-wide
      // policy. Beta never receives alpha's approval.
      const alphaCall = fake.calls.find((call) => call.code === "return 'A'");
      const betaCall = fake.calls.find((call) => call.code === "return 'B'");
      expect(alphaCall?.approvedDownloads).toBe(true);
      expect(betaCall?.approvedDownloads).toBe(false);
      expect(fake.downloadPolicy).toBe("ask");

      // Releasing alpha must neither restart the worker nor affect beta's own
      // approval bit; beta can still run with its explicit approval.
      runtime.approveDownloads("beta");
      await runtime.release("alpha", false);
      await runtime.evaluate("beta", "return 'B after alpha release'");
      const betaAfterRelease = fake.calls.find((call) => call.code === "return 'B after alpha release'");
      expect(betaAfterRelease?.approvedDownloads).toBe(true);
      expect(fake.downloadPolicy).toBe("ask");
    } finally {
      await runtime.stop();
    }
  });
});

test("releasing a lease closes only its own betterwright session", async () => {
  const fake = new FakeBetterWright();
  const runtime = createBetterWrightRuntime(settingsFor(), quietLog, {
    createBrowser: () => fake,
    maxLeases: 5,
  });
  try {
    await runtime.acquire(leaseFor("alpha"));
    await runtime.acquire(leaseFor("beta"));
    await runtime.release("alpha", false);
    expect(fake.closedSessions).toEqual(["alpha"]);
    expect(runtime.hasLease("alpha")).toBe(false);
    expect(runtime.hasLease("beta")).toBe(true);
  } finally {
    await runtime.stop();
  }
});

test("a deflated 1.7.1 envelope stays deflated and new fields pass through", async () => {
  const fake = new FakeBetterWright(() => ({
    events: [],
    console: [],
    warnings: ["switch dropped"],
    challenges: [{ type: "bot_challenge" }],
    skills: [{ name: "s", description: "d", path: "/p" }],
    pendingCredential: { pendingId: "p2", origin: "o", matchMode: "base-domain", username: null, label: null, expiresAt: null },
  }));
  const runtime = createBetterWrightRuntime(settingsFor(), quietLog, { createBrowser: () => fake });
  try {
    await runtime.acquire(leaseFor("sparse"));
    const result = await runtime.evaluate("sparse", "return 1");
    expect("console" in result).toBe(false);
    expect("events" in result).toBe(false);
    expect("screenshots" in result).toBe(false);
    expect("truncated" in result).toBe(false);
    expect(result.warnings).toEqual(["switch dropped"]);
    expect(result.challenges).toEqual([{ type: "bot_challenge" }]);
    expect(result.skills).toEqual([{ name: "s", description: "d", path: "/p" }]);
    expect(result.pendingCredential?.pendingId).toBe("p2");
  } finally { await runtime.stop(); }
});
