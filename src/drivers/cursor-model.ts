/**
 * Beckett — Cursor model selection (`src/drivers/cursor-model.ts`)
 * =======================================================================================
 * The Auto Balance question, resolved against the live API and encoded so it stays resolved.
 *
 * ## What was asked for
 *
 * Auto **Balance** — explicitly, never bare Auto and never Auto Cost. Auto Cost was ruled out on
 * the owner's call ("may select poorer models"); the whole point of the variant is best-of-both.
 * Cursor's docs describe the Cost/Balance/Intelligence split as "Cursor Router", requested as
 * `model: { id: "auto-smart", params: [{ id: "optimize_for", value: "balanced" }] }`.
 *
 * ## What the account actually offers (probed 2026-08-19, individual Pro key)
 *
 * `GET /v1/models` returns exactly ONE Auto entry:
 *
 *     { "id": "default", "displayName": "Auto", "aliases": ["auto"],
 *       "variants": [ { "params": [], "displayName": "Auto", "isDefault": true } ] }
 *
 * No `auto-smart` id. No `optimize_for` parameter — on Auto or on any of the other 34 models.
 * Asking for `auto-smart` is refused outright:
 *
 *     Cannot use this model: auto-smart. Available models: default, grok-4.6, composer-2.5, …
 *
 * Worse for us, `{ id: "auto", params: [{ id: "optimize_for", value: "balanced" }] }` is ACCEPTED
 * by `Agent.create` — because create validates the model ID, not the params. An undeclared param
 * is silently dropped. That is the dangerous shape: it would let this seat report "running Auto
 * Balance" forever while running plain Auto, which is precisely the silent substitution the
 * owner ruled out.
 *
 * ## So this module does not guess
 *
 * {@link resolveCursorSelection} asks for Balance and then CHECKS the catalogue for a variant that
 * actually declares it. Offered → we send it. Not offered → we send plain Auto and say so, loudly,
 * in a note that rides onto the run trace and the handoff file. The fallback is plain Auto,
 * NEVER Auto Cost — {@link REJECTED_OPTIMIZE_FOR} pins that so a later edit can't quietly
 * introduce it.
 *
 * The preference is expressed as data, not as a comment: the day Cursor enables Router on an
 * individual plan, the catalogue grows the variant and this starts requesting Balance with no
 * code change and no redeploy.
 */

/** The Beckett-side model label for "let Cursor pick" — what a cast and the rate table use. */
export const CURSOR_AUTO_MODEL = "cursor-auto";

/** Cursor's own id for the Auto entry (its alias `auto` resolves to the same row). */
const CURSOR_AUTO_ID = "default";

/** The Router parameter Auto Balance is requested through, when the account has Router at all. */
const OPTIMIZE_FOR_PARAM = "optimize_for";

/** The value that means Balance. */
const OPTIMIZE_FOR_BALANCED = "balanced";

/**
 * Values this seat must never send. Auto Cost was ruled out by the owner by name; degrading to it
 * silently when Balance is unavailable is the specific failure mode this constant exists to make
 * impossible. Enforced by {@link resolveCursorSelection} and pinned by a test.
 */
const REJECTED_OPTIMIZE_FOR: ReadonlySet<string> = new Set(["cost", "cheap", "economy"]);

/** One `{ id, value }` model parameter, structurally identical to the SDK's `ModelParameterValue`. */
interface CursorModelParam {
  id: string;
  value: string;
}

/** A model selection, structurally identical to the SDK's `ModelSelection`. */
interface CursorSelection {
  id: string;
  params?: CursorModelParam[];
}

/** One catalogue row, structurally identical to the SDK's `ModelListItem`. */
export interface CursorCatalogueItem {
  id: string;
  displayName?: string;
  aliases?: string[];
  parameters?: Array<{ id: string; values?: Array<{ value: string }> }>;
  variants?: Array<{ params: CursorModelParam[]; displayName?: string; isDefault?: boolean }>;
}

/** What {@link resolveCursorSelection} decided, and why. */
interface ResolvedCursorModel {
  /** The selection to send to `Agent.create`. */
  selection: CursorSelection;
  /** A human label for logs / the handoff file (e.g. `Auto (auto balance unavailable)`). */
  label: string;
  /** True when the account really did offer the Balance variant and we are using it. */
  balanced: boolean;
  /**
   * Set when we asked for Balance and could not get it — the honest one-liner that goes on the run
   * trace and into the handoff. Absent when nothing was degraded.
   */
  note?: string;
}

/** Find the catalogue row for an id or alias. */
function findModel(catalogue: readonly CursorCatalogueItem[], id: string): CursorCatalogueItem | undefined {
  const wanted = id.trim().toLowerCase();
  return catalogue.find(
    (m) =>
      m.id.toLowerCase() === wanted ||
      (m.aliases ?? []).some((alias) => alias.toLowerCase() === wanted),
  );
}

/** Whether `model` genuinely offers a variant carrying `param=value` (not just accepting it). */
export function offersVariant(model: CursorCatalogueItem | undefined, param: string, value: string): boolean {
  if (!model) return false;
  // Both halves must agree. The parameter has to be DECLARED (so the backend knows the knob) and
  // at least one shipped variant has to carry the value (so the knob has that setting). An
  // account with Router disabled fails both; the accepted-but-ignored shape fails both too.
  const declared = (model.parameters ?? []).some(
    (p) => p.id === param && (p.values ?? []).some((v) => v.value === value),
  );
  const variant = (model.variants ?? []).some((v) =>
    (v.params ?? []).some((p) => p.id === param && p.value === value),
  );
  return declared && variant;
}

/**
 * Resolve the selection to send for a Beckett cast model.
 *
 * @param castModel  The `model` on the cast, or "" for the seat default. `cursor-auto` (the
 *                   default) means "Auto Balance if this account has it, plain Auto otherwise".
 *                   Anything else is passed through as a raw Cursor model id and validated
 *                   against the catalogue.
 * @param catalogue  `Cursor.models.list()` output. An EMPTY catalogue (the call failed) is treated
 *                   as "cannot confirm Balance" and degrades to plain Auto with a note — never as
 *                   "assume it works", which would put us right back in the silent-substitution
 *                   hole this module exists to close.
 */
export function resolveCursorSelection(
  castModel: string,
  catalogue: readonly CursorCatalogueItem[],
): ResolvedCursorModel {
  const wanted = (castModel || CURSOR_AUTO_MODEL).trim();

  if (wanted !== CURSOR_AUTO_MODEL) {
    // An explicitly cast Cursor model id. It still has to exist on this account — a typo must
    // fail here, with the roster in hand, rather than as an opaque mid-run API refusal.
    const model = findModel(catalogue, wanted);
    if (!model && catalogue.length > 0) {
      throw new Error(
        `cursor: model "${wanted}" is not available on this account ` +
          `(available: ${catalogue.map((m) => m.id).sort().join(", ")})`,
      );
    }
    return { selection: { id: model?.id ?? wanted }, label: model?.displayName ?? wanted, balanced: false };
  }

  const auto = findModel(catalogue, CURSOR_AUTO_ID);
  if (offersVariant(auto, OPTIMIZE_FOR_PARAM, OPTIMIZE_FOR_BALANCED)) {
    return {
      selection: {
        id: auto!.id,
        params: [{ id: OPTIMIZE_FOR_PARAM, value: OPTIMIZE_FOR_BALANCED }],
      },
      label: "Auto Balance",
      balanced: true,
    };
  }

  // Degrade — to PLAIN Auto. Never to a cost-optimized variant, whatever the catalogue offers.
  const note =
    catalogue.length === 0
      ? "cursor: could not read the model catalogue, so Auto Balance could not be confirmed — " +
        "running plain Auto. (Auto Cost is never substituted.)"
      : "cursor: this account does not offer the Auto Balance router variant (no `optimize_for` " +
        "parameter on any model) — running plain Auto. Auto Cost was NOT substituted. This " +
        "resolves itself with no code change the day Cursor enables Router on this plan.";
  return {
    selection: { id: auto?.id ?? CURSOR_AUTO_ID },
    label: "Auto",
    balanced: false,
    note,
  };
}

/**
 * Belt-and-braces on the one substitution that is forbidden: any selection leaving this module
 * must not carry a cost-optimized router value. Called by the shim immediately before
 * `Agent.create`, so even a hand-edited config cannot smuggle Auto Cost onto this seat.
 */
export function assertNotCostOptimized(selection: CursorSelection): void {
  for (const param of selection.params ?? []) {
    if (param.id === OPTIMIZE_FOR_PARAM && REJECTED_OPTIMIZE_FOR.has(param.value.toLowerCase())) {
      throw new Error(
        `cursor: refusing to request "${OPTIMIZE_FOR_PARAM}=${param.value}" — Auto Cost is ruled ` +
          `out for this seat; use Auto Balance, or plain Auto when Balance is unavailable`,
      );
    }
  }
}
