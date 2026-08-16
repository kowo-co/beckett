/**
 * `beckett proposals` — the proposal queue's only CLI surface (issue #37).
 *
 *   - `proposals file`      file a proposal by hand
 *   - `proposals ls`        list proposals (open by default; `--all` for the full history)
 *   - `proposals show <id>` print one proposal
 *   - `proposals accept <id>` — THE only way a proposal becomes a ticket or a task branch.
 *     Accepting a doctrine or persona proposal files a normal ticket; accepting a ticket or
 *     memory-correction proposal allocates a real task branch. Neither this file nor anything it
 *     calls can edit doctrine, persona, or a memory.
 *   - `proposals reject <id> --why <reason>` — rejection is signal, not deletion; it always
 *     records a calibration.
 *   - `proposals expire`    sweep proposals past their TTL
 */

import {
  PROPOSAL_KINDS,
  type Proposal,
  type ProposalKind,
  createProposal,
  listProposals,
  readProposal,
  sweepExpiredProposals,
} from "../proposal/store.ts";
import { acceptProposal, pendingProposals, rejectProposal } from "../proposal/decide.ts";
import { out, fail, parse, quietLogger } from "./io.ts";
import { paths } from "./context.ts";

const USAGE =
  "usage: beckett proposals ls [--all|--json] | proposals show <id> | proposals accept <id> [--board <name>] | " +
  "proposals reject <id> --why <reason> [--about <slug>] | proposals expire | " +
  `proposals file --kind ${PROPOSAL_KINDS.join("|")} --claim <one line> --why <rationale> --from <src,src> [--channel <id>]`;

/**
 * The proposal queue's verbs. `accept` and `reject` are the ONLY transitions that exist — and
 * both of them hand the work to a normal front door (the tracker, the task store, the
 * calibration ledger) rather than touching anything themselves.
 */
export async function runProposals(argv: string[]): Promise<void> {
  const [sub, ...rest] = argv;
  const { _, flags } = parse(rest);

  if (sub === "file") {
    const kind = String(flags.kind ?? "").trim() as ProposalKind;
    if (!PROPOSAL_KINDS.includes(kind)) fail(`proposals file: --kind must be one of: ${PROPOSAL_KINDS.join(", ")}`);
    try {
      const proposal = createProposal(paths.proposalsDir, {
        kind,
        claim: String(flags.claim ?? ""),
        rationale: String(flags.why ?? flags.rationale ?? ""),
        provenance: String(flags.from ?? flags.provenance ?? "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        origin: flags.origin ? String(flags.origin) : "manual",
        ...(flags.channel ? { channel: String(flags.channel) } : {}),
      });
      out({ proposed: proposal.id, kind: proposal.kind, claim: proposal.claim, status: proposal.status });
    } catch (err) {
      fail((err as Error).message);
    }
    return;
  }

  if (!sub || sub === "ls" || sub === "list" || sub.startsWith("--")) {
    const listFlags = sub?.startsWith("--") ? parse(argv).flags : flags;
    // Expire on the way in, so an `ls` never quietly hides what it just aged out.
    const expired = safeSweep();
    const all = listFlags.all === true;
    const proposals = listProposals(paths.proposalsDir, { all });
    if (listFlags.json) out({ proposals, expired: expired.map((p) => p.id) });
    out(renderProposalList(proposals, all));
    return;
  }

  if (sub === "show") {
    const id = _[0]?.trim();
    if (!id) fail("usage: beckett proposals show <id>");
    let proposal: Proposal | null = null;
    try {
      proposal = readProposal(paths.proposalsDir, id!);
    } catch (err) {
      fail((err as Error).message);
    }
    if (!proposal) fail(`no such proposal: ${id}`);
    out(proposal);
    return;
  }

  if (sub === "expire") {
    out({ expired: safeSweep().map((p) => p.id), open: pendingProposals(paths.proposalsDir).length });
    return;
  }

  if (sub === "accept") {
    const id = _[0]?.trim();
    if (!id) fail("usage: beckett proposals accept <id> [--board <name>] [--project <slug>] [--confirm-beckett]");
    // Loaded here, not at module scope: the run ledger and the task store are the two front
    // doors an accept walks through, and `ls`/`show` must never pay for them.
    const { TaskStore } = await import("../task/store.ts");
    const { RunStore } = await import("../run/store.ts");
    const { deployRun } = await import("./task-deploy.ts");
    const { notifyBus } = await import("./core.ts");
    const { guardRestrictedProject } = await import("./core.ts");
    const { join } = await import("node:path");
    // Accepting a doctrine proposal is exactly the case that wants to build against Beckett's
    // own repo — so it takes the SAME restricted-project speed bump every other filing takes.
    // A proposal earns no exemption from a routing check for having been raised at 4am.
    guardRestrictedProject(flags.project ? String(flags.project) : undefined, flags["confirm-beckett"] === true);
    const store = new TaskStore(join(paths.beckettDir, "tasks.json"));
    try {
      const result = await acceptProposal(
        {
          proposalsDir: paths.proposalsDir,
          deployRun: async (input) => {
            // The proposal's claim IS the acceptance criterion, so it rides into the prompt
            // rather than into a separate criteria field the run model no longer has: the
            // worker authors its own spec.md checklist from this brief.
            const prompt = [input.body.trim(), "", "Acceptance criteria:", ...input.criteria.map((c) => `- ${c}`)]
              .join("\n")
              .trim();
            const deployed = await deployRun(
              [
                "--title", input.title,
                "--prompt", prompt,
                ...(flags.project ? ["--repo", String(flags.project)] : []),
              ],
              { store: new RunStore(join(paths.beckettDir, "runs.json")), notifyBus },
            );
            return { runId: "runId" in deployed ? deployed.runId : deployed.id };
          },
          createTaskBranch: async (input) => {
            const created = await store.createTask({
              title: input.title,
              ...(flags.project ? { project: String(flags.project) } : {}),
            });
            return { taskRef: `#${created.task.number}`, branchRef: `#${created.branch.ref}` };
          },
        },
        id!,
      );
      out({
        accepted: result.proposal.id,
        kind: result.proposal.kind,
        route: result.route,
        became: result.became,
        url: result.url,
      });
    } catch (err) {
      fail((err as Error).message);
    }
    return;
  }

  if (sub === "reject") {
    const id = _[0]?.trim();
    const why = typeof flags.why === "string" ? flags.why : "";
    if (!id) fail("usage: beckett proposals reject <id> --why <reason> [--about <slug>]");
    if (!why.trim()) fail("proposals reject: --why <reason> is required — rejection is signal, not deletion");
    const { createMemory } = await import("../memory/index.ts");
    const { createCalibration } = await import("../memory/calibration.ts");
    const memory = createMemory({ memoryDir: paths.memoryDir, git: true, logger: quietLogger });
    try {
      const result = await rejectProposal(
        {
          proposalsDir: paths.proposalsDir,
          recordCalibration: async (input) => {
            const entry = await createCalibration(memory, { kind: "veto", ...input });
            return { name: entry.node.name };
          },
        },
        id!,
        why,
        { ...(flags.about ? { about: String(flags.about) } : {}) },
      );
      out({ rejected: result.proposal.id, why: result.proposal.note, calibration: result.calibration });
    } catch (err) {
      fail((err as Error).message);
    }
    return;
  }

  fail(USAGE);
}

/** A sweep must never be the thing that breaks a read-only verb. */
function safeSweep(): Proposal[] {
  try {
    return sweepExpiredProposals(paths.proposalsDir);
  } catch {
    return [];
  }
}

function renderProposalList(proposals: Proposal[], all: boolean): string {
  if (!proposals.length) return all ? "(no proposals)" : "(no open proposals)";
  return proposals
    .map((p) => {
      const decided = p.status === "open" ? "" : ` → ${p.became ?? p.note ?? p.status}`;
      return `- ${p.id} [${p.kind}] [${p.status}]${decided}\n  ${p.claim}`;
    })
    .join("\n");
}
