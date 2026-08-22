/**
 * Beckett — Reminders model (`src/reminder/types.ts`)
 * =======================================================================================
 * ro asked for a reminders function: "internal or external", self-clearing once fired unless
 * it recurs. A **reminder** is a note plus a fire time. When it fires it is DELIVERED — either
 * `external` (a Discord post, optionally pinging people, through the same `discord.reply` bus
 * path `beckett discord reply --ping` already uses) or `internal` (a framed SYSTEM turn on the
 * concierge, the same `askUpdate`/`SYSTEM_SCOPE` lane run/mail/routine-self updates already use —
 * see `routine.self` in `src/concierge/index.ts`, the closest existing precedent).
 *
 * A one-shot reminder (`recurrence.kind === "none"`) is REMOVED from the store the moment it
 * fires — that is the "self-clearing" behavior ro asked for, and the caller never has to clean
 * up after it. A recurring reminder rolls forward to its next occurrence and stays on the list
 * (`src/reminder/schedule.ts` owns that math).
 *
 * Every reminder carries an absolute UTC fire instant PLUS its IANA timezone, so recurrence can
 * always re-derive the correct next wall-clock instant across a DST transition — the same
 * discipline `src/routine/schedule.ts` uses for its fuzz windows, reused here (see
 * `./schedule.ts`).
 *
 * `status` is the crash-safety seam ({@link ./scheduler.ts}): `pending` is due-checked every
 * tick; `firing` means a delivery attempt has started but not yet been confirmed finished (a
 * persisted CLAIM written before dispatch), so a restart mid-fire retries delivery instead of
 * either dropping the reminder or leaving it stuck.
 */

import { z } from "zod";
import { WeekdaySchema, type Weekday } from "../routine/types.ts";

export { WeekdaySchema, type Weekday };

/**
 * How a reminder repeats after it fires.
 *   - `none`          — one-shot; fires once and is removed from the store (issue's ask).
 *   - `daily`         — same wall-clock time, every calendar day.
 *   - `weekly`        — same wall-clock time, once per week on `weekday`.
 *   - `weekday`       — same wall-clock time, every Monday–Friday (skips weekends).
 *   - `every-n-days`  — same wall-clock time, every `days` calendar days (`days` ≥ 1).
 */
export const RecurrenceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }),
  z.object({ kind: z.literal("daily") }),
  z.object({ kind: z.literal("weekly"), weekday: WeekdaySchema }),
  z.object({ kind: z.literal("weekday") }),
  z.object({ kind: z.literal("every-n-days"), days: z.number().int().min(1) }),
]);
export type Recurrence = z.infer<typeof RecurrenceSchema>;

/**
 * `external` posts into a Discord channel (optionally pinging people); `internal` surfaces to
 * the concierge itself on its next turn and never posts anywhere a human would see it.
 */
export const ReminderKindSchema = z.enum(["internal", "external"]);
export type ReminderKind = z.infer<typeof ReminderKindSchema>;

/**
 * `pending` — due-checked every scheduler tick, fires when `fireAt` has passed.
 * `firing`  — a delivery attempt has been CLAIMED (persisted) but not yet confirmed finished.
 * See the module header and {@link ../reminder/scheduler.ts} for the crash-safety story this
 * buys: a restart that finds a reminder here retries delivery rather than silently losing it.
 */
export const ReminderStatusSchema = z.enum(["pending", "firing"]);
export type ReminderStatus = z.infer<typeof ReminderStatusSchema>;

export const ReminderSchema = z.object({
  /** Stable id, e.g. an 8-char random slug (mirrors `RoutineStore`'s id scheme). */
  id: z.string().min(1),
  /** What to say when it fires. */
  note: z.string().min(1),
  kind: ReminderKindSchema,
  /** The absolute UTC instant this reminder next fires at, ISO-8601. */
  fireAt: z.string().min(1),
  /** IANA timezone `fireAt`'s wall-clock is expressed in — recurrence rolls in this zone. */
  tz: z.string().min(1),
  recurrence: RecurrenceSchema,
  /**
   * `external`: the Discord channel it posts to (required). `internal`: the channel the
   * reminder was CREATED from, kept for provenance/context only — internal delivery never
   * posts to it.
   */
  channelId: z.string().min(1).nullable().default(null),
  /** Discord user ids to ping (`external` only; resolved through the identity map at create time). */
  pingUserIds: z.array(z.string().min(1)).default([]),
  status: ReminderStatusSchema.default("pending"),
  /** Authenticated requester the reminder is attributed to, when known. */
  requesterId: z.string().min(1).nullable().default(null),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Reminder = z.infer<typeof ReminderSchema>;

export const ReminderRegistrySchema = z.object({
  version: z.literal(1),
  reminders: z.array(ReminderSchema).default([]),
});
export type ReminderRegistry = z.infer<typeof ReminderRegistrySchema>;
