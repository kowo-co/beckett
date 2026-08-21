import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendChillTransformLog,
  formatChillTransformLog,
  MAX_RECORDS,
  readChillTransformLog,
  type ChillTransformLogRecord,
} from "./chilltext-log.ts";

function tmpLogPath(): string {
  return join(mkdtempSync(join(tmpdir(), "beckett-chilltext-log-")), "chilltext-transforms.jsonl");
}

function record(overrides: Partial<ChillTransformLogRecord> = {}): ChillTransformLogRecord {
  return {
    ts: "2026-08-18T00:00:00.000Z",
    channelId: "chan-1",
    input: "the user's message",
    agentOutput: "the real reply",
    outcome: "ok",
    durationMs: 42,
    bubbles: [
      {
        rewritten: "yo the reply",
        posted: "yo the reply",
        echoFallback: false,
        echoContentScore: 0.1,
        echoFullScore: 0.1,
      },
    ],
    ...overrides,
  };
}

describe("appendChillTransformLog / readChillTransformLog", () => {
  test("a written record round-trips exactly", () => {
    const path = tmpLogPath();
    const rec = record();
    appendChillTransformLog(path, rec);
    expect(readChillTransformLog(path)).toEqual([rec]);
  });

  test("multiple appends accumulate in order", () => {
    const path = tmpLogPath();
    appendChillTransformLog(path, record({ channelId: "a" }));
    appendChillTransformLog(path, record({ channelId: "b" }));
    appendChillTransformLog(path, record({ channelId: "c" }));
    expect(readChillTransformLog(path).map((r) => r.channelId)).toEqual(["a", "b", "c"]);
  });

  test("a missing file reads as empty", () => {
    expect(readChillTransformLog(join(mkdtempSync(join(tmpdir(), "beckett-chilltext-log-")), "gone.jsonl"))).toEqual([]);
  });

  test("a torn final line is dropped, valid rows still read", () => {
    const path = tmpLogPath();
    appendChillTransformLog(path, record({ channelId: "good" }));
    const body = readFileSync(path, "utf8");
    writeFileSync(path, `${body.trimEnd()}\n{"ts": "broken`);
    expect(readChillTransformLog(path).map((r) => r.channelId)).toEqual(["good"]);
  });

  test("the file is bounded at MAX_RECORDS — oldest rows drop first", () => {
    const path = tmpLogPath();
    for (let i = 0; i < MAX_RECORDS + 25; i++) {
      appendChillTransformLog(path, record({ channelId: `msg-${i}` }));
    }
    const rows = readChillTransformLog(path);
    expect(rows.length).toBe(MAX_RECORDS);
    expect(rows[0]!.channelId).toBe("msg-25"); // the oldest 25 were trimmed off
    expect(rows.at(-1)!.channelId).toBe(`msg-${MAX_RECORDS + 24}`);
  });

  test("a write failure (unwritable directory) is swallowed, never throws", () => {
    // Point the log at a path whose parent is actually a FILE, not a directory — mkdirSync must fail.
    const dir = mkdtempSync(join(tmpdir(), "beckett-chilltext-log-"));
    const blocker = join(dir, "blocker");
    writeFileSync(blocker, "not a directory");
    const path = join(blocker, "chilltext-transforms.jsonl");
    const warnings: Array<[string, unknown]> = [];
    expect(() =>
      appendChillTransformLog(path, record(), { warn: (m: string, f?: unknown) => warnings.push([m, f]) } as any),
    ).not.toThrow();
    expect(warnings.length).toBe(1);
    expect(warnings[0]![0]).toContain("chilltext transform log write failed");
  });
});

describe("appendChillTransformLog / readChillTransformLog — fidelity fields (2026-08-21 incident)", () => {
  test("a dropped surplus bubble and a block-only fallback round-trip with null rewritten/posted", () => {
    const path = tmpLogPath();
    const rec = record({
      bubbles: [
        {
          rewritten: "yeah that's broken. i know why. gimme 10",
          posted: null,
          echoFallback: false,
          echoContentScore: null,
          echoFullScore: null,
          fidelityDropped: true,
        },
        {
          rewritten: null,
          posted: "the real block text",
          echoFallback: false,
          echoContentScore: null,
          echoFullScore: null,
          fidelityFallback: true,
        },
      ],
    });
    appendChillTransformLog(path, rec);
    expect(readChillTransformLog(path)).toEqual([rec]);
  });
});

describe("formatChillTransformLog", () => {
  test("an empty ledger reads as explicitly empty, not a blank string", () => {
    expect(formatChillTransformLog([], 10)).toBe("(no chilltext transforms recorded yet)");
  });

  test("shows the last `tail` records with input/before/after and per-bubble echo info", () => {
    const rows = [
      record({ channelId: "old", agentOutput: "old reply" }),
      record({
        channelId: "new",
        agentOutput: "the real reply beckett meant to send",
        bubbles: [
          {
            rewritten: "an echoed bubble",
            posted: "the real reply beckett meant to send",
            echoFallback: true,
            echoContentScore: 0.91,
            echoFullScore: 0.4,
          },
        ],
      }),
    ];
    const out = formatChillTransformLog(rows, 1);
    expect(out).not.toContain("old reply");
    expect(out).toContain("new");
    expect(out).toContain("the real reply beckett meant to send");
    expect(out).toContain("an echoed bubble");
    expect(out).toContain("ECHO FALLBACK");
    expect(out).toContain("0.91");
  });

  test("a dropped surplus bubble and a block-only fallback render distinctly, not as blank text", () => {
    const rows = [
      record({
        bubbles: [
          {
            rewritten: "yeah that's broken. i know why. gimme 10",
            posted: null,
            echoFallback: false,
            echoContentScore: null,
            echoFullScore: null,
            fidelityDropped: true,
            fidelityScore: 0,
          },
          {
            rewritten: null,
            posted: "the real block text",
            echoFallback: false,
            echoContentScore: null,
            echoFullScore: null,
            fidelityFallback: true,
          },
        ],
      }),
    ];
    const out = formatChillTransformLog(rows, 1);
    expect(out).toContain("(dropped — never posted)");
    expect(out).toContain("(no bubble — block posted verbatim)");
    expect(out).toContain("the real block text");
    expect(out).toContain("FIDELITY DROPPED");
    expect(out).toContain("FIDELITY FALLBACK");
  });
});
