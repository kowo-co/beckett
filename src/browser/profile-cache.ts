/** Safe cleanup of Chromium data that is disposable between browser launches. */
import { lstat, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

/**
 * Chromium subtrees below a `Default` profile that hold only regenerable data:
 * HTTP/code/GPU caches and the Service Worker cache/script stores. Chromium
 * rebuilds all of these on demand, so their churn is not real profile growth.
 * This one list is authoritative for what the routine prune deletes, so the prune
 * and the "disposable" judgement can never disagree.
 */
export const DISPOSABLE_CACHE_PATHS = [
  ["Cache"],
  ["Code Cache"],
  ["GPUCache"],
  ["ShaderCache"],
  ["GrShaderCache"],
  ["DawnGraphiteCache"],
  ["DawnWebGPUCache"],
  ["Service Worker", "CacheStorage"],
  ["Service Worker", "ScriptCache"],
] as const;

/**
 * Chromium subtrees a *page* fills using the storage the browser granted it — the
 * bytes `navigator.storage.estimate()` counts as `usage`. These are not regenerable
 * the way a cache is, but they are not Beckett's profile state either: they belong to
 * the quota the lane advertised, and are budgeted against it rather than against the
 * much smaller ceiling for Chromium's own bookkeeping.
 *
 * A model runner that stages several GB of weights uses these directly: Cache Storage
 * and the HTTP cache are covered above, and the Origin Private File System ("File
 * System") is the other half of what a WebGPU app writes.
 */
export const SITE_STORAGE_PATHS = [
  ["File System"],
  ["IndexedDB"],
  ["Local Storage"],
  ["Shared Storage"],
  ["blob_storage"],
  ["databases"],
] as const;

export interface ChromeCachePruneResult {
  reclaimedBytes: number;
}

/**
 * True when `path` is a disposable Chromium cache subtree (one of DISPOSABLE_CACHE_PATHS
 * sitting directly under a `Default` profile, at any depth from the profile root). Purely
 * structural — no filesystem access — so it is safe to call inside a live scan and against
 * an open browser: it never touches the tree, it only decides whether to count it.
 */
export function isDisposableCacheDir(path: string): boolean {
  return matchesProfileSubtree(path, DISPOSABLE_CACHE_PATHS);
}

/**
 * True when `path` is storage a page filled under its granted quota — a disposable
 * cache, or one of {@link SITE_STORAGE_PATHS}. This is the set the per-lease profile
 * accounting discounts, because those bytes are already bounded by the quota the lane
 * advertised (see storage-quota.ts) rather than by the profile-hygiene ceiling.
 */
export function isSiteStorageDir(path: string): boolean {
  return isDisposableCacheDir(path) || matchesProfileSubtree(path, SITE_STORAGE_PATHS);
}

/** Purely structural, no filesystem access: is `path` one of `subtrees` under a `Default`? */
function matchesProfileSubtree(path: string, subtrees: ReadonlyArray<ReadonlyArray<string>>): boolean {
  const segments = path.split(/[/\\]+/).filter(Boolean);
  for (const parts of subtrees) {
    if (segments.length < parts.length + 1) continue;
    const anchor = segments.length - parts.length;
    if (segments[anchor - 1] !== "Default") continue;
    if (parts.every((part, index) => segments[anchor + index] === part)) return true;
  }
  return false;
}

/**
 * Allocated bytes, ignoring symlinks so a profile cannot lead scans outside itself.
 * With `excludeSiteStorage`, quota-managed storage is skipped so the result tracks
 * Beckett's own profile state rather than what a page stored under its granted quota.
 */
export async function measureDirectoryBytes(
  root: string,
  stopAfter = Number.POSITIVE_INFINITY,
  options?: { excludeSiteStorage?: boolean },
): Promise<number> {
  const excludeSiteStorage = options?.excludeSiteStorage ?? false;
  const pending = [root];
  let total = 0;
  while (pending.length > 0 && total <= stopAfter) {
    const current = pending.pop()!;
    if (excludeSiteStorage && isSiteStorageDir(current)) continue;
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink()) continue;
      total += Number.isFinite(stat.blocks) && stat.blocks > 0 ? stat.blocks * 512 : Math.max(0, stat.size);
      if (stat.isDirectory()) {
        for (const entry of await readdir(current)) pending.push(join(current, entry));
      }
    } catch {
      // Chrome can rotate cache files during a scan; a later measurement is authoritative.
    }
  }
  return total;
}

/**
 * Remove cache trees below every Chromium `Default` profile found under root.
 * This deliberately has no broad profile cleanup fallback: authentication and browser state stay.
 * Callers must ensure no browser process currently owns the profile.
 *
 * With `includeSiteStorage`, {@link SITE_STORAGE_PATHS} goes too. That is the escalation
 * for a profile still over its whole-footprint ceiling after the caches are gone — a
 * page may legitimately have staged gigabytes it never has to give back, and without
 * this the lane would refuse every subsequent lease with nothing left to reclaim.
 * Cookies, logins and history survive either way.
 */
export async function pruneChromeProfileCaches(
  profileRoot: string,
  options?: { includeSiteStorage?: boolean },
): Promise<ChromeCachePruneResult> {
  const targets = options?.includeSiteStorage
    ? [...DISPOSABLE_CACHE_PATHS, ...SITE_STORAGE_PATHS]
    : DISPOSABLE_CACHE_PATHS;
  const before = await measureDirectoryBytes(profileRoot);
  const pending = [profileRoot];
  const defaults: string[] = [];
  while (pending.length > 0) {
    const current = pending.pop()!;
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) continue;
      if (current !== profileRoot && current.split(/[/\\]/).at(-1) === "Default") {
        defaults.push(current);
        continue;
      }
      for (const entry of await readdir(current)) pending.push(join(current, entry));
    } catch {
      // A concurrently removed cache is already successfully pruned.
    }
  }
  await Promise.all(defaults.flatMap((defaultDir) => targets.map(async (parts) => {
    const target = join(defaultDir, ...parts);
    try {
      const stat = await lstat(target);
      if (!stat.isSymbolicLink()) await rm(target, { recursive: true, force: true });
    } catch {
      // Missing/churning cache directories are harmless.
    }
  })));
  const after = await measureDirectoryBytes(profileRoot);
  return { reclaimedBytes: Math.max(0, before - after) };
}

export interface MeasurementCache {
  /** Cached-or-fresh value for `key`; concurrent callers share one in-flight `produce`. */
  measure(key: string, produce: () => Promise<number>): Promise<number>;
  /** Prime `key` with a just-measured value (fresh as of now()). */
  seed(key: string, value: number): void;
  /** Drop every cached value; the next measure() per key re-produces. */
  invalidate(): void;
}

/**
 * TTL-gated memoizer for expensive directory scans. `ttlMs <= 0` disables caching entirely
 * (every measure() produces), which is also the test escape hatch. Failed produces are never
 * cached, so an error cannot mask a later over-budget state. Staleness contract: a caller may
 * observe a value up to `ttlMs` old — enforcement built on it is delayed by at most the TTL,
 * never skipped, because the first call after expiry always re-produces.
 */
export function createMeasurementCache(options: { ttlMs: number; now?: () => number }): MeasurementCache {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs;
  const entries = new Map<string, { value: number; at: number }>();
  const inFlight = new Map<string, Promise<number>>();
  return {
    async measure(key, produce) {
      if (ttlMs <= 0) return produce();
      const cached = entries.get(key);
      if (cached && now() - cached.at < ttlMs) return cached.value;
      const pending = inFlight.get(key);
      if (pending) return pending;
      const work = (async () => {
        const value = await produce();
        entries.set(key, { value, at: now() });
        return value;
      })().finally(() => inFlight.delete(key));
      inFlight.set(key, work);
      return work;
    },
    seed(key, value) {
      if (ttlMs <= 0) return;
      entries.set(key, { value, at: now() });
    },
    invalidate() {
      entries.clear();
    },
  };
}
