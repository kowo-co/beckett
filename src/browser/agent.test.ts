/** Background browser agent: detach, park/surface/resume, keychain secrets, durable outcomes. */

import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserRuntime } from "./runtime.ts";
import type { Config, Logger } from "../types.ts";
import type { KeychainReader } from "../secret/keychain-read.ts";
import type { KeychainStore, KeychainField } from "../secret/keychain.ts";
import {
  contextPreamble,
  createBrowserAgent,
  redactKnownBrowserInputs,
  resolveCredsEntry,
  secretsPreamble,
  type BrowserAgentQuestion,
  type BrowserAgentRun,
} from "./agent.ts";

const quietLog = (() => {
  const logger = { info() {}, warn() {}, debug() {}, error() {}, child() { return logger; } };
  return logger as unknown as Logger;
})();

function writeStubBin(dir: string): string {
  const bin = join(dir, "claude-stub.sh");
  writeFileSync(
    bin,
    `#!/bin/bash
is_resume=0
for arg in "$@"; do
  [ "$arg" = "--resume" ] && is_resume=1
done
input="$(cat)"
if [ "$is_resume" = "1" ]; then args_file=args-resume.txt; else args_file=args.txt; fi
printf '%s\n' "$@" >> "$PWD/$args_file"
printf '%s' "$input" > "$PWD/input-$args_file"
if [[ "$input" == *SLOW* ]]; then sleep 2; fi
# Stand in for the browser MCP server registering its tool during claude's startup handshake: a
# real leg touches the attach marker, a leg whose tool went missing does not. NO_TOOL never
# attaches; FLAKY misses the first attempt and attaches thereafter (proving retry recovers).
attach=1
bail='{"session_id":"test","structured_output":{"status":"needs_input","summary":"I have only the output tool.","question":"","proofApplicable":false}}'
if [[ "$input" == *NO_TOOL* ]]; then
  attach=0
  out="$bail"
elif [[ "$input" == *FLAKY* ]]; then
  if [ -f "$PWD/flaky-attempted" ]; then
    out='{"session_id":"test","structured_output":{"status":"completed","summary":"BROWSER:recovered","question":null,"proofApplicable":true}}'
  else
    printf 'x' > "$PWD/flaky-attempted"
    attach=0
    out="$bail"
  fi
elif [[ "$input" == *ASK_COLOR* ]]; then
  out='{"session_id":"test","structured_output":{"status":"needs_input","summary":"I reached the color choice.","question":"Which color should I choose?","proofApplicable":true}}'
elif [[ "$input" == *SECOND_QUESTION* ]]; then
  out='{"session_id":"test","structured_output":{"status":"needs_input","summary":"One more decision.","question":"The saved password is hunter2. Should I continue?","proofApplicable":false}}'
elif [[ "$input" == *BROWSER_FAIL* ]]; then
  out='{"session_id":"test","structured_output":{"status":"failed","summary":"The site rejected the request.","question":null,"proofApplicable":false}}'
else
  flat="\${input//\$'\\n'/ }"
  out="$(printf '{"session_id":"test","structured_output":{"status":"completed","summary":"BROWSER:%s","question":null,"proofApplicable":true}}' "$flat")"
fi
[ "$attach" = "1" ] && printf 'x' > "$PWD/mcp-attached"
printf '%s\n' "$out"
`,
  );
  chmodSync(bin, 0o755);
  return bin;
}

function makeConfig(dir: string, overrides: Partial<Config["quick"]> = {}): Config {
  return {
    paths: {
      beckett_dir: dir,
      db: "beckett.db",
      events_dir: "events",
      logs_dir: "logs",
      memory_dir: "memory",
      socket: "beckett.sock",
      spend: "spend.jsonl",
      projects: "projects",
    },
    quick: {
      enabled: true,
      model: "test-model",
      effort: "low",
      sync_wait_secs: 2,
      hard_timeout_secs: 5,
      max_concurrent: 2,
      browser_profile_dir: "browser/profile",
      browser_headless: true,
      browser_viewport_width: 1440,
      browser_viewport_height: 900,
      browser_launch_timeout_ms: 30_000,
      browser_action_timeout_ms: 10_000,
      browser_navigation_timeout_ms: 30_000,
      browser_eval_timeout_ms: 60_000,
      browser_max_output_chars: 24_000,
      browser_question_wait_secs: 60,
      ...overrides,
    },
    harness: { claude: { bin: writeStubBin(dir), permission_mode: "bypassPermissions", extra_flags: [] } },
  } as unknown as Config;
}

function fakeBrowser(maxConcurrentLeases = 1): BrowserRuntime {
  const leases = new Map<string, { runId: string; artifactsDir: string }>();
  return {
    async acquire(next) {
      if (!leases.has(next.runId) && leases.size >= maxConcurrentLeases) throw new Error("computer-use is busy");
      leases.set(next.runId, next);
      mkdirSync(next.artifactsDir, { recursive: true });
    },
    async evaluate() {
      throw new Error("not used by agent unit tests");
    },
    async capture(runId, name) {
      const lease = leases.get(runId);
      if (!lease) throw new Error("missing lease");
      const path = join(lease.artifactsDir, `${name}.png`);
      writeFileSync(path, Buffer.from("89504e470d0a1a0a", "hex"));
      return path;
    },
    async checkpoint() {
      return { urls: ["about:blank"], activeIndex: 0 };
    },
    async restore() {},
    async release(runId, captureProof) {
      if (!leases.has(runId)) return [];
      const files = captureProof ? [await this.capture(runId, "proof")] : [];
      leases.delete(runId);
      return files;
    },
    hasLease(runId) {
      return leases.has(runId);
    },
    stats() {
      return {
        ready: leases.size > 0,
        profileDir: "test",
        activeRunId: leases.keys().next().value ?? null,
        activeRunIds: [...leases.keys()],
        maxConcurrentLeases,
        pages: 1,
        launches: 1,
        evaluations: 0,
        averageEvalMs: 0,
      };
    },
    async stop() {
      leases.clear();
    },
  };
}

function fakeKeychain(values: Record<string, string>, totpCodes: string[] = []): KeychainReader {
  const codes = [...totpCodes];
  return {
    async read(entry) {
      return {
        entry,
        fields: [...Object.keys(values), ...(totpCodes.length > 0 ? ["totp"] : [])],
        values: { ...values },
        hasTotp: totpCodes.length > 0,
      };
    },
    async totp() {
      const code = codes.shift();
      if (!code) throw new Error("no more codes");
      return code;
    },
    async list() {
      return ["x.com", "team-email"];
    },
  };
}

/** Records every write; `fail` makes it throw instead (a bad jingle exit code). */
function fakeKeychainStore(calls: { entry: string; fields: KeychainField[] }[], fail = false): KeychainStore {
  return async ({ entry, fields }) => {
    calls.push({ entry, fields });
    if (fail) throw new Error("jingle set failed (1)");
  };
}

function setup(
  overrides: Partial<Config["quick"]> = {},
  behavior: {
    onQuestion?: (run: BrowserAgentRun, question: BrowserAgentQuestion) => Promise<string>;
    onOutcome?: (run: BrowserAgentRun) => void | Promise<void>;
    browser?: BrowserRuntime;
    keychain?: KeychainReader;
    keychainStore?: KeychainStore;
    dir?: string;
    logger?: Logger;
  } = {},
) {
  const dir = behavior.dir ?? mkdtempSync(join(tmpdir(), "browser-agent-test-"));
  const outcomes: BrowserAgentRun[] = [];
  const questions: { run: BrowserAgentRun; question: BrowserAgentQuestion }[] = [];
  const agent = createBrowserAgent({
    config: makeConfig(dir, overrides),
    logger: behavior.logger ?? quietLog,
    browser: behavior.browser ?? fakeBrowser(),
    ...(behavior.keychain ? { keychain: behavior.keychain } : {}),
    ...(behavior.keychainStore ? { keychainStore: behavior.keychainStore } : {}),
    onOutcome: behavior.onOutcome ?? ((run) => {
      outcomes.push(structuredClone(run));
    }),
    onQuestion: behavior.onQuestion ?? (async (run, question) => {
      questions.push({ run, question });
      return `question-${questions.length}`;
    }),
  });
  return { dir, agent, outcomes, questions };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for test state");
    await Bun.sleep(20);
  }
}

describe("dispatch", () => {
  test("returns immediately, runs in the background, and reports the outcome", async () => {
    const { dir, agent, outcomes } = setup();
    const { runId } = await agent.run("inspect args", { channelId: "chan", requesterId: "owner" });
    expect(runId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const runDir = join(dir, "browser-agent", runId);
    await waitUntil(() => outcomes.length === 1);
    const args = readFileSync(join(runDir, "args.txt"), "utf8");
    expect(args).toContain("--system-prompt");
    expect(args).toContain("--strict-mcp-config");
    expect(args).toContain("--no-chrome");
    expect(args).toContain("mcp__browser__betterwright_browser");
    const mcp = JSON.parse(readFileSync(join(runDir, "mcp.json"), "utf8"));
    expect(mcp.mcpServers.browser.args[0]).toEndWith("/src/browser/mcp.ts");
    expect(mcp.mcpServers.browser.env.BECKETT_BROWSER_RUN_ID).toBe(runId);
    expect(mcp.mcpServers.browser.env.BECKETT_BROWSER_CONTROL_TOKEN.length).toBeGreaterThanOrEqual(43);
    // The fake harness echoes its whole input, which now carries the credentials preamble too.
    expect(outcomes[0]).toMatchObject({ state: "done", outcomeDelivered: false });
    expect(outcomes[0]!.result).toStartWith("BROWSER:inspect args");
    expect(outcomes[0]!.proofFiles).toHaveLength(1);
  });

  test("acks with a runId BEFORE a slow lease acquire finishes (issue #137: ack on accept, not on start)", async () => {
    // The browser-lease acquire + cold Chromium boot can outlast the control-bus deadline. The
    // dispatch must return the instant the daemon accepts the task — blocking on the acquire is the
    // accept-vs-complete confusion that made a started run read as a CLI timeout/failure.
    const browser = fakeBrowser();
    const originalAcquire = browser.acquire.bind(browser);
    let released: (() => void) | null = null;
    const acquiring = new Promise<void>((resolve) => (released = resolve));
    browser.acquire = async (lease) => {
      await acquiring; // hold the lane open, as a real cold boot would
      await originalAcquire(lease);
    };
    const { agent, outcomes } = setup({}, { browser });

    // If run() awaited the acquire this would hang until the timeout; it resolves right away instead.
    const dispatch = await Promise.race([
      agent.run("BROWSER_slow_start", { channelId: "chan", requesterId: "owner" }),
      Bun.sleep(1_000).then(() => "still-blocked" as const),
    ]);
    expect(dispatch).not.toBe("still-blocked");
    expect((dispatch as { runId: string }).runId).toMatch(/^[0-9a-f-]{36}$/);
    // The run has not finished — the acquire is still parked, so no outcome has been delivered yet.
    expect(outcomes).toHaveLength(0);

    released!();
    await waitUntil(() => outcomes.length === 1, 8_000);
    expect(outcomes[0]!.runId).toBe((dispatch as { runId: string }).runId);
  });

  test("queues a second run at the legacy single-lease cap and rejects a dispatch without channel/requester", async () => {
    const { agent, questions } = setup();
    await agent.run("ASK_COLOR", { channelId: "chan", requesterId: "owner" });
    await waitUntil(() => questions.length === 1);
    // The lease is busy: the dispatch queues (never refuses) and names its position.
    const second = await agent.run("another", { channelId: "chan", requesterId: "owner" });
    expect(second.queued).toBe(1);
    expect(agent.stats().queued).toBe(1);
    await expect(agent.run("x", { channelId: "", requesterId: "owner" })).rejects.toThrow(/origin channel/);
  });

  test("admits concurrent sessions through the cap; question anchors and answers stay with their run", async () => {
    const { agent, outcomes, questions } = setup({}, { browser: fakeBrowser(2) });
    const first = await agent.run("ASK_COLOR first", { channelId: "chan", requesterId: "owner" });
    const second = await agent.run("ASK_COLOR second", { channelId: "chan", requesterId: "owner" });
    const third = await agent.run("over cap", { channelId: "chan", requesterId: "owner" });
    expect(first.queued).toBeUndefined();
    expect(second.queued).toBeUndefined();
    expect(third.queued).toBe(1);
    await waitUntil(() => questions.length === 2);
    expect(new Set(questions.map(({ run }) => run.runId))).toEqual(new Set([first.runId, second.runId]));
    expect(agent.stats()).toMatchObject({ waiting: 2, queued: 1 });

    // Replying to first's anchor resumes only first; second remains parked on its own anchor.
    await agent.resume(first.runId, "blue");
    await waitUntil(() => outcomes.some((run) => run.runId === first.runId));
    expect((await agent.inspect(second.runId, { screenshot: false }))!.run.state).toBe("waiting");
    await agent.resume(second.runId, "red");
    await waitUntil(() => outcomes.length === 3);
  });
});

describe("dispatch queue", () => {
  test("a queued run starts automatically when the lease releases, FIFO", async () => {
    const { agent, outcomes, questions } = setup();
    const first = await agent.run("ASK_COLOR", { channelId: "chan", requesterId: "owner" });
    await waitUntil(() => questions.length === 1);
    const second = await agent.run("second task", { channelId: "chan", requesterId: "owner" });
    const third = await agent.run("third task", { channelId: "chan", requesterId: "owner" });
    expect(second).toMatchObject({ queued: 1 });
    expect(third).toMatchObject({ queued: 2 });
    const queuedView = await agent.inspect(second.runId, { screenshot: false });
    expect(queuedView!.run.state).toBe("queued");
    expect(queuedView!.journal.map((event) => event.kind)).toContain("queued");
    await agent.resume(first.runId, "blue");
    // Both queued runs drain in order without any re-dispatch.
    await waitUntil(() => outcomes.length === 3, 8_000);
    expect(outcomes.map((run) => run.runId)).toEqual([first.runId, second.runId, third.runId]);
    expect(outcomes[1]!.result).toStartWith("BROWSER:second task");
    expect(outcomes[2]!.result).toStartWith("BROWSER:third task");
    expect(agent.stats().queued).toBe(0);
  });

  test("stopping a queued run cancels it without touching the live run's lease", async () => {
    const browser = fakeBrowser();
    const { agent, outcomes, questions } = setup({}, { browser });
    const first = await agent.run("ASK_COLOR", { channelId: "chan", requesterId: "owner" });
    await waitUntil(() => questions.length === 1);
    const second = await agent.run("never runs", { channelId: "chan", requesterId: "owner" });
    await agent.stop(second.runId, "person cancelled the queued task");
    await waitUntil(() => outcomes.length === 1);
    expect(outcomes[0]).toMatchObject({ runId: second.runId, state: "cancelled" });
    expect(outcomes[0]!.result).toContain("person cancelled");
    // The live run is untouched: still parked on its question, still holding the lease.
    expect(agent.stats().waiting).toBe(1);
    expect(browser.hasLease(first.runId)).toBe(true);
  });

  test("steering a queued run folds the note into its launch input", async () => {
    const { dir, agent, outcomes, questions } = setup();
    const first = await agent.run("ASK_COLOR", { channelId: "chan", requesterId: "owner" });
    await waitUntil(() => questions.length === 1);
    const second = await agent.run("book the flight", { channelId: "chan", requesterId: "owner" });
    expect(await agent.steer(second.runId, "prefer the aisle seat")).toBe("queued");
    await agent.resume(first.runId, "blue");
    await waitUntil(() => outcomes.length === 2, 8_000);
    const input = readFileSync(join(dir, "browser-agent", second.runId, "input-args.txt"), "utf8");
    expect(input.startsWith("book the flight")).toBe(true);
    expect(input).toContain("queued");
    expect(input).toContain("prefer the aisle seat");
  });

  test("restart cancels persisted queued runs instead of replaying them", async () => {
    const { dir, agent, questions } = setup();
    const first = await agent.run("ASK_COLOR", { channelId: "chan-1", requesterId: "owner" });
    await waitUntil(() => questions.length === 1);
    const q1 = await agent.run("first queued", { channelId: "chan-2", requesterId: "owner" });
    const q2 = await agent.run("second queued", { channelId: "chan-3", requesterId: "owner" });
    // The queue is durable: the ledger round-trips both queued records.
    const ledger = JSON.parse(readFileSync(join(dir, "browser-agent", "runs.json"), "utf8")) as BrowserAgentRun[];
    expect(ledger.filter((run) => run.state === "queued").map((run) => run.runId)).toEqual([q1.runId, q2.runId]);
    // Simulate a hard crash: a fresh agent over the same beckett dir, no stopAll.
    const revived = setup({}, { dir });
    await revived.agent.recover();
    // No task is replayed after a restart: every durable active/queued row is a cancellation.
    await waitUntil(() => revived.outcomes.length === 3, 8_000);
    expect(revived.outcomes.map((run) => run.runId)).toEqual([first.runId, q1.runId, q2.runId]);
    expect(revived.outcomes.every((run) => run.state === "cancelled" && run.restartCancelled)).toBe(true);
    expect(revived.agent.stats()).toMatchObject({ running: 0, waiting: 0, queued: 0 });
  });

  test("losing the lease race to an inline exec re-queues the run instead of erroring it", async () => {
    const browser = fakeBrowser();
    const originalAcquire = browser.acquire.bind(browser);
    let stolen = false;
    browser.acquire = async (lease) => {
      // Model an inline exec sliding into the queue→live handoff: the first queued start
      // finds the lease held. Contention must re-queue, never settle a terminal error —
      // the dispatcher already told the person "never re-dispatch".
      if (stolen) {
        stolen = false;
        throw new Error("computer-use is busy with run inline-1; retry after it finishes");
      }
      await originalAcquire(lease);
    };
    const { agent, outcomes, questions } = setup({}, { browser });
    const first = await agent.run("ASK_COLOR", { channelId: "chan", requesterId: "owner" });
    await waitUntil(() => questions.length === 1);
    const survivor = await agent.run("queued survivor", { channelId: "chan", requesterId: "owner" });
    stolen = true;
    await agent.resume(first.runId, "blue");
    await waitUntil(() => outcomes.length === 2, 8_000);
    expect(outcomes.map((run) => run.runId)).toEqual([first.runId, survivor.runId]);
    expect(outcomes[1]!.result).toStartWith("BROWSER:queued survivor");
  });

  test("a queued credentialed dispatch drops the secret values and re-reads them at start", async () => {
    let reads = 0;
    const keychain: KeychainReader = {
      async read(entry) {
        reads++;
        return { entry, fields: ["password"], values: { password: "sup3r-secret-pw" }, hasTotp: false };
      },
      async totp() {
        throw new Error("unused");
      },
      async list() {
        return ["x.com"];
      },
    };
    const { dir, agent, outcomes, questions } = setup({}, { keychain });
    const first = await agent.run("ASK_COLOR", { channelId: "chan", requesterId: "owner" });
    await waitUntil(() => questions.length === 1);
    const second = await agent.run("log in", { channelId: "chan", requesterId: "owner", credsEntry: "x.com" });
    // The dispatch-time read stays fail-fast validation only — values are NOT held in memory
    // for the (unbounded) queue wait.
    expect(reads).toBe(1);
    await agent.resume(first.runId, "blue");
    await waitUntil(() => outcomes.length === 2, 8_000);
    // The run still launched credentialed: startDispatch re-read the entry when the lease freed.
    expect(reads).toBe(2);
    const input = readFileSync(join(dir, "browser-agent", second.runId, "input-args.txt"), "utf8");
    expect(input).toContain('keychain entry "x.com"');
  });

  test("a queued run whose start fails settles as an error outcome and the queue moves on", async () => {
    const browser = fakeBrowser();
    const failNext = { on: false };
    const originalAcquire = browser.acquire.bind(browser);
    browser.acquire = async (lease) => {
      if (failNext.on) {
        failNext.on = false;
        throw new Error("chromium exploded");
      }
      await originalAcquire(lease);
    };
    const { agent, outcomes, questions } = setup({}, { browser });
    const first = await agent.run("ASK_COLOR", { channelId: "chan", requesterId: "owner" });
    await waitUntil(() => questions.length === 1);
    const doomed = await agent.run("doomed", { channelId: "chan", requesterId: "owner" });
    const survivor = await agent.run("survivor", { channelId: "chan", requesterId: "owner" });
    failNext.on = true;
    await agent.resume(first.runId, "blue");
    await waitUntil(() => outcomes.length === 3, 8_000);
    expect(outcomes.map((run) => run.runId)).toEqual([first.runId, doomed.runId, survivor.runId]);
    expect(outcomes[1]).toMatchObject({ state: "error" });
    expect(outcomes[1]!.result).toContain("could not start");
    expect(outcomes[2]).toMatchObject({ state: "done" });
  });
});

describe("pause, surface, resume", () => {
  test("parks on a screenshot-backed question and resumes the same session", async () => {
    const { dir, agent, outcomes, questions } = setup();
    const { runId } = await agent.run("ASK_COLOR", { channelId: "chan", requesterId: "owner" });
    await waitUntil(() => agent.stats().waiting === 1 && questions.length === 1);
    expect(questions[0]!.question.text).toBe("Which color should I choose?");
    expect(existsSync(questions[0]!.question.screenshot)).toBe(true);
    await agent.resume(runId, "blue");
    await waitUntil(() => outcomes.length === 1);
    expect(readFileSync(join(dir, "browser-agent", runId, "args-resume.txt"), "utf8")).toContain("--resume");
    expect(outcomes[0]).toMatchObject({ state: "done", result: "BROWSER:[redacted]" });
  });

  test("scrubs password and OTP answers from resumed summaries and later questions", async () => {
    const { agent, outcomes, questions } = setup();
    const { runId } = await agent.run("ASK_COLOR", { channelId: "chan", requesterId: "owner" });
    await waitUntil(() => questions.length === 1 && agent.stats().waiting === 1);
    await agent.resume(runId, "SECOND_QUESTION hunter2");
    await waitUntil(() => questions.length === 2 && agent.stats().waiting === 1);
    expect(questions[1]!.question.text).toContain("[redacted]");
    expect(questions[1]!.question.text).not.toContain("hunter2");
    await agent.resume(runId, "yes");
    await waitUntil(() => outcomes.length === 1);
    expect(outcomes[0]!.state).toBe("done");
  });

  test("a question nobody answers times out and still reports back", async () => {
    const { agent, outcomes } = setup({ browser_question_wait_secs: 0.2 });
    await agent.run("ASK_COLOR", { channelId: "chan", requesterId: "owner" });
    await waitUntil(() => outcomes.length === 1);
    expect(outcomes[0]!.state).toBe("timeout");
    expect(outcomes[0]!.result).toContain("Timed out waiting");
  });

  test("downgrades a claimed completion when proof capture fails", async () => {
    const browser = fakeBrowser();
    browser.release = async () => [];
    const { agent, outcomes } = setup({}, { browser });
    await agent.run("finish visibly", { channelId: "chan", requesterId: "owner" });
    await waitUntil(() => outcomes.length === 1);
    expect(outcomes[0]).toMatchObject({ state: "error", proofFiles: [] });
    expect(outcomes[0]!.result).toContain("outcome as unverified");
  });
});

describe("keychain secrets", () => {
  test("resolves the entry at dispatch, names fields to the model, injects values per eval", async () => {
    const keychain = fakeKeychain({ email: "bot@example.com", password: "sup3r-secret-pw" }, ["739184", "224466"]);
    const { dir, agent, outcomes } = setup({}, { keychain });
    const { runId } = await agent.run("ASK_COLOR log in first", {
      channelId: "chan",
      requesterId: "owner",
      credsEntry: "x.com",
    });
    const first = await agent.evalSecrets(runId);
    expect(first).toMatchObject({ email: "bot@example.com", password: "sup3r-secret-pw", totp: "739184" });
    const second = await agent.evalSecrets(runId);
    expect(second!.totp).toBe("224466");
    await waitUntil(() => agent.stats().waiting === 1);
    // The model's task input names the fields but never the values.
    const input = readFileSync(join(dir, "browser-agent", runId, "input-args.txt"), "utf8");
    expect(input).toContain("secrets.password");
    expect(input).toContain('keychain entry "x.com"');
    expect(input).not.toContain("sup3r-secret-pw");
    await agent.resume(runId, "the password is sup3r-secret-pw and code 739184");
    await waitUntil(() => outcomes.length === 1);
    expect(outcomes[0]!.result).not.toContain("sup3r-secret-pw");
    expect(outcomes[0]!.result).not.toContain("739184");
    // The durable ledger never holds a secret value.
    const ledger = readFileSync(join(dir, "browser-agent", "runs.json"), "utf8");
    expect(ledger).not.toContain("sup3r-secret-pw");
    expect(ledger).not.toContain("739184");
    expect(ledger).toContain('"credsEntry": "x.com"');
  });

  test("a bad keychain entry fails the dispatch instantly", async () => {
    const keychain: KeychainReader = {
      async read() {
        throw new Error('jingle entry "nope" is not readable (1)');
      },
      async totp() {
        throw new Error("unused");
      },
      async list() {
        return ["x.com"];
      },
    };
    const { agent } = setup({}, { keychain });
    await expect(
      agent.run("log in", { channelId: "chan", requesterId: "owner", credsEntry: "nope" }),
    ).rejects.toThrow(/not readable/);
    expect(agent.stats().running).toBe(0);
  });

  // The dispatcher wrote the entry name into the task PROSE instead of credsEntry, so the run
  // started with no `secrets` at all, reached for BetterWright's own credential store, and asked
  // for "a stored credential named jingle". Resolve the name or refuse — never start blind.
  describe("credential entry resolution", () => {
    const vault = ["x-account", "team-email"];

    test("an explicit entry always wins", () => {
      expect(resolveCredsEntry("log in to x.com", "x-account", vault)).toEqual({ entry: "x-account" });
    });

    test("a task with no credential intent needs no entry", () => {
      expect(resolveCredsEntry("check the status page for outages", null, vault)).toEqual({ entry: null });
    });

    test("recovers the entry a dispatcher named only in the task text", () => {
      const resolved = resolveCredsEntry(
        "Log into X (x.com) using the x-account credentials from jingle, then post.",
        null,
        vault,
      );
      expect(resolved).toMatchObject({ entry: "x-account", recoveredFrom: "task text" });
    });

    test("refuses a credential task naming no real entry, and lists what exists", () => {
      const resolved = resolveCredsEntry("log in to x.com and post the thread", null, vault);
      expect(resolved.entry).toBeNull();
      expect(resolved.error).toContain("x-account, team-email");
    });

    test("refuses rather than guessing when the task names two entries", () => {
      const resolved = resolveCredsEntry("log in with x-account then team-email", null, vault);
      expect(resolved.entry).toBeNull();
      expect(resolved.error).toContain("more than one");
    });

    test("a dispatch that needs credentials but carries none never starts", async () => {
      const { agent } = setup({}, { keychain: fakeKeychain({ password: "pw" }) });
      await expect(
        agent.run("log in to example.com and post", { channelId: "chan", requesterId: "owner" }),
      ).rejects.toThrow(/pass credsEntry/);
      expect(agent.stats().running).toBe(0);
    });
  });

  test("runs without a creds entry expose no secrets", async () => {
    const { agent, outcomes } = setup();
    const { runId } = await agent.run("plain lookup", { channelId: "chan", requesterId: "owner" });
    expect(await agent.evalSecrets(runId)).toBeNull();
    await waitUntil(() => outcomes.length === 1);
  });

  test("secretsPreamble lists fields, marks totp as per-script, and holds no values", () => {
    const preamble = secretsPreamble({
      entry: "x.com",
      fields: ["email", "password", "totp"],
      values: { email: "bot@example.com", password: "pw" },
      hasTotp: true,
    });
    expect(preamble).toContain("secrets.email");
    expect(preamble).toContain("secrets.totp");
    expect(preamble).not.toContain("bot@example.com");
  });
});

describe("secrets.save (the write door)", () => {
  test("saveSecret writes the run's own entry and never journals the value", async () => {
    const calls: { entry: string; fields: KeychainField[] }[] = [];
    const keychainStore = fakeKeychainStore(calls);
    const { dir, agent } = setup({}, { keychain: fakeKeychain({}), keychainStore });
    const { runId } = await agent.run("ASK_COLOR", { channelId: "chan", requesterId: "owner", credsEntry: "huggingface" });
    await waitUntil(() => agent.stats().waiting === 1);
    const receipt = await agent.saveSecret(runId, "hf_token", "hf_live_super_secret_token");
    expect(receipt).toEqual({ field: "hf_token", entry: "huggingface", ok: true });
    expect(calls).toEqual([{ entry: "huggingface", fields: [{ field: "hf_token", value: "hf_live_super_secret_token" }] }]);
    const journal = readFileSync(join(dir, "browser-agent", runId, "journal.jsonl"), "utf8");
    expect(journal).toContain('"field":"hf_token"');
    expect(journal).toContain('"kind":"secret"');
    expect(journal).not.toContain("hf_live_super_secret_token");
  });

  test("a saved value is redacted from everything the run says afterwards", async () => {
    const calls: { entry: string; fields: KeychainField[] }[] = [];
    const keychainStore = fakeKeychainStore(calls);
    const { agent, outcomes } = setup({}, { keychain: fakeKeychain({}), keychainStore });
    const { runId } = await agent.run("ASK_COLOR", { channelId: "chan", requesterId: "owner", credsEntry: "huggingface" });
    await waitUntil(() => agent.stats().waiting === 1);
    await agent.saveSecret(runId, "hf_token", "hf_live_super_secret_token");
    await agent.resume(runId, "the minted token was hf_live_super_secret_token, all done");
    await waitUntil(() => outcomes.length === 1);
    expect(outcomes[0]!.result).not.toContain("hf_live_super_secret_token");
    expect(outcomes[0]!.result).toContain("[redacted]");
  });

  test("a later eval sees the saved field in secrets", async () => {
    const calls: { entry: string; fields: KeychainField[] }[] = [];
    const keychainStore = fakeKeychainStore(calls);
    const { agent } = setup({}, { keychain: fakeKeychain({}), keychainStore });
    const { runId } = await agent.run("ASK_COLOR", { channelId: "chan", requesterId: "owner", credsEntry: "huggingface" });
    await waitUntil(() => agent.stats().waiting === 1);
    expect(await agent.evalSecrets(runId)).toEqual({});
    await agent.saveSecret(runId, "hf_token", "hf_live_super_secret_token");
    expect(await agent.evalSecrets(runId)).toEqual({ hf_token: "hf_live_super_secret_token" });
  });

  test("saveSecret on a run with no credsEntry refuses with the re-dispatch instruction", async () => {
    const calls: { entry: string; fields: KeychainField[] }[] = [];
    const keychainStore = fakeKeychainStore(calls);
    const { agent } = setup({}, { keychainStore });
    const { runId } = await agent.run("ASK_COLOR", { channelId: "chan", requesterId: "owner" });
    await waitUntil(() => agent.stats().waiting === 1);
    const receipt = await agent.saveSecret(runId, "hf_token", "hf_live_super_secret_token");
    expect(receipt.ok).toBe(false);
    expect(receipt.error).toContain("re-dispatch it with credsEntry");
    expect(calls).toHaveLength(0);
  });

  test("a jingle write failure returns ok:false and does not cache the value", async () => {
    const calls: { entry: string; fields: KeychainField[] }[] = [];
    const keychainStore = fakeKeychainStore(calls, true);
    const { agent } = setup({}, { keychain: fakeKeychain({}), keychainStore });
    const { runId } = await agent.run("ASK_COLOR", { channelId: "chan", requesterId: "owner", credsEntry: "huggingface" });
    await waitUntil(() => agent.stats().waiting === 1);
    const receipt = await agent.saveSecret(runId, "hf_token", "hf_live_super_secret_token");
    expect(receipt.ok).toBe(false);
    expect(receipt.error).toContain("jingle refused the write");
    expect(await agent.evalSecrets(runId)).toEqual({});
  });

  test("saveSecret refuses without throwing when no keychainStore is wired", async () => {
    const { agent } = setup({}, { keychain: fakeKeychain({}) });
    const { runId } = await agent.run("ASK_COLOR", { channelId: "chan", requesterId: "owner", credsEntry: "huggingface" });
    await waitUntil(() => agent.stats().waiting === 1);
    const receipt = await agent.saveSecret(runId, "hf_token", "hf_live_super_secret_token");
    expect(receipt).toEqual({ field: "hf_token", entry: "huggingface", ok: false, error: "the jingle keychain writer is not wired" });
  });
});

describe("durable outcomes and crash recovery", () => {
  test("a run that died in a daemon restart is recorded as a cancellation on recover", async () => {
    const { dir, agent, questions } = setup();
    await agent.run("ASK_COLOR", { channelId: "chan-7", requesterId: "owner" });
    await waitUntil(() => questions.length === 1 && agent.stats().waiting === 1);
    // Simulate a hard crash: a fresh agent over the same beckett dir, no stopAll.
    const revived = setup({}, { dir });
    await revived.agent.recover();
    expect(revived.outcomes).toHaveLength(1);
    expect(revived.outcomes[0]).toMatchObject({
      channelId: "chan-7",
      state: "cancelled",
      restartCancelled: true,
      task: "ASK_COLOR",
    });
    expect(revived.outcomes[0]!.result).toContain("Cancelled because the daemon restarted");
    const ledger = JSON.parse(readFileSync(join(dir, "browser-agent", "runs.json"), "utf8")) as BrowserAgentRun[];
    expect(ledger.every((run) => run.outcomeDelivered)).toBe(true);
  });

  test("an undelivered outcome is retried by recover until the concierge takes it", async () => {
    const { dir, agent } = setup({}, {
      onOutcome: () => {
        throw new Error("concierge offline");
      },
    });
    await agent.run("plain task", { channelId: "chan", requesterId: "owner" });
    await waitUntil(() => agent.stats().running === 0);
    const revived = setup({}, { dir });
    await revived.agent.recover();
    expect(revived.outcomes).toHaveLength(1);
    expect(revived.outcomes[0]!.state).toBe("done");
    const ledger = JSON.parse(readFileSync(join(dir, "browser-agent", "runs.json"), "utf8")) as BrowserAgentRun[];
    expect(ledger.every((run) => run.outcomeDelivered)).toBe(true);
  });

  test("shutdown records each live run as a restart cancellation for the next boot", async () => {
    const failures: string[] = [];
    const { dir, agent } = setup({}, {
      onOutcome: (run) => {
        failures.push(run.runId);
        throw new Error("shutting down");
      },
    });
    await agent.run("ASK_COLOR", { channelId: "chan", requesterId: "owner" });
    await waitUntil(() => agent.stats().waiting === 1);
    await agent.stopAll();
    expect(agent.stats().running + agent.stats().waiting).toBe(0);
    const revived = setup({}, { dir });
    await revived.agent.recover();
    expect(revived.outcomes).toHaveLength(1);
    expect(revived.outcomes[0]).toMatchObject({ state: "cancelled", restartCancelled: true, task: "ASK_COLOR" });
    expect(revived.outcomes[0]!.result).toContain("daemon restarted");
  });

  test("shutdown cancels every concurrent live run and queued dispatch", async () => {
    const { agent, outcomes, questions } = setup({}, { browser: fakeBrowser(2) });
    const first = await agent.run("ASK_COLOR first", { channelId: "chan", requesterId: "owner" });
    const second = await agent.run("ASK_COLOR second", { channelId: "chan", requesterId: "owner" });
    const queued = await agent.run("after deploy", { channelId: "chan", requesterId: "owner" });
    await waitUntil(() => questions.length === 2);
    await agent.stopAll();
    await waitUntil(() => outcomes.length === 3);
    expect(outcomes.map((run) => run.runId).sort()).toEqual([first.runId, second.runId, queued.runId].sort());
    expect(outcomes.every((run) => run.state === "cancelled" && run.restartCancelled)).toBeTrue();
    expect(agent.stats().runs.filter((run) => ["running", "waiting", "queued"].includes(run.state))).toHaveLength(0);
  });

  test("stopAll does not wait forever for an offline question post", async () => {
    const { agent } = setup({}, {
      onQuestion: async () => await new Promise<string>(() => undefined),
    });
    await agent.run("ASK_COLOR", { channelId: "chan", requesterId: "owner" });
    await waitUntil(() => agent.stats().waiting === 1);
    await Promise.race([
      agent.stopAll(),
      Bun.sleep(500).then(() => {
        throw new Error("stopAll hung on question delivery");
      }),
    ]);
    expect(agent.stats().waiting).toBe(0);
  });
});

describe("context sharing", () => {
  test("dispatch-time context rides below the task, framed as background", async () => {
    const { dir, agent, outcomes } = setup();
    const { runId } = await agent.run("post the thread", {
      channelId: "chan",
      requesterId: "owner",
      context: "Jason wants it up before 9am ET; casual tone",
    });
    await waitUntil(() => outcomes.length === 1);
    const input = readFileSync(join(dir, "browser-agent", runId, "input-args.txt"), "utf8");
    expect(input.startsWith("post the thread")).toBe(true);
    expect(input).toContain("Background from the requesting conversation");
    expect(input).toContain("casual tone");
  });

  test("context sits above the secrets preamble and never displaces the task", async () => {
    const keychain = fakeKeychain({ password: "sup3r-secret-pw" });
    const { dir, agent, outcomes } = setup({}, { keychain });
    const { runId } = await agent.run("log in", {
      channelId: "chan",
      requesterId: "owner",
      credsEntry: "x.com",
      context: "the person prefers the annual plan",
    });
    await waitUntil(() => outcomes.length === 1);
    const input = readFileSync(join(dir, "browser-agent", runId, "input-args.txt"), "utf8");
    expect(input.indexOf("log in")).toBe(0);
    expect(input.indexOf("annual plan")).toBeLessThan(input.indexOf("keychain entry"));
  });

  test("contextPreamble marks the task as authoritative", () => {
    expect(contextPreamble("background facts")).toContain("background facts");
    expect(contextPreamble("background facts")).toContain("the task");
  });
});

describe("steering", () => {
  test("a running run queues notes for the next eval and the journal records them", async () => {
    const { agent, outcomes } = setup();
    const { runId } = await agent.run("SLOW lookup", { channelId: "chan", requesterId: "owner" });
    expect(await agent.steer(runId, "prefer the annual plan")).toBe("queued");
    expect(agent.drainSteers(runId)).toEqual(["prefer the annual plan"]);
    // Drained means delivered: a second drain must not repeat the note.
    expect(agent.drainSteers(runId)).toEqual([]);
    const inspection = await agent.inspect(runId, { screenshot: false });
    expect(inspection!.journal.map((event) => event.kind)).toContain("steer");
    await waitUntil(() => outcomes.length === 1, 5_000);
  });

  test("steering a parked run resumes the same session with the note framed as guidance", async () => {
    const { dir, agent, outcomes, questions } = setup();
    const { runId } = await agent.run("ASK_COLOR", { channelId: "chan", requesterId: "owner" });
    await waitUntil(() => questions.length === 1 && agent.stats().waiting === 1);
    expect(await agent.steer(runId, "skip the color step entirely")).toBe("resumed");
    await waitUntil(() => outcomes.length === 1);
    const resumeInput = readFileSync(join(dir, "browser-agent", runId, "input-args-resume.txt"), "utf8");
    expect(resumeInput).toContain("STEERING from the dispatcher");
    expect(resumeInput).toContain("skip the color step entirely");
    expect(outcomes[0]!.state).toBe("done");
  });

  test("steering an unknown or finished run fails plainly", async () => {
    const { agent, outcomes } = setup();
    const { runId } = await agent.run("plain task", { channelId: "chan", requesterId: "owner" });
    await waitUntil(() => outcomes.length === 1);
    await expect(agent.steer(runId, "too late")).rejects.toThrow(/not live/);
    await expect(agent.steer("nope", "x")).rejects.toThrow(/not live/);
  });
});

describe("stop", () => {
  test("cancels a running leg, releases the browser, and reports state cancelled", async () => {
    const browser = fakeBrowser();
    const { agent, outcomes } = setup({}, { browser });
    const { runId } = await agent.run("SLOW forever", { channelId: "chan", requesterId: "owner" });
    await agent.stop(runId, "person cancelled the request");
    await waitUntil(() => outcomes.length === 1);
    expect(outcomes[0]).toMatchObject({ state: "cancelled" });
    expect(outcomes[0]!.result).toContain("person cancelled");
    expect(browser.hasLease(runId)).toBe(false);
    expect(agent.stats().running + agent.stats().waiting).toBe(0);
  });

  test("cancels a parked run without waiting out its question timer", async () => {
    const { agent, outcomes } = setup();
    const { runId } = await agent.run("ASK_COLOR", { channelId: "chan", requesterId: "owner" });
    await waitUntil(() => agent.stats().waiting === 1);
    await agent.stop(runId);
    await waitUntil(() => outcomes.length === 1);
    expect(outcomes[0]!.state).toBe("cancelled");
    expect(outcomes[0]!.result).toContain("stopped by the dispatcher");
  });
});

describe("browser tool attach", () => {
  function countLegs(dir: string, runId: string): number {
    const args = readFileSync(join(dir, "browser-agent", runId, "args.txt"), "utf8");
    // One "--strict-mcp-config" token per leg spawn — the retry loop appends a fresh block each try.
    return args.split("\n").filter((line) => line === "--strict-mcp-config").length;
  }

  test("mcp.json points the browser server at a per-run attach marker", async () => {
    const { dir, agent, outcomes } = setup();
    const { runId } = await agent.run("plain task", { channelId: "chan", requesterId: "owner" });
    await waitUntil(() => outcomes.length === 1);
    const mcp = JSON.parse(readFileSync(join(dir, "browser-agent", runId, "mcp.json"), "utf8"));
    expect(mcp.mcpServers.browser.env.BECKETT_BROWSER_ATTACH_MARKER).toBe(
      join(dir, "browser-agent", runId, "mcp-attached"),
    );
  });

  test("a leg whose browser tool never attaches fails fast as infra, never success or a question", async () => {
    const { dir, agent, outcomes, questions } = setup();
    const { runId } = await agent.run("NO_TOOL post the thread", { channelId: "chan", requesterId: "owner" });
    await waitUntil(() => outcomes.length === 1, 8_000);
    // Never trusts the tool-less leg: not "done" (a bogus success), not "waiting" (a bogus question).
    expect(outcomes[0]!.state).toBe("error");
    expect(outcomes[0]!.result).toContain("failed to attach");
    expect(outcomes[0]!.result).toContain("mcp__browser__betterwright_browser");
    // The contentless needs_input from a tool-less leg must not surface as a human question.
    expect(questions).toHaveLength(0);
    expect(agent.stats().waiting).toBe(0);
    // Bounded retry actually happened rather than a single silent pass-through.
    expect(countLegs(dir, runId)).toBe(3);
    const journal = readFileSync(join(dir, "browser-agent", runId, "journal.jsonl"), "utf8");
    expect(journal).toContain('"attached":false');
  });

  test("a transient attach miss is retried and the run then succeeds", async () => {
    const { dir, agent, outcomes, questions } = setup();
    const { runId } = await agent.run("FLAKY do the thing", { channelId: "chan", requesterId: "owner" });
    await waitUntil(() => outcomes.length === 1);
    expect(outcomes[0]!.state).toBe("done");
    expect(outcomes[0]!.result).toBe("BROWSER:recovered");
    expect(questions).toHaveLength(0);
    // One retry: the first attempt missed the tool, the second attached and completed.
    expect(countLegs(dir, runId)).toBe(2);
  });
});

describe("observability", () => {
  test("the journal narrates the run and inspect returns it with the run state", async () => {
    const { agent, outcomes, questions } = setup();
    const { runId } = await agent.run("ASK_COLOR", { channelId: "chan", requesterId: "owner" });
    await waitUntil(() => questions.length === 1);
    agent.recordEval(runId, { ok: true, ms: 120, url: "https://example.com", pages: 1, screenshots: 0 });
    const parked = await agent.inspect(runId, { screenshot: false });
    expect(parked!.run).toMatchObject({ runId, state: "waiting", question: "Which color should I choose?" });
    const kinds = parked!.journal.map((event) => event.kind);
    expect(kinds).toContain("dispatched");
    expect(kinds).toContain("leg");
    expect(kinds).toContain("eval");
    expect(kinds).toContain("question");
    await agent.resume(runId, "blue");
    await waitUntil(() => outcomes.length === 1);
    const done = await agent.inspect(runId);
    expect(done!.run.state).toBe("done");
    expect(done!.screenshot).toBeNull();
    expect(done!.journal.map((event) => event.kind)).toContain("finished");
    expect(await agent.inspect("unknown-run")).toBeNull();
  });

  test("inspect captures a fresh screenshot while the run holds the lease", async () => {
    const { agent, questions } = setup();
    const { runId } = await agent.run("ASK_COLOR", { channelId: "chan", requesterId: "owner" });
    await waitUntil(() => questions.length === 1);
    const inspection = await agent.inspect(runId);
    expect(inspection!.screenshot).toBeTruthy();
    expect(existsSync(inspection!.screenshot!)).toBe(true);
  });

  test("the journal redacts keychain values and human answers", async () => {
    const keychain = fakeKeychain({ password: "sup3r-secret-pw" });
    const { dir, agent, outcomes, questions } = setup({}, { keychain });
    const { runId } = await agent.run("ASK_COLOR", { channelId: "chan", requesterId: "owner", credsEntry: "x.com" });
    await waitUntil(() => questions.length === 1);
    agent.recordEval(runId, { ok: false, ms: 5, error: "typed sup3r-secret-pw into the wrong field" });
    await agent.resume(runId, "the code is 998877");
    await waitUntil(() => outcomes.length === 1);
    const journal = readFileSync(join(dir, "browser-agent", runId, "journal.jsonl"), "utf8");
    expect(journal).not.toContain("sup3r-secret-pw");
    expect(journal).not.toContain("998877");
  });

  test("stats names each run's task, question, and finish time", async () => {
    const { agent, questions } = setup();
    const { runId } = await agent.run("ASK_COLOR pick something", { channelId: "chan", requesterId: "owner" });
    await waitUntil(() => questions.length === 1);
    const run = agent.stats().runs.find((candidate) => candidate.runId === runId);
    expect(run).toMatchObject({
      state: "waiting",
      task: "ASK_COLOR pick something",
      question: "Which color should I choose?",
      finishedAt: null,
    });
  });
});

describe("redaction", () => {
  test("treats every exact sensitive input as sensitive regardless of strength", () => {
    for (const answer of ["monkey", "abcde", "a!2", "123", "Lee"]) {
      expect(redactKnownBrowserInputs(`The prior answer was ${answer}.`, [answer])).toBe(
        "The prior answer was [redacted].",
      );
    }
    const extracted = redactKnownBrowserInputs("Should I use monkey again?", ["Use monkey"]);
    expect(extracted).not.toContain("monkey");
  });
});

describe("live view", () => {
  test("inspect carries the live-view URL alongside the screenshot when asked", async () => {
    const browser = fakeBrowser();
    browser.liveView = async () => ({ running: true, url: "https://100.108.167.104:7788/#tok" });
    const { agent, questions } = setup({}, { browser });
    const { runId } = await agent.run("ASK_COLOR", { channelId: "chan", requesterId: "owner" });
    await waitUntil(() => questions.length === 1);
    const inspection = await agent.inspect(runId, { live: true });
    expect(inspection!.screenshot).toBeTruthy();
    expect(inspection!.liveViewUrl).toBe("https://100.108.167.104:7788/#tok");
  });

  test("a plain watch never starts live view — it is opt-in per watch", async () => {
    const browser = fakeBrowser();
    let starts = 0;
    browser.liveView = async () => {
      starts++;
      return { running: true, url: "https://100.108.167.104:7788/#tok" };
    };
    const { agent, questions } = setup({}, { browser });
    const { runId } = await agent.run("ASK_COLOR", { channelId: "chan", requesterId: "owner" });
    await waitUntil(() => questions.length === 1);
    const inspection = await agent.inspect(runId);
    expect(inspection!.screenshot).toBeTruthy();
    expect(inspection!.liveViewUrl).toBeNull();
    expect(starts).toBe(0);
  });

  test("a failing live view is attempted once per run, not once per watch", async () => {
    const browser = fakeBrowser();
    let attempts = 0;
    browser.liveView = async () => {
      attempts++;
      throw new Error("no tailscale interface");
    };
    const { agent, questions } = setup({}, { browser });
    const { runId } = await agent.run("ASK_COLOR", { channelId: "chan", requesterId: "owner" });
    await waitUntil(() => questions.length === 1);
    for (let i = 0; i < 3; i++) {
      expect((await agent.inspect(runId, { live: true }))!.liveViewUrl).toBeNull();
    }
    // Memoized: a down expose interface costs one launch attempt for the run's whole life.
    expect(attempts).toBe(1);
  });

  test("a failing live view degrades to screenshot-only with one warn", async () => {
    const warnings: string[] = [];
    const logger = (() => {
      const captured = {
        info() {},
        warn(message: string) {
          warnings.push(message);
        },
        debug() {},
        error() {},
        child() {
          return captured;
        },
      };
      return captured as unknown as Logger;
    })();
    const browser = fakeBrowser();
    browser.liveView = async () => {
      throw new Error("no tailscale interface");
    };
    const { agent, questions } = setup({}, { browser, logger });
    const { runId } = await agent.run("ASK_COLOR", { channelId: "chan", requesterId: "owner" });
    await waitUntil(() => questions.length === 1);
    const inspection = await agent.inspect(runId, { live: true });
    expect(inspection!.screenshot).toBeTruthy();
    expect(inspection!.liveViewUrl).toBeNull();
    expect(warnings.filter((message) => message === "browser watch live view failed")).toHaveLength(1);
  });

  test("a runtime without live view simply reports none", async () => {
    const { agent, questions } = setup();
    const { runId } = await agent.run("ASK_COLOR", { channelId: "chan", requesterId: "owner" });
    await waitUntil(() => questions.length === 1);
    const inspection = await agent.inspect(runId, { live: true });
    expect(inspection!.screenshot).toBeTruthy();
    expect(inspection!.liveViewUrl).toBeNull();
  });
});
