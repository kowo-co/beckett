/** Best-effort live spend source backed by `npx ccusage`, the local Claude Code usage/cost CLI. */
import type { CcusageSpend } from "./types.ts";

/** The dashboard ticks every minute; ccusage shells out to npx and rereads local transcripts, so
 * five minutes keeps that off the hot path the same way the Anthropic usage cache does. */
export const CCUSAGE_CACHE_TTL_MS = 5 * 60_000;
/** A wedged npx/network resolve must not stall the dashboard cycle. */
const CCUSAGE_TIMEOUT_MS = 20_000;

type Exec = (argv: string[]) => Promise<{ code: number; stdout: string }>;

export interface CcusageSourceDeps {
  now?: () => number;
  exec?: Exec;
}

/** Runs `npx ccusage` for the active session block and the latest day; never throws. */
export class CcusageSource {
  private readonly now: () => number;
  private readonly exec: Exec;
  private cache: { expiresAt: number; value: CcusageSpend } | null = null;

  constructor(deps: CcusageSourceDeps = {}) {
    this.now = deps.now ?? Date.now;
    this.exec = deps.exec ?? realExec;
  }

  async collect(): Promise<CcusageSpend> {
    const now = this.now();
    if (this.cache && now < this.cache.expiresAt) return this.cache.value;
    const value = await this.fetch();
    this.cache = { expiresAt: now + CCUSAGE_CACHE_TTL_MS, value };
    return value;
  }

  private async fetch(): Promise<CcusageSpend> {
    const [session, daily] = await Promise.all([
      this.run(["blocks", "--active", "--json"]),
      this.run(["daily", "--json", "--last", "1"]),
    ]);
    const sessionCostUsd = activeBlockCost(session);
    const dailyCostUsd = latestDailyCost(daily);
    const available = sessionCostUsd !== null || dailyCostUsd !== null;
    return { available, sessionCostUsd, dailyCostUsd, observedAt: available ? new Date(this.now()).toISOString() : null };
  }

  private async run(args: string[]): Promise<unknown> {
    try {
      const { code, stdout } = await this.exec(["npx", "--yes", "ccusage", ...args]);
      if (code !== 0) return null;
      return JSON.parse(stdout);
    } catch {
      return null;
    }
  }
}

async function realExec(argv: string[]): Promise<{ code: number; stdout: string }> {
  const proc = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const timeout = setTimeout(() => proc.kill("SIGKILL"), CCUSAGE_TIMEOUT_MS);
  try {
    const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return { code, stdout };
  } finally {
    clearTimeout(timeout);
  }
}

function activeBlockCost(value: unknown): number | null {
  const blocks = record(value)?.blocks;
  if (!Array.isArray(blocks)) return null;
  const active = blocks.map(record).find((block) => block?.isActive === true);
  return number(active?.costUSD);
}

function latestDailyCost(value: unknown): number | null {
  const days = record(value)?.daily;
  if (!Array.isArray(days) || days.length === 0) return null;
  return number(record(days.at(-1))?.totalCost);
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
