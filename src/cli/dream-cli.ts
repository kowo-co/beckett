/**
 * `beckett dream` — read the dream journal back, work the proposal queue, and the routine body
 * for the nightly pass.
 *
 *   - `dream ls`            list entries (newest first; truncated nights flagged)
 *   - `dream show <date>`   print one entry verbatim
 *   - `dream run`           the `nightly-dream` routine's BODY (issue #36) — spawned detached
 *                           by the self lane's dispatch fork, or run by hand. Contained by
 *                           construction: read-only assembly, a tool-less reflection call under
 *                           the config token ceiling, and writes only to `~/.beckett/dreams/`
 *                           plus create-only `dream`-namespace memories.
 *   - `dream propose`       file a proposal by hand (issue #37)
 *   - `dream spikes …`      ls | show — read overnight-spike records + findings back (issue
 *                           #38). Read-only: a spike is built by the nightly pass and decided
 *                           through the proposal queue; there is no CLI verb that merges,
 *                           pushes, or revives one.
 *   - `dream proposals …`   ls | show | accept | reject | expire — THE only way a proposal
 *                           moves. Accepting a doctrine or persona proposal files a normal
 *                           ticket; accepting a ticket or memory-correction proposal allocates
 *                           a real task branch. Neither this file nor anything it calls can
 *                           edit doctrine, persona, or a memory.
 */

import { readFileSync } from "node:fs";
import { listDreamEntries, readDreamEntry } from "../dream/journal.ts";
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
import { config, paths } from "./context.ts";

const USAGE =
  "usage: beckett dream ls [--json] | dream show <YYYY-MM-DD> | dream run [--force] [--routine <id>] [--requester <id>] | " +
  `dream propose --kind ${PROPOSAL_KINDS.join("|")} --claim <one line> --why <rationale> --from <src,src> [--channel <id>] | ` +
  "dream proposals ls [--all|--json] | proposals show <id> | proposals accept <id> [--board <name>] | " +
  "proposals reject <id> --why <reason> [--about <slug>] | proposals expire | " +
  "dream spikes ls [--json] | spikes show <id>";

export async function runDream(argv: string[]): Promise<void> {
  const [sub, ...rest] = argv;

  if (!sub || sub === "ls" || sub === "list") {
    const { flags } = parse(rest);
    const entries = listDreamEntries(paths.dreamsDir);
    if (flags.json) out({ entries });
    if (!entries.length) out("(no dreams yet)");
    out(
      entries
        .map((e) => `- ${e.date}  ${String(e.bytes).padStart(6)}B${e.truncated ? "  [truncated]" : ""}`)
        .join("\n"),
    );
  }

  if (sub === "show") {
    const date = rest[0]?.trim();
    if (!date) fail("usage: beckett dream show <YYYY-MM-DD>");
    let content: string | null = null;
    try {
      content = readDreamEntry(paths.dreamsDir, date!);
    } catch (err) {
      fail((err as Error).message);
    }
    if (content === null) fail(`no dream entry for ${date}`);
    out(content!);
  }

  if (sub === "propose") {
    const { flags } = parse(rest);
    const kind = String(flags.kind ?? "").trim() as ProposalKind;
    if (!PROPOSAL_KINDS.includes(kind)) fail(`dream propose: --kind must be one of: ${PROPOSAL_KINDS.join(", ")}`);
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
  }

  if (sub === "proposals") {
    await runProposals(rest);
  }

  if (sub === "spikes" || sub === "spike") {
    await runSpikes(rest);
  }

  if (sub === "run") {
    const { flags } = parse(rest);
    // Imported lazily: ls/show must stay cheap and never drag the run graph (memory, channels).
    const { runDreamPass } = await import("../dream/run.ts");
    const outcome = await runDreamPass({
      config,
      paths,
      logger: quietLogger,
      routineId: flags.routine ? String(flags.routine) : "manual",
      force: flags.force === true,
    });
    out(outcome);
  }

  fail(USAGE);
}

/**
 * The proposal queue's verbs. `accept` and `reject` are the ONLY transitions that exist — and
 * both of them hand the work to a normal front door (the tracker, the task store, the
 * calibration ledger) rather than touching anything themselves.
 */
async function runProposals(argv: string[]): Promise<void> {
  const [sub, ...rest] = argv;
  const { _, flags } = parse(rest);

  if (!sub || sub === "ls" || sub === "list" || sub.startsWith("--")) {
    const listFlags = sub?.startsWith("--") ? parse(argv).flags : flags;
    // Expire on the way in, so an `ls` never quietly hides what it just aged out.
    const expired = safeSweep();
    const all = listFlags.all === true;
    const proposals = listProposals(paths.proposalsDir, { all });
    if (listFlags.json) out({ proposals, expired: expired.map((p) => p.id) });
    out(renderProposalList(proposals, all));
  }

  if (sub === "show") {
    const id = _[0]?.trim();
    if (!id) fail("usage: beckett dream proposals show <id>");
    let proposal: Proposal | null = null;
    try {
      proposal = readProposal(paths.proposalsDir, id!);
    } catch (err) {
      fail((err as Error).message);
    }
    if (!proposal) fail(`no such proposal: ${id}`);
    out(proposal);
  }

  if (sub === "expire") {
    out({ expired: safeSweep().map((p) => p.id), open: pendingProposals(paths.proposalsDir).length });
  }

  if (sub === "accept") {
    const id = _[0]?.trim();
    if (!id) fail("usage: beckett dream proposals accept <id> [--board <name>] [--project <slug>] [--confirm-beckett]");
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
  }

  if (sub === "reject") {
    const id = _[0]?.trim();
    const why = typeof flags.why === "string" ? flags.why : "";
    if (!id) fail("usage: beckett dream proposals reject <id> --why <reason> [--about <slug>]");
    if (!why.trim()) fail("dream proposals reject: --why <reason> is required — rejection is signal, not deletion");
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
  }

  fail(
    "usage: beckett dream proposals ls [--all|--json] | proposals show <id> | proposals accept <id> | " +
      "proposals reject <id> --why <reason> | proposals expire",
  );
}

/**
 * The overnight-spike readback (issue #38). Deliberately read-only: `ls` lists records, `show`
 * prints one record plus its durable finding. Acting on a spike goes through `dream proposals
 * accept|reject` like everything else a dream asks for.
 */
async function runSpikes(argv: string[]): Promise<void> {
  const [sub, ...rest] = argv;
  // Imported lazily like `dream run`: ls/show of OTHER verbs must never drag this graph in.
  const { listSpikes, readSpike } = await import("../dream/spike.ts");
  const { flags, _ } = parse(rest);

  if (!sub || sub === "ls" || sub === "list" || sub.startsWith("--")) {
    const listFlags = sub?.startsWith("--") ? parse(argv).flags : flags;
    const spikes = listSpikes(paths.spikesDir);
    if (listFlags.json) out({ spikes });
    if (!spikes.length) out("(no spikes yet — most nights, that's the system working)");
    out(
      spikes
        .map(
          (s) =>
            `- ${s.id} [${s.status}] ${s.pair.join(" + ")}\n  ${s.question}\n  artifact: ${s.findingPath}` +
            (s.proposalId ? `\n  proposal: ${s.proposalId}` : ""),
        )
        .join("\n"),
    );
  }

  if (sub === "show") {
    const id = _[0]?.trim() ?? rest[0]?.trim();
    if (!id) fail("usage: beckett dream spikes show <id>");
    let record: ReturnType<typeof readSpike> = null;
    try {
      record = readSpike(paths.spikesDir, id!);
    } catch (err) {
      fail((err as Error).message);
    }
    if (!record) fail(`no such spike: ${id}`);
    let finding = "";
    try {
      finding = readFileSync(record!.findingPath, "utf8");
    } catch {
      finding = "(finding file unreadable)";
    }
    out(`${JSON.stringify(record, null, 2)}\n\n${finding}`);
  }

  fail("usage: beckett dream spikes ls [--json] | spikes show <id>");
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
