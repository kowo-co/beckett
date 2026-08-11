/**
 * Deciding a proposal (issue #37): accept ROUTES through a normal front door and stamps what it
 * became; reject requires a reason and moves the bar; nothing re-decides, nothing decides late.
 */

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ACCEPT_ROUTE, DREAM_CALIBRATION_CHANNEL, acceptProposal, pendingProposals, rejectProposal } from "./decide.ts";
import { PROPOSAL_KINDS, PROPOSAL_TTL_DAYS, createProposal, listProposals, readProposal } from "./store.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function sandbox(): string {
  const dir = mkdtempSync(join(tmpdir(), "beckett-decide-"));
  dirs.push(dir);
  return dir;
}

const NIGHT = new Date("2026-07-26T11:00:00.000Z");
const BASE = {
  kind: "doctrine-change" as const,
  claim: "stop asking for confirmation on read-only commands",
  rationale: "Three turns last night spent confirming a `ls`.",
  provenance: ["journal:#31"],
  origin: "dream:2026-07-26",
  now: NIGHT,
};

/** Recording stand-ins for the two front doors and the calibration ledger. */
function harness(dir: string) {
  const filed: Array<{ title: string; body: string; criteria: string[] }> = [];
  const branched: Array<{ title: string; body: string }> = [];
  const calibrated: Array<{ channel: string; about: string; reason: string; source: string }> = [];
  return {
    filed,
    branched,
    calibrated,
    accept: {
      proposalsDir: dir,
      now: () => NIGHT,
      deployRun: async (input: { title: string; body: string; criteria: string[] }) => {
        filed.push(input);
        return { runId: "run-20260810-doctrine", url: "https://github.com/kowo-co/beckett/pull/42" };
      },
      createTaskBranch: async (input: { title: string; body: string }) => {
        branched.push(input);
        return { taskRef: "#12", branchRef: "#12.1" };
      },
    },
    reject: {
      proposalsDir: dir,
      now: () => NIGHT,
      recordCalibration: async (input: { channel: string; about: string; reason: string; source: string }) => {
        calibrated.push(input);
        return { name: `cal-${calibrated.length}` };
      },
    },
  };
}

// ── routing ────────────────────────────────────────────────────────────────────────────

test("every kind routes to a normal front door — there is no third destination", () => {
  expect(Object.keys(ACCEPT_ROUTE).sort()).toEqual([...PROPOSAL_KINDS].sort());
  expect(new Set(Object.values(ACCEPT_ROUTE))).toEqual(new Set(["run", "task"]));
});

test("accepting a doctrine change DEPLOYS A RUN and stamps what it became", async () => {
  const dir = sandbox();
  const h = harness(dir);
  const p = createProposal(dir, BASE);
  const result = await acceptProposal(h.accept, p.id);

  expect(result.route).toBe("run");
  expect(result.became).toBe("run:run-20260810-doctrine");
  expect(h.branched).toEqual([]);
  expect(h.filed.length).toBe(1);
  expect(h.filed[0]!.title).toBe(`doctrine-change: ${BASE.claim}`);
  expect(h.filed[0]!.criteria).toEqual([BASE.claim]);
  // The filed body carries the claim, the argument, and the receipts back to the pipeline.
  expect(h.filed[0]!.body).toContain(BASE.rationale);
  expect(h.filed[0]!.body).toContain("journal:#31");
  expect(h.filed[0]!.body).toContain(p.id);

  const stored = readProposal(dir, p.id)!;
  expect(stored.status).toBe("accepted");
  expect(stored.became).toBe("run:run-20260810-doctrine");
  expect(stored.decided).toBe(NIGHT.toISOString());
  expect(listProposals(dir, { now: NIGHT })).toEqual([]);
});

test("a persona change deploys a run too; a ticket or memory correction becomes a task branch", async () => {
  const dir = sandbox();
  const h = harness(dir);
  const persona = createProposal(dir, { ...BASE, kind: "persona-change", claim: "sound less breathless at night" });
  const spike = createProposal(dir, { ...BASE, kind: "ticket", claim: "spike the retry idea" });
  const correction = createProposal(dir, { ...BASE, kind: "memory-correction", claim: "jason moved off pacific time" });

  expect((await acceptProposal(h.accept, persona.id)).route).toBe("run");
  expect((await acceptProposal(h.accept, spike.id)).became).toBe("task:#12.1");
  expect((await acceptProposal(h.accept, correction.id)).became).toBe("task:#12.1");
  expect(h.filed.map((f) => f.title)).toEqual(["persona-change: sound less breathless at night"]);
  expect(h.branched.map((b) => b.title)).toEqual(["spike the retry idea", "jason moved off pacific time"]);
});

test("a failed route leaves the proposal open rather than claiming it became something", async () => {
  const dir = sandbox();
  const p = createProposal(dir, BASE);
  const deps = {
    proposalsDir: dir,
    now: () => NIGHT,
    deployRun: async () => {
      throw new Error("the run ledger is unwritable");
    },
    createTaskBranch: async () => ({ taskRef: "#1", branchRef: "#1.1" }),
  };
  await expect(acceptProposal(deps, p.id)).rejects.toThrow(/the run ledger is unwritable/);
  expect(readProposal(dir, p.id)!.status).toBe("open");

  // A front door that answers with nothing is the same failure, not a silent accept.
  const empty = { ...deps, deployRun: async () => ({ runId: "  " }) };
  await expect(acceptProposal(empty, p.id)).rejects.toThrow(/no run id/);
  expect(readProposal(dir, p.id)!.status).toBe("open");
});

// ── rejection ──────────────────────────────────────────────────────────────────────────

test("rejection requires a reason, keeps the record, and writes a calibration record", async () => {
  const dir = sandbox();
  const h = harness(dir);
  const p = createProposal(dir, BASE);

  await expect(rejectProposal(h.reject, p.id, "   ")).rejects.toThrow(/--why/);
  expect(readProposal(dir, p.id)!.status).toBe("open");

  const result = await rejectProposal(h.reject, p.id, "confirmation on destructive reads is the point");
  expect(result.calibration).toBe("cal-1");
  expect(h.calibrated[0]).toMatchObject({
    channel: DREAM_CALIBRATION_CHANNEL,
    // The join key is the CLASS of proposal, so the same SHAPE is weighed differently next time.
    about: "proposal-doctrine-change",
    source: `proposal:${p.id}`,
  });
  expect(h.calibrated[0]!.reason).toContain("confirmation on destructive reads is the point");

  const stored = readProposal(dir, p.id)!;
  expect(stored.status).toBe("rejected");
  expect(stored.note).toBe("confirmation on destructive reads is the point");
  expect(stored.calibration).toBe("cal-1");
  // Rejection is signal, not deletion — the claim survives with its reason attached.
  expect(stored.claim).toBe(BASE.claim);
});

test("a proposal about a room is calibrated in THAT room, and --about can sharpen the class", async () => {
  const dir = sandbox();
  const h = harness(dir);
  const p = createProposal(dir, { ...BASE, channel: "1520986792373911622" });
  await rejectProposal(h.reject, p.id, "not in this channel", { about: "late-night-doctrine-nudge" });
  expect(h.calibrated[0]).toMatchObject({ channel: "1520986792373911622", about: "late-night-doctrine-nudge" });
});

test("an unwritable calibration ledger fails the reject loudly instead of dropping the signal", async () => {
  const dir = sandbox();
  const p = createProposal(dir, BASE);
  const deps = {
    proposalsDir: dir,
    now: () => NIGHT,
    recordCalibration: async () => {
      throw new Error("memory dir is read-only");
    },
  };
  await expect(rejectProposal(deps, p.id, "no")).rejects.toThrow(/read-only/);
  expect(readProposal(dir, p.id)!.status).toBe("open");

  const silent = { ...deps, recordCalibration: async () => ({ name: "" }) };
  await expect(rejectProposal(silent, p.id, "no")).rejects.toThrow(/calibration record .* was not written/);
  expect(readProposal(dir, p.id)!.status).toBe("open");
});

// ── the transitions that must not exist ────────────────────────────────────────────────

test("nothing is decided twice", async () => {
  const dir = sandbox();
  const h = harness(dir);
  const p = createProposal(dir, BASE);
  await acceptProposal(h.accept, p.id);
  await expect(acceptProposal(h.accept, p.id)).rejects.toThrow(/already accepted \(run:run-20260810-doctrine\)/);
  await expect(rejectProposal(h.reject, p.id, "changed my mind")).rejects.toThrow(/already accepted/);
  expect(h.filed.length).toBe(1);
});

test("an expired proposal cannot be accepted two weeks late — it gets re-proposed instead", async () => {
  const dir = sandbox();
  const h = harness(dir);
  const late = new Date(NIGHT.getTime() + PROPOSAL_TTL_DAYS * 86_400_000);
  const p = createProposal(dir, BASE);
  const deps = { ...h.accept, now: () => late };
  await expect(acceptProposal(deps, p.id)).rejects.toThrow(/expired undecided/);
  expect(h.filed).toEqual([]);
  // And the refusal stamps the expiry, so the queue is honest on disk afterwards.
  expect(readProposal(dir, p.id)!.status).toBe("expired");
  await expect(rejectProposal({ ...h.reject, now: () => late }, p.id, "too late")).rejects.toThrow(/expired|already/);
});

test("a missing or malformed id decides nothing", async () => {
  const dir = sandbox();
  const h = harness(dir);
  await expect(acceptProposal(h.accept, "prop-2026-07-26-ghost")).rejects.toThrow(/no such proposal/);
  await expect(acceptProposal(h.accept, "../../persona")).rejects.toThrow(/invalid id/);
  await expect(rejectProposal(h.reject, "../../persona", "no")).rejects.toThrow(/invalid id/);
  expect(h.filed).toEqual([]);
  expect(h.calibrated).toEqual([]);
});

test("pendingProposals sweeps first, so what it returns is what is on disk", () => {
  const dir = sandbox();
  createProposal(dir, BASE);
  const fresh = createProposal(dir, { ...BASE, claim: "a newer ask", now: new Date(NIGHT.getTime() + 13 * 86_400_000) });
  const open = pendingProposals(dir, new Date(NIGHT.getTime() + PROPOSAL_TTL_DAYS * 86_400_000));
  expect(open.map((p) => p.id)).toEqual([fresh.id]);
  expect(listProposals(dir, { all: true }).filter((p) => p.status === "expired").length).toBe(1);
});
