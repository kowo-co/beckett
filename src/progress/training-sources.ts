/**
 * Beckett — the file-tailed training progress sources (`src/progress/training-sources.ts`)
 * =======================================================================================
 * The one production config for `./training-card.ts`: the CPU continue run (resumed from the
 * served checkpoint), running as the `babble-cpu-pretrain` systemd --user unit outside Beckett's
 * own process tree entirely. Adding a second file-tailed source later is a second array entry
 * here, not a code change — see `./training-source.ts#FileTailProgressSourceConfig` for what a
 * source needs to name.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import type { FileTailProgressSourceConfig } from "./training-source.ts";

/** Where the CPU continue run writes its logs — read-only, never written into. */
const BABBLE_SCRATCH_DIR = join(homedir(), "babble-scratch", "cpu-continue");

/**
 * Total `tokens_consumed` this run is aiming at (see `cpu-continue/README.txt`). The jsonl
 * counter was seeded at ~600,206,202 from the served checkpoint, so this is NOT "tokens this
 * session" and is NOT an epoch size. Percent = tokens_seen / this, ETA = (this − tokens_seen) / rate.
 */
export const BABBLE_TOKEN_BUDGET = 680_000_000;

/** Every configured source, or `[]` when `channelId` is null (the card's channel is disabled). */
export function defaultFileTailProgressSources(channelId: string | null): FileTailProgressSourceConfig[] {
  if (!channelId) return [];
  return [
    {
      label: "CPU continue from checkpoint",
      unit: "babble-cpu-pretrain.service",
      jsonlPath: join(BABBLE_SCRATCH_DIR, "loss.jsonl"),
      consoleLogPath: join(BABBLE_SCRATCH_DIR, "train.out"),
      tokenBudget: BABBLE_TOKEN_BUDGET,
      channelId,
    },
  ];
}
