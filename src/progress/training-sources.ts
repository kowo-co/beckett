/**
 * Beckett — the file-tailed training progress sources (`src/progress/training-sources.ts`)
 * =======================================================================================
 * The one production config for `./training-card.ts`: ro's throttled CPU pretrain, running as the
 * `babble-cpu-pretrain` systemd --user unit outside Beckett's own process tree entirely. Adding a
 * second file-tailed source later is a second array entry here, not a code change — see
 * `./training-source.ts#FileTailProgressSourceConfig` for what a source needs to name.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import type { FileTailProgressSourceConfig } from "./training-source.ts";

/** Where the throttled CPU pretrain writes its logs — read-only, never written into. */
const BABBLE_SCRATCH_DIR = join(homedir(), "babble-scratch", "throttled-cpu-pretrain");

/** One epoch over the pretrain corpus, in tokens. */
const BABBLE_EPOCH_TOKEN_BUDGET = 239_000_000;

/** Every configured source, or `[]` when `channelId` is null (the card's channel is disabled). */
export function defaultFileTailProgressSources(channelId: string | null): FileTailProgressSourceConfig[] {
  if (!channelId) return [];
  return [
    {
      label: "throttled CPU pretrain",
      unit: "babble-cpu-pretrain.service",
      jsonlPath: join(BABBLE_SCRATCH_DIR, "loss.jsonl"),
      consoleLogPath: join(BABBLE_SCRATCH_DIR, "train.out"),
      tokenBudget: BABBLE_EPOCH_TOKEN_BUDGET,
      channelId,
    },
  ];
}
