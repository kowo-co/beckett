/**
 * How much storage the sandboxed browser lane may use, and what it tells pages.
 *
 * CloakBrowser normalises `navigator.storage.estimate()` the same way it normalises
 * every other fingerprint surface: the reported quota is a consumer-plausible figure
 * derived from the `--fingerprint` seed, roughly 400-650 MB, with no relation to the
 * host disk. It is only a reported number — a lane whose estimate said 549 MB still
 * accepted 12 GiB of CacheStorage writes without an error — but a page cannot know
 * that. Apps that stage a large asset set (WebGPU model weights, offline maps, video
 * projects) read the estimate first and refuse before they fetch a byte.
 *
 * So the lane sets the figure itself, from the real free space on the filesystem
 * backing the profile, bounded by what Beckett is actually willing to let one browser
 * lane keep on disk. Chromium's quota manager stays on and unmodified; the number
 * pages see stops being fiction.
 *
 * The same resolved budget is the lane's per-file `RLIMIT_FSIZE` (isolated.ts) and the
 * profile's on-disk ceiling (betterwright.ts), so the storage Beckett advertises, the
 * storage a single write may reach, and the storage the lease budget tolerates are one
 * number rather than three that can disagree.
 */

import { statfsSync } from "node:fs";

/**
 * Ceiling on the lane's on-disk footprint. Large enough for the multi-GB asset sets
 * that motivate the whole exercise (a 5.3 GB model, cached whole) with room for a
 * second one beside it, and still a small fraction of any disk worth running on.
 */
export const LANE_STORAGE_BYTES = 32 * 1024 * 1024 * 1024;

/**
 * Free space the lane never claims. The browser lane is a guest on a machine that
 * also runs the daemon, its worktrees, and its logs; a page that fills the disk to
 * the last block takes all of them down with it.
 */
export const HOST_FREE_SPACE_RESERVE_BYTES = 8 * 1024 * 1024 * 1024;

/**
 * Floor for the resolved budget. On a nearly full host the honest answer approaches
 * zero, but a zero-byte `RLIMIT_FSIZE` stops Chromium from writing its own profile,
 * so the lane keeps a working minimum and lets the filesystem report ENOSPC itself.
 */
export const MIN_LANE_STORAGE_BYTES = 512 * 1024 * 1024;

/** Injectable for tests; mirrors the shape of `node:fs`'s statfsSync result. */
export type StatfsProbe = (path: string) => { bsize: number; bavail: number | bigint };

export interface LaneStorageOptions {
  /** Any path on the filesystem that backs the profile. */
  profileDir: string;
  /** Ceiling override; defaults to {@link LANE_STORAGE_BYTES}. */
  budgetBytes?: number;
  reserveBytes?: number;
  statfs?: StatfsProbe;
}

/**
 * Bytes this lane may store: free space on the profile's filesystem less the host
 * reserve, clamped into [{@link MIN_LANE_STORAGE_BYTES}, budget].
 *
 * A filesystem that cannot be probed falls back to the floor rather than the ceiling:
 * an unreadable disk is not evidence of a large one.
 */
export function resolveLaneStorageBytes(options: LaneStorageOptions): number {
  const budget = Math.floor(options.budgetBytes ?? LANE_STORAGE_BYTES);
  const reserve = Math.floor(options.reserveBytes ?? HOST_FREE_SPACE_RESERVE_BYTES);
  const floor = Math.min(MIN_LANE_STORAGE_BYTES, budget);
  let free: number;
  try {
    const stats = (options.statfs ?? statfsSync)(options.profileDir);
    free = Number(stats.bsize) * Number(stats.bavail);
  } catch {
    return floor;
  }
  if (!Number.isFinite(free) || free <= 0) return floor;
  return Math.max(floor, Math.min(budget, Math.floor(free - reserve)));
}

/**
 * The budget in whole mebibytes, the unit CloakBrowser's `--fingerprint-storage-quota`
 * switch takes. Always at least 1 so the switch is never emitted as a no-op zero.
 */
export function laneStorageQuotaMib(bytes: number): number {
  return Math.max(1, Math.floor(bytes / (1024 * 1024)));
}

/** Which BetterWright engine actually served a session (betterwright worker.ts `browserBackend`). */
export type BrowserLaneBackend = "obscura" | "compatibility";

/**
 * What Obscura reports for `navigator.storage.estimate().quota`, always, on every host.
 *
 * BetterWright 1.7.1 runs headless sessions on the resident Obscura engine rather than
 * CloakBrowser (docs/obscura.md; CHANGELOG 1.7.0 "Headless sessions now use
 * checksum-pinned Obscura 0.1.11 for resident DOM, JavaScript, storage, cookie, and
 * guarded network execution"). Obscura implements `navigator.storage` as its own fixed
 * shim — the `estimate`/`persist`/`persisted` trio hangs off its synthesised navigator
 * prototype — and neither Obscura's release notes nor BetterWright's docs offer a lever
 * over the figure. `--fingerprint-storage-quota`, the lane's only lever
 * (cloak-storage-quota.mjs), is a CloakBrowser switch and never reaches Obscura, which
 * also ignores `chromiumArgs` outright for resident execution.
 *
 * So on Obscura the lane's measured budget is NOT what a page reads; a flat 5 GB is.
 * Observed on linux-x64 Obscura 0.1.11 under Beckett's sandboxed host: exactly
 * 5,000,000,000 with a real `usage` beside it and no `usageDetails` key, on a profile
 * whose resolved lane budget was 621,809,664 bytes — the number tracks nothing about the
 * host. Pinning it exactly is the point: if Obscura ever honours a quota lever, or moves
 * its constant, this gate fires and the lane gets rewired instead of quietly advertising
 * a figure Beckett did not choose.
 */
export const OBSCURA_STORAGE_QUOTA_BYTES = 5_000_000_000;

/** Tolerance on the compatibility lane: free space on the profile's filesystem moves while a smoke runs. */
const LANE_BUDGET_TOLERANCE_BYTES = 1024 * 1024 * 1024;

export interface LaneStorageQuotaCheck {
  backend: BrowserLaneBackend;
  /** The quota a real page read from `navigator.storage.estimate()`. */
  quota: number;
  /** The lane budget {@link resolveLaneStorageBytes} resolved for the profile that served it. */
  expectedBytes: number;
}

/**
 * Why the quota a page actually read is wrong for the backend that served it, or `null`
 * when it is right. Pure so both arms stay testable without either engine installed.
 *
 * The two arms assert different things because the lane reaches the two backends
 * differently. CloakBrowser fabricates the figure from the profile's fingerprint seed
 * unless the lane overrides it, so the assertion is that the lane's override won: whole
 * mebibytes (the switch's unit), inside the policy band, tracking the measured budget.
 * Obscura takes no override at all, so the assertion is its exact fixed constant.
 */
export function laneStorageQuotaViolation(check: LaneStorageQuotaCheck): string | null {
  const { backend, quota, expectedBytes } = check;
  if (!Number.isFinite(quota) || quota <= 0) return `browser reported no storage quota: ${String(quota)}`;
  if (backend === "obscura") {
    // Exact, not a band: the constant is the whole signal. Anything else means Obscura's
    // storage reporting changed and the lane's budget has to be re-plumbed for it.
    if (quota !== OBSCURA_STORAGE_QUOTA_BYTES) {
      return `storage quota ${quota} is not Obscura's fixed ${OBSCURA_STORAGE_QUOTA_BYTES}-byte estimate`;
    }
    return null;
  }
  // Whole mebibytes is the signature of the lane's own switch: CloakBrowser's fabricated
  // figure is a seed-derived byte count (593.46 MiB on the profile that motivated this).
  if (quota % (1024 * 1024) !== 0) return `storage quota ${quota} is not the lane's whole-MiB budget`;
  if (quota < MIN_LANE_STORAGE_BYTES || quota > LANE_STORAGE_BYTES) {
    return `storage quota ${quota} is outside the lane's policy band`;
  }
  // The smoke's profile sits on a filesystem whose free space moves while it runs, so the
  // budget is compared with a tolerance rather than for equality — the point is that the
  // page sees THIS lane's measured budget, not a number invented from a fingerprint.
  if (Math.abs(quota - expectedBytes) > LANE_BUDGET_TOLERANCE_BYTES) {
    return `storage quota ${quota} does not track the lane budget ${expectedBytes}`;
  }
  return null;
}
