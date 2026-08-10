import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createMeasurementCache,
  isDisposableCacheDir,
  isSiteStorageDir,
  measureDirectoryBytes,
  pruneChromeProfileCaches,
} from "./profile-cache.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("isDisposableCacheDir matches disposable cache trees below Default and nothing else", () => {
  const root = "/state/profile";
  // Disposable: single- and nested-segment caches directly under a Default profile.
  expect(isDisposableCacheDir(join(root, "Default", "Cache"))).toBe(true);
  expect(isDisposableCacheDir(join(root, "Default", "Code Cache"))).toBe(true);
  expect(isDisposableCacheDir(join(root, "Default", "Service Worker", "CacheStorage"))).toBe(true);
  // Nested Default (betterwright layout) is still matched.
  expect(isDisposableCacheDir(join(root, "betterwright", "browser", "profile", "Default", "GPUCache"))).toBe(true);
  // Real profile state is never disposable, even when its name resembles a cache.
  expect(isDisposableCacheDir(join(root, "Default", "Cookies"))).toBe(false);
  expect(isDisposableCacheDir(join(root, "Default", "IndexedDB"))).toBe(false);
  expect(isDisposableCacheDir(join(root, "Default", "Service Worker", "Database"))).toBe(false);
  // A cache-named dir that is not under a Default profile is left alone.
  expect(isDisposableCacheDir(join(root, "Cache"))).toBe(false);
});

test("isSiteStorageDir covers what a page stores under its quota, not Beckett's own state", () => {
  const root = "/state/profile";
  // Everything disposable is site storage too.
  expect(isSiteStorageDir(join(root, "Default", "Cache"))).toBe(true);
  expect(isSiteStorageDir(join(root, "Default", "Service Worker", "CacheStorage"))).toBe(true);
  // ...plus the quota-managed stores a page writes directly. OPFS is the one a WebGPU
  // model runner uses for weights, alongside Cache Storage.
  expect(isSiteStorageDir(join(root, "Default", "File System"))).toBe(true);
  expect(isSiteStorageDir(join(root, "Default", "IndexedDB"))).toBe(true);
  expect(isSiteStorageDir(join(root, "Default", "Local Storage"))).toBe(true);
  expect(isSiteStorageDir(join(root, "betterwright", "browser", "profile", "Default", "File System"))).toBe(true);
  // Beckett's own profile state is never a page's to fill.
  expect(isSiteStorageDir(join(root, "Default", "Cookies"))).toBe(false);
  expect(isSiteStorageDir(join(root, "Default", "Login Data"))).toBe(false);
  expect(isSiteStorageDir(join(root, "File System"))).toBe(false);
  // The disposable set stays narrower: the routine prune must not reach site storage.
  expect(isDisposableCacheDir(join(root, "Default", "File System"))).toBe(false);
});

test("measureDirectoryBytes can exclude site storage while counting Beckett's own state", async () => {
  const root = mkdtempSync(join(tmpdir(), "beckett-profile-measure-"));
  roots.push(root);
  const defaultDir = join(root, "Default");
  mkdirSync(join(defaultDir, "Cache"), { recursive: true });
  writeFileSync(join(defaultDir, "Cache", "media.bin"), Buffer.alloc(512 * 1024));
  mkdirSync(join(defaultDir, "File System"), { recursive: true });
  writeFileSync(join(defaultDir, "File System", "weights.bin"), Buffer.alloc(256 * 1024));
  writeFileSync(join(defaultDir, "Cookies"), Buffer.alloc(64 * 1024));

  const everything = await measureDirectoryBytes(root);
  const ownState = await measureDirectoryBytes(root, Number.POSITIVE_INFINITY, { excludeSiteStorage: true });
  // Both the disposable cache (512 KiB) and the OPFS weights (256 KiB) are discounted;
  // the cookie jar is not.
  expect(everything - ownState).toBeGreaterThanOrEqual(768 * 1024);
  expect(ownState).toBeGreaterThanOrEqual(64 * 1024);
});

test("the escalated prune reclaims site storage but still keeps authentication", async () => {
  const root = mkdtempSync(join(tmpdir(), "beckett-profile-escalate-"));
  roots.push(root);
  const defaultDir = join(root, "betterwright", "browser", "profile", "Default");
  mkdirSync(join(defaultDir, "File System"), { recursive: true });
  mkdirSync(join(defaultDir, "Cache"), { recursive: true });
  writeFileSync(join(defaultDir, "File System", "weights.bin"), Buffer.alloc(1024 * 1024));
  writeFileSync(join(defaultDir, "Cache", "media.bin"), Buffer.alloc(256 * 1024));
  writeFileSync(join(defaultDir, "Cookies"), "signed-in");

  // The routine prune leaves a page's own storage alone...
  const routine = await pruneChromeProfileCaches(root);
  expect(existsSync(join(defaultDir, "Cache"))).toBe(false);
  expect(existsSync(join(defaultDir, "File System"))).toBe(true);
  expect(routine.reclaimedBytes).toBeGreaterThanOrEqual(256 * 1024);

  // ...and only the escalation, for a profile with nothing else left to give back,
  // reaches it. Logins survive both.
  const escalated = await pruneChromeProfileCaches(root, { includeSiteStorage: true });
  expect(existsSync(join(defaultDir, "File System"))).toBe(false);
  expect(escalated.reclaimedBytes).toBeGreaterThanOrEqual(1024 * 1024);
  expect(readFileSync(join(defaultDir, "Cookies"), "utf8")).toBe("signed-in");
});

test("prunes only disposable caches in every nested Default profile", async () => {
  const root = mkdtempSync(join(tmpdir(), "beckett-profile-cache-"));
  roots.push(root);
  const defaults = [
    join(root, "Default"),
    join(root, "betterwright", "browser", "profile", "Default"),
    join(root, "betterwright", "browser", "profile-chromium", "Default"),
  ];
  const caches = ["Cache", "Code Cache", "GPUCache", "DawnGraphiteCache", "DawnWebGPUCache", "Service Worker/CacheStorage", "Service Worker/ScriptCache"];
  const state = ["Cookies", "Local Storage", "Login Data", "Preferences", "Web Data", "IndexedDB", "Sessions", "History"];
  for (const dir of defaults) {
    for (const cache of caches) {
      mkdirSync(join(dir, cache), { recursive: true });
      writeFileSync(join(dir, cache, "payload"), Buffer.alloc(4096));
    }
    for (const file of state) {
      const isDirectory = file === "Local Storage" || file === "IndexedDB" || file === "Sessions";
      if (isDirectory) {
        mkdirSync(join(dir, file), { recursive: true });
        writeFileSync(join(dir, file, "state"), "keep");
      } else {
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, file), "keep");
      }
    }
  }

  const result = await pruneChromeProfileCaches(root);
  expect(result.reclaimedBytes).toBeGreaterThan(0);
  for (const dir of defaults) {
    for (const cache of caches) expect(existsSync(join(dir, cache))).toBe(false);
    for (const file of state) {
      const target = join(dir, file);
      expect(existsSync(target)).toBe(true);
      if (file !== "Local Storage" && file !== "IndexedDB" && file !== "Sessions") expect(readFileSync(target, "utf8")).toBe("keep");
    }
  }
});

describe("createMeasurementCache", () => {
  test("returns the cached value inside the ttl without re-producing", async () => {
    let clock = 0;
    let produced = 0;
    const cache = createMeasurementCache({ ttlMs: 10_000, now: () => clock });
    const produce = async () => { produced++; return 7; };
    expect(await cache.measure("k", produce)).toBe(7);
    clock = 9_999;
    expect(await cache.measure("k", produce)).toBe(7);
    expect(produced).toBe(1);
  });

  test("re-produces after the ttl expires", async () => {
    let clock = 0;
    let produced = 0;
    const cache = createMeasurementCache({ ttlMs: 10_000, now: () => clock });
    const produce = async () => { produced++; return produced; };
    await cache.measure("k", produce);
    clock = 10_000;
    expect(await cache.measure("k", produce)).toBe(2);
    expect(produced).toBe(2);
  });

  test("ttlMs 0 disables caching", async () => {
    let produced = 0;
    const cache = createMeasurementCache({ ttlMs: 0, now: () => 0 });
    const produce = async () => { produced++; return 1; };
    await cache.measure("k", produce);
    await cache.measure("k", produce);
    await cache.measure("k", produce);
    expect(produced).toBe(3);
    // seed() is a no-op with caching off, so the next measure still produces.
    cache.seed("k", 42);
    expect(await cache.measure("k", produce)).toBe(1);
    expect(produced).toBe(4);
  });

  test("concurrent measures share one in-flight produce", async () => {
    let produced = 0;
    let release!: (value: number) => void;
    const gate = new Promise<number>((resolve) => { release = resolve; });
    const cache = createMeasurementCache({ ttlMs: 10_000, now: () => 0 });
    const produce = async () => { produced++; return gate; };
    const first = cache.measure("k", produce);
    const second = cache.measure("k", produce);
    release(5);
    expect(await first).toBe(5);
    expect(await second).toBe(5);
    expect(produced).toBe(1);
  });

  test("a failed produce is not cached", async () => {
    let produced = 0;
    const cache = createMeasurementCache({ ttlMs: 10_000, now: () => 0 });
    const produce = async () => {
      produced++;
      if (produced === 1) throw new Error("scan failed");
      return 3;
    };
    await expect(cache.measure("k", produce)).rejects.toThrow("scan failed");
    expect(await cache.measure("k", produce)).toBe(3);
    expect(produced).toBe(2);
  });

  test("seed primes and invalidate clears", async () => {
    let produced = 0;
    const cache = createMeasurementCache({ ttlMs: 10_000, now: () => 0 });
    const produce = async () => { produced++; return 1; };
    cache.seed("k", 42);
    expect(await cache.measure("k", produce)).toBe(42);
    expect(produced).toBe(0);
    cache.invalidate();
    expect(await cache.measure("k", produce)).toBe(1);
    expect(produced).toBe(1);
  });
});
