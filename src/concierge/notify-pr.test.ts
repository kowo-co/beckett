/**
 * Coverage for the GitHub PR sense relay (Concierge.notifyPrEvents, OPS-124): a material PR
 * transition becomes ONE automated-update turn per channel, carrying the right --channel, and a PR
 * with no origin channel is dropped silently. Pinned against a fake session like notify.test.ts.
 */
import { expect, test } from "bun:test";
import { Concierge, type ConciergeSession } from "./index.ts";
import type { Config } from "../types.ts";
import type { PrPollEvent, PrRef } from "../github/types.ts";

const CHAN = "1097283746520174592";
const config = { concierge: { model: "m", rotate_at_tokens: 190_000 }, paths: {} } as unknown as Config;

function harness() {
  const asks: string[] = [];
  const session = { ask: (m: string) => { asks.push(m); return Promise.resolve(""); } } as unknown as ConciergeSession;
  const concierge = new Concierge({ config, session, gateway: {} as never });
  return { concierge, asks };
}

const pr = (over: Partial<PrRef> = {}): PrRef => ({
  repo: "0xbeckett/foo",
  number: 96,
  url: "https://github.com/0xbeckett/foo/pull/96",
  title: "Add sense",
  runId: "run-20260810-sense",
  channel: CHAN,
  ...over,
});

test("a requested-changes review relays as one turn with the origin --channel", () => {
  const { concierge, asks } = harness();
  concierge.notifyPrEvents({
    kind: "review",
    pr: pr(),
    review: { id: "r1", author: "ro", state: "CHANGES_REQUESTED", submittedAt: "t", body: "fix the thing" },
  });
  expect(asks.length).toBe(1);
  expect(asks[0]).toContain(`beckett discord reply --channel ${CHAN}`);
  expect(asks[0]).toContain("requested changes");
  expect(asks[0]).toContain("#96");
  expect(asks[0]).toContain("do NOT merge"); // read-and-relay guardrail is stated in the turn
});

test("a CI failure is surfaced loudly", () => {
  const { concierge, asks } = harness();
  concierge.notifyPrEvents({ kind: "ci", pr: pr(), conclusion: "FAILURE" });
  expect(asks.length).toBe(1);
  expect(asks[0]).toContain("CI FAILED");
});

test("a PR with no origin channel is dropped silently (no turn)", () => {
  const { concierge, asks } = harness();
  concierge.notifyPrEvents({ kind: "merged", pr: pr({ channel: undefined }) });
  expect(asks.length).toBe(0);
});

test("a batch of events for the same channel folds into one turn", () => {
  const { concierge, asks } = harness();
  const events: PrPollEvent[] = [
    { kind: "review", pr: pr(), review: { id: "r1", author: "ro", state: "APPROVED", submittedAt: "t", body: "" } },
    { kind: "ci", pr: pr(), conclusion: "SUCCESS" },
    { kind: "merged", pr: pr() },
  ];
  concierge.notifyPrEvents(events);
  expect(asks.length).toBe(1);
  expect(asks[0]).toContain("approved");
  expect(asks[0]).toContain("MERGED");
});

test("events for different channels get one turn each", () => {
  const { concierge, asks } = harness();
  concierge.notifyPrEvents([
    { kind: "merged", pr: pr({ channel: "chan-a", number: 1 }) },
    { kind: "closed", pr: pr({ channel: "chan-b", number: 2 }) },
  ]);
  expect(asks.length).toBe(2);
  expect(asks.some((a) => a.includes("chan-a"))).toBe(true);
  expect(asks.some((a) => a.includes("chan-b"))).toBe(true);
});
