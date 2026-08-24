/**
 * The dream pass's MAINTENANCE surface: `updateDream`, `retireDream`, `flagStaleNode`. The pass
 * now prunes as well as adds, so these three exist — and each one keeps the same wall
 * `rememberDream` has (`dreams.test.ts`, unchanged): a dream may edit its OWN namespace and
 * nothing else, and may only ever FLAG somebody's fact, never rewrite it.
 */

import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createMemory, type MemoryStore } from "./index.ts";
import type { Logger } from "../types.ts";

const dirs: string[] = [];
const quiet = (() => {
  const log = { debug() {}, info() {}, warn() {}, error() {}, child: () => log };
  return log as unknown as Logger;
})();

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function store(): { memory: MemoryStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "beckett-dream-maint-"));
  dirs.push(dir);
  return { memory: createMemory({ memoryDir: dir, logger: quiet, git: false }), dir };
}

/** One dream node plus one plain observed fact — the two sides of every wall below. */
async function seeded(): Promise<{ memory: MemoryStore; dir: string }> {
  const { memory, dir } = store();
  await memory.rememberDream({
    name: "dream-2026-08-01-ship-cadence",
    description: "releases ship on mondays",
    body: "inferred from a standup",
    provenance: ["channel:c:1"],
    reason: "seed",
  });
  await memory.remember({
    op: "create",
    name: "jason",
    type: "person",
    description: "jason, on the platform team",
    source: "conversation",
    reason: "seed",
  });
  return { memory, dir };
}

// ── updateDream ──────────────────────────────────────────────────────────────────────────

test("updateDream rewrites an existing dream node in place, keeping type/inference markers", async () => {
  const { memory } = await seeded();
  await memory.updateDream({
    name: "dream-2026-08-01-ship-cadence",
    description: "releases ship on fridays",
    body: "corrected tonight",
    provenance: ["channel:c:2"],
    reason: "test",
  });
  const node = memory.buildGraph().nodes.get("dream-2026-08-01-ship-cadence")!;
  expect(node.description).toBe("releases ship on fridays");
  expect(node.body).toBe("corrected tonight");
  expect(node.type).toBe("dream");
  expect(node.metadata.inference).toBe(true);
  expect(node.metadata.provenance).toEqual(["channel:c:2"]);
});

test("updateDream leaves description and provenance alone when the caller omits them", async () => {
  const { memory } = await seeded();
  await memory.updateDream({ name: "dream-2026-08-01-ship-cadence", body: "just a note", reason: "test" });
  const node = memory.buildGraph().nodes.get("dream-2026-08-01-ship-cadence")!;
  expect(node.description).toBe("releases ship on mondays");
  expect(node.metadata.provenance).toEqual(["channel:c:1"]);
});

test("updateDream refuses a node outside the dream namespace — the whole point of the method", async () => {
  const { memory } = await seeded();
  await expect(
    memory.updateDream({ name: "jason", description: "rewritten by a dream", reason: "test" }),
  ).rejects.toThrow(/invalid dream node name/);
  expect(memory.buildGraph().nodes.get("jason")!.description).toBe("jason, on the platform team");
});

test("updateDream refuses a dream-SHAPED name that does not exist, and one that is not type dream", async () => {
  const { memory } = await seeded();
  await expect(
    memory.updateDream({ name: "dream-2026-08-01-nope", description: "x", reason: "test" }),
  ).rejects.toThrow(/no such dream node/);

  // A node that answers to a dream-shaped name but is NOT a dream (only reachable by writing it
  // through `remember`) is still refused — the type check is independent of the name check.
  await memory.remember({
    op: "create",
    name: "dream-2026-08-05-impostor",
    type: "preference",
    description: "not actually a dream",
    source: "conversation",
    reason: "seed",
  });
  await expect(
    memory.updateDream({ name: "dream-2026-08-05-impostor", description: "x", reason: "test" }),
  ).rejects.toThrow(/is not a dream node/);
});

// ── retireDream ──────────────────────────────────────────────────────────────────────────

test("retireDream archives the node out of the graph — the bytes survive, nothing is deleted", async () => {
  const { memory, dir } = await seeded();
  await memory.retireDream("dream-2026-08-01-ship-cadence", "superseded tonight");
  expect(memory.buildGraph().nodes.has("dream-2026-08-01-ship-cadence")).toBe(false);
  const archived = join(dir, "archive", "dream-2026-08-01-ship-cadence.md");
  expect(existsSync(archived)).toBe(true);
  expect(readFileSync(archived, "utf8")).toContain("superseded tonight");
});

test("retireDream refuses anything outside the namespace", async () => {
  const { memory } = await seeded();
  await expect(memory.retireDream("jason", "inconvenient")).rejects.toThrow(/invalid dream node name/);
  expect(memory.buildGraph().nodes.has("jason")).toBe(true);
});

// ── flagStaleNode ────────────────────────────────────────────────────────────────────────

test("flagStaleNode writes a NEW dream node about the target and never touches the target", async () => {
  const { memory, dir } = await seeded();
  const before = readFileSync(memory.buildGraph().nodes.get("jason")!.path, "utf8");

  await memory.flagStaleNode({
    name: "dream-2026-08-19-stale-jason",
    target: "jason",
    flagReason: "says he moved to infra",
    provenance: ["channel:c:9"],
    reason: "test",
  });

  const flag = memory.buildGraph().nodes.get("dream-2026-08-19-stale-jason")!;
  expect(flag.type).toBe("dream");
  expect(flag.metadata.inference).toBe(true);
  expect(flag.metadata.flag_target).toBe("jason");
  expect(flag.metadata.flag_reason).toBe("says he moved to infra");
  expect(flag.description).toContain("possibly stale: jason");
  expect(readFileSync(join(dir, "people", "jason.md"), "utf8")).toBe(before);
});

test("flagStaleNode refuses a flag with no reason and one with no provenance", async () => {
  const { memory } = await seeded();
  await expect(
    memory.flagStaleNode({ name: "dream-2026-08-19-stale-jason", target: "jason", flagReason: "", provenance: ["channel:c:9"], reason: "t" }),
  ).rejects.toThrow(/needs a reason/);
  await expect(
    memory.flagStaleNode({ name: "dream-2026-08-19-stale-jason", target: "jason", flagReason: "why", provenance: [], reason: "t" }),
  ).rejects.toThrow(/non-empty provenance/);
});

test("flagStaleNode refuses a target that does not exist, and refuses to flag another dream", async () => {
  const { memory } = await seeded();
  await expect(
    memory.flagStaleNode({ name: "dream-2026-08-19-stale-nobody", target: "nobody", flagReason: "gone", provenance: ["channel:c:9"], reason: "t" }),
  ).rejects.toThrow(/no such node to flag/);
  await expect(
    memory.flagStaleNode({
      name: "dream-2026-08-19-stale-own",
      target: "dream-2026-08-01-ship-cadence",
      flagReason: "wrong",
      provenance: ["channel:c:9"],
      reason: "t",
    }),
  ).rejects.toThrow(/use updateDream\/retireDream/);
});

test("a flag node is itself create-only — a second flag under the same name is refused", async () => {
  const { memory } = await seeded();
  const input = {
    name: "dream-2026-08-19-stale-jason",
    target: "jason",
    flagReason: "says he moved to infra",
    provenance: ["channel:c:9"],
    reason: "t",
  };
  await memory.flagStaleNode(input);
  await expect(memory.flagStaleNode(input)).rejects.toThrow(/create-only/);
});
