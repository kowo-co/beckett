/**
 * Beckett — id scheme (`src/ids.ts`)
 * =======================================================================================
 * Stable, URL-safe, collision-safe ids: prefixed short ids derived from `crypto.randomUUID()`
 * hex (entropy-dense; ~48 bits in the default slice is ample for a single-box daemon).
 */

import { randomUUID } from "node:crypto";

/** Default entropy slice length (hex chars) for prefixed ids. */
const SHORT_LEN = 8;

/** Hex entropy from a v4 UUID, dashes stripped. */
function hex(): string {
  return randomUUID().replace(/-/g, "");
}

/** A prefixed short id, e.g. `prefixedId("task")` → "task_1a2b3c4d". */
export function prefixedId(prefix: string, len = SHORT_LEN): string {
  return `${prefix}_${hex().slice(0, len)}`;
}

export const workerId = (): string => prefixedId("wk");
