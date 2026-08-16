import { describe, expect, test } from "bun:test";
import { ActivityType, type PresenceData } from "discord.js";
import {
  derivePresence,
  initialPresenceData,
  PresenceController,
  presenceKey,
  toPresenceData,
  type PresenceInputs,
} from "./presence.ts";

const NOTHING: PresenceInputs = {
  degraded: false,
  deployInFlight: false,
  browserRunLive: false,
  branchesInFlight: 0,
};

/** A logger that swallows everything — the controller must never throw regardless. */
const silentLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return silentLogger;
  },
};

describe("derivePresence — state priority", () => {
  test("nothing running → an empty board (idle)", () => {
    const d = derivePresence(NOTHING);
    expect(d).toMatchObject({ text: "an empty board", status: "idle" });
    expect(d.line).toBe("an empty board");
  });

  test("branches in flight → N branches build (online)", () => {
    const d = derivePresence({ ...NOTHING, branchesInFlight: 3 });
    expect(d).toMatchObject({ text: "3 branches build", status: "online" });
  });

  test("active facts compose into one line, highest-priority first", () => {
    const d = derivePresence({ ...NOTHING, deployInFlight: true, browserRunLive: true, branchesInFlight: 2 });
    expect(d.text).toBe("a deploy in flight · a browser run live · 2 branches build");
    expect(d.status).toBe("online");
  });

  test("a browser run and branches compose without a deploy", () => {
    const d = derivePresence({ ...NOTHING, browserRunLive: true, branchesInFlight: 1 });
    expect(d.text).toBe("a browser run live · 1 branch build");
  });

  test("degraded dominates everything and drops the other facts", () => {
    const d = derivePresence({ degraded: true, deployInFlight: true, browserRunLive: true, branchesInFlight: 9 });
    expect(d).toMatchObject({ text: "something break", status: "dnd" });
  });

  test("full ladder, highest-first", () => {
    const ladder: Array<[PresenceInputs, string]> = [
      [{ degraded: true, deployInFlight: true, browserRunLive: true, branchesInFlight: 2 }, "something break"],
      [{ degraded: false, deployInFlight: true, browserRunLive: true, branchesInFlight: 2 }, "a deploy in flight · a browser run live · 2 branches build"],
      [{ degraded: false, deployInFlight: false, browserRunLive: true, branchesInFlight: 2 }, "a browser run live · 2 branches build"],
      [{ degraded: false, deployInFlight: false, browserRunLive: false, branchesInFlight: 2 }, "2 branches build"],
      [{ degraded: false, deployInFlight: false, browserRunLive: false, branchesInFlight: 0 }, "an empty board"],
    ];
    for (const [inputs, text] of ladder) expect(derivePresence(inputs).text).toBe(text);
  });
});

describe("derivePresence — plural", () => {
  test("N=1 is singular 'branch'", () => {
    expect(derivePresence({ ...NOTHING, branchesInFlight: 1 }).text).toBe("1 branch build");
  });

  test("N>1 is plural 'branches'", () => {
    expect(derivePresence({ ...NOTHING, branchesInFlight: 2 }).text).toBe("2 branches build");
    expect(derivePresence({ ...NOTHING, branchesInFlight: 42 }).text).toBe("42 branches build");
  });

  test("negative/fractional counts clamp to the empty board", () => {
    expect(derivePresence({ ...NOTHING, branchesInFlight: -1 }).text).toBe("an empty board");
    expect(derivePresence({ ...NOTHING, branchesInFlight: 0.9 }).text).toBe("an empty board");
    expect(derivePresence({ ...NOTHING, branchesInFlight: 1.9 }).text).toBe("1 branch build");
  });
});

describe("toPresenceData — custom status", () => {
  test("renders as a Custom activity with the line in state, not name", () => {
    const data = toPresenceData(derivePresence({ ...NOTHING, branchesInFlight: 2 }));
    expect(data).toEqual({
      status: "online",
      activities: [{ type: ActivityType.Custom, name: "custom", state: "2 branches build" }],
    });
  });
});

test("initialPresenceData is the nothing-running state", () => {
  expect(initialPresenceData()).toEqual({
    status: "idle",
    activities: [{ type: ActivityType.Custom, name: "custom", state: "an empty board" }],
  });
});

/** Collect what the sink received, with a controllable clock. */
function harness(startMs = 1_000) {
  const presences: PresenceData[] = [];
  let clock = startMs;
  const controller = new PresenceController({
    logger: silentLogger,
    now: () => clock,
    minSendIntervalMs: 15_000,
    sinks: {
      setPresence: (data) => { presences.push(data); },
    },
  });
  return {
    controller,
    presences,
    advance: (ms: number) => { clock += ms; },
  };
}

describe("PresenceController — change-only + rate floor", () => {
  test("emits on connect (first call)", async () => {
    const h = harness();
    await h.controller.update(NOTHING);
    expect(h.presences).toHaveLength(1);
    expect(h.presences[0]?.activities?.[0]?.state).toBe("an empty board");
  });

  test("a presence update with only the gateway sink still emits on change", async () => {
    const h = harness();
    await h.controller.update(NOTHING);
    h.advance(60_000);
    await h.controller.update({ ...NOTHING, branchesInFlight: 2 });
    expect(h.presences).toHaveLength(2);
    expect(h.presences[1]?.activities?.[0]?.state).toBe("2 branches build");
  });

  test("does not re-emit when the derived line is unchanged", async () => {
    const h = harness();
    await h.controller.update(NOTHING);
    h.advance(60_000);
    await h.controller.update({ ...NOTHING, branchesInFlight: 0 }); // same line
    expect(h.presences).toHaveLength(1);
  });

  test("emits again when the line actually changes", async () => {
    const h = harness();
    await h.controller.update(NOTHING);
    h.advance(60_000);
    await h.controller.update({ ...NOTHING, branchesInFlight: 2 });
    expect(h.presences).toHaveLength(2);
    expect(h.presences[1]?.activities?.[0]?.state).toBe("2 branches build");
  });

  test("a change inside the 15s floor is suppressed, then re-sent after the floor", async () => {
    const h = harness();
    await h.controller.update(NOTHING); // send #1 at t=1000
    h.advance(5_000); // t=6000, within floor
    await h.controller.update({ ...NOTHING, branchesInFlight: 1 });
    expect(h.presences).toHaveLength(1); // floored — not sent

    h.advance(15_000); // t=21000, floor cleared; still the pending change
    await h.controller.update({ ...NOTHING, branchesInFlight: 1 });
    expect(h.presences).toHaveLength(2);
    expect(h.presences[1]?.activities?.[0]?.state).toBe("1 branch build");
  });

  test("rapid A→B→A within the floor never leaves presence stuck on a stale line", async () => {
    const h = harness();
    await h.controller.update({ ...NOTHING, branchesInFlight: 1 }); // send A at t=1000
    h.advance(2_000);
    await h.controller.update({ ...NOTHING, branchesInFlight: 2 }); // B — floored
    h.advance(2_000);
    await h.controller.update({ ...NOTHING, branchesInFlight: 1 }); // back to A — still floored
    expect(h.presences).toHaveLength(1); // last sent is still A; no wasted send

    h.advance(15_000);
    await h.controller.update({ ...NOTHING, branchesInFlight: 2 }); // now B, floor cleared
    expect(h.presences).toHaveLength(2);
    expect(h.presences[1]?.activities?.[0]?.state).toBe("2 branches build");
  });
});

describe("PresenceController — failures are contained", () => {
  test("a throwing setPresence sink never throws out of update", async () => {
    const controller = new PresenceController({
      logger: silentLogger,
      now: () => 1_000,
      sinks: {
        setPresence: () => { throw new Error("gateway down"); },
      },
    });
    await expect(controller.update(NOTHING)).resolves.toBeUndefined();
  });
});

test("presenceKey distinguishes status/text", () => {
  const a = derivePresence(NOTHING);
  const b = derivePresence({ ...NOTHING, branchesInFlight: 1 });
  expect(presenceKey(a)).not.toBe(presenceKey(b));
  expect(presenceKey(a)).toBe(presenceKey(derivePresence(NOTHING)));
});
