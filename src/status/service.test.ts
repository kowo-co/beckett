import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DiscordTransientMessageEditError, DiscordUnknownMessageError } from "../discord/gateway.ts";
import { createStatusDashboardService, statusDashboardMessagePath } from "./service.ts";
import type { StatusDashboardSnapshot } from "./types.ts";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function snapshot(): StatusDashboardSnapshot {
  return {
    collectedAt: "2026-07-26T12:00:00.000Z", pollIntervalMs: 5_000,
    versions: { beckett: "6.5.2", bun: "1.3.14" },
    uptime: { currentUptimeMs: 1_000, bootedAt: "2026-07-26T12:00:00.000Z", downtimeHistory: "no-history", downtimeMessage: "no downtime history recorded yet", downtimeWindows: [], totalDowntimeMs: null, uncleanRestarts: 0 },
    system: { source: "proc", collectedAt: "2026-07-26T12:00:00.000Z", cpu: { loadPercent: 1 }, memory: { usedBytes: 1, totalBytes: 2 }, disk: { usedBytes: 1, totalBytes: 2 }, cpuLoad: 1, memoryUsed: 1, memoryTotal: 2, diskUsed: 1, diskTotal: 2 },
    runs: { live: 0, queued: 0, parked: 0 },
    health: [{ name: "Run supervisor", reachable: true, lastSuccessAt: 1, lastSuccessAgeMs: 0, consecutiveFailures: 0 }],
    harnessUsage: [],
    subscriptionLimits: { claude: { available: false, limits: [] }, codex: { available: false, limits: [], observedAgeMs: null, stale: false } },
    ccusage: { available: false, sessionCostUsd: null, dailyCostUsd: null, observedAt: null },
  };
}

class FakeGateway {
  posts: string[] = [];
  edits: string[] = [];
  nextEditError: Error | null = null;

  async post(_channelId: string): Promise<string> {
    const id = `message-${this.posts.length + 1}`;
    this.posts.push(id);
    return id;
  }

  async editMessage(channelId: string, messageId: string): Promise<void> {
    if (this.nextEditError) {
      const error = this.nextEditError;
      this.nextEditError = null;
      throw error;
    }
    this.edits.push(`${channelId}:${messageId}`);
  }
}

function service(gateway: FakeGateway, statePath: string) {
  return createStatusDashboardService({
    gateway,
    channelId: "1525690195234521179",
    statePath,
    collectSnapshot: async () => snapshot(),
    intervalMs: 60_000,
    logger: { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } },
  });
}

test("status dashboard integration: post, edit, resume, replace deleted, and survive one failed cycle", async () => {
  const dir = mkdtempSync(join(tmpdir(), "beckett-status-dashboard-"));
  dirs.push(dir);
  const statePath = statusDashboardMessagePath(dir);
  const gateway = new FakeGateway();

  // First render posts exactly one message; its normal next cycle edits it in place.
  const first = service(gateway, statePath);
  await first.start();
  await first.runCycle();
  first.stop();
  expect(gateway.posts).toEqual(["message-1"]);
  expect(gateway.edits).toEqual(["1525690195234521179:message-1"]);

  // A restarted service reads the persisted id and resumes editing, never reposting.
  const restarted = service(gateway, statePath);
  await restarted.start();
  restarted.stop();
  expect(gateway.posts).toEqual(["message-1"]);
  expect(gateway.edits.at(-1)).toBe("1525690195234521179:message-1");

  // Typed Unknown Message causes one fresh post and atomically updates durable state.
  gateway.nextEditError = new DiscordUnknownMessageError("1525690195234521179", "message-1");
  await restarted.runCycle();
  expect(gateway.posts).toEqual(["message-1", "message-2"]);
  expect(JSON.parse(readFileSync(statePath, "utf8"))).toEqual({ messageId: "message-2" });

  // A transient failure skips only this cycle; the following cycle still edits the replacement.
  gateway.nextEditError = new DiscordTransientMessageEditError(
    "1525690195234521179", "message-2", "temporary gateway blip",
  );
  await restarted.runCycle();
  expect(gateway.posts).toHaveLength(2);
  const editsBeforeRecovery = gateway.edits.length;
  await restarted.runCycle();
  expect(gateway.edits).toHaveLength(editsBeforeRecovery + 1);
  expect(gateway.edits.at(-1)).toBe("1525690195234521179:message-2");
});
