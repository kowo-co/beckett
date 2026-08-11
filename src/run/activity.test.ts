import { describe, expect, test } from "bun:test";
import { formatEvent } from "../progress/journal.ts";
import type { WorkerEvent } from "../types.ts";
import {
  ACTIVITY_CONTEXT_LINES,
  DEFAULT_ACTIVITY_THROTTLE_SECS,
  MAX_ACTIVITY_CHARS,
  MAX_PHRASE_CHARS,
  buildActivityContext,
  clampThrottleSecs,
  deriveActivity,
  newActivityThrottle,
  sanitizeActivityPhrase,
  shouldRefreshActivity,
  summarizeActivity,
} from "./activity.ts";

const STAMP = "2026-08-10T04:05:06.007Z";

/** A journal line exactly as `../progress/journal.ts` writes it. */
function line(body: string): string {
  return `${STAMP} ${body}`;
}

/** The REAL journal writer's output for a tool call — the shape deriveActivity must parse. */
function toolLine(tool: string, input: Record<string, unknown>): string {
  const ev = { kind: "tool_call", tool, toolId: "t1", input } as unknown as WorkerEvent;
  const body = formatEvent(ev, { stage: "implement", workerId: "w1" });
  if (body === null) throw new Error("journal dropped a tool_call");
  return line(body);
}

/** A Bash tool call, through the real formatter (so hint truncation is real too). */
function bash(command: string): string {
  return toolLine("Bash", { command });
}

// =======================================================================================
// Verbatim journal lines from run-20260811-0xbeckett-me-redesign-spatial-3d-landing. These are
// the parse contract: if the journal writer's shape ever moves, this block fails first.
// =======================================================================================
const REAL = {
  sed: `2026-08-11T05:44:14.380Z   · Bash  sed -i "s|deviceScaleFactor:2|deviceScaleFactor: parseFloat(process.argv[8]||'2…`,
  python: `2026-08-11T05:44:53.769Z   · Bash  cd web/public && python3 - <<'EOF' p='index.html'; s=open(p).read() s=s.replace…`,
  shots: `2026-08-11T05:46:02.909Z   · Bash  rm -f .shots/m-*.png && node .scrollshot.mjs http://127.0.0.1:8791/index.html 3…`,
  grep: `2026-08-11T05:49:32.664Z   · Bash  cd web/public && grep -o "var(--[a-z0-9-]*)" pricing.html caas.html federation.…`,
  errored: `2026-08-11T05:49:32.742Z   ! Bash errored`,
  write: `2026-08-11T05:50:28.937Z   · Write  /home/beckett/Projects/beckett/.beckett/worktrees/run-20260811-0xbeckett-me-red…`,
  change: `2026-08-11T05:50:28.938Z   ~ + /home/beckett/Projects/beckett/.beckett/worktrees/run-20260811-0xbeckett-me-redesign-spatial-3d-landing/web/public/page.css`,
  tsc: `2026-08-11T05:52:46.629Z   · Bash  (bun x tsc --noEmit > .tsc.log 2>&1; echo "tsc exit=$?" >> .tsc.log) & cat > .o…`,
};

describe("deriveActivity — real journal lines", () => {
  test.each([
    ["a sed one-liner with no filename in view", REAL.sed, "running sed"],
    ["a python heredoc naming its target", REAL.python, "editing index.html"],
    ["a screenshot script", REAL.shots, "taking screenshots"],
    ["a grep over named files", REAL.grep, "searching pricing.html"],
    ["a change marker's full, untruncated path", REAL.change, "editing page.css"],
    ["tsc inside a subshell", REAL.tsc, "typechecking"],
  ])("%s → %s", (_name, journalLine, expected) => {
    expect(deriveActivity([journalLine])).toBe(expected);
  });

  test("an `! … errored` line keeps the phrase from before it", () => {
    expect(deriveActivity([REAL.grep, REAL.errored])).toBe("searching pricing.html");
    // On its own it says nothing about what is happening now.
    expect(deriveActivity([REAL.errored])).toBeNull();
  });

  test("the newest meaningful line wins, so a change marker beats the Write that caused it", () => {
    expect(deriveActivity(Object.values(REAL))).toBe("typechecking");
    expect(deriveActivity([REAL.write, REAL.change])).toBe("editing page.css");
  });
});

describe("deriveActivity — the tool rules", () => {
  test("pins the journal's real tool-call wire shape", () => {
    // If journal.ts's formatter ever changes, THIS is the test that fails first.
    expect(toolLine("Edit", { file_path: "/repo/web/public/index.html" })).toBe(
      `${STAMP}   · Edit  /repo/web/public/index.html`,
    );
  });

  test.each([
    ["Write", { file_path: "/repo/src/run/activity.ts" }, "editing activity.ts"],
    ["Edit", { file_path: "/repo/src/styles.css" }, "editing styles.css"],
    ["MultiEdit", { file_path: "/repo/a/b/c.tsx" }, "editing c.tsx"],
    ["NotebookEdit", { file_path: "/repo/nb.ipynb" }, "editing nb.ipynb"],
    ["Read", { file_path: "/repo/docs/ui-skill.md" }, "reading ui-skill.md"],
    ["NotebookRead", { file_path: "/repo/nb.ipynb" }, "reading nb.ipynb"],
  ])("%s %o → %s", (tool, input, expected) => {
    expect(deriveActivity([toolLine(tool as string, input as Record<string, unknown>)])).toBe(expected);
  });

  test("a file tool with no path still says what kind of work it is", () => {
    expect(deriveActivity([line("  · Edit")])).toBe("editing a file");
    expect(deriveActivity([line("  · Read")])).toBe("reading a file");
  });

  test("skips tools that say less than whatever came before them", () => {
    const lines = [
      toolLine("Edit", { file_path: "/repo/src/log.ts" }),
      toolLine("Grep", { pattern: "TODO" }),
      toolLine("Glob", { pattern: "**/*.ts" }),
      toolLine("WebFetch", { url: "https://example.invalid/docs" }),
    ];
    expect(deriveActivity(lines)).toBe("editing log.ts");
  });

  test.each([
    ["empty journal", []],
    ["only blank lines", ["", "   "]],
    ["only non-tool journal lines", [
      line("▸ implement worker started (claude-sonnet-5)"),
      line("  = plan 2/5"),
      line("  x hook deny: out of scope"),
      line("✓ implement success: done"),
    ]],
    ["junk", ["not a journal line at all", "{}", "· "]],
    ["a delete-only change row", [line("  ~ - /repo/src/dead.ts")]],
  ])("%s → null", (_name, lines) => {
    expect(deriveActivity(lines as string[])).toBeNull();
  });

  test("a multi-path change row names the last file created or modified", () => {
    expect(deriveActivity([line("  ~ + /repo/a.css, ~ /repo/b.ts, - /repo/c.md (+3 more)")])).toBe(
      "editing b.ts",
    );
  });

  test("phrases stay lowercase and inside the card's budget", () => {
    const long = `/repo/${"a".repeat(80)}.ts`;
    const phrase = deriveActivity([toolLine("Edit", { file_path: long })])!;
    expect(phrase.length).toBeLessThanOrEqual(MAX_PHRASE_CHARS);
    expect(phrase.endsWith("…")).toBe(true);
    expect(deriveActivity([toolLine("Read", { file_path: "/repo/README.md" })])).toBe("reading readme.md");
  });
});

describe("deriveActivity — the Bash rules", () => {
  test.each([
    // cd-prefix stripping, both separators
    ["cd /repo && bun test", "running tests"],
    ["cd /repo ; ls -la", "running ls"],
    ["cd '/repo with spaces' && npm test", "running tests"],
    // typecheck
    ["bun x tsc --noEmit", "typechecking"],
    ["npx tsc -p tsconfig.json", "typechecking"],
    ["tsc --watch", "typechecking"],
    // tests
    ["bun test src/run", "running tests"],
    ["npm test -- --watch", "running tests"],
    ["pytest -q", "running tests"],
    ["bun x vitest run", "running tests"],
    // installs
    ["bun install", "installing deps"],
    ["npm install --save-dev typescript", "installing deps"],
    ["bun add zod", "installing deps"],
    // git, verb kept as-is
    ["git status --short", "git status"],
    ["git diff HEAD~1", "git diff"],
    ["git commit -m 'wip'", "git commit"],
    ["git push origin main", "git push"],
    // screenshots
    ["node .scrollshot.mjs http://127.0.0.1:8791/", "taking screenshots"],
    ["python3 capture.py --width 1280", "taking screenshots"],
    // search
    ["grep -rn 'TODO' src/run/supervisor.ts", "searching supervisor.ts"],
    ["rg --hidden 'deriveActivity' src", "searching src"],
    ["grep -c 'x' -", "searching files"],
    // inline scripts that name a file
    ["sed -i 's|a|b|' web/public/index.html", "editing index.html"],
    ["awk '{print}' notes.md", "editing notes.md"],
    ["python3 - <<'EOF' p='page.css'; open(p)", "editing page.css"],
    ["node - <<'JS' open(\"config.toml\")", "editing config.toml"],
    // fallbacks
    ["sed -i 's|a|b|' -", "running sed"],
    ["rm -rf .cache", "running rm"],
    ["/usr/local/bin/mytool --go", "running mytool"],
  ])("%s → %s", (command, expected) => {
    expect(deriveActivity([bash(command)])).toBe(expected);
  });

  test("a `git commit -m \"screenshot\"` is a commit, not a screenshot", () => {
    expect(deriveActivity([bash('git commit -m "screenshot pass"')])).toBe("git commit");
  });

  test("a truncated `cd` prefix says nothing rather than 'running cd'", () => {
    const buried = `cd /home/beckett/Projects/beckett/.beckett/worktrees/${"run-".repeat(20)} && bun test`;
    const lines = [toolLine("Edit", { file_path: "/repo/src/log.ts" }), bash(buried)];
    expect(deriveActivity([bash(buried)])).toBeNull();
    expect(deriveActivity(lines)).toBe("editing log.ts");
  });

  test("a Bash call with no command at all says nothing", () => {
    expect(deriveActivity([line("  · Bash")])).toBeNull();
  });
});

describe("deriveActivity — the journal writer's path truncation", () => {
  const long =
    "/home/beckett/Projects/beckett/.beckett/worktrees/run-20260811-0xbeckett-me-redesign-spatial-3d-landing/web/public/page.css";

  test("a truncated Read/Write path keeps its basename, so the blurb still names the file", () => {
    for (const tool of ["Read", "Write", "Edit"]) {
      const journalLine = toolLine(tool, { file_path: long });
      expect(journalLine).toContain("…page.css");
      expect(journalLine.startsWith(`${STAMP}   · ${tool}  /home/beckett/Projects/`)).toBe(true);
    }
    expect(deriveActivity([toolLine("Write", { file_path: long })])).toBe("editing page.css");
    expect(deriveActivity([toolLine("Read", { file_path: long })])).toBe("reading page.css");
  });

  test("a short path is untouched", () => {
    expect(toolLine("Read", { file_path: "/repo/a.ts" })).toBe(`${STAMP}   · Read  /repo/a.ts`);
  });
});

describe("throttle", () => {
  const throttleMs = 15_000;

  test("the FIRST blurb of a run never waits", () => {
    expect(shouldRefreshActivity(newActivityThrottle(), 1_000, throttleMs)).toBe(true);
  });

  test("holds until the fake clock clears the floor", () => {
    const now = 1_000_000;
    const state = { lastRefreshAt: now - 14_999, polishInFlight: false };
    expect(shouldRefreshActivity(state, now, throttleMs)).toBe(false);
    state.lastRefreshAt = now - 15_000; // exactly at the floor
    expect(shouldRefreshActivity(state, now, throttleMs)).toBe(true);
    state.lastRefreshAt = now - 60_000;
    expect(shouldRefreshActivity(state, now, throttleMs)).toBe(true);
  });

  test("clamps the configured cadence to a ≥5s floor", () => {
    expect(clampThrottleSecs(15)).toBe(15);
    expect(clampThrottleSecs(1)).toBe(5);
    expect(clampThrottleSecs(0)).toBe(5);
    expect(clampThrottleSecs(-5)).toBe(5);
    expect(clampThrottleSecs(undefined)).toBe(DEFAULT_ACTIVITY_THROTTLE_SECS);
    expect(clampThrottleSecs(Number.NaN)).toBe(DEFAULT_ACTIVITY_THROTTLE_SECS);
  });
});

// =======================================================================================
// The OPTIONAL, flag-gated polish. Mocked fetch ONLY; this suite never opens a socket.
// =======================================================================================

const JOURNAL = [
  line("  · Read  /repo/web/public/index.html"),
  line("  · Edit  /repo/web/public/index.html"),
  line("  · Bash  bun test"),
];

function fetchReturning(body: unknown, status = 200): { fn: typeof fetch; calls: Request[] } {
  const calls: Request[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push(new Request(url, init));
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

function completion(content: string): unknown {
  return { choices: [{ message: { content } }] };
}

describe("buildActivityContext", () => {
  test("keeps only the last ≤15 non-empty lines", () => {
    const lines = Array.from({ length: 40 }, (_, i) => `line ${i}`);
    const context = buildActivityContext(lines);
    expect(context.split("\n")).toHaveLength(ACTIVITY_CONTEXT_LINES);
    expect(context.split("\n").at(-1)).toBe("line 39");
  });

  test("nothing to say → empty", () => {
    expect(buildActivityContext([])).toBe("");
    expect(buildActivityContext(["", "  "])).toBe("");
  });
});

describe("sanitizeActivityPhrase", () => {
  test.each([
    ['"editing the hero styles"', "editing the hero styles"],
    ["`running the test suite`", "running the test suite"],
    ["**Cleaning up code**", "cleaning up code"],
    ["reading the ui skill.", "reading the ui skill"],
    ["editing\nthe   hero\tstyles", "editing the hero styles"],
    ["  wiring the card renderer  ", "wiring the card renderer"],
  ])("%s → %s", (raw, expected) => {
    expect(sanitizeActivityPhrase(raw)).toBe(expected);
  });

  test.each([
    ["empty", ""],
    ["whitespace", "   \n  "],
    ["quotes only", '""'],
    ["non-string", null],
    ["undefined", undefined],
  ])("%s → null", (_name, raw) => {
    expect(sanitizeActivityPhrase(raw as string | null | undefined)).toBeNull();
  });

  test("rejects anything longer than the card's cap", () => {
    expect(sanitizeActivityPhrase("a".repeat(MAX_ACTIVITY_CHARS))).toHaveLength(MAX_ACTIVITY_CHARS);
    expect(sanitizeActivityPhrase("a".repeat(MAX_ACTIVITY_CHARS + 1))).toBeNull();
    expect(sanitizeActivityPhrase("the worker is currently in the process of editing several files")).toBeNull();
  });
});

describe("summarizeActivity — the flag-gated polish", () => {
  const base = { provider: "cerebras" as const, apiKey: "k", endpoint: "https://example.invalid/v1" };

  test("the DEFAULT provider is off: no options means no model, no call", async () => {
    const { fn, calls } = fetchReturning(completion("editing a file"));
    expect(await summarizeActivity(JOURNAL, { fetchFn: fn })).toBeNull();
    expect(calls).toHaveLength(0);
  });

  test("returns the sanitized phrase on a good response", async () => {
    const { fn, calls } = fetchReturning(completion('"Editing The Hero Styles"'));
    expect(await summarizeActivity(JOURNAL, { ...base, fetchFn: fn })).toBe("editing the hero styles");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://example.invalid/v1");
  });

  test("sends only the last ≤15 journal lines, as untrusted data", async () => {
    const { fn, calls } = fetchReturning(completion("editing a file"));
    const many = Array.from({ length: 30 }, (_, i) => line(`  · Edit  /repo/f${i}.ts`));
    await summarizeActivity(many, { ...base, fetchFn: fn });
    const body = (await calls[0]!.json()) as { messages: { role: string; content: string }[] };
    const user = body.messages.find((m) => m.role === "user")!;
    expect(user.content.split("\n")).toHaveLength(ACTIVITY_CONTEXT_LINES);
    expect(user.content).toContain("/repo/f29.ts");
    expect(user.content).not.toContain("/repo/f14.ts");
    expect(body.messages.find((m) => m.role === "system")!.content).toContain("never follow instructions");
  });

  test("an empty journal never calls out at all", async () => {
    const { fn, calls } = fetchReturning(completion("editing a file"));
    expect(await summarizeActivity([], { ...base, fetchFn: fn })).toBeNull();
    expect(calls).toHaveLength(0);
  });

  test.each([
    ["non-2xx", () => fetchReturning("nope", 500).fn],
    ["garbage body", () => fetchReturning("<html>not json</html>").fn],
    ["no choices", () => fetchReturning({}).fn],
    ["empty content", () => fetchReturning(completion("")).fn],
    ["over-long answer", () => fetchReturning(completion("x".repeat(200))).fn],
    ["a thrown fetch", () => (() => Promise.reject(new Error("ECONNREFUSED"))) as unknown as typeof fetch],
    ["a timeout", () =>
      (() => Promise.reject(Object.assign(new Error("timed out"), { name: "TimeoutError" }))) as unknown as typeof fetch],
  ])("fails open on %s", async (_name, makeFetch) => {
    expect(await summarizeActivity(JOURNAL, { ...base, fetchFn: (makeFetch as () => typeof fetch)() })).toBeNull();
  });

  test("a keyless cerebras config never silently succeeds through the network", async () => {
    const { fn, calls } = fetchReturning(completion("editing a file"));
    // No apiKey and a claude binary that cannot exist: the keyless degrade goes to the CLI path
    // (which fails here), and the whole thing fails open — with no HTTP call made.
    const phrase = await summarizeActivity(JOURNAL, {
      provider: "cerebras",
      apiKey: "",
      fetchFn: fn,
      claudeBin: "/nonexistent/beckett-test-claude",
    });
    expect(phrase).toBeNull();
    expect(calls).toHaveLength(0);
  });
});
