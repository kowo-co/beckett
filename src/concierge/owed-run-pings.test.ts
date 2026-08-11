/**
 * Issue #233 — run-completion pings get a durable owed-notification record, mirroring the
 * owed-mention ledger's shape but wrapped around `Concierge.notify`'s outbound path instead of
 * `onMessage`'s inbound one.
 *
 * Two layers, same split as `notify.test.ts` / `mention-replay.test.ts`:
 *   A. In-process (no disk): the exact confirmed-delivery contract — a debt opens BEFORE any
 *      post, stays owed through an attempt that never actually posts, and settles ONLY on a
 *      confirmed post (`recordBeckettPost`), never merely because the attempt completed.
 *   B. Across a restart (disk-backed): the boot scan replays what it inherited, and its dedupe
 *      is deliberately biased the OPPOSITE way from the mention ledger's — replay unless there
 *      is positive evidence Beckett already spoke in the channel.
 */

import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Concierge, type ConciergeSession } from "./index.ts";
import { validateConfig } from "../config.ts";
import { OWED_RUN_NOTIFICATION_MAX_REPLAYS, type OwedRunNotification } from "./owed-run-notifications.ts";
import type { Config } from "../types.ts";
import type { Run, RunStateChange } from "../run/types.ts";
import type { DiscordGateway } from "../discord/gateway.ts";

const CHAN = "1097283746520174592";

// ── shared fixtures ──────────────────────────────────────────────────────────────────────────

function run(overrides: Partial<Run> = {}): Run {
  return {
    id: "run-20260810-healthz",
    slug: "healthz",
    title: "Add healthz",
    prompt: "Add a /healthz endpoint.",
    channelId: CHAN,
    requesterId: "333333333333333333",
    taskRef: null,
    ultracode: false,
    cast: null,
    repo: null,
    state: "implementing",
    createdAt: "2026-08-10T00:00:00.000Z",
    updatedAt: "2026-08-10T00:00:00.000Z",
    workspace: null,
    branch: "beckett/run-healthz",
    baseSha: null,
    sessionIds: {},
    sessionName: "beckett-run-healthz",
    reviewCycles: 0,
    prUrl: null,
    error: null,
    published: null,
    ...overrides,
  };
}

function change(to: Run["state"], overrides: Partial<Run> = {}, from: Run["state"] | null = "implementing"): RunStateChange {
  return { kind: "state_changed", run: run({ state: to, ...overrides }), from, to };
}

interface OwedRunsHandle {
  list(): OwedRunNotification[];
  has(runId: string): boolean;
}

function owedRuns(concierge: Concierge): OwedRunsHandle {
  return (concierge as unknown as { owedRuns: OwedRunsHandle }).owedRuns;
}

function recordPost(concierge: Concierge, channelId: string, text: string, messageId: string | null): void {
  (concierge as unknown as { recordBeckettPost(c: string, t: string, m: string | null): void }).recordBeckettPost(
    channelId,
    text,
    messageId,
  );
}

const tick = () => new Promise((r) => setTimeout(r, 0));

// ── A. in-process: the confirmed-delivery contract ──────────────────────────────────────────

const config = { concierge: { model: "m", rotate_at_tokens: 190_000 }, paths: {} } as unknown as Config;

/**
 * `onAsk`, when given, runs SYNCHRONOUSLY as part of `ask()` — before the turn's promise
 * resolves. That is the real shape a confirmed post takes in production: the model's
 * `beckett discord reply` Bash-tool call happens WHILE the `claude` child's turn is still in
 * flight, strictly before `pool.ask(SYSTEM_SCOPE, …)` resolves. A fake session that instead
 * called `recordBeckettPost` AFTER resolving would race `askUpdate`'s own `finally` cleanup and
 * prove nothing about the real ordering.
 */
function harness(onAsk?: (concierge: Concierge, text: string) => void) {
  const asks: string[] = [];
  let concierge!: Concierge;
  const session = {
    ask: (m: string) => {
      const text = String(m);
      asks.push(text);
      onAsk?.(concierge, text);
      return Promise.resolve(""); // concierge "replies" via the CLI, so the return is unused
    },
  } as unknown as ConciergeSession;
  const gateway = {} as never; // notify never touches the gateway directly
  concierge = new Concierge({ config, session, gateway });
  return { concierge, asks };
}

test("a run reaching done opens a debt BEFORE the delivery attempt runs, and it's the same run", async () => {
  const { concierge, asks } = harness();
  concierge.notify(change("done", {}, "publishing"));
  await tick();
  expect(asks.length).toBe(1); // the queued system turn ran
  const owed = owedRuns(concierge).list();
  expect(owed).toHaveLength(1);
  expect(owed[0]!.runId).toBe("run-20260810-healthz");
  expect(owed[0]!.state).toBe("done");
  expect(owed[0]!.channelId).toBe(CHAN);
  expect(owed[0]!.requesterIds).toEqual(["333333333333333333"]);
});

test("an attempt that never produces a confirmed post leaves the debt owed — not paid by trying", async () => {
  const { concierge } = harness();
  concierge.notify(change("failed", { error: "worker exited" }));
  await tick();
  // The fake session's turn "ran" (askUpdate resolved) but nothing ever called
  // recordBeckettPost — exactly what a model that judged silence, or a dead turn, looks like.
  expect(owedRuns(concierge).list()).toHaveLength(1);
});

test("settles ONLY once a post is CONFIRMED via recordBeckettPost, during the delivery attempt", async () => {
  const { concierge } = harness((c) => recordPost(c, CHAN, "shipped it — PR's up", "mid-1"));
  concierge.notify(change("done", {}, "publishing"));
  await tick();

  expect(owedRuns(concierge).list()).toEqual([]);
});

test("a post in an UNRELATED channel does not falsely settle a pending run notification", async () => {
  const { concierge } = harness((c) => recordPost(c, "some-other-channel", "unrelated chatter", "mid-9"));
  concierge.notify(change("done", {}, "publishing"));
  await tick();

  expect(owedRuns(concierge).list()).toHaveLength(1); // still owed — wrong channel confirms nothing
});

test("done, failed, and parked each open a debt; cancelled and mid-flight churn never do", async () => {
  const { concierge } = harness();
  concierge.notify(change("done", { id: "run-done" }, "publishing"));
  concierge.notify(change("failed", { id: "run-failed" }));
  concierge.notify(change("parked", { id: "run-parked", error: "rework cap" }));
  concierge.notify(change("cancelled", { id: "run-cancelled" }));
  concierge.notify(change("reviewing", { id: "run-reviewing" }, null)); // boot restart re-staff ping
  await tick();

  const owed = owedRuns(concierge);
  expect(owed.has("run-done")).toBe(true);
  expect(owed.has("run-failed")).toBe(true);
  expect(owed.has("run-parked")).toBe(true);
  expect(owed.has("run-cancelled")).toBe(false);
  expect(owed.has("run-reviewing")).toBe(false);
});

test("a re-delivered done event (ambiguous-ack re-fire) never launders the debt's age", async () => {
  const { concierge } = harness();
  concierge.notify(change("done", {}, "publishing"));
  await tick();
  const [first] = owedRuns(concierge).list();
  const createdAt = first!.createdAt;

  // The dedupe window suppresses an IMMEDIATE re-delivery at the notify() layer, so drive claim's
  // own idempotency directly — the property under test either way is "claim never resets an open
  // debt's clock", which is what protects against the observed 4x re-fire loop.
  (concierge as unknown as { owedRuns: { claim(e: unknown): void } }).owedRuns.claim({
    runId: "run-20260810-healthz",
    state: "done",
    channelId: CHAN,
    requesterIds: ["333333333333333333"],
  });

  const [again] = owedRuns(concierge).list();
  expect(again!.createdAt).toBe(createdAt);
  expect(owedRuns(concierge).list()).toHaveLength(1);
});

// ── B. across a restart: boot-scan replay + dedupe ──────────────────────────────────────────

const savedDir = process.env.BECKETT_DIR;
const savedOwner = process.env.DISCORD_OWNER_ID;
const savedStartup = process.env.BECKETT_STARTUP_CHANNEL_ID;
const tmpDirs: string[] = [];
afterEach(() => {
  if (savedDir === undefined) delete process.env.BECKETT_DIR;
  else process.env.BECKETT_DIR = savedDir;
  if (savedOwner === undefined) delete process.env.DISCORD_OWNER_ID;
  else process.env.DISCORD_OWNER_ID = savedOwner;
  if (savedStartup === undefined) delete process.env.BECKETT_STARTUP_CHANNEL_ID;
  else process.env.BECKETT_STARTUP_CHANNEL_ID = savedStartup;
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const quietLog = (() => {
  const q = { info() {}, warn() {}, debug() {}, error() {}, child() { return q; } };
  return q as never;
})();

function tempBeckettDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "beckett-owed-run-boot-"));
  tmpDirs.push(dir);
  process.env.BECKETT_DIR = dir;
  process.env.DISCORD_OWNER_ID = "333333333333333333";
  process.env.BECKETT_STARTUP_CHANNEL_ID = "disabled";
  return dir;
}

function ledgerFile(dir: string): string {
  return join(dir, "concierge-owed-run-notifications.json");
}

function ledger(dir: string): OwedRunNotification[] {
  const file = ledgerFile(dir);
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as OwedRunNotification[]) : [];
}

/** Open debts only — `settle` stamps `settledAt` rather than deleting (see the store's header). */
function openDebts(dir: string): OwedRunNotification[] {
  return ledger(dir).filter((e) => e.settledAt === null);
}

function writeOwedRunLedger(dir: string, entries: Partial<OwedRunNotification>[]): void {
  writeFileSync(
    ledgerFile(dir),
    JSON.stringify(
      entries.map((e) => ({
        runId: "run-1",
        state: "done",
        channelId: CHAN,
        requesterIds: [],
        createdAt: Date.now(),
        replays: 0,
        phase: "queued",
        settledAt: null,
        ...e,
      })),
    ),
  );
}

interface BootHarness {
  concierge: Concierge;
  asks: string[];
  dir: string;
}

/** A real (validated) config brings up the durable shared-context store, needed for the dedupe check. */
function bootHarness(dir: string, opts: { confirmPostsOnAsk?: boolean } = {}): BootHarness {
  const asks: string[] = [];
  const gateway = {
    onMessage() {},
    async start() {},
    async stop() {},
    sendTyping() {},
    async post() {
      return "mid-x";
    },
  } as unknown as DiscordGateway;

  let concierge!: Concierge;
  const session = {
    async start() {},
    async stop() {},
    queueDepth: () => 0,
    getCurrentMeta: () => null,
    ask(message: unknown) {
      const text = String(message);
      asks.push(text);
      // Stands in for "the model ran `beckett discord reply` and it landed" — the one thing a
      // fake session can't actually do by calling the control bus, so it's simulated directly at
      // the confirmed-delivery signal `recordBeckettPost` already exists to record.
      if (opts.confirmPostsOnAsk && text.includes("run-completion")) {
        (concierge as unknown as { recordBeckettPost(c: string, t: string, m: string | null): void }).recordBeckettPost(
          CHAN,
          "told them",
          "mid-boot",
        );
      }
      return Promise.resolve({ decision: "pass", message: null });
    },
  } as unknown as ConciergeSession;

  concierge = new Concierge({ config: validateConfig({}), gateway, session, logger: quietLog });
  return { concierge, asks, dir };
}

test("a delivering-phase run notification with no channel history replays at boot and settles once confirmed", async () => {
  const dir = tempBeckettDir();
  writeOwedRunLedger(dir, [{ runId: "run-1", state: "done", phase: "delivering", createdAt: Date.now() - 60_000 }]);

  const boot = bootHarness(dir, { confirmPostsOnAsk: true });
  await boot.concierge.start();
  await (boot.concierge as unknown as { replayRunNotificationsDone: Promise<void> }).replayRunNotificationsDone;
  try {
    expect(boot.asks.some((a) => a.includes("run-1"))).toBe(true);
    expect(openDebts(dir)).toEqual([]);
  } finally {
    await boot.concierge.stop();
  }
});

test("a delivering-phase entry ALREADY announced (Beckett spoke since createdAt) settles WITHOUT replaying", async () => {
  const dir = tempBeckettDir();
  const seed = bootHarness(dir);
  await seed.concierge.start();
  await (seed.concierge as unknown as { replayRunNotificationsDone: Promise<void> }).replayRunNotificationsDone;
  // A confirmed Beckett post lands in the channel (e.g. the live ping actually worked, but the
  // process died before it could stamp the ledger settled).
  (seed.concierge as unknown as { recordBeckettPost(c: string, t: string, m: string | null): void }).recordBeckettPost(
    CHAN,
    "already told you it shipped",
    "mid-already",
  );
  await seed.concierge.stop();

  // The ledger entry is written AFTER the post above, with an earlier createdAt — exactly the
  // "posted, then the process died before settling" shape.
  writeOwedRunLedger(dir, [{ runId: "run-1", state: "done", phase: "delivering", createdAt: Date.now() - 60_000 }]);

  const boot = bootHarness(dir);
  await boot.concierge.start();
  await (boot.concierge as unknown as { replayRunNotificationsDone: Promise<void> }).replayRunNotificationsDone;
  try {
    expect(boot.asks.some((a) => a.includes("run-1"))).toBe(false); // no replay — already announced
    expect(openDebts(dir)).toEqual([]); // and the debt is struck off
  } finally {
    await boot.concierge.stop();
  }
});

test("a delivering-phase entry with NO evidence either way replays — the opposite bias from owed-mentions", async () => {
  const dir = tempBeckettDir();
  // No prior channel activity at all: with nothing to check, this ledger replays rather than
  // staying silent (see owed-run-notifications.ts's header on why the bias is inverted here).
  writeOwedRunLedger(dir, [{ runId: "run-1", state: "done", phase: "delivering", createdAt: Date.now() - 60_000 }]);

  const boot = bootHarness(dir);
  await boot.concierge.start();
  await (boot.concierge as unknown as { replayRunNotificationsDone: Promise<void> }).replayRunNotificationsDone;
  try {
    expect(boot.asks.some((a) => a.includes("run-1"))).toBe(true);
  } finally {
    await boot.concierge.stop();
  }
});

test("a queued-phase entry replays blind, regardless of channel history", async () => {
  const dir = tempBeckettDir();
  const seed = bootHarness(dir);
  await seed.concierge.start();
  await (seed.concierge as unknown as { replayRunNotificationsDone: Promise<void> }).replayRunNotificationsDone;
  (seed.concierge as unknown as { recordBeckettPost(c: string, t: string, m: string | null): void }).recordBeckettPost(
    CHAN,
    "unrelated later post",
    "mid-unrelated",
  );
  await seed.concierge.stop();

  // `queued` means no delivery attempt was ever even STARTED — nothing was said, so there is
  // nothing to check for, and the mention ledger's own rule applies: safe to replay blind.
  writeOwedRunLedger(dir, [{ runId: "run-1", state: "done", phase: "queued", createdAt: Date.now() - 60_000 }]);

  const boot = bootHarness(dir);
  await boot.concierge.start();
  await (boot.concierge as unknown as { replayRunNotificationsDone: Promise<void> }).replayRunNotificationsDone;
  try {
    expect(boot.asks.some((a) => a.includes("run-1"))).toBe(true);
  } finally {
    await boot.concierge.stop();
  }
});

test("a run notification that has already exhausted its replay budget gives up quietly instead of asking again", async () => {
  const dir = tempBeckettDir();
  writeOwedRunLedger(dir, [
    { runId: "run-1", state: "done", phase: "delivering", createdAt: Date.now() - 60_000, replays: OWED_RUN_NOTIFICATION_MAX_REPLAYS },
  ]);

  const boot = bootHarness(dir);
  await boot.concierge.start();
  await (boot.concierge as unknown as { replayRunNotificationsDone: Promise<void> }).replayRunNotificationsDone;
  try {
    expect(boot.asks.some((a) => a.includes("run-1"))).toBe(false); // budget spent — no further attempt
    expect(openDebts(dir)).toEqual([]); // but the debt is still struck off, not left to loop forever
  } finally {
    await boot.concierge.stop();
  }
});
