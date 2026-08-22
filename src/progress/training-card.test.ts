import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DiscordCard } from "../types.ts";
import { DiscordUnknownMessageError, type DiscordGateway } from "../discord/gateway.ts";
import type { FileTailProgressSnapshot, FileTailProgressSourceConfig } from "./training-source.ts";
import { createTrainingProgressCardService, renderTrainingHeaderText, trainingProgressCardsPath } from "./training-card.ts";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "beckett-training-card-"));
  dirs.push(dir);
  return dir;
}

// ── header text ────────────────────────────────────────────────────────────────────────────────

test("header text plainly says stopped when the unit is not active, with no live fields", () => {
  const snapshot: FileTailProgressSnapshot = { label: "throttled CPU pretrain", active: false, stats: null, consoleLines: [] };
  const text = renderTrainingHeaderText(snapshot, 1_000_000);
  expect(text).toContain("stopped");
  expect(text).toContain("throttled CPU pretrain");
  expect(text).not.toContain("tok/s");
  expect(text).not.toContain("ETA");
});

test("header text carries the last observed step when stopped, but never as if it were live", () => {
  const snapshot: FileTailProgressSnapshot = {
    label: "throttled CPU pretrain", active: false,
    stats: {
      latest: { step: 950, loss: 2.4, tokensSeen: 2_700_000, docsConsumed: 1, elapsedS: 1, tokensPerS: 300, wallClock: "x", threads: 1, batchSize: 1, blockSize: 1 },
      recentAvgLoss: 2.4, firstAvgLoss: 6.0, tokensPct: 1.1, progressBar: "[--]", etaMs: 1000,
    },
    consoleLines: [],
  };
  const text = renderTrainingHeaderText(snapshot, 239_000_000);
  expect(text).toContain("stopped");
  expect(text).toContain("step 950");
  expect(text).not.toContain("tok/s");
});

test("header text says 'no step data yet' when active but the jsonl has nothing parseable", () => {
  const snapshot: FileTailProgressSnapshot = { label: "throttled CPU pretrain", active: true, stats: null, consoleLines: [] };
  expect(renderTrainingHeaderText(snapshot, 1_000_000)).toContain("no step data yet");
});

test("header text shows step, loss trend, token progress, rate, and ETA when active with data", () => {
  const snapshot: FileTailProgressSnapshot = {
    label: "throttled CPU pretrain", active: true,
    stats: {
      latest: { step: 984, loss: 2.3528, tokensSeen: 2_792_189, docsConsumed: 1, elapsedS: 8854.17, tokensPerS: 313.61, wallClock: "x", threads: 1, batchSize: 1, blockSize: 1 },
      recentAvgLoss: 2.2, firstAvgLoss: 6.9, tokensPct: 1.168, progressBar: "[#-------------------]", etaMs: 7_538_000_000,
    },
    consoleLines: [],
  };
  const text = renderTrainingHeaderText(snapshot, 239_000_000);
  expect(text).toContain("step 984");
  expect(text).toContain("loss 2.3528");
  expect(text).toContain("2.2");
  expect(text).toContain("6.9");
  expect(text).toContain("↓"); // recent avg below first-window avg: loss is going down
  expect(text).toContain("1.2%");
  expect(text).toContain("313.6 tok/s");
  expect(text).toContain("ETA");
});

// ── the posting service ───────────────────────────────────────────────────────────────────────

function fakeGateway() {
  const posts: { channelId: string; card?: DiscordCard }[] = [];
  const edits: { channelId: string; messageId: string; card?: DiscordCard }[] = [];
  let editFails: Error | null = null;
  let n = 0;
  const gateway = {
    async post(channelId: string, _content: string, opts?: { card?: DiscordCard }) {
      posts.push({ channelId, card: opts?.card });
      return `msg-${++n}`;
    },
    async editMessage(channelId: string, messageId: string, payload: { card?: DiscordCard }) {
      if (editFails) throw editFails;
      edits.push({ channelId, messageId, card: payload.card });
    },
  } as unknown as Pick<DiscordGateway, "post" | "editMessage">;
  return { gateway, posts, edits, failEdits: (e: Error | null) => (editFails = e) };
}

function sourceConfig(dir: string): FileTailProgressSourceConfig {
  return {
    label: "throttled CPU pretrain",
    unit: "test-babble.service",
    jsonlPath: join(dir, "loss.jsonl"),
    consoleLogPath: join(dir, "train.out"),
    tokenBudget: 1_000_000,
    channelId: "chan-1",
  };
}

test("posts once, then edits the same message in place on the next cycle", async () => {
  const dir = tmpDir();
  writeFileSync(join(dir, "loss.jsonl"), `${JSON.stringify({ step: 1, loss: 5, tokens_seen: 100, docs_consumed: 1, elapsed_s: 1, tokens_per_s: 100, wall_clock: "x", threads: 1, batch_size: 1, block_size: 1 })}\n`);
  writeFileSync(join(dir, "train.out"), "hello\n");
  const { gateway, posts, edits } = fakeGateway();
  const service = createTrainingProgressCardService({
    gateway, statePath: join(dir, "state.json"), sources: [sourceConfig(dir)],
    isUnitActive: () => true, intervalMs: 60_000,
  });

  await service.runCycle();
  expect(posts.length).toBe(1);
  expect(edits.length).toBe(0);

  await service.runCycle();
  expect(posts.length).toBe(1); // no second post
  expect(edits.length).toBe(1); // same message, edited in place
  expect(edits[0]!.messageId).toBe("msg-1");
});

test("a restarted service resumes editing the persisted anchor instead of reposting", async () => {
  const dir = tmpDir();
  writeFileSync(join(dir, "loss.jsonl"), `${JSON.stringify({ step: 1, loss: 5, tokens_seen: 100, docs_consumed: 1, elapsed_s: 1, tokens_per_s: 100, wall_clock: "x", threads: 1, batch_size: 1, block_size: 1 })}\n`);
  const statePath = join(dir, "state.json");
  const first = fakeGateway();
  const service1 = createTrainingProgressCardService({
    gateway: first.gateway, statePath, sources: [sourceConfig(dir)], isUnitActive: () => true,
  });
  await service1.runCycle();
  expect(first.posts.length).toBe(1);

  const second = fakeGateway();
  const service2 = createTrainingProgressCardService({
    gateway: second.gateway, statePath, sources: [sourceConfig(dir)], isUnitActive: () => true,
  });
  await service2.runCycle();
  expect(second.posts.length).toBe(0);
  expect(second.edits.length).toBe(1);
  expect(second.edits[0]!.messageId).toBe("msg-1");
});

test("a deleted card is reposted once, and the new anchor is what gets edited next", async () => {
  const dir = tmpDir();
  writeFileSync(join(dir, "loss.jsonl"), `${JSON.stringify({ step: 1, loss: 5, tokens_seen: 100, docs_consumed: 1, elapsed_s: 1, tokens_per_s: 100, wall_clock: "x", threads: 1, batch_size: 1, block_size: 1 })}\n`);
  const { gateway, posts, edits, failEdits } = fakeGateway();
  const service = createTrainingProgressCardService({
    gateway, statePath: join(dir, "state.json"), sources: [sourceConfig(dir)], isUnitActive: () => true,
  });
  await service.runCycle();
  expect(posts.length).toBe(1);

  failEdits(new DiscordUnknownMessageError("chan-1", "msg-1"));
  await service.runCycle();
  expect(posts.length).toBe(2); // reposted after the typed delete
  failEdits(null);

  await service.runCycle();
  expect(edits.length).toBe(1);
  expect(edits[0]!.messageId).toBe("msg-2");
});

test("when the unit is not active the card is still updated — plainly, not silently frozen", async () => {
  const dir = tmpDir();
  const { gateway, posts } = fakeGateway();
  const service = createTrainingProgressCardService({
    gateway, statePath: join(dir, "state.json"), sources: [sourceConfig(dir)], isUnitActive: () => false,
  });
  await service.runCycle();
  expect(posts.length).toBe(1);
  const text = JSON.stringify(posts[0]!.card);
  expect(text).toContain("stopped");
});

test("a source read failure (e.g. an unreadable path) never sinks the cycle or throws", async () => {
  const dir = tmpDir();
  const { gateway, posts } = fakeGateway();
  const service = createTrainingProgressCardService({
    gateway, statePath: join(dir, "state.json"),
    sources: [sourceConfig(dir)],
    isUnitActive: () => { throw new Error("systemctl is unreachable"); },
  });
  await expect(service.runCycle()).resolves.toBeUndefined();
  expect(posts.length).toBe(0);
});

test("with no sources configured, start() is a no-op and nothing is posted", async () => {
  const dir = tmpDir();
  const { gateway, posts } = fakeGateway();
  const service = createTrainingProgressCardService({ gateway, statePath: join(dir, "state.json"), sources: [] });
  await service.start();
  expect(posts.length).toBe(0);
  service.stop();
});

test("persisted anchors survive a restart on disk in the documented shape", async () => {
  const dir = tmpDir();
  writeFileSync(join(dir, "loss.jsonl"), `${JSON.stringify({ step: 1, loss: 5, tokens_seen: 100, docs_consumed: 1, elapsed_s: 1, tokens_per_s: 100, wall_clock: "x", threads: 1, batch_size: 1, block_size: 1 })}\n`);
  const statePath = trainingProgressCardsPath(dir);
  const { gateway } = fakeGateway();
  const service = createTrainingProgressCardService({
    gateway, statePath, sources: [sourceConfig(dir)], isUnitActive: () => true,
  });
  await service.runCycle();
  const persisted = JSON.parse(readFileSync(statePath, "utf8"));
  expect(persisted.version).toBe(1);
  expect(persisted.anchors["test-babble.service"]).toEqual({ channelId: "chan-1", messageId: "msg-1" });
});
