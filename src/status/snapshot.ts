/** Snapshot collector for the status dashboard. All network/disk work stays here, never in renderers. */
import { readSpendLedger, summarizeSpendWindows } from "../spend.ts";
import type { SystemMetrics } from "../system-metrics.ts";
import type { RunState } from "../run/types.ts";
import { readUptimeSnapshot } from "../uptime.ts";
import { CcusageSource } from "./ccusage.ts";
import { SubscriptionLimitsSource } from "./subscriptions.ts";
import type { CcusageSpend, CoreOperationHealth, HarnessUsage, RunBoard, StatusDashboardSnapshot, SubscriptionLimits } from "./types.ts";

/**
 * What the collector needs to see of the run engine. Deliberately the narrowest shape that answers
 * the dashboard's question — how much work is in flight, and is the supervisor still ticking — so a
 * test hands in two closures instead of standing up a RunStore and a supervisor.
 */
export interface RunEngineView {
  /** Every non-terminal run (the store's `live()`), each with its lifecycle state. */
  live(): Array<{ state: RunState }>;
  /** Epoch ms of the supervisor's last staffing reconciliation, or null before its first tick. */
  lastTickAt(): number | null;
}

export interface StatusSnapshotCollectorDeps {
  version: string;
  /** The supervisor's staffing-watchdog cadence — what gives health staleness a concrete meaning. */
  pollIntervalMs: number;
  runs: RunEngineView;
  metrics: { read(): Promise<SystemMetrics> };
  lifecycleLedgerPath: string;
  spendPath: string;
  fetch?: typeof fetch;
  now?: () => number;
  subscriptions?: Pick<SubscriptionLimitsSource, "collect">;
  ccusage?: Pick<CcusageSource, "collect">;
}

/** Long-lived collector: it retains the last observed supervisor tick between 60-second snapshots. */
export class StatusSnapshotCollector {
  private readonly now: () => number;
  private readonly fetchImpl: typeof fetch;
  private readonly subscriptions: Pick<SubscriptionLimitsSource, "collect">;
  private readonly ccusage: Pick<CcusageSource, "collect">;

  constructor(private readonly deps: StatusSnapshotCollectorDeps) {
    this.now = deps.now ?? Date.now;
    this.fetchImpl = deps.fetch ?? globalThis.fetch.bind(globalThis);
    this.subscriptions = deps.subscriptions ?? new SubscriptionLimitsSource({ fetch: this.fetchImpl, now: this.now });
    this.ccusage = deps.ccusage ?? new CcusageSource({ now: this.now });
  }

  async collect(): Promise<StatusDashboardSnapshot> {
    const now = this.now();
    const [system, subscriptionLimits, ccusage] = await Promise.all([
      this.deps.metrics.read(), this.collectSubscriptions(), this.collectCcusage(),
    ]);
    const runs = this.collectRuns();
    const lastTickAt = this.readTick();
    // ONE core-operation row now: the run supervisor IS the engine. There is no out-of-process
    // tracker to be reachable or unreachable, so the honest liveness signal is "did the staffing
    // watchdog tick recently" — the same staleness question the old poller row answered.
    const health: CoreOperationHealth[] = [
      {
        name: "Run supervisor",
        reachable: lastTickAt === null ? null : true,
        lastSuccessAt: lastTickAt,
        lastSuccessAgeMs: age(now, lastTickAt),
        consecutiveFailures: 0,
        detail: `${runs.live} live · ${runs.queued} queued · ${runs.parked} parked`,
      },
    ];
    return {
      collectedAt: new Date(now).toISOString(),
      pollIntervalMs: this.deps.pollIntervalMs,
      versions: {
        beckett: this.deps.version,
        bun: process.versions.bun ?? "unknown",
      },
      uptime: readUptimeSnapshot(this.deps.lifecycleLedgerPath, now),
      system,
      runs,
      health,
      harnessUsage: usage(this.deps.spendPath, now),
      subscriptionLimits,
      ccusage,
    };
  }

  private async collectSubscriptions(): Promise<SubscriptionLimits> {
    try { return await this.subscriptions.collect(); }
    catch { return { claude: { available: false, limits: [] }, codex: { available: false, limits: [], observedAgeMs: null, stale: false } }; }
  }

  private async collectCcusage(): Promise<CcusageSpend> {
    try { return await this.ccusage.collect(); }
    catch { return { available: false, sessionCostUsd: null, dailyCostUsd: null, observedAt: null }; }
  }

  /**
   * The run board: what is actually in flight right now. A store read failure degrades to zeroes
   * rather than failing the whole snapshot — the dashboard's other rows are still worth posting.
   */
  private collectRuns(): RunBoard {
    try {
      const live = this.deps.runs.live();
      return {
        live: live.length,
        queued: live.filter((run) => run.state === "queued").length,
        parked: live.filter((run) => run.state === "parked").length,
      };
    } catch {
      return { live: 0, queued: 0, parked: 0 };
    }
  }

  private readTick(): number | null {
    try {
      return this.deps.runs.lastTickAt();
    } catch {
      return null;
    }
  }
}

function usage(path: string, now: number): HarnessUsage[] {
  const windows = summarizeSpendWindows(readSpendLedger(path), now);
  const rows24 = new Map(windows.last24h.byHarness.map((row) => [row.name, row]));
  const rows7 = new Map(windows.last7d.byHarness.map((row) => [row.name, row]));
  return [...new Set([...rows24.keys(), ...rows7.keys()])].sort().map((harness) => ({
    harness,
    last24h: compact(rows24.get(harness)),
    last7d: compact(rows7.get(harness)),
  }));
}

function compact(row: { records: number; turns: number; tokensIn: number; tokensOut: number; costUsd: number | null } | undefined) {
  return row ?? { records: 0, turns: 0, tokensIn: 0, tokensOut: 0, costUsd: null };
}

function age(now: number, at: number | null): number | null {
  return at === null ? null : Math.max(0, now - at);
}

export function createStatusSnapshotCollector(deps: StatusSnapshotCollectorDeps): StatusSnapshotCollector {
  return new StatusSnapshotCollector(deps);
}
