import { expect, test } from "bun:test";
import {
  HOST_FREE_SPACE_RESERVE_BYTES,
  LANE_STORAGE_BYTES,
  MIN_LANE_STORAGE_BYTES,
  OBSCURA_STORAGE_QUOTA_BYTES,
  laneStorageQuotaMib,
  laneStorageQuotaViolation,
  resolveLaneStorageBytes,
} from "./storage-quota.ts";

const GiB = 1024 * 1024 * 1024;

/** statfs stub reporting `freeBytes` available in 4 KiB blocks, as Linux does. */
function statfsWith(freeBytes: number) {
  return () => ({ bsize: 4096, bavail: Math.floor(freeBytes / 4096) });
}

test("a roomy host gets the full lane budget, not the whole disk", () => {
  const bytes = resolveLaneStorageBytes({ profileDir: "/anything", statfs: statfsWith(400 * GiB) });
  expect(bytes).toBe(LANE_STORAGE_BYTES);
  // The ticket's bar: at least 20 GB reported on a host with >100 GB free.
  expect(bytes).toBeGreaterThanOrEqual(20 * 1000 * 1000 * 1000);
});

test("a tight host is told the truth, less the host reserve", () => {
  const bytes = resolveLaneStorageBytes({ profileDir: "/anything", statfs: statfsWith(20 * GiB) });
  expect(bytes).toBe(20 * GiB - HOST_FREE_SPACE_RESERVE_BYTES);
  expect(bytes).toBeLessThan(LANE_STORAGE_BYTES);
});

test("a nearly full host still leaves the lane a working floor", () => {
  const bytes = resolveLaneStorageBytes({ profileDir: "/anything", statfs: statfsWith(1024) });
  // A zero-byte budget becomes a zero-byte RLIMIT_FSIZE, which stops Chromium writing
  // its own profile. The filesystem reports ENOSPC on its own terms instead.
  expect(bytes).toBe(MIN_LANE_STORAGE_BYTES);
});

test("an unprobeable filesystem falls back to the floor, never the ceiling", () => {
  const bytes = resolveLaneStorageBytes({
    profileDir: "/anything",
    statfs: () => { throw new Error("ENOENT"); },
  });
  expect(bytes).toBe(MIN_LANE_STORAGE_BYTES);
});

test("an explicit budget below the floor still binds", () => {
  const bytes = resolveLaneStorageBytes({
    profileDir: "/anything",
    budgetBytes: 4 * 1024 * 1024,
    statfs: statfsWith(400 * GiB),
  });
  expect(bytes).toBe(4 * 1024 * 1024);
});

test("the switch value is whole mebibytes and never zero", () => {
  expect(laneStorageQuotaMib(LANE_STORAGE_BYTES)).toBe(32 * 1024);
  expect(laneStorageQuotaMib(3 * 1024 * 1024 + 700)).toBe(3);
  expect(laneStorageQuotaMib(0)).toBe(1);
});

// The two fixtures are the real figures both engines produced under the sandboxed host:
// 572 MiB from the CloakBrowser lane with the lane's switch applied, and Obscura's flat
// 5,000,000,000. The Obscura arm is proven here so the assertion holds on hosts where
// only one engine is installed.
const COMPAT_QUOTA = 572 * 1024 * 1024;
const LANE_BUDGET = 620_122_112;

test("the compatibility lane must show the lane's own whole-MiB budget", () => {
  expect(laneStorageQuotaViolation({ backend: "compatibility", quota: COMPAT_QUOTA, expectedBytes: LANE_BUDGET })).toBeNull();
});

test("the compatibility lane rejects a fingerprint-derived quota", () => {
  // 593.46 MiB — the seed-derived byte count from the profile that motivated the switch.
  const violation = laneStorageQuotaViolation({ backend: "compatibility", quota: 622_290_000, expectedBytes: LANE_BUDGET });
  expect(violation).toBe("storage quota 622290000 is not the lane's whole-MiB budget");
});

test("the compatibility lane rejects a budget it does not track", () => {
  expect(laneStorageQuotaViolation({ backend: "compatibility", quota: 8 * 1024 * 1024 * 1024, expectedBytes: LANE_BUDGET }))
    .toBe(`storage quota ${8 * 1024 * 1024 * 1024} does not track the lane budget ${LANE_BUDGET}`);
  expect(laneStorageQuotaViolation({ backend: "compatibility", quota: 64 * 1024 * 1024 * 1024, expectedBytes: LANE_BUDGET }))
    .toBe(`storage quota ${64 * 1024 * 1024 * 1024} is outside the lane's policy band`);
});

test("Obscura's flat estimate fails the compatibility assertion that caught the incident", () => {
  // The deploy-gate failure this split fixes: 5e9 is not a whole number of mebibytes.
  expect(laneStorageQuotaViolation({ backend: "compatibility", quota: OBSCURA_STORAGE_QUOTA_BYTES, expectedBytes: LANE_BUDGET }))
    .toBe("storage quota 5000000000 is not the lane's whole-MiB budget");
});

test("the Obscura arm pins the fixed constant exactly", () => {
  expect(OBSCURA_STORAGE_QUOTA_BYTES).toBe(5_000_000_000);
  expect(laneStorageQuotaViolation({ backend: "obscura", quota: OBSCURA_STORAGE_QUOTA_BYTES, expectedBytes: LANE_BUDGET })).toBeNull();
  // Not a band and not a tautology: the lane's own budget, and a figure one byte off the
  // constant, both fail — the day Obscura starts honouring a quota lever, this fires.
  expect(laneStorageQuotaViolation({ backend: "obscura", quota: LANE_BUDGET, expectedBytes: LANE_BUDGET }))
    .toBe(`storage quota ${LANE_BUDGET} is not Obscura's fixed 5000000000-byte estimate`);
  expect(laneStorageQuotaViolation({ backend: "obscura", quota: OBSCURA_STORAGE_QUOTA_BYTES - 1, expectedBytes: LANE_BUDGET }))
    .toBe("storage quota 4999999999 is not Obscura's fixed 5000000000-byte estimate");
});

test("neither backend accepts a missing quota", () => {
  for (const backend of ["obscura", "compatibility"] as const) {
    expect(laneStorageQuotaViolation({ backend, quota: 0, expectedBytes: LANE_BUDGET })).toBe("browser reported no storage quota: 0");
    expect(laneStorageQuotaViolation({ backend, quota: Number.NaN, expectedBytes: LANE_BUDGET })).toBe("browser reported no storage quota: NaN");
  }
});
