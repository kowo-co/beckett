import { expect, test } from "bun:test";
import { healthColor, renderStatusDashboardEmbed } from "./status.ts";
import type { StatusDashboardSnapshot } from "../status/types.ts";

export const fixtureSnapshot: StatusDashboardSnapshot = {
  collectedAt: "2026-07-26T12:00:00.000Z",
  pollIntervalMs: 5_000,
  versions: { beckett: "6.5.2", bun: "1.3.14" },
  uptime: {
    currentUptimeMs: 3_661_000,
    bootedAt: "2026-07-26T10:58:59.000Z",
    downtimeHistory: "no-history",
    downtimeMessage: "no downtime history recorded yet",
    downtimeWindows: [],
    totalDowntimeMs: null,
    uncleanRestarts: 0,
  },
  system: {
    source: "netdata",
    collectedAt: "2026-07-26T12:00:00.000Z",
    cpu: { loadPercent: 14.2 },
    memory: { usedBytes: 2 * 1024 ** 3, totalBytes: 8 * 1024 ** 3 },
    disk: { usedBytes: 50 * 1024 ** 3, totalBytes: 100 * 1024 ** 3 },
    cpuLoad: 14.2,
    memoryUsed: 2 * 1024 ** 3,
    memoryTotal: 8 * 1024 ** 3,
    diskUsed: 50 * 1024 ** 3,
    diskTotal: 100 * 1024 ** 3,
  },
  runs: { live: 2, queued: 1, parked: 0 },
  health: [
    { name: "Run supervisor", reachable: true, lastSuccessAt: 1, lastSuccessAgeMs: 1_000, consecutiveFailures: 0, detail: "2 live · 1 queued · 0 parked" },
  ],
  harnessUsage: [
    { harness: "claude", last24h: { records: 2, turns: 3, tokensIn: 1200, tokensOut: 300, costUsd: 0.02 }, last7d: { records: 4, turns: 8, tokensIn: 3000, tokensOut: 1000, costUsd: 0.05 } },
  ],
  subscriptionLimits: {
    claude: { available: true, limits: [{ label: "5h session", percentUsed: 14, resetsAt: "2026-07-26T13:00:00Z", severity: "normal" }], overage: { used: 0, limit: 20, currency: "USD" } },
    codex: { available: true, limits: [{ label: "5h", percentUsed: 34, resetsAt: "2026-07-26T14:00:00Z", severity: null }], observedAgeMs: 31 * 60_000, stale: true },
  },
  ccusage: { available: true, sessionCostUsd: 2.5, dailyCostUsd: 6.75, observedAt: "2026-07-26T12:00:00.000Z" },
};

test("pure status renderer exposes every dashboard panel from a fixture snapshot", () => {
  const embed = renderStatusDashboardEmbed(fixtureSnapshot);
  expect(embed.title).toBe("Beckett live status");
  expect(embed.fields?.map((field) => field.name)).toEqual([
    "Uptime", "Downtime", "Versions", "CPU load", "RAM", "Disk", "Runs", "Core health", "Harness usage", "ccusage spend", "Subscription limits",
  ]);
  expect(embed.fields?.[1]?.value).toContain("No downtime recorded since 2026-07-26");
  expect(embed.fields?.[6]?.value).toBe("2 live · 1 queued · 0 parked");
  expect(embed.fields?.[7]?.value).toContain("Run supervisor");
  expect(embed.fields?.[8]?.value).toContain("24h:");
  expect(embed.fields?.[8]?.value).toContain("7d:");
  expect(embed.fields?.[9]?.value).toContain("Session: $2.50");
  expect(embed.fields?.[9]?.value).toContain("Today: $6.75");
  expect(embed.fields?.[10]?.value).toContain("Claude Max");
  expect(embed.fields?.[10]?.value).toContain("STALE");
});

test("unavailable ccusage spend renders plainly instead of blank or throwing", () => {
  const embed = renderStatusDashboardEmbed({ ...fixtureSnapshot, ccusage: { available: false, sessionCostUsd: null, dailyCostUsd: null, observedAt: null } });
  expect(embed.fields?.[9]).toEqual({ name: "ccusage spend", value: "unavailable", inline: true });
});

test("health yellow has the concrete stale-but-reachable meaning", () => {
  const current = fixtureSnapshot.health[0]!;
  expect(healthColor(current, fixtureSnapshot.pollIntervalMs)).toBe("green");
  expect(healthColor({ ...current, lastSuccessAgeMs: 10_001 }, fixtureSnapshot.pollIntervalMs)).toBe("yellow");
  expect(healthColor({ ...current, reachable: false }, fixtureSnapshot.pollIntervalMs)).toBe("red");
  expect(healthColor({ ...current, consecutiveFailures: 3 }, fixtureSnapshot.pollIntervalMs)).toBe("red");
});

test("a fresh boot with no tick yet renders starting-up yellow, not down red", () => {
  const startingUp = {
    name: "Run supervisor", reachable: null, lastSuccessAt: null, lastSuccessAgeMs: null,
    consecutiveFailures: 0, detail: "starting up — first watchdog tick pending", startingUp: true,
  };
  expect(healthColor(startingUp, fixtureSnapshot.pollIntervalMs)).toBe("yellow");
  const line = renderStatusDashboardEmbed({ ...fixtureSnapshot, health: [startingUp] }).fields?.[7]?.value;
  expect(line).toContain("🟡");
  expect(line).toContain("starting up — first tick pending");
});

test("a null tick past the boot grace window is genuinely down, not starting up", () => {
  const neverTicked = {
    name: "Run supervisor", reachable: null, lastSuccessAt: null, lastSuccessAgeMs: null,
    consecutiveFailures: 0, startingUp: false,
  };
  expect(healthColor(neverTicked, fixtureSnapshot.pollIntervalMs)).toBe("red");
  const line = renderStatusDashboardEmbed({ ...fixtureSnapshot, health: [neverTicked] }).fields?.[7]?.value;
  expect(line).toContain("🔴");
  expect(line).toContain("never succeeded");
});
