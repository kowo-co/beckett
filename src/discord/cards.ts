/** Pure renderers for compact Discord embeds and Components V2 cards. They receive aggregates, never source patches. */
import type { DiscordButton, DiscordCard, DiscordCardBlock, DiscordCardImage, DiscordEmbed } from "../types.ts";
import type { BranchCardSnapshot, TaskCardBranchSnapshot, TaskCardSnapshot } from "../task/status.ts";
import type { TaskBranchStatus } from "../task/store.ts";
import { componentId } from "./interactions.ts";

const GREEN = 0x2ea043;
const RED = 0xda3633;
const AMBER = 0xd29922;
const BLUE = 0x2f81f7;
const GRAY = 0x6e7681;

/** The real controls carried with a branch card; link controls and interactions share one row. */
export function branchCardButtons(card: BranchCardSnapshot): DiscordButton[] {
  const buttons: DiscordButton[] = [];
  if (card.pullRequest) buttons.push({ label: "Open PR", url: card.pullRequest.url });
  else if (card.publication) buttons.push({ label: "Open repository", url: card.publication.url });
  if (card.status === "done" && card.pullRequest?.state === "OPEN") {
    buttons.push({ label: "Merge branch", customId: componentId("merge", card.ref) });
  }
  if (card.status !== "cancelled") {
    buttons.push({ label: "Cancel branch", customId: componentId("cancel", card.ref), danger: true });
  }
  // The interaction channel (not this card's author/location) is the workspace target.
  buttons.push({ label: "Attach to thread", customId: componentId("attach", String(card.taskNumber)) });
  return buttons;
}

export function renderBranchEmbed(card: BranchCardSnapshot): DiscordEmbed {
  const fields: NonNullable<DiscordEmbed["fields"]> = [];
  if (card.changes) {
    fields.push(
      { name: "Changes", value: `+${card.changes.additions}  /  -${card.changes.deletions}`, inline: true },
      { name: "Files", value: String(card.changes.files), inline: true },
      { name: "Commits", value: String(card.changes.commits), inline: true },
    );
  } else {
    fields.push({ name: "Changes", value: "Waiting for a worktree", inline: true });
  }
  if (card.checks) {
    fields.push({
      name: "Checks",
      value: card.checks.total === 0
        ? "No checks configured"
        : `✓ ${card.checks.passed} passed   ◷ ${card.checks.pending} running   ✕ ${card.checks.failed} failed`,
    });
  } else {
    fields.push({
      name: "Checks",
      value: card.publication ? "Published without a pull request" : "Not published yet",
    });
  }
  if (card.review) {
    fields.push(
      { name: "Review", value: card.review.decision || "Review required", inline: true },
      { name: "Latest reviews", value: String(card.review.count), inline: true },
    );
  }
  if (card.discussion) fields.push({ name: "Conversation", value: String(card.discussion.comments), inline: true });

  const prState = card.pullRequest
    ? `${card.pullRequest.draft ? "DRAFT " : ""}${card.pullRequest.state} PR #${card.pullRequest.number}`
    : card.publication
      ? "PUBLISHED"
      : "LOCAL";
  return {
    title: `#${card.ref} - ${card.title}`,
    ...(card.pullRequest
      ? { url: card.pullRequest.url }
      : card.publication
        ? { url: card.publication.url }
        : {}),
    description: `Part of **#${card.taskNumber} - ${card.taskTitle}**\n${card.gitRef ? `\`${card.gitRef}\` · ` : ""}${prState}`,
    color: branchColor(card),
    fields,
    footer: { text: `Branch ${card.status} · aggregate Git status only` },
    timestamp: card.updatedAt,
  };
}

// ── task card (#104): one self-editing Components V2 card per task, machine state only ───────
//
// The card is a single accent-colored container: a heading, one section per branch (status +
// links, with the branch's primary control pinned as the section accessory), an inline media
// gallery of branch screenshots when any exist, and a bottom action row for cancel/attach.
// Discord caps a container at TEN components, so the section budget is whatever is left after
// the fixed header/separator/actions/footer and the optional gallery; overflow branches are
// folded into a "…and N more" header note rather than breaking the send.

/** Human label for each lifecycle state the card reflects. */
const BRANCH_STATE_LABEL: Record<TaskBranchStatus, string> = {
  ready: "Queued",
  waiting: "Waiting on dependencies",
  designing: "Designing",
  approval: "Awaiting design approval",
  running: "Running",
  review: "In review",
  blocked: "Stalled",
  done: "Done",
  cancelled: "Cancelled",
};

/** A dot per state so the card scans at a glance without depending on field colour. */
const BRANCH_STATE_ICON: Record<TaskBranchStatus, string> = {
  ready: "⚪",
  waiting: "⚪",
  designing: "🔵",
  approval: "🟡",
  running: "🔵",
  review: "🟡",
  blocked: "🔴",
  done: "🟢",
  cancelled: "⚫",
};

/** Discord caps a container at 10 children; header + separator + actions + footer are fixed. */
const CONTAINER_BUDGET = 10;
const FIXED_BLOCKS = 4; // header text, separator, actions row, footer text
/** A gallery shows at most this many images (Discord's own media-gallery cap). */
const GALLERY_MAX_IMAGES = 10;
/** Cancel buttons share one action row with Attach; the remainder wait for a later render. */
const ACTION_ROW_BUTTON_BUDGET = 5;

/** A branch whose open PR is mergeable gets the green Merge accessory; merged/closed retires it. */
function mergeable(branch: TaskCardBranchSnapshot): boolean {
  return (
    branch.status === "done" &&
    branch.pullRequestNumber !== undefined &&
    branch.pullRequestState !== "MERGED" &&
    branch.pullRequestState !== "CLOSED"
  );
}

/** The branch's one pinned control: Merge when shippable, else its artifact link, else nothing. */
function branchAccessory(branch: TaskCardBranchSnapshot): DiscordButton | undefined {
  if (mergeable(branch)) {
    return { label: `Merge #${branch.ref}`, customId: componentId("merge", branch.ref), success: true };
  }
  if (branch.artifact) {
    return {
      label: branch.artifact.kind === "pull_request"
        ? `Open PR${branch.pullRequestNumber ? ` #${branch.pullRequestNumber}` : ""}`
        : "Open repository",
      url: branch.artifact.url,
    };
  }
  return undefined;
}

/** `<t:…:R>` renders as Discord-native relative time ("2 minutes ago"); unparseable → no stamp. */
function relativeTimestamp(iso: string): string | undefined {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? undefined : `<t:${Math.floor(ms / 1000)}:R>`;
}

/** Every branch screenshot, most-recent-branch first, capped at the gallery's own limit. */
function galleryImages(snapshot: TaskCardSnapshot): DiscordCardImage[] {
  return snapshot.branches
    .flatMap((branch) =>
      (branch.images ?? []).map((image) => ({
        url: image.url,
        description: image.description ?? `#${branch.ref} · ${truncate(branch.title, 60)}`,
      })),
    )
    .slice(0, GALLERY_MAX_IMAGES);
}

/**
 * The whole task as one Components V2 card: accent colour, heading + aggregate state, a section
 * per branch carrying its lifecycle state and — once work has produced them — artifact/preview
 * links and the merge control, a screenshot reel, and the cancel/attach row. This is machine
 * state, edited in place; it never speaks in Beckett's voice.
 */
export function renderTaskCard(snapshot: TaskCardSnapshot): DiscordCard {
  const images = galleryImages(snapshot);
  const sectionBudget = CONTAINER_BUDGET - FIXED_BLOCKS - (images.length > 0 ? 1 : 0);
  const shown = snapshot.branches.slice(0, Math.max(1, sectionBudget));
  const overflow = snapshot.branches.length - shown.length;

  const header = [
    `## ${truncate(`#${snapshot.number} - ${snapshot.title}`, 80)}`,
    taskStateLine(snapshot),
    ...(overflow > 0 ? [`-# …and ${overflow} more branch${overflow === 1 ? "" : "es"} not shown`] : []),
  ].join("\n");

  const blocks: DiscordCardBlock[] = [{ kind: "text", text: header }, { kind: "separator" }];

  if (shown.length === 0) {
    blocks.push({ kind: "text", text: "No branches yet" });
  } else {
    for (const branch of shown) {
      const accessory = branchAccessory(branch);
      const text = `**${truncate(`#${branch.ref} · ${branch.title}`, 80)}**\n${branchLine(branch)}`;
      // A Components V2 section MUST carry an accessory — Discord rejects an accessory-less one
      // outright (400 Invalid Form Body), failing the whole message. Most branches have no button
      // to pin for most of their life (no artifact yet, nothing mergeable), so those render as a
      // plain text block instead of an empty section. This keeps a section-without-accessory
      // structurally unrepresentable through this path (#154).
      blocks.push(accessory ? { kind: "section", text, accessory } : { kind: "text", text });
    }
  }

  if (images.length > 0) blocks.push({ kind: "gallery", images });

  // Cancel sits in the shared bottom row (per-branch accessories carry only the primary control);
  // past the row budget the extras simply reappear as earlier branches resolve and the card
  // re-renders. Attach is always present — the interaction channel is the workspace target.
  const cancellable = snapshot.branches.filter((b) => b.status !== "cancelled" && b.status !== "done");
  const row: DiscordButton[] = [
    ...cancellable.slice(0, ACTION_ROW_BUTTON_BUDGET - 1).map((branch) => ({
      label: `Cancel #${branch.ref}`,
      customId: componentId("cancel", branch.ref),
      danger: true,
    })),
    { label: "Attach to thread", customId: componentId("attach", String(snapshot.number)) },
  ];
  blocks.push({ kind: "actions", buttons: row });

  const stamp = relativeTimestamp(snapshot.updatedAt);
  blocks.push({
    kind: "text",
    text: `-# Live task card · updates in place${stamp ? ` · updated ${stamp}` : ""}`,
  });

  return { color: taskCardColor(snapshot), blocks };
}

function branchLine(branch: TaskCardBranchSnapshot): string {
  const parts = [`${BRANCH_STATE_ICON[branch.status]} ${BRANCH_STATE_LABEL[branch.status]}`];
  if (branch.artifact) {
    parts.push(branch.artifact.kind === "pull_request"
      ? `[PR${branch.pullRequestNumber ? ` #${branch.pullRequestNumber}` : ""}](${branch.artifact.url})`
      : `[Repository](${branch.artifact.url})`);
  }
  if (branch.preview) parts.push(`[Live preview](${branch.preview.url})`);
  return parts.join(" · ");
}

function taskStateLine(snapshot: TaskCardSnapshot): string {
  const total = snapshot.branches.length;
  const done = snapshot.branches.filter((b) => b.status === "done").length;
  const cancelled = snapshot.branches.filter((b) => b.status === "cancelled").length;
  const label = snapshot.status === "done"
    ? "Done"
    : snapshot.status === "cancelled"
      ? "Cancelled"
      : snapshot.status === "paused"
        ? "Paused"
        : "Active";
  return total > 0
    ? `**${label}** · ${done}/${total} branches done${cancelled ? ` · ${cancelled} cancelled` : ""}`
    : `**${label}**`;
}

function taskCardColor(snapshot: TaskCardSnapshot): number {
  if (snapshot.branches.some((b) => b.status === "blocked")) return RED;
  if (snapshot.status === "done") return GREEN;
  if (snapshot.status === "cancelled") return GRAY;
  if (snapshot.branches.some((b) => b.status === "review" || b.status === "approval")) return AMBER;
  if (snapshot.branches.some((b) => b.status === "running" || b.status === "designing")) return BLUE;
  return GRAY;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function branchColor(card: BranchCardSnapshot): number {
  if (card.checks?.failed || card.review?.decision === "CHANGES_REQUESTED") return RED;
  if (card.pullRequest) {
    if (card.pullRequest.state === "MERGED") return GREEN;
    if (card.pullRequest.state === "CLOSED") return RED;
    if (card.checks?.pending || card.pullRequest.draft) return AMBER;
    return BLUE;
  }
  if (card.publication || card.status === "done") return GREEN;
  if (card.status === "review") return AMBER;
  if (card.source === "local") return GRAY;
  return BLUE;
}
