/**
 * V5 Phase 0 characterization safety net — the CONTROL BUS surface.
 * =======================================================================================
 * Snapshots the observable behavior of EVERY command `Concierge.onBusRequest` handles today
 * (every `if (req.cmd === …)` branch plus the unknown-command fallthrough). This is the
 * contract for the extensibility refactor: when Phase 1 turns the sequential ifs into a
 * CapabilityRegistry walk, and Phase 2 normalizes the capability modules, THIS suite must
 * stay green unchanged — that is what makes "all capabilities retained" a checkable claim.
 *
 * Deliberately hermetic: a fake gateway/session, a temp BECKETT_DIR, and no wired
 * dispatcher/quick-runner/browser-runtime. For commands whose happy path needs live Discord
 * or a wired daemon, the characterized behavior is the deterministic contract at this layer:
 * argument validation and the exact "unavailable — not wired" refusals the CLI relays today.
 *
 * If a change breaks one of these snapshots INTENTIONALLY, that is a behavior change, not a
 * refactor — call it out explicitly in review before regenerating.
 */

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Concierge, type ConciergeSession } from "./index.ts";
import { validateConfig } from "../config.ts";
import type { BusResponse } from "../shell/control-bus.ts";
import type { DiscordGateway } from "../discord/gateway.ts";

const savedDir = process.env.BECKETT_DIR;
const tmpDirs: string[] = [];
afterEach(() => {
  if (savedDir === undefined) delete process.env.BECKETT_DIR;
  else process.env.BECKETT_DIR = savedDir;
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Keep the default-config snapshot independent of a developer's local Cerebras credential. */
function keylessDefaultConfig() {
  const saved = process.env.CEREBRAS_API_KEY;
  delete process.env.CEREBRAS_API_KEY;
  try {
    return validateConfig({});
  } finally {
    if (saved === undefined) delete process.env.CEREBRAS_API_KEY;
    else process.env.CEREBRAS_API_KEY = saved;
  }
}

function harness(): { concierge: Concierge; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "beckett-bus-char-"));
  tmpDirs.push(dir);
  process.env.BECKETT_DIR = dir;
  const config = keylessDefaultConfig();
  const gateway = {
    onMessage() {},
    async start() {},
    async stop() {},
    sendTyping() {},
    async post() {
      return "mid-1";
    },
    isConnected: () => true,
    lastEventAgeMs: () => 1,
  } as unknown as DiscordGateway;
  const session = {
    async start() {},
    async stop() {},
    ask: async () => "",
    stats: () => ({}),
  } as unknown as ConciergeSession;
  return { concierge: new Concierge({ config, session, gateway }), dir };
}

/** Snapshot-safe view of a BusResponse: the temp dir is the only run-varying value. */
function stable(res: BusResponse, dir: string): unknown {
  return JSON.parse(JSON.stringify(res).replaceAll(dir, "<BECKETT_DIR>"));
}

async function run(cmd: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const { concierge, dir } = harness();
  return stable(await concierge.onBusRequest({ cmd, args }), dir);
}

// ── self-management ───────────────────────────────────────────────────────────────────────

test("bus: reload", async () => {
  expect(await run("reload")).toMatchSnapshot();
});

test("bus: persona (not yet seeded)", async () => {
  expect(await run("persona")).toMatchSnapshot();
});

// ── task / ticket plumbing ────────────────────────────────────────────────────────────────

test("bus: task.created rejects a missing/invalid taskNumber", async () => {
  expect(await run("task.created", {})).toMatchSnapshot();
  expect(await run("task.created", { taskNumber: 0 })).toMatchSnapshot();
  expect(await run("task.created", { taskRef: "#abc" })).toMatchSnapshot();
});

test("bus: the retired ticket verbs are gone, not silently accepted", async () => {
  for (const verb of ["ticket.filed", "ticket.restaff", "ticket.courier"]) {
    expect(await run(verb, { id: "OPS-1" })).toMatchSnapshot();
  }
});

test("bus: pr.watch validates repo/number/url and no-ops without a wired poller (#31)", async () => {
  expect(await run("pr.watch", {})).toMatchSnapshot();
  expect(await run("pr.watch", { repo: "x/y", number: 0, url: "u" })).toMatchSnapshot();
  expect(
    await run("pr.watch", {
      repo: "betterwright/betterwright",
      number: 66,
      url: "https://github.com/betterwright/betterwright/pull/66",
    }),
  ).toMatchSnapshot();
});

// ── status ────────────────────────────────────────────────────────────────────────────────

test("bus: status assembles discord + concierge halves (no provider wired)", async () => {
  expect(await run("status")).toMatchSnapshot();
});

// ── browser / quick lane ──────────────────────────────────────────────────────────────────

test("bus: browser.eval without a wired runtime is refused", async () => {
  expect(await run("browser.eval", { runId: "r", controlToken: "t", code: "1" })).toMatchSnapshot();
});

test("bus: quick.run without a wired runner is refused", async () => {
  expect(await run("quick.run", { agent: "quick-code", task: "x" })).toMatchSnapshot();
});

test("bus: quick.list without a wired runner is refused", async () => {
  expect(await run("quick.list")).toMatchSnapshot();
});

// ── channels (shared context store, empty temp dir) ──────────────────────────────────────

test("bus: channels.list on an empty store", async () => {
  expect(await run("channels.list")).toMatchSnapshot();
});

test("bus: channels.search validates the query and returns no hits on an empty store", async () => {
  expect(await run("channels.search", {})).toMatchSnapshot();
  expect(await run("channels.search", { query: "deploy" })).toMatchSnapshot();
});

test("bus: channels.recall validates the channel and refuses an unknown one", async () => {
  expect(await run("channels.recall", {})).toMatchSnapshot();
  expect(await run("channels.recall", { channel: "#nope" })).toMatchSnapshot();
});

test("bus: channels.wipe on an empty store", async () => {
  expect(await run("channels.wipe", {})).toMatchSnapshot();
  expect(await run("channels.wipe", { channelId: "123" })).toMatchSnapshot();
});

// ── proactivity ───────────────────────────────────────────────────────────────────────────

test("bus: proactivity.status default payload", async () => {
  expect(await run("proactivity.status")).toMatchSnapshot();
});

test("bus: proactivity.set validates mode, owner-gates auto, accepts off/suggest", async () => {
  expect(await run("proactivity.set", { channelId: "1", mode: "loud" })).toMatchSnapshot();
  expect(await run("proactivity.set", { mode: "off" })).toMatchSnapshot();
  expect(await run("proactivity.set", { channelId: "1", mode: "auto" })).toMatchSnapshot(); // no owner turn
  expect(await run("proactivity.set", { channelId: "1", mode: "suggest" })).toMatchSnapshot();
});

test("bus: proactivity.off kills the master switch", async () => {
  expect(await run("proactivity.off")).toMatchSnapshot();
});

// ── discord ───────────────────────────────────────────────────────────────────────────────

test("bus: discord.decline off-turn is refused", async () => {
  expect(await run("discord.decline", {})).toMatchSnapshot();
  expect(await run("discord.decline", { channelId: "123" })).toMatchSnapshot();
});

test("bus: discord.reply validates args and posts through the gateway", async () => {
  expect(await run("discord.reply", {})).toMatchSnapshot();
  expect(await run("discord.reply", { channelId: "123" })).toMatchSnapshot();
  expect(await run("discord.reply", { channelId: "123", text: "hello" })).toMatchSnapshot();
  expect(await run("discord.reply", { channelId: "123", text: "", files: ["/tmp/a.png"] })).toMatchSnapshot();
});

test("bus: discord.reply dedupes an identical retry within the window (same response object)", async () => {
  const { concierge, dir } = harness();
  const args = { channelId: "123", text: "hello" };
  const first = await concierge.onBusRequest({ cmd: "discord.reply", args });
  const retry = await concierge.onBusRequest({ cmd: "discord.reply", args });
  expect(stable(retry, dir)).toEqual(stable(first, dir));
});

// ── the fallthrough ───────────────────────────────────────────────────────────────────────

test("bus: an unknown command is refused with the exact unknown-command shape", async () => {
  expect(await run("nope.nothing")).toMatchSnapshot();
});
