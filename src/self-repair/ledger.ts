/**
 * Beckett — nightly self-repair filing ledger (`src/self-repair/ledger.ts`)
 * =======================================================================================
 * The pass is idempotent across days because it remembers which signatures it already filed.
 * A cluster with an OPEN run (or a ledger hit) is never re-filed. Dying halfway must not
 * leave a half-filed run: the runner writes the ledger row AFTER a successful deploy, one
 * cluster at a time.
 *
 * Atomic tmp+rename, same discipline as the other small JSON ledgers.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";

const EntrySchema = z.object({
  signature: z.string().min(1),
  filedAt: z.string().min(1),
  runId: z.string().min(1),
  title: z.string().min(1),
});

const LedgerSchema = z.object({
  version: z.literal(1).default(1),
  filed: z.array(EntrySchema).default([]),
});

type FiledEntry = z.infer<typeof EntrySchema>;
export type SelfRepairLedger = z.infer<typeof LedgerSchema>;

const EMPTY: SelfRepairLedger = { version: 1, filed: [] };

export function ledgerPath(rootDir: string): string {
  return `${rootDir.replace(/\/$/, "")}/filed.json`;
}

export function readLedger(path: string): SelfRepairLedger {
  try {
    const raw = readFileSync(path, "utf8");
    return LedgerSchema.parse(JSON.parse(raw));
  } catch {
    return structuredClone(EMPTY);
  }
}

export function writeLedger(path: string, ledger: SelfRepairLedger): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(ledger, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, path);
}

export function isFiled(ledger: SelfRepairLedger, signature: string): boolean {
  return ledger.filed.some((row) => row.signature === signature);
}

export function recordFiled(ledger: SelfRepairLedger, entry: FiledEntry): SelfRepairLedger {
  return {
    version: 1,
    filed: [...ledger.filed.filter((row) => row.signature !== entry.signature), entry],
  };
}

/** Marker the brief carries so a later pass can see an open run without parsing titles. */
export const SIGNATURE_MARKER = "self-repair-signature:";

export function promptCarriesSignature(prompt: string, signature: string): boolean {
  return prompt.includes(`${SIGNATURE_MARKER} ${signature}`);
}
