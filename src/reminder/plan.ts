/**
 * Beckett — Reminder delivery plan (`src/reminder/plan.ts`)
 * =======================================================================================
 * Turns a reminder into a concrete, inspectable delivery plan — pure, no I/O — shared by the
 * scheduler tick (which hands the plan to a real dispatcher) and `remind fire --dry`, which
 * builds and prints the SAME plan without ever calling `dispatch`. Mirrors
 * {@link ../routine/plan.ts}'s split for the identical reason: the wiring is provable without a
 * live post or a live concierge turn.
 */

import type { Reminder } from "./types.ts";

export interface ReminderDeliveryPlan {
  reminderId: string;
  kind: "internal" | "external";
  note: string;
  /** external only — the channel it posts to. */
  channelId: string | null;
  /** external only — resolved Discord user ids pinged in the post. */
  pingUserIds: string[];
  /** Human-readable summary for `remind fire --dry` / logs. */
  preview: string;
}

export function buildDeliveryPlan(reminder: Reminder): ReminderDeliveryPlan {
  if (reminder.kind === "external") {
    const pingSuffix = reminder.pingUserIds.length ? `, pinging ${reminder.pingUserIds.join(", ")}` : "";
    return {
      reminderId: reminder.id,
      kind: "external",
      note: reminder.note,
      channelId: reminder.channelId,
      pingUserIds: reminder.pingUserIds,
      preview: `post to Discord channel ${reminder.channelId ?? "(none)"}${pingSuffix}: "${reminder.note}"`,
    };
  }
  return {
    reminderId: reminder.id,
    kind: "internal",
    note: reminder.note,
    channelId: null,
    pingUserIds: [],
    preview: `wake the concierge on its own turn (no channel post): "${reminder.note}"`,
  };
}
