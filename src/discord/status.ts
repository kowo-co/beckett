/** Pure Discord status-dashboard renderer: snapshot in, embed out. */
import type { DiscordEmbed } from "../types.ts";
import type { CcusageSpend, CoreOperationHealth, StatusDashboardSnapshot, SubscriptionLimits } from "../status/types.ts";
import { formatDisplayDate } from "../time-display.ts";

const GREEN = 0x2ea043;
const AMBER = 0xd29922;
const RED = 0xda3633;

/** Green means the operation is reachable, has no current failures, and succeeded within two poll intervals. */
export const HEALTH_GREEN_MAX_AGE_POLL_INTERVALS = 2;
/** Yellow means the operation is still reachable, but its last successful observation is older than two poll intervals. */
export const HEALTH_YELLOW_STALE_AFTER_POLL_INTERVALS = HEALTH_GREEN_MAX_AGE_POLL_INTERVALS;
/** Red means the operation is unreachable, has never succeeded, or has failed three consecutive observations. */
export const HEALTH_RED_CONSECUTIVE_FAILURES = 3;

type HealthColor = "green" | "yellow" | "red";

/** Render a fully collected dashboard snapshot without gateway, disk, or network access. */
export function renderStatusDashboardEmbed(snapshot: StatusDashboardSnapshot): DiscordEmbed {
  const health = snapshot.health.map((operation) => ({
    operation,
    color: healthColor(operation, snapshot.pollIntervalMs),
  }));
  return {
    title: "Beckett live status",
    description: "One live dashboard · updated every 60 seconds",
    color: health.some((entry) => entry.color === "red") ? RED : health.some((entry) => entry.color === "yellow") ? AMBER : GREEN,
    fields: [
      { name: "Uptime", value: formatDuration(snapshot.uptime.currentUptimeMs), inline: true },
      { name: "Downtime", value: downtime(snapshot), inline: true },
      { name: "Versions", value: `Beckett ${snapshot.versions.beckett}\nBun ${snapshot.versions.bun}`, inline: true },
      { name: "CPU load", value: `${snapshot.system.cpuLoad.toFixed(1)}% (${snapshot.system.source})`, inline: true },
      { name: "RAM", value: usage(snapshot.system.memoryUsed, snapshot.system.memoryTotal), inline: true },
      { name: "Disk", value: usage(snapshot.system.diskUsed, snapshot.system.diskTotal), inline: true },
      { name: "Runs", value: `${snapshot.runs.live} live · ${snapshot.runs.queued} queued · ${snapshot.runs.parked} parked`, inline: true },
      { name: "Core health", value: health.map(({ operation, color }) => healthLine(operation, color)).join("\n") || "No operations observed" },
      { name: "Harness usage", value: harnessUsage(snapshot) },
      { name: "ccusage spend", value: ccusageSpend(snapshot.ccusage), inline: true },
      { name: "Subscription limits", value: subscriptionLimits(snapshot.subscriptionLimits, snapshot.collectedAt) },
    ],
    footer: { text: "Health: green current · yellow stale but reachable · red unavailable" },
    timestamp: snapshot.collectedAt,
  };
}

/** Deterministic operation classification, exported for direct threshold tests. */
export function healthColor(operation: CoreOperationHealth, pollIntervalMs: number): HealthColor {
  // Unreachable is normally red outright — EXCEPT the one honest exception: a fresh boot that
  // hasn't had time for its first tick yet is not a failure, so `startingUp` downgrades it to
  // yellow instead. Past the boot grace window the collector stops setting `startingUp`, and a
  // null tick goes back to meaning what it always meant: genuinely down.
  if (operation.reachable !== true) return operation.startingUp ? "yellow" : "red";
  const ageLimit = Math.max(1, pollIntervalMs) * HEALTH_YELLOW_STALE_AFTER_POLL_INTERVALS;
  if (operation.lastSuccessAgeMs === null || operation.consecutiveFailures >= HEALTH_RED_CONSECUTIVE_FAILURES) return "red";
  if (operation.lastSuccessAgeMs > ageLimit) return "yellow";
  return "green";
}

function healthLine(operation: CoreOperationHealth, color: HealthColor): string {
  const icon = color === "green" ? "🟢" : color === "yellow" ? "🟡" : "🔴";
  const age = operation.lastSuccessAgeMs === null
    ? (operation.startingUp ? "starting up — first tick pending" : "never succeeded")
    : `last success ${formatDuration(operation.lastSuccessAgeMs)} ago`;
  return `${icon} **${operation.name}** — ${age}${operation.detail ? ` (${operation.detail})` : ""}`;
}

function downtime(snapshot: StatusDashboardSnapshot): string {
  if (snapshot.uptime.downtimeHistory === "no-history") {
    return `No downtime recorded since ${snapshot.uptime.bootedAt ? formatDate(snapshot.uptime.bootedAt) : "this daemon started"}`;
  }
  return `${formatDuration(snapshot.uptime.totalDowntimeMs)} recorded`;
}

function harnessUsage(snapshot: StatusDashboardSnapshot): string {
  if (snapshot.harnessUsage.length === 0) return "No harness activity in the last 7d";
  return snapshot.harnessUsage.map((row) => {
    const h24 = `${row.last24h.turns} turns · ${formatTokens(row.last24h.tokensIn + row.last24h.tokensOut)}`;
    const h7 = `${row.last7d.turns} turns · ${formatTokens(row.last7d.tokensIn + row.last7d.tokensOut)}`;
    return `**${row.harness}** — 24h: ${h24}; 7d: ${h7}`;
  }).join("\n").slice(0, 1_000);
}

function ccusageSpend(ccusage: CcusageSpend): string {
  if (!ccusage.available) return "unavailable";
  const money = (n: number | null) => (n === null ? "—" : `$${n.toFixed(2)}`);
  return `Session: ${money(ccusage.sessionCostUsd)}\nToday: ${money(ccusage.dailyCostUsd)}`;
}

function subscriptionLimits(limits: SubscriptionLimits, collectedAt: string): string {
  const claude = limits.claude.available
    ? limits.claude.limits.map((limit) => limitLine(limit, collectedAt)).join("\n") || "unavailable"
    : "unavailable";
  const overage = limits.claude.overage
    ? `\nOverage credits — ${money(limits.claude.overage.used, limits.claude.overage.currency)} / ${money(limits.claude.overage.limit, limits.claude.overage.currency)}`
    : "";
  const codex = limits.codex.available
    ? `${limits.codex.limits.map((limit) => limitLine(limit, collectedAt)).join("\n") || "unavailable"}\nObserved ${formatDuration(limits.codex.observedAgeMs)} ago${limits.codex.stale ? " · **STALE**" : ""}`
    : "unavailable";
  return `**Claude Max**\n${claude}${overage}\n\n**ChatGPT / Codex**\n${codex}`.slice(0, 1_000);
}

function limitLine(limit: SubscriptionLimits["claude"]["limits"][number], collectedAt: string): string {
  const icon = limitColor(limit.severity, limit.percentUsed);
  return `${icon} ${limit.label} — ${limit.percentUsed.toFixed(0)}% used · resets ${reset(limit.resetsAt, collectedAt)}`;
}

function limitColor(severity: string | null, percent: number): string {
  const severityHint = severity?.toLowerCase();
  if (severityHint === "normal") return "🟢";
  if (severityHint === "warning") return "🟡";
  if (severityHint === "critical" || severityHint === "error") return "🔴";
  return percent >= 90 ? "🔴" : percent >= 75 ? "🟡" : "🟢";
}

function reset(value: string | null, collectedAt: string): string {
  if (!value) return "unknown";
  const ms = Date.parse(value) - Date.parse(collectedAt);
  return Number.isFinite(ms) ? `in ${formatDuration(Math.max(0, ms))}` : "unknown";
}

function money(amount: number, currency: string): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency, minimumFractionDigits: 2 }).format(amount);
}

function usage(used: number, total: number): string {
  const percent = total > 0 ? ` (${((used / total) * 100).toFixed(1)}%)` : "";
  return `${formatBytes(used)} / ${formatBytes(total)}${percent}`;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  const exponent = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** exponent).toFixed(exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M tok`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k tok`;
  return `${tokens} tok`;
}

function formatDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return "Unknown";
  const seconds = Math.max(0, Math.round(ms / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : formatDisplayDate(date);
}
