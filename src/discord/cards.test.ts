import { expect, test } from "bun:test";
import { branchCardButtons, renderBranchEmbed, renderTaskCard } from "./cards.ts";
import type { DiscordCard, DiscordCardBlock } from "../types.ts";
import type { BranchCardSnapshot, TaskCardBranchSnapshot, TaskCardSnapshot } from "../task/status.ts";
import type { TaskBranchStatus, TaskStatus } from "../task/store.ts";

test("branch card shows aggregate Git and PR health without diff content", () => {
  const card: BranchCardSnapshot = {
    ref: "42.2",
    title: "Voting interface",
    taskNumber: 42,
    taskTitle: "Build voting",
    status: "review",
    source: "pull_request",
    gitRef: "beckett/42-2-voting-interface",
    repo: "0xbeckett/voting",
    changes: { additions: 184, deletions: 37, files: 6, commits: 3 },
    pullRequest: { number: 96, url: "https://github.com/0xbeckett/voting/pull/96", state: "OPEN", draft: false },
    checks: { total: 9, passed: 8, pending: 1, failed: 0, skipped: 0, conclusion: "PENDING" },
    review: { decision: "APPROVED", count: 2 },
    discussion: { comments: 4 },
    updatedAt: "2026-07-12T00:00:00.000Z",
  };
  const embed = renderBranchEmbed(card);
  const json = JSON.stringify(embed);
  expect(embed.title).toBe("#42.2 - Voting interface");
  expect(json).toContain("+184");
  expect(json).toContain("8 passed");
  expect(json).toContain("4");
  expect(json).not.toContain("@@");
  expect(json).not.toContain("diff --git");
});

test("local cards admit that checks are unavailable", () => {
  const embed = renderBranchEmbed({
    ref: "7.1",
    title: "Main",
    taskNumber: 7,
    taskTitle: "Uploads",
    status: "running",
    source: "local",
    changes: { additions: 10, deletions: 2, files: 2, commits: 1 },
    updatedAt: "2026-07-12T00:00:00.000Z",
  });
  expect(JSON.stringify(embed)).toContain("Not published yet");
});

test("a finished branch card carries merge, cancel, and attach interaction buttons", () => {
  const buttons = branchCardButtons({
    ref: "7.1",
    title: "Main",
    taskNumber: 7,
    taskTitle: "Uploads",
    status: "done",
    source: "pull_request",
    pullRequest: { number: 3, url: "https://github.com/acme/repo/pull/3", state: "OPEN", draft: false },
    updatedAt: "2026-07-12T00:00:00.000Z",
  });
  expect(buttons).toContainEqual({ label: "Merge branch", customId: "beckett:v1:merge:7.1" });
  expect(buttons).toContainEqual({ label: "Cancel branch", customId: "beckett:v1:cancel:7.1", danger: true });
  expect(buttons).toContainEqual({ label: "Attach to thread", customId: "beckett:v1:attach:7" });
});

test("a done branch with an open PR and pending checks stays amber, not shipped green", () => {
  const embed = renderBranchEmbed({
    ref: "7.1",
    title: "Main",
    taskNumber: 7,
    taskTitle: "Uploads",
    status: "done",
    source: "pull_request",
    pullRequest: { number: 3, url: "https://github.com/acme/repo/pull/3", state: "OPEN", draft: false },
    checks: { total: 1, passed: 0, pending: 1, failed: 0, skipped: 0, conclusion: "PENDING" },
    updatedAt: "2026-07-12T00:00:00.000Z",
  });
  expect(embed.color).toBe(0xd29922);
});

test("a direct push card links the published repository instead of calling it local", () => {
  const embed = renderBranchEmbed({
    ref: "8.1",
    title: "Main",
    taskNumber: 8,
    taskTitle: "Voting",
    status: "done",
    source: "published",
    publication: { url: "https://github.com/acme/voting", kind: "pushed" },
    updatedAt: "2026-07-12T00:00:00.000Z",
  });
  expect(embed.url).toBe("https://github.com/acme/voting");
  expect(embed.description).toContain("PUBLISHED");
  expect(JSON.stringify(embed)).toContain("Published without a pull request");
  expect(embed.color).toBe(0x2ea043);
});

// ── task card (#104): one self-editing Components V2 card ────────────────────────────────────

function taskCard(over: Partial<TaskCardSnapshot> = {}, branch: Partial<TaskCardBranchSnapshot> = {}): TaskCardSnapshot {
  return {
    number: 104,
    title: "One self-editing task card",
    status: "active",
    updatedAt: "2026-07-28T00:00:00.000Z",
    branches: [{ ref: "104.1", title: "Main", status: "running", ...branch }],
    ...over,
  };
}

function blocksOfKind<K extends DiscordCardBlock["kind"]>(card: DiscordCard, kind: K) {
  return card.blocks.filter((block) => block.kind === kind) as Extract<DiscordCardBlock, { kind: K }>[];
}

function cardText(card: DiscordCard): string {
  return card.blocks
    .filter((block): block is Extract<DiscordCardBlock, { kind: "text" | "section" }> =>
      block.kind === "text" || block.kind === "section",
    )
    .map((block) => block.text)
    .join("\n");
}

function actionButtons(card: DiscordCard) {
  return blocksOfKind(card, "actions").flatMap((row) => row.buttons);
}

function accessories(card: DiscordCard) {
  return blocksOfKind(card, "section").flatMap((section) => (section.accessory ? [section.accessory] : []));
}

test("task card titles itself and states its aggregate progress", () => {
  const card = renderTaskCard(taskCard());
  const header = card.blocks[0];
  expect(header?.kind).toBe("text");
  expect(cardText(card)).toContain("#104 - One self-editing task card");
  expect(cardText(card)).toContain("0/1 branches done");
  expect(cardText(card)).toContain("updates in place");
  // The timestamp renders as Discord-native relative time in the footer subtext.
  expect(cardText(card)).toContain(`<t:${Math.floor(Date.parse("2026-07-28T00:00:00.000Z") / 1000)}:R>`);
});

// Each lifecycle state renders with the right label and colour.
const LIFECYCLE: Array<{ status: TaskBranchStatus; taskStatus: TaskStatus; label: string; color: number }> = [
  { status: "ready", taskStatus: "active", label: "Queued", color: 0x6e7681 },
  { status: "running", taskStatus: "active", label: "Running", color: 0x2f81f7 },
  { status: "review", taskStatus: "active", label: "In review", color: 0xd29922 },
  { status: "blocked", taskStatus: "active", label: "Stalled", color: 0xda3633 },
  { status: "done", taskStatus: "done", label: "Done", color: 0x2ea043 },
  { status: "cancelled", taskStatus: "cancelled", label: "Cancelled", color: 0x6e7681 },
];
for (const state of LIFECYCLE) {
  test(`task card renders the ${state.status} lifecycle state`, () => {
    const card = renderTaskCard(taskCard({ status: state.taskStatus }, { status: state.status }));
    expect(cardText(card)).toContain(state.label);
    expect(card.color).toBe(state.color);
  });
}

test("a stalled branch turns the whole card red even mid-flight", () => {
  const card = renderTaskCard(taskCard({ status: "active" }, { status: "blocked" }));
  expect(card.color).toBe(0xda3633);
});

test("task card shows the artifact link once a branch is finished", () => {
  const card = renderTaskCard(taskCard({ status: "done" }, {
    status: "done",
    artifact: { url: "https://github.com/acme/repo/pull/9", kind: "pull_request" },
    pullRequestNumber: 9,
  }));
  expect(cardText(card)).toContain("https://github.com/acme/repo/pull/9");
  expect(cardText(card)).toContain("PR #9");
});

test("task card surfaces a live preview link while in review", () => {
  const card = renderTaskCard(taskCard({}, {
    status: "review",
    preview: { url: "https://beckett-preview.0xbeckett.me" },
  }));
  expect(cardText(card)).toContain("https://beckett-preview.0xbeckett.me");
});

test("task card lists every branch as its own block, titled", () => {
  const multi = renderTaskCard({
    ...taskCard(),
    branches: [
      { ref: "104.1", title: "Backend", status: "done", artifact: { url: "https://x/pull/1", kind: "pull_request" }, pullRequestNumber: 1 },
      { ref: "104.2", title: "Frontend", status: "running" },
    ],
  });
  // The branch with an artifact keeps its section+accessory; the artifact-less one drops to a plain
  // text block so it never becomes an accessory-less section (which Discord rejects, #154).
  const sections = blocksOfKind(multi, "section");
  expect(sections).toHaveLength(1);
  expect(sections[0]?.text).toContain("#104.1 · Backend");
  expect(cardText(multi)).toContain("#104.2 · Frontend");
});

// Every lifecycle state, including a done branch that never opened a PR, must produce a card
// Discord accepts: no { kind: "section" } block may exist without an accessory (#154).
const ALL_BRANCH_STATUSES: TaskBranchStatus[] = [
  "ready", "waiting", "designing", "approval", "running", "review", "blocked", "cancelled", "done",
];
for (const status of ALL_BRANCH_STATUSES) {
  test(`an artifact-less ${status} branch never emits an accessory-less section`, () => {
    // No artifact, no pull request → branchAccessory returns nothing for every status here
    // (a done branch with no PR is not mergeable), so this is the accessory-less path.
    const card = renderTaskCard(taskCard({}, { status }));
    const sections = blocksOfKind(card, "section");
    for (const section of sections) expect(section.accessory).toBeDefined();
    // The branch state is still shown — it just rides in a plain text block instead of a section.
    expect(cardText(card)).toContain("#104.1 · Main");
  });
}

test("a task whose branches ALL lack artifacts renders no accessory-less section", () => {
  const card = renderTaskCard({
    ...taskCard(),
    branches: ALL_BRANCH_STATUSES.map((status, i) => ({
      ref: `104.${i + 1}`,
      title: `Branch ${status}`,
      status,
    })),
  });
  const sections = blocksOfKind(card, "section");
  for (const section of sections) expect(section.accessory).toBeDefined();
});

test("a mergeable branch pins a green Merge accessory; the PR link stays inline", () => {
  const card = renderTaskCard(taskCard({ status: "done" }, {
    status: "done",
    artifact: { url: "https://github.com/acme/repo/pull/9", kind: "pull_request" },
    pullRequestNumber: 9,
  }));
  expect(accessories(card)).toContainEqual({ label: "Merge #104.1", customId: "beckett:v1:merge:104.1", success: true });
  expect(cardText(card)).toContain("https://github.com/acme/repo/pull/9");
});

test("a finished branch without a mergeable PR pins its artifact link as the accessory", () => {
  const card = renderTaskCard(taskCard({ status: "done" }, {
    status: "done",
    artifact: { url: "https://github.com/acme/repo/pull/9", kind: "pull_request" },
    pullRequestNumber: 9,
    pullRequestState: "MERGED",
  }));
  expect(accessories(card)).toContainEqual({ label: "Open PR #9", url: "https://github.com/acme/repo/pull/9" });
  expect(accessories(card).some((b) => "customId" in b && b.customId.startsWith("beckett:v1:merge"))).toBe(false);
});

test("the Merge accessory stays while the PR is open or pre-state, retires when merged or closed", () => {
  const hasMerge = (state?: "OPEN" | "CLOSED" | "MERGED") =>
    accessories(renderTaskCard(taskCard({ status: "done" }, {
      status: "done",
      artifact: { url: "https://github.com/acme/repo/pull/9", kind: "pull_request" },
      pullRequestNumber: 9,
      ...(state ? { pullRequestState: state } : {}),
    }))).some((b) => "customId" in b && b.customId.startsWith("beckett:v1:merge"));
  expect(hasMerge(undefined)).toBe(true);
  expect(hasMerge("OPEN")).toBe(true);
  expect(hasMerge("MERGED")).toBe(false);
  expect(hasMerge("CLOSED")).toBe(false);
});

test("an in-flight branch offers cancel in the action row but no accessory", () => {
  const card = renderTaskCard(taskCard({}, { status: "running" }));
  expect(actionButtons(card)).toContainEqual({ label: "Cancel #104.1", customId: "beckett:v1:cancel:104.1", danger: true });
  expect(accessories(card)).toHaveLength(0);
  expect(actionButtons(card)).toContainEqual({ label: "Attach to thread", customId: "beckett:v1:attach:104" });
});

test("a cancelled branch offers neither merge nor cancel, still attach", () => {
  const card = renderTaskCard(taskCard({ status: "cancelled" }, { status: "cancelled" }));
  const ids = [...actionButtons(card), ...accessories(card)]
    .flatMap((b) => ("customId" in b ? [b.customId] : []));
  expect(ids.some((id) => id.startsWith("beckett:v1:cancel"))).toBe(false);
  expect(ids.some((id) => id.startsWith("beckett:v1:merge"))).toBe(false);
  expect(actionButtons(card)).toContainEqual({ label: "Attach to thread", customId: "beckett:v1:attach:104" });
});

test("a task with no branches still renders and offers attach", () => {
  const card = renderTaskCard({ number: 5, title: "Fresh", status: "active", updatedAt: "2026-07-28T00:00:00.000Z", branches: [] });
  expect(cardText(card)).toContain("No branches yet");
  expect(actionButtons(card)).toContainEqual({ label: "Attach to thread", customId: "beckett:v1:attach:5" });
});

test("branch screenshots render as one inline gallery with per-branch captions", () => {
  const card = renderTaskCard({
    ...taskCard(),
    branches: [
      { ref: "104.1", title: "Backend", status: "done", images: [{ url: "https://cdn.discordapp.com/a.png" }] },
      {
        ref: "104.2",
        title: "Frontend",
        status: "review",
        images: [{ url: "https://cdn.discordapp.com/b.png", description: "OPS-12" }],
      },
    ],
  });
  const galleries = blocksOfKind(card, "gallery");
  expect(galleries).toHaveLength(1);
  expect(galleries[0]?.images).toEqual([
    { url: "https://cdn.discordapp.com/a.png", description: "#104.1 · Backend" },
    { url: "https://cdn.discordapp.com/b.png", description: "OPS-12" },
  ]);
});

test("no images means no gallery block", () => {
  expect(blocksOfKind(renderTaskCard(taskCard()), "gallery")).toHaveLength(0);
});

test("a branch overflow folds into a header note instead of breaking the container budget", () => {
  const branches = Array.from({ length: 9 }, (_, i) => ({
    ref: `104.${i + 1}`,
    title: `Branch ${i + 1}`,
    status: "running" as const,
  }));
  const card = renderTaskCard({ ...taskCard(), branches });
  // Container cap is 10 children: header + separator + sections + actions + footer.
  expect(card.blocks.length).toBeLessThanOrEqual(10);
  expect(cardText(card)).toContain("more branches not shown");
});

test("a gallery narrows the section budget rather than exceeding the container cap", () => {
  const branches = Array.from({ length: 9 }, (_, i) => ({
    ref: `104.${i + 1}`,
    title: `Branch ${i + 1}`,
    status: "running" as const,
    images: [{ url: `https://cdn.discordapp.com/${i}.png` }],
  }));
  const card = renderTaskCard({ ...taskCard(), branches });
  expect(card.blocks.length).toBeLessThanOrEqual(10);
  expect(blocksOfKind(card, "gallery")[0]?.images.length).toBeLessThanOrEqual(10);
});
