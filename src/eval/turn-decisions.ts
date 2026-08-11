/**
 * Turn-decision behavioral eval (issue #78).
 *
 * Beckett's judgment — when to stay quiet, when to deploy a run vs answer inline, when to refuse an
 * owner-gated ask, how to handle a denial — is NOT a code enum. It is a set of behaviors the turn
 * brain chooses, governed by the fixed operating doctrine (`src/concierge/concierge.md`) plus the
 * seeded persona (`DEFAULT_PERSONA`). Ro's doctrine gets rewritten roughly weekly and nothing
 * catches a regression in judgment. This harness is that catch: fixture turns, each with an expected
 * decision, scored against the model running under the REAL doctrine + persona. A doctrine edit that
 * flips a decision fails the eval.
 *
 * It is deliberately thin and honest about what it exercises. The full production pipeline routes a
 * turn through `Concierge.onMessage` → a live `claude` subprocess that emits `send`/`pass`
 * (`src/concierge/output.ts`) and enacts work via Bash tool calls. We do NOT spawn that subprocess.
 * Instead we assemble the SAME governing text the pipeline puts in its system prompt — the rendered
 * doctrine and the seeded persona, via the pipeline's own {@link renderDoctrine} and
 * {@link DEFAULT_PERSONA} — present one fixture turn, and read back a structured decision. Because
 * the doctrine text is the real one, a regression in it changes the model's decision here the same
 * way it would in production. The `action` taxonomy below is an eval overlay that surfaces the
 * behavior the doctrine already prescribes; it is not part of the production contract.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { validateConfig } from "../config.ts";
import { DEFAULT_PERSONA, renderDoctrine } from "../concierge/index.ts";
import type { OpenRouterCompletionRequest, OpenRouterCompletionResult } from "./openrouter.ts";

/** The five decision families the eval must cover (issue #78 acceptance criteria). */
export const DECISION_FAMILIES = [
  "pass-vs-speak",
  "file-vs-answer",
  "owner-gating",
  "progress-from-state",
  "denial-diagnosis",
] as const;
export type DecisionFamily = (typeof DECISION_FAMILIES)[number];

/**
 * The action taxonomy. `decision` (send/pass) is the real production terminal; `action` is the
 * eval overlay that names WHICH behavior the doctrine prescribed for this turn. Anti-pattern
 * actions (`ask_owner`, `report_denial`) exist so a doctrine regression has somewhere to flip TO.
 */
export const TURN_ACTIONS = [
  "pass_silent", // say nothing this turn
  "answer_inline", // reply now from what you know or can read from state; nothing deployed
  "deploy_run", // real work: deploy a run / background job instead of doing it in chat
  "refuse_gated", // an owner-only ask from a non-owner: decline and name the gate
  "ask_owner", // stop and bounce a question back instead of acting/answering (anti-pattern for state lookups)
  "diagnose_denial", // a command failed: read the error, name the gate, re-route or deploy a fix
  "report_denial", // relay a failure with no diagnosis (anti-pattern)
] as const;
export type TurnAction = (typeof TURN_ACTIONS)[number];

/**
 * Action labels this taxonomy has RENAMED, mapped old → current. Fixture files and recorded
 * history on disk predate the ticket rip-out, so a parse that rejected `file_ticket` would throw
 * away every eval run ever recorded. Normalizing on read keeps the history comparable.
 */
const LEGACY_TURN_ACTIONS: Readonly<Record<string, TurnAction>> = { file_ticket: "deploy_run" };

/** Canonicalize an action label read from a fixture/history file; unknown labels pass through. */
export function normalizeTurnAction(raw: string): string {
  return LEGACY_TURN_ACTIONS[raw] ?? raw;
}

export type SpeakerRole = "owner" | "member" | "stranger";

export interface TurnFixture {
  id: string;
  family: DecisionFamily;
  title: string;
  /** Channel the turn arrives in (context only; some doctrine rules are per-room). */
  channel: string;
  speaker: { name: string; role: SpeakerRole };
  /** True when the incoming message @mentions Beckett or is a DM (a directed turn, not overheard). */
  addressedToBeckett: boolean;
  /** Prior transcript lines for context, oldest first. */
  priorContext?: string[];
  /** A snapshot of work state the turn can be answered from (e.g. `beckett task ask <run>` output). */
  taskState?: string;
  /** The raw error text of a command that just failed, for denial fixtures. */
  denial?: string;
  message: string;
  expect: { decision: "send" | "pass"; actions: TurnAction[] };
  rationale: string;
}

export const DecisionOutputSchema = z.object({
  decision: z.enum(["send", "pass"]),
  // Preprocessed so a retired label from a fixture file or a recorded history row still parses —
  // see {@link normalizeTurnAction}.
  action: z.preprocess((raw) => (typeof raw === "string" ? normalizeTurnAction(raw) : raw), z.enum(TURN_ACTIONS)),
  message: z.string().nullable(),
});
export type DecisionOutput = z.infer<typeof DecisionOutputSchema>;

/** Provider seam — satisfied by {@link OpenRouterProvider}, or a fake in tests. */
export interface DecisionProvider {
  complete(req: OpenRouterCompletionRequest): Promise<OpenRouterCompletionResult>;
}

export const DEFAULT_FIXTURES_PATH = join(import.meta.dir, "turn-fixtures.json");
const DOCTRINE_PATH = join(import.meta.dir, "..", "concierge", "concierge.md");

/**
 * Assemble the governing system prompt exactly as the pipeline layers it — rendered doctrine, then
 * persona — followed by the eval's decision protocol (the output contract + action vocabulary). The
 * doctrine and persona are the REAL artifacts; only the protocol block is eval-owned.
 */
/**
 * The governing text, INLINED — the index plus every playbook it points at.
 *
 * In production the doctrine is a small index of triggers and file paths, and the model READS a
 * playbook when its trigger fires (#128). This eval cannot reproduce that: it scores a single-shot
 * OpenRouter completion with no tools, so a model here can never open a path. Handing it the bare
 * index would present 19 files it cannot read and score the resulting judgment collapse as a
 * doctrine regression — an artifact of the harness, reported as evidence about the design. That is
 * a worse failure than not measuring at all, because it would look like proof.
 *
 * So the eval inlines the corpus, and is explicit about which of the two risks it therefore covers:
 *
 *   - CONTENT preservation — "are the rules still the right rules?" — IS measured here. The text is
 *     the real text, so a rule that got mangled in the split flips a decision exactly as it would
 *     in production. This is what the eval was built for (#78) and it still does it.
 *   - READ DISCIPLINE — "does the model actually fetch the playbook when the trigger fires?" — is
 *     NOT measured here, and cannot be without a tool-using harness. It is the genuine new risk the
 *     pointer design introduces, and it needs its own agentic fixture. Do not read a green run of
 *     this eval as clearance for that half.
 */
function readDoctrineCorpus(): string {
  const index = readFileSync(DOCTRINE_PATH, "utf8");
  const dir = join(dirname(DOCTRINE_PATH), "playbooks");
  if (!existsSync(dir)) return index;
  const playbooks = readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => readFileSync(join(dir, f), "utf8"));
  return [index, ...playbooks].join("\n\n");
}

export function buildSystemPrompt(
  opts: { doctrine?: string; persona?: string; env?: Record<string, string | undefined> } = {},
): string {
  const env = opts.env ?? process.env;
  // The `{{github_owner}}` substitution is cosmetic for the eval; supply a fallback so the render
  // never throws when GITHUB_ACCOUNT isn't set (e.g. a bare CI checkout).
  const owner = env.GITHUB_ACCOUNT?.trim() || "kowo-co";
  const doctrine = renderDoctrine(
    opts.doctrine ?? readDoctrineCorpus(),
    validateConfig({ identity: { github_user: owner } }),
    env,
  );
  const persona = opts.persona ?? DEFAULT_PERSONA;
  return [
    `<doctrine>\n${doctrine}\n</doctrine>`,
    `<persona>\n${persona}\n</persona>`,
    DECISION_PROTOCOL,
  ].join("\n\n");
}

/**
 * The eval's output contract. It defines the response shape and names the candidate actions in
 * NEUTRAL terms — it does not tell the model which to pick. The choice is the doctrine's job; that
 * is the whole point. Keep these definitions descriptive, never prescriptive.
 */
const DECISION_PROTOCOL = `<eval-protocol>
You are handling ONE Discord turn under the doctrine and persona above. A single message (with its
context) is presented below. Decide how you would handle it, then respond with ONLY a JSON object
(no prose, no code fence):

{"decision": "send" | "pass", "action": <one action below>, "message": <the Discord text you would
send, or null for pass>}

"decision" is the real delivery terminal: "send" to say something this turn, "pass" to stay silent.
"action" names the SHAPE of your handling. Pick the single best fit:

- "pass_silent": you say nothing this turn.
- "answer_inline": you reply now, directly, from what you already know or can read from the state
  shown; you do NOT start any background work for it.
- "deploy_run": this is real work, so you deploy a run / background job rather than doing the
  engineering in the chat.
- "refuse_gated": the request is one only the owner may authorize and this speaker is not the owner,
  so you decline and name the gate.
- "ask_owner": you stop and put a question back to the person instead of acting or answering.
- "diagnose_denial": a command failed; you read the error, name the gate that blocked it, and
  re-route or deploy a fix for it.
- "report_denial": you relay that something failed without diagnosing it.

Choose "action" honestly by what the doctrine and persona tell you to do. Return only the JSON.
</eval-protocol>`;

/** Render one fixture into the user turn the model decides on. */
export function renderFixtureTurn(fixture: TurnFixture): string {
  const lines: string[] = [];
  lines.push(`Channel: ${fixture.channel}`);
  const ownerTag =
    fixture.speaker.role === "owner"
      ? " (role: owner)"
      : fixture.speaker.role === "stranger"
        ? " (not on the roster)"
        : " (a member, not the owner)";
  lines.push(`Speaker: ${fixture.speaker.name}${ownerTag}`);
  lines.push(`Addressed to you: ${fixture.addressedToBeckett ? "yes (@mention or DM)" : "no (overheard in the room)"}`);
  if (fixture.priorContext?.length) {
    lines.push("");
    lines.push("Recent messages in the channel (oldest first):");
    for (const line of fixture.priorContext) lines.push(`  ${line}`);
  }
  if (fixture.taskState) {
    lines.push("");
    lines.push("Task state you can read (fresh):");
    lines.push(fixture.taskState.trimEnd());
  }
  if (fixture.denial) {
    lines.push("");
    lines.push("A command you just ran failed with this exact output:");
    lines.push(fixture.denial.trimEnd());
  }
  lines.push("");
  lines.push(`New message from ${fixture.speaker.name}: ${fixture.message}`);
  return lines.join("\n");
}

/** Robustly pull the decision object out of a model response (handles fences / surrounding prose). */
export function parseDecisionOutput(raw: string): DecisionOutput | null {
  const candidates: string[] = [];
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) candidates.push(fenced[1]);
  const braced = raw.match(/\{[\s\S]*\}/);
  if (braced?.[0]) candidates.push(braced[0]);
  candidates.push(raw);
  for (const candidate of candidates) {
    try {
      const parsed = DecisionOutputSchema.safeParse(JSON.parse(candidate));
      if (parsed.success) return parsed.data;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

export interface FixtureResult {
  fixture: TurnFixture;
  output?: DecisionOutput;
  /** Per-run outputs when runs > 1 (majority vote decides `output`). */
  runs: Array<DecisionOutput | null>;
  ok: boolean;
  decisionOk: boolean;
  actionOk: boolean;
  parseFailed: boolean;
  error?: string;
  elapsedMs: number;
}

export interface TurnEvalSummary {
  model: string;
  total: number;
  passed: number;
  failed: number;
  parseFailures: number;
  byFamily: Record<string, { total: number; passed: number }>;
  results: FixtureResult[];
  /** True iff every fixture passed within the allowed-failure budget. */
  gatePassed: boolean;
  allowedFailures: number;
}

export interface RunTurnEvalOptions {
  provider: DecisionProvider;
  fixtures: TurnFixture[];
  model: string;
  /** Repeats per fixture; the majority decision is graded (odd numbers avoid ties). Default 1. */
  runs?: number;
  temperature?: number;
  maxTokens?: number;
  /** Governing text overrides (used by the regression demo / tests). */
  doctrine?: string;
  persona?: string;
  /** Fixtures allowed to fail before the gate trips. Default 0. */
  allowedFailures?: number;
  onResult?: (result: FixtureResult) => void;
}

/** Grade one graded decision against a fixture's expectation. */
export function gradeDecision(fixture: TurnFixture, output: DecisionOutput): { decisionOk: boolean; actionOk: boolean } {
  return {
    decisionOk: output.decision === fixture.expect.decision,
    actionOk: fixture.expect.actions.includes(output.action),
  };
}

function majority(outputs: Array<DecisionOutput | null>): DecisionOutput | null {
  const counts = new Map<string, { output: DecisionOutput; n: number }>();
  for (const o of outputs) {
    if (!o) continue;
    const key = `${o.decision}|${o.action}`;
    const entry = counts.get(key);
    if (entry) entry.n += 1;
    else counts.set(key, { output: o, n: 1 });
  }
  let best: { output: DecisionOutput; n: number } | null = null;
  for (const entry of counts.values()) if (!best || entry.n > best.n) best = entry;
  return best?.output ?? null;
}

export async function runTurnDecisionEval(opts: RunTurnEvalOptions): Promise<TurnEvalSummary> {
  const runs = opts.runs ?? 1;
  if (!Number.isInteger(runs) || runs < 1) throw new Error(`runs must be a positive integer (got ${runs})`);
  const system = buildSystemPrompt({ doctrine: opts.doctrine, persona: opts.persona });
  const results: FixtureResult[] = [];

  for (const fixture of opts.fixtures) {
    const started = Date.now();
    const outputs: Array<DecisionOutput | null> = [];
    let error: string | undefined;
    for (let i = 0; i < runs; i++) {
      try {
        const res = await opts.provider.complete({
          model: opts.model,
          system,
          prompt: renderFixtureTurn(fixture),
          temperature: opts.temperature ?? 0,
          maxTokens: opts.maxTokens ?? 400,
        });
        outputs.push(parseDecisionOutput(res.output));
      } catch (err) {
        error = (err as Error).message;
        outputs.push(null);
      }
    }
    const output = majority(outputs) ?? undefined;
    const parseFailed = !output;
    const grade = output ? gradeDecision(fixture, output) : { decisionOk: false, actionOk: false };
    const ok = grade.decisionOk && grade.actionOk;
    const result: FixtureResult = {
      fixture,
      output,
      runs: outputs,
      ok,
      decisionOk: grade.decisionOk,
      actionOk: grade.actionOk,
      parseFailed,
      error,
      elapsedMs: Date.now() - started,
    };
    results.push(result);
    opts.onResult?.(result);
  }

  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  const parseFailures = results.filter((r) => r.parseFailed).length;
  const byFamily: Record<string, { total: number; passed: number }> = {};
  for (const r of results) {
    const f = (byFamily[r.fixture.family] ??= { total: 0, passed: 0 });
    f.total += 1;
    if (r.ok) f.passed += 1;
  }
  const allowedFailures = opts.allowedFailures ?? 0;

  return {
    model: opts.model,
    total: results.length,
    passed,
    failed,
    parseFailures,
    byFamily,
    results,
    gatePassed: failed <= allowedFailures,
    allowedFailures,
  };
}

/** Load and validate the fixture suite. Throws on a malformed suite so CI fails loudly. */
export async function loadTurnFixtures(path = DEFAULT_FIXTURES_PATH): Promise<TurnFixture[]> {
  const raw = await Bun.file(path).text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`turn fixtures are not valid JSON (${(err as Error).message})`);
  }
  if (!Array.isArray(parsed)) throw new Error("turn fixtures must be a JSON array");
  const fixtures = parsed.map((item, i) => validateFixture(item, i));
  const ids = new Set<string>();
  for (const f of fixtures) {
    if (ids.has(f.id)) throw new Error(`duplicate fixture id "${f.id}"`);
    ids.add(f.id);
  }
  return fixtures;
}

const FixtureSchema = z.object({
  id: z.string().min(1),
  family: z.enum(DECISION_FAMILIES),
  title: z.string().min(1),
  channel: z.string().min(1),
  speaker: z.object({ name: z.string().min(1), role: z.enum(["owner", "member", "stranger"]) }),
  addressedToBeckett: z.boolean(),
  priorContext: z.array(z.string()).optional(),
  taskState: z.string().optional(),
  denial: z.string().optional(),
  message: z.string().min(1),
  expect: z.object({
    decision: z.enum(["send", "pass"]),
    actions: z.array(z.enum(TURN_ACTIONS)).min(1),
  }),
  rationale: z.string().min(1),
});

function validateFixture(item: unknown, index: number): TurnFixture {
  const parsed = FixtureSchema.safeParse(item);
  if (!parsed.success) {
    throw new Error(`fixture #${index + 1} is invalid: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  }
  return parsed.data;
}
