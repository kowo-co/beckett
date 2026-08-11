import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { harvest } from "./harvest.ts";

const line = (value: unknown) => `${JSON.stringify(value)}\n`;

test("harvest normalizes Claude, pi, Codex, and review-bounce transitions", async () => {
  const root = await mkdtemp(join(tmpdir(), "beckett-telemetry-"));
  const claude = join(root, "claude/projects/project");
  const pi = join(root, "pi/agent/sessions/project");
  const codex = join(root, "codex/sessions/2026/01/01");
  const events = join(root, "events");
  await Promise.all([mkdir(claude, { recursive: true }), mkdir(pi, { recursive: true }), mkdir(codex, { recursive: true }), mkdir(events, { recursive: true })]);
  await writeFile(join(claude, "c.jsonl"), [
    line({ type: "user", sessionId: "claude-1", timestamp: "2026-01-01T00:00:00Z", message: { role: "user", content: "[OPS-9] do it" } }),
    line({ type: "assistant", sessionId: "claude-1", timestamp: "2026-01-01T00:01:00Z", message: { id: "one", role: "assistant", model: "claude-haiku-4-5-20251001", usage: { input_tokens: 1_000_000, output_tokens: 1_000_000, cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 1_000_000 } } }),
  ].join(""));
  await writeFile(join(pi, "p.jsonl"), [
    line({ type: "session", id: "pi-1", cwd: "/work/OPS-9", timestamp: "2026-01-01T00:00:00Z" }),
    line({ type: "model_change", modelId: "gpt-5.6-terra", timestamp: "2026-01-01T00:00:01Z" }),
    line({ type: "message", timestamp: "2026-01-01T00:00:02Z", message: { role: "assistant", usage: { input: 1_000_000, output: 1_000_000 } } }),
  ].join(""));
  await writeFile(join(codex, "rollout-codex-1.jsonl"), [
    line({ type: "session_meta", timestamp: "2026-01-01T00:00:00Z", payload: { session_id: "codex-1", cwd: "/work/OPS-9" } }),
    line({ type: "turn_context", timestamp: "2026-01-01T00:00:01Z", payload: { model: "gpt-5.6-luna" } }),
    line({ type: "event_msg", timestamp: "2026-01-01T00:00:03Z", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 1_000_000, cached_input_tokens: 200_000, output_tokens: 1_000_000 } } } }),
  ].join(""));
  // One legacy-keyed row and one current-keyed row: both count, so an append-only ledger that
  // spans the ticket rip-out still yields the same review-cycle number.
  await writeFile(join(events, "dispatch.jsonl"), [
    line({ ticketRef: "OPS-9", stage: "review:verdict", outcome: "bounced" }),
    line({ runRef: "OPS-9", stage: "review:verdict", outcome: "bounced" }),
    line({ runRef: "OPS-9", stage: "review:verdict", outcome: "passed" }),
  ].join(""));

  const output = join(root, "runs.json");
  const notes: string[] = [];
  const dataset = await harvest({
    output, rates: join(process.cwd(), "config/model-rates.json"), claudeDir: join(root, "claude/projects"),
    piDir: join(root, "pi"), codexDir: join(root, "codex"), runEventsPath: join(events, "dispatch.jsonl"), note: (message) => notes.push(message),
  });
  expect(dataset.runs).toHaveLength(3);
  expect(dataset.runs.map((run) => run.harness).sort()).toEqual(["claude-code", "codex", "pi"]);
  expect(dataset.runs.every((run) => run.review_cycles === 2 && run.cost_usd > 0 && run.task_id === "OPS-9")).toBe(true);
  const claudeRun = dataset.runs.find((run) => run.harness === "claude-code");
  expect(claudeRun?.model).toBe("claude-haiku-4-5-20251001");
  expect(claudeRun?.tokens.cache_read).toBe(1_000_000);
  expect(claudeRun?.tokens.cache_write).toBe(1_000_000);
  expect(claudeRun?.cost_usd).toBe(7.35);
  expect(JSON.parse(await readFile(output, "utf8")).runs).toHaveLength(3);
  expect(notes.at(-1)).toContain("wrote 3 normalized runs");
});

test("Claude child runs use the child id rather than their shared parent session id", async () => {
  const root = await mkdtemp(join(tmpdir(), "beckett-telemetry-child-"));
  const claude = join(root, "claude/projects/project/subagents");
  await mkdir(claude, { recursive: true });
  await writeFile(join(claude, "child.jsonl"), [
    line({ type: "user", sessionId: "parent-1", agentId: "agent-1", timestamp: "2026-01-01T00:00:00Z", message: { role: "user", content: "[OPS-9] do it" } }),
    line({ type: "assistant", sessionId: "parent-1", agentId: "agent-1", timestamp: "2026-01-01T00:00:02Z", message: { id: "one", role: "assistant", model: "claude-haiku-4-5", usage: { input_tokens: 1 } } }),
  ].join(""));
  const dataset = await harvest({
    output: join(root, "runs.json"), rates: join(process.cwd(), "config/model-rates.json"), claudeDir: join(root, "claude/projects"),
    piDir: join(root, "none"), codexDir: join(root, "none"), runEventsPath: join(root, "none/dispatch.jsonl"), note: () => {},
  });
  expect(dataset.runs[0]?.session_id).toBe("agent-1");
  expect(dataset.runs[0]?.run_id).toBe("claude-code:agent-1");
});

test("harvest completes with absent session sources", async () => {
  const root = await mkdtemp(join(tmpdir(), "beckett-telemetry-empty-"));
  const notes: string[] = [];
  const dataset = await harvest({
    output: join(root, "runs.json"), rates: join(process.cwd(), "config/model-rates.json"), claudeDir: join(root, "none"),
    piDir: join(root, "none"), codexDir: join(root, "none"), runEventsPath: join(root, "none/dispatch.jsonl"), note: (message) => notes.push(message),
  });
  expect(dataset.runs).toEqual([]);
  expect(notes.some((message) => message.includes("source absent/unreadable"))).toBe(true);
});
