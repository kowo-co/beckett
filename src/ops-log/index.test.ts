import { afterEach, describe, expect, test } from "bun:test";
import { defaultConfig } from "../config.ts";
import { log, setLogLevel } from "../log.ts";
import { componentMatches, opsLogEnabled, startOpsLogSink, type OpsLogSink } from "./index.ts";

const quiet = { debug() {}, info() {}, warn() {}, error() {}, child() { return quiet; } } as never;

function manualScheduler() {
  const timers: { fn: () => void; ms: number; cancelled: boolean }[] = [];
  return {
    timers,
    schedule: (fn: () => void, ms: number) => {
      const timer = { fn, ms, cancelled: false };
      timers.push(timer);
      return { cancel: () => (timer.cancelled = true) };
    },
    pending: () => timers.filter((t) => !t.cancelled),
    fire: () => {
      for (const timer of timers.filter((t) => !t.cancelled)) {
        timer.cancelled = true;
        timer.fn();
      }
    },
  };
}

/** Every test that starts a real sink MUST stop it — addLogSink is process-global state shared
 *  with every other test file bun runs in this process. */
const live: OpsLogSink[] = [];
afterEach(async () => {
  for (const sink of live.splice(0)) await sink.stop();
});

function harness(overrides: { level?: "debug" | "info" | "warn" | "error"; includeDebug?: string[] } = {}) {
  const posts: { channelId: string; content: string }[] = [];
  let postFails = false;
  const timers = manualScheduler();
  let clock = 1_000_000;
  const config = {
    ...defaultConfig().ops_log,
    enabled: true,
    channel_id: "111111111111111111",
    ...(overrides.level ? { level: overrides.level } : {}),
    ...(overrides.includeDebug ? { include_debug_components: overrides.includeDebug } : {}),
  };
  const sink = startOpsLogSink({
    config,
    post: async (channelId, content) => {
      if (postFails) throw new Error("discord down");
      posts.push({ channelId, content });
    },
    logger: quiet,
    now: () => clock,
    schedule: timers.schedule,
  });
  live.push(sink);
  return {
    sink,
    posts,
    timers,
    config,
    advance: (ms: number) => (clock += ms),
    setFailing: (v: boolean) => (postFails = v),
    flush: async () => {
      timers.fire();
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

describe("opsLogEnabled — config gating", () => {
  test("off by default (enabled=false)", () => {
    expect(opsLogEnabled(defaultConfig().ops_log)).toBe(false);
  });

  test("enabled=true with no channel_id still stays off", () => {
    expect(opsLogEnabled({ ...defaultConfig().ops_log, enabled: true })).toBe(false);
  });

  test("channel_id alone with enabled=false stays off", () => {
    expect(opsLogEnabled({ ...defaultConfig().ops_log, channel_id: "111111111111111111" })).toBe(false);
  });

  test("both enabled and a channel_id set turns it on", () => {
    expect(opsLogEnabled({ ...defaultConfig().ops_log, enabled: true, channel_id: "111111111111111111" })).toBe(true);
  });

  test("a whitespace-only channel_id does not count as set", () => {
    expect(opsLogEnabled({ ...defaultConfig().ops_log, enabled: true, channel_id: "   " })).toBe(false);
  });
});

describe("componentMatches", () => {
  test("exact match", () => {
    expect(componentMatches("browser", "browser")).toBe(true);
  });
  test("suffix match tolerates however many .child(...) calls prefixed it", () => {
    expect(componentMatches("shell.v4.concierge.concierge", "concierge")).toBe(true);
    expect(componentMatches("shell.v4.concierge.concierge.concierge.pool", "concierge.pool")).toBe(true);
  });
  test("a component that merely CONTAINS the name without a dot boundary does not match", () => {
    expect(componentMatches("myconcierge", "concierge")).toBe(false);
  });
});

describe("end-to-end sink: renders known events and batches them", () => {
  test("a known event posts its rendered line", async () => {
    const { posts, flush, config } = harness();
    log.child("run.supervisor").info("run done", { run: "run-9" });
    await flush();
    expect(posts).toEqual([{ channelId: config.channel_id, content: "▲ run done run-9" }]);
  });

  test("an unknown event at/above the configured level falls back to the compact k=v line", async () => {
    const { posts, flush } = harness();
    log.child("some.weird.component").warn("a thing nobody named", { x: 1 });
    await flush();
    expect(posts[0]!.content).toContain("some.weird.component: a thing nobody named (x=1)");
  });

  test("an event below the configured level is dropped", async () => {
    const { posts, flush } = harness({ level: "warn" });
    log.child("run.supervisor").info("run done", { run: "run-9" });
    await flush();
    expect(posts).toEqual([]);
  });

  test("include_debug_components admits a debug event from an allow-listed component even below level", async () => {
    // The GLOBAL log level (BECKETT_LOG_LEVEL, src/log.ts) gates fan-out to every sink before
    // ops_log's OWN level ever sees the record — a debug record never reaches ANY sink unless
    // the daemon's global level is itself "debug". Set it for this one test, restore after.
    setLogLevel("debug");
    try {
      const { posts, flush } = harness({ level: "warn", includeDebug: ["browser"] });
      log.child("browser").debug("browser lease acquired", { runId: "run-1" });
      await flush();
      expect(posts.length).toBe(1);
      expect(posts[0]!.content).toContain("browser lease acquired");
    } finally {
      setLogLevel("info");
    }
  });

  test("a debug event from a NON-allow-listed component stays dropped", async () => {
    setLogLevel("debug");
    try {
      const { posts, flush } = harness({ level: "warn", includeDebug: ["browser"] });
      log.child("discord").debug("some debug chatter", {});
      await flush();
      expect(posts).toEqual([]);
    } finally {
      setLogLevel("info");
    }
  });
});

describe("no feedback loop", () => {
  test("a log record FROM the sink's own component is never rendered or queued", async () => {
    const { posts, sink, flush } = harness();
    // Simulate the batcher's own internal failure-logging path re-entering the log system.
    log.child("ops-log").warn("ops-log post failed — batch dropped", { lines: 3 });
    await flush();
    expect(posts).toEqual([]);
    expect(sink.batcher.queued()).toBe(0);
  });

  test("a batch post failure logged asynchronously does not re-enter the batch it just dropped", async () => {
    const { posts, flush, setFailing } = harness();
    setFailing(true);
    log.child("run.supervisor").info("run done", { run: "run-1" });
    await flush();
    expect(posts).toEqual([]);
    // If the failure warning HAD leaked back in, a second flush would show it queued.
    await flush();
    expect(posts).toEqual([]);
  });
});

describe("turn heartbeat wiring", () => {
  test("turn start arms the heartbeat; turn done disarms it", async () => {
    const { sink, advance, timers, posts, flush } = harness();
    log.child("shell.v4.concierge.concierge").info("turn start", { channelName: "general", author: "sshdev" });
    await flush(); // posts "turn start" itself; also fires (and re-arms) the heartbeat's first tick
    expect(sink.heartbeat.isLive()).toBe(true);
    advance(60_000);
    timers.fire(); // the heartbeat's re-armed tick: elapsed >= 60s, pushes into the batcher
    await Promise.resolve();
    timers.fire(); // flush the batcher's freshly-armed window from that push
    await Promise.resolve();
    await Promise.resolve();
    expect(posts.some((p) => p.content.includes("still working"))).toBe(true);

    log.child("shell.v4.concierge.concierge").info("turn done", { elapsedMs: 65_000, decision: "send" });
    expect(sink.heartbeat.isLive()).toBe(false);
  });
});

describe("stop()", () => {
  test("unregisters the sink — events after stop never post", async () => {
    const { sink, posts, flush } = harness();
    await sink.stop();
    live.length = 0; // already stopped; afterEach must not double-stop
    log.child("run.supervisor").info("run done", { run: "run-1" });
    await flush();
    expect(posts).toEqual([]);
  });
});
