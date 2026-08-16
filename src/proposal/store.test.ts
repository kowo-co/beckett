/**
 * The proposal queue's record half (issue #37): id shape, the one-line claim, the parsed-not-
 * trusted read boundary, the hard-capped session block, and 14-day auto-expiry.
 */

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  PROPOSALS_BLOCK_MAX_LINES,
  PROPOSAL_ID_RE,
  PROPOSAL_TTL_DAYS,
  type Proposal,
  asProposal,
  createProposal,
  listProposals,
  proposalPath,
  readProposal,
  renderProposalsBlock,
  sweepExpiredProposals,
} from "./store.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function sandbox(): string {
  const dir = mkdtempSync(join(tmpdir(), "beckett-proposals-"));
  dirs.push(dir);
  return dir;
}

const NIGHT = new Date("2026-07-26T11:00:00.000Z");
const BASE = {
  kind: "doctrine-change" as const,
  claim: "stop asking for confirmation on read-only commands",
  rationale: "Three turns last night spent confirming a `ls`. The confirmation bought nothing.",
  provenance: ["journal:#31", "channel:123"],
  origin: "dream:2026-07-26",
  now: NIGHT,
};

const daysAfter = (n: number): Date => new Date(NIGHT.getTime() + n * 86_400_000);

// ── shape ──────────────────────────────────────────────────────────────────────────────

test("ids are namespace-locked — traversal and junk never reach the filesystem", () => {
  const dir = sandbox();
  expect(proposalPath(dir, "prop-2026-07-26-x")).toBe(join(dir, "prop-2026-07-26-x.json"));
  for (const bad of ["../persona", "prop-2026-07-26-x.json", "persona", "", "prop-2026-7-6-x", "prop-2026-07-26-x/../../y"]) {
    expect(() => proposalPath(dir, bad)).toThrow(/invalid id/);
  }
});

test("a proposal carries kind, one-line claim, rationale, and provenance", () => {
  const dir = sandbox();
  const p = createProposal(dir, BASE);
  expect(PROPOSAL_ID_RE.test(p.id)).toBe(true);
  expect(p.id.startsWith("prop-2026-07-26-")).toBe(true);
  expect(p).toMatchObject({
    kind: "doctrine-change",
    claim: BASE.claim,
    rationale: BASE.rationale,
    provenance: ["journal:#31", "channel:123"],
    origin: "dream:2026-07-26",
    status: "open",
    decided: null,
    became: null,
  });
  expect(readProposal(dir, p.id)).toEqual(p);
});

test("the claim is one line by construction, and a rationale-sized one is refused", () => {
  const dir = sandbox();
  const p = createProposal(dir, { ...BASE, claim: "  keep\nreplies\tshort  " });
  expect(p.claim).toBe("keep replies short");
  expect(() => createProposal(dir, { ...BASE, claim: "x".repeat(400) })).toThrow(/one line/);
});

test("every field of the contract is required", () => {
  const dir = sandbox();
  expect(() => createProposal(dir, { ...BASE, kind: "whatever" as never })).toThrow(/kind must be one of/);
  expect(() => createProposal(dir, { ...BASE, claim: "   " })).toThrow(/claim is required/);
  expect(() => createProposal(dir, { ...BASE, rationale: "" })).toThrow(/rationale is required/);
  expect(() => createProposal(dir, { ...BASE, provenance: [] })).toThrow(/provenance/);
  expect(() => createProposal(dir, { ...BASE, provenance: ["  "] })).toThrow(/provenance/);
  expect(() => createProposal(dir, { ...BASE, origin: " " })).toThrow(/origin is required/);
});

test("two proposals about the same thing on one night both survive — never an overwrite", () => {
  const dir = sandbox();
  const first = createProposal(dir, BASE);
  const second = createProposal(dir, { ...BASE, rationale: "a second, different argument" });
  expect(second.id).not.toBe(first.id);
  expect(readProposal(dir, first.id)!.rationale).toBe(BASE.rationale);
  expect(readdirSync(dir).length).toBe(2);
});

// ── the read boundary ──────────────────────────────────────────────────────────────────

test("records are parsed, not trusted: invented fields are dropped on the floor", () => {
  const parsed = asProposal("prop-2026-07-26-x", {
    id: "prop-2026-07-26-x",
    kind: "doctrine-change",
    claim: "a claim",
    rationale: "a rationale",
    provenance: ["journal:#1"],
    origin: "dream:2026-07-26",
    created: NIGHT.toISOString(),
    status: "open",
    // Everything below is a record author's invention. None of it survives the read.
    apply: true,
    target: "../../persona.md",
    write: { path: "/etc/passwd", content: "x" },
    autoAccept: true,
  });
  expect(parsed).not.toBeNull();
  expect(Object.keys(parsed!).sort()).toEqual(
    ["became", "calibration", "channel", "claim", "created", "decided", "id", "kind", "note", "origin", "provenance", "rationale", "status"],
  );
});

test("malformed and self-contradicting records are simply absent", () => {
  const dir = sandbox();
  const good = createProposal(dir, BASE);
  const plant = (id: string, body: unknown): void =>
    writeFileSync(join(dir, `${id}.json`), typeof body === "string" ? body : JSON.stringify(body));

  plant("prop-2026-07-20-not-json", "{not json");
  plant("prop-2026-07-20-bad-kind", { ...readProposal(dir, good.id), id: "prop-2026-07-20-bad-kind", kind: "apply-now" });
  plant("prop-2026-07-20-no-claim", { ...readProposal(dir, good.id), id: "prop-2026-07-20-no-claim", claim: "" });
  // An id that disagrees with its own filename is never followed to the id it claims.
  plant("prop-2026-07-20-liar", { ...readProposal(dir, good.id), id: good.id });
  // Open, yet stamped with a decision: a contradiction, not something to normalize.
  plant("prop-2026-07-20-half", { ...readProposal(dir, good.id), id: "prop-2026-07-20-half", decided: NIGHT.toISOString() });

  expect(listProposals(dir, { all: true, now: NIGHT }).map((p) => p.id)).toEqual([good.id]);
  expect(readProposal(dir, "prop-2026-07-20-bad-kind")).toBeNull();
});

// ── listing order ──────────────────────────────────────────────────────────────────────

test("listing is highest-signal kind first, oldest first within a kind", () => {
  const dir = sandbox();
  const spike = createProposal(dir, { ...BASE, kind: "ticket", claim: "spike the retry idea", now: daysAfter(-3) });
  const olderDoctrine = createProposal(dir, { ...BASE, claim: "older doctrine ask", now: daysAfter(-2) });
  const newerDoctrine = createProposal(dir, { ...BASE, claim: "newer doctrine ask", now: daysAfter(-1) });
  const persona = createProposal(dir, { ...BASE, kind: "persona-change", claim: "sound less breathless", now: daysAfter(-5) });
  expect(listProposals(dir, { now: NIGHT }).map((p) => p.id)).toEqual([
    olderDoctrine.id,
    newerDoctrine.id,
    persona.id,
    spike.id,
  ]);
});

test("a product idea is a first-class kind, and it lists above a ticket", () => {
  const dir = sandbox();
  const idea = createProposal(dir, { ...BASE, kind: "product-idea", claim: "a shared watchlist" });
  const spike = createProposal(dir, { ...BASE, kind: "ticket", claim: "spike the retry idea", now: daysAfter(-1) });
  const persona = createProposal(dir, { ...BASE, kind: "persona-change", claim: "sound less breathless", now: daysAfter(-2) });
  const doctrine = createProposal(dir, { ...BASE, claim: "stop asking on read-only commands", now: daysAfter(-3) });
  const correction = createProposal(dir, {
    ...BASE,
    kind: "memory-correction",
    claim: "jason moved off pacific time",
    now: daysAfter(-4),
  });

  expect(() => createProposal(dir, { ...BASE, kind: "whatever" as never })).toThrow(/kind must be one of/);
  expect(listProposals(dir, { now: NIGHT }).map((p) => p.id)).toEqual([
    doctrine.id,
    persona.id,
    correction.id,
    idea.id,
    spike.id,
  ]);
});

test("decided proposals are kept but leave the open list", () => {
  const dir = sandbox();
  const p = createProposal(dir, BASE);
  const stored = readProposal(dir, p.id)!;
  writeFileSync(
    join(dir, `${p.id}.json`),
    JSON.stringify({ ...stored, status: "rejected", decided: NIGHT.toISOString(), note: "not now" } satisfies Proposal),
  );
  expect(listProposals(dir, { now: NIGHT })).toEqual([]);
  expect(listProposals(dir, { all: true, now: NIGHT }).map((x) => x.status)).toEqual(["rejected"]);
  expect(readProposal(dir, p.id)!.note).toBe("not now");
});

// ── the session block ──────────────────────────────────────────────────────────────────

test("the block is silent when there is nothing pending", () => {
  const dir = sandbox();
  expect(renderProposalsBlock(dir, NIGHT)).toBe("");
  expect(renderProposalsBlock(join(dir, "nope"), NIGHT)).toBe("");
  expect(renderProposalsBlock(null, NIGHT)).toBe("");
  createProposal(dir, BASE);
  expect(renderProposalsBlock(dir, NIGHT)).toContain("<open-proposals>");
});

test("the block shows the claim, never the rationale, and caps hard", () => {
  const dir = sandbox();
  for (let i = 0; i < PROPOSALS_BLOCK_MAX_LINES + 4; i++) {
    createProposal(dir, { ...BASE, claim: `claim number ${i}`, rationale: `SECRET RATIONALE ${i}`, now: daysAfter(-i) });
  }
  const block = renderProposalsBlock(dir, NIGHT);
  expect(block).not.toContain("SECRET RATIONALE");
  const claimLines = block.split("\n").filter((l) => l.startsWith("- "));
  expect(claimLines.length).toBe(PROPOSALS_BLOCK_MAX_LINES);
  expect(block).toContain("+4 more");
  expect(block).toContain("beckett proposals ls");
});

test("an unreadable proposals directory never keeps a session from launching", () => {
  const dir = sandbox();
  writeFileSync(join(dir, "prop-2026-07-26-x.json"), "{not json");
  expect(renderProposalsBlock(dir, NIGHT)).toBe("");
  // A file where the directory should be is the harshest version of the same thing.
  const notADir = join(sandbox(), "file");
  writeFileSync(notADir, "x");
  expect(renderProposalsBlock(notADir, NIGHT)).toBe("");
});

// ── expiry ─────────────────────────────────────────────────────────────────────────────

test("an undecided proposal auto-expires after the TTL, with a note and its claim intact", () => {
  const dir = sandbox();
  const p = createProposal(dir, BASE);
  const later = daysAfter(PROPOSAL_TTL_DAYS);

  // Read-time first: the queue never SHOWS a fifteen-day-old proposal as open, swept or not.
  expect(listProposals(dir, { now: daysAfter(PROPOSAL_TTL_DAYS - 1) }).map((x) => x.id)).toEqual([p.id]);
  expect(listProposals(dir, { now: later })).toEqual([]);
  expect(renderProposalsBlock(dir, later)).toBe("");

  const expired = sweepExpiredProposals(dir, later);
  expect(expired.map((x) => x.id)).toEqual([p.id]);
  const stored = readProposal(dir, p.id)!;
  expect(stored.status).toBe("expired");
  expect(stored.claim).toBe(BASE.claim);
  expect(stored.note).toMatch(new RegExp(`${PROPOSAL_TTL_DAYS} days`));
  expect(stored.decided).toBe(later.toISOString());
  // Idempotent, and never deletes: a recurring proposal is visible as recurring.
  expect(sweepExpiredProposals(dir, daysAfter(60))).toEqual([]);
  expect(readProposal(dir, p.id)!.decided).toBe(later.toISOString());
  expect(readFileSync(join(dir, `${p.id}.json`), "utf8")).toContain(BASE.claim);
});

test("a decided proposal is never re-aged by the sweep", () => {
  const dir = sandbox();
  const p = createProposal(dir, BASE);
  const stored = readProposal(dir, p.id)!;
  writeFileSync(
    join(dir, `${p.id}.json`),
    JSON.stringify({ ...stored, status: "accepted", decided: NIGHT.toISOString(), became: "ticket:OPS-9" }),
  );
  expect(sweepExpiredProposals(dir, daysAfter(90))).toEqual([]);
  expect(readProposal(dir, p.id)!.became).toBe("ticket:OPS-9");
});
