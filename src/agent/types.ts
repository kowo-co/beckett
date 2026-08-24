/**
 * Beckett — Agent registry model (`src/agent/types.ts`)
 * =======================================================================================
 * An **agent** is a named, reusable worker persona: a system prompt + a harness/model/effort
 * seat + the skills/tools it is allowed to reach for. The registry is read LIVE by the running
 * daemon the same way `routines.json` is ({@link ../routine/types.ts}) — adding or editing an
 * agent needs no rebuild or restart (issue #66, foundation for #55).
 *
 * These are the Zod-validated shapes the store reads/writes ({@link ./store.ts}) and the
 * defensive live loader enumerates ({@link ./registry.ts}). Harness/effort literals mirror the
 * daemon's driver seats (`src/types.ts` `Harness` / `Effort`) rather than reinventing them.
 *
 * The `persistent` flag distinguishes an ephemeral (spun up on the fly for one task) agent from
 * a persistent one that keeps context/state across invocations. Persistence itself lands in
 * #55.2 — here the schema just carries the flag so the two kinds are already distinguishable.
 */

import { z } from "zod";

/**
 * Which CLI harness the agent runs under. Mirrors `Harness` in `src/types.ts`; the authoritative
 * usable set is the driver registry (`src/drivers`), but the registry only needs the three the
 * daemon can spawn today.
 */
export const AGENT_HARNESSES = ["claude", "codex", "pi"] as const;
export const AgentHarnessSchema = z.enum(AGENT_HARNESSES);

/**
 * Reasoning depth. Mirrors `Effort` in `src/types.ts`. `""` means "let the harness default decide"
 * (the same loose seat convention the chat/quick config seats use).
 */
export const AGENT_EFFORTS = ["", "low", "medium", "high", "xhigh"] as const;
export const AgentEffortSchema = z.enum(AGENT_EFFORTS);

/** The harness seat: which CLI + model + reasoning depth the agent spawns with. */
export const AgentModelSchema = z.object({
  harness: AgentHarnessSchema.default("claude"),
  model: z.string().min(1),
  effort: AgentEffortSchema.default("medium"),
});

export const AgentDefinitionSchema = z.object({
  /** Stable id/name, kebab-case (e.g. "release-notes-writer"). */
  id: z.string().min(1),
  /** Human-readable one-liner: what this agent is for. Surfaced to humans + the concierge. */
  description: z.string().min(1),
  /** The system prompt that defines the agent's persona/instructions. */
  systemPrompt: z.string().min(1),
  /** Harness + model + effort seat. */
  model: AgentModelSchema,
  /** Skills the agent may invoke (by skill name). Empty = none granted beyond defaults. */
  skills: z.array(z.string()).default([]),
  /** Tools the agent may use (by tool name). Empty = none granted beyond defaults. */
  tools: z.array(z.string()).default([]),
  /**
   * false (default) = ephemeral: spun up on the fly for one task, no state kept.
   * true = persistent: keeps context/state across invocations (mechanics land in #55.2).
   */
  persistent: z.boolean().default(false),
  /** True for engine-seeded agents that re-appear on boot unless explicitly removed. */
  builtin: z.boolean().default(false),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type AgentDefinition = z.infer<typeof AgentDefinitionSchema>;

export const AgentRegistrySchema = z.object({
  version: z.literal(1),
  agents: z.array(AgentDefinitionSchema).default([]),
  /** Built-in ids the user explicitly removed, so seeding doesn't resurrect them. */
  removedBuiltins: z.array(z.string()).default([]),
});
export type AgentRegistry = z.infer<typeof AgentRegistrySchema>;
