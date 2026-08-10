/**
 * The directed settle window's timing core, pinned exhaustively. Every question the wiring in
 * index.ts asks is answered here, so the wiring itself is one lookup and one branch:
 *
 *   - is the feature off?          → passthrough, always, before any state is read
 *   - is this the first fragment?  → hold for exactly the window
 *   - is the author still typing?  → extend, but never past 2× the window
 *   - is the cap already reached?  → release now, with everything said so far
 *   - whose hold is this anyway?   → one author, one channel, and no other pair
 */

import { expect, test } from "bun:test";
import {
  clampSettleWindowMs,
  decideSettle,
  settleKey,
  DIRECTED_SETTLE_MAX_MS,
  SETTLE_HOLD_CAP_MULTIPLE,
  type SettleHoldState,
} from "./directed-settle.ts";

// ── OFF is off ────────────────────────────────────────────────────────────────────────────

test("a zero window is passthrough — the shipped default never holds anything", () => {
  expect(decideSettle({ windowMs: 0, now: 1_000, existing: null })).toEqual({ kind: "passthrough" });
});

test("a zero window is passthrough even with a hold somehow in flight (config lowered mid-hold)", () => {
  const existing: SettleHoldState = { startedAt: 0, dueAt: 500, folded: 1 };
  expect(decideSettle({ windowMs: 0, now: 100, existing })).toEqual({ kind: "passthrough" });
});

test("a negative or NaN window is passthrough, not a negative timer", () => {
  expect(decideSettle({ windowMs: -1, now: 0, existing: null }).kind).toBe("passthrough");
  expect(decideSettle({ windowMs: Number.NaN, now: 0, existing: null }).kind).toBe("passthrough");
});

// ── the first fragment opens a hold ───────────────────────────────────────────────────────

test("the first directed message holds for exactly the window", () => {
  const d = decideSettle({ windowMs: 800, now: 5_000, existing: null });
  expect(d).toEqual({
    kind: "hold",
    state: { startedAt: 5_000, dueAt: 5_800, folded: 1 },
    delayMs: 800,
  });
});

test("the hold counts itself — one message is one folded message, not zero", () => {
  const d = decideSettle({ windowMs: 100, now: 0, existing: null });
  expect(d.kind === "hold" && d.state.folded).toBe(1);
});

// ── a second fragment extends it ──────────────────────────────────────────────────────────

test("a fragment inside the window restarts the full window from NOW", () => {
  const first = decideSettle({ windowMs: 1_000, now: 0, existing: null });
  expect(first.kind).toBe("hold");
  const second = decideSettle({ windowMs: 1_000, now: 400, existing: (first as { state: SettleHoldState }).state });
  expect(second).toEqual({
    kind: "extend",
    // startedAt is the ANCHOR: it never moves, which is what bounds the cap.
    state: { startedAt: 0, dueAt: 1_400, folded: 2 },
    delayMs: 1_000,
  });
});

test("every fragment increments the fold count", () => {
  let state: SettleHoldState = { startedAt: 0, dueAt: 1_000, folded: 1 };
  for (let i = 2; i <= 4; i++) {
    const d = decideSettle({ windowMs: 1_000, now: 100 * (i - 1), existing: state });
    expect(d.kind).toBe("extend");
    state = (d as { state: SettleHoldState }).state;
    expect(state.folded).toBe(i);
  }
});

// ── the cap: a fast typist cannot delay forever ───────────────────────────────────────────

test("an extension is clipped to 2x the window, measured from the FIRST fragment", () => {
  // Window 1000, hold opened at t=0 → the ceiling is t=2000, full stop.
  const existing: SettleHoldState = { startedAt: 0, dueAt: 1_500, folded: 2 };
  const d = decideSettle({ windowMs: 1_000, now: 1_500, existing });
  expect(d.kind).toBe("extend");
  // now + window would be 2500; the cap wins.
  expect((d as { state: SettleHoldState }).state.dueAt).toBe(2_000);
  expect((d as { delayMs: number }).delayMs).toBe(500);
});

test("SETTLE_HOLD_CAP_MULTIPLE is what the clip is computed from", () => {
  const windowMs = 700;
  // Opened at t=0 and already extended once to t=1000; a fragment at t=800 wants t=1500.
  const existing: SettleHoldState = { startedAt: 0, dueAt: 1_000, folded: 2 };
  const d = decideSettle({ windowMs, now: 800, existing });
  expect((d as { state: SettleHoldState }).state.dueAt).toBe(windowMs * SETTLE_HOLD_CAP_MULTIPLE);
});

test("a fragment landing AT the cap releases immediately rather than arming a zero timer", () => {
  const existing: SettleHoldState = { startedAt: 0, dueAt: 2_000, folded: 3 };
  const d = decideSettle({ windowMs: 1_000, now: 2_000, existing });
  expect(d).toEqual({ kind: "release", state: { startedAt: 0, dueAt: 2_000, folded: 4 } });
});

test("a fragment landing PAST the cap also releases, and still folds in — never dropped", () => {
  const existing: SettleHoldState = { startedAt: 0, dueAt: 2_000, folded: 2 };
  const d = decideSettle({ windowMs: 1_000, now: 9_999, existing });
  expect(d.kind).toBe("release");
  expect((d as { state: SettleHoldState }).state.folded).toBe(3);
});

test("no run of fragments, however fast, can push the release past 2x the window", () => {
  const windowMs = 500;
  const cap = windowMs * SETTLE_HOLD_CAP_MULTIPLE;
  let state: SettleHoldState = { startedAt: 0, dueAt: windowMs, folded: 1 };
  let now = 0;
  let released = false;
  // Someone typing a fragment every 10ms for four seconds of wall clock.
  for (let i = 0; i < 400 && !released; i++) {
    now += 10;
    const d = decideSettle({ windowMs, now, existing: state });
    if (d.kind === "release") {
      released = true;
      expect(d.state.dueAt).toBeGreaterThanOrEqual(cap);
      // Released at the very first arrival on/after the ceiling — not one fragment later.
      expect(d.state.dueAt).toBeLessThan(cap + 10);
      break;
    }
    expect(d.kind).toBe("extend");
    state = (d as { state: SettleHoldState }).state;
    expect(state.dueAt).toBeLessThanOrEqual(cap);
  }
  expect(released).toBe(true);
});

test("a lull longer than the window still caps: the hold's own timer would have fired first", () => {
  // The wiring can only reach decideSettle with an `existing` hold while that hold is unfired, so
  // this is the boundary the core must still answer safely rather than with a negative delay.
  const existing: SettleHoldState = { startedAt: 0, dueAt: 1_000, folded: 1 };
  const d = decideSettle({ windowMs: 1_000, now: 5_000, existing });
  expect(d.kind).toBe("release");
});

// ── whose hold is it ──────────────────────────────────────────────────────────────────────

test("the hold key is the (channel, author) PAIR — never one or the other alone", () => {
  expect(settleKey("chan-a", "alice")).toBe(settleKey("chan-a", "alice"));
  // A second author in the same channel gets their own hold: their question is not alice's burst.
  expect(settleKey("chan-a", "alice")).not.toBe(settleKey("chan-a", "bob"));
  // The same author in another channel is another conversation.
  expect(settleKey("chan-a", "alice")).not.toBe(settleKey("chan-b", "alice"));
});

test("ids that differ only where they are split cannot collide into one hold", () => {
  expect(settleKey("a b", "c")).not.toBe(settleKey("a", "b c"));
});

// ── the clamp ─────────────────────────────────────────────────────────────────────────────

test("clampSettleWindowMs floors at off and ceilings at the max", () => {
  expect(clampSettleWindowMs(0, DIRECTED_SETTLE_MAX_MS)).toBe(0);
  expect(clampSettleWindowMs(-50, DIRECTED_SETTLE_MAX_MS)).toBe(0);
  expect(clampSettleWindowMs(800, DIRECTED_SETTLE_MAX_MS)).toBe(800);
  expect(clampSettleWindowMs(60_000, DIRECTED_SETTLE_MAX_MS)).toBe(DIRECTED_SETTLE_MAX_MS);
  // A non-finite window degrades to OFF, not to the ceiling: "hold forever" is the one reading of
  // Infinity, and never answering is worse than never holding.
  expect(clampSettleWindowMs(Number.NaN, DIRECTED_SETTLE_MAX_MS)).toBe(0);
  expect(clampSettleWindowMs(Number.POSITIVE_INFINITY, DIRECTED_SETTLE_MAX_MS)).toBe(0);
  // A fractional value becomes a whole number of milliseconds, not a fractional timer.
  expect(clampSettleWindowMs(120.9, DIRECTED_SETTLE_MAX_MS)).toBe(120);
});
