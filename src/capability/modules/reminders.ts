/**
 * Beckett — the reminders extension (`src/capability/modules/reminders.ts`)
 * =======================================================================================
 * ro asked: "create a reminders function so you can set internal or external reminders … once
 * the reminder is sent it clears from the list unless its a weekly or whatever." This organ, on
 * the v6 extension contract (following `routines.ts`'s Phase 3b shape — the closest sibling: a
 * `startPhase: "late"` background scheduler that dispatches into the live system):
 *
 *   - `init` builds the durable {@link ReminderStore} and the scheduler's deps INERT.
 *   - `start` (late sweep) arms the tick loop via `startReminderScheduler`, plus a 5s post-boot
 *     prime tick so a reminder already due at boot doesn't wait a full 30s — same shape as the
 *     routines extension's prime.
 *   - `stop` is idempotent.
 *   - `health` reports loop liveness + the pending census + the earliest next fire.
 *
 * Delivery is two lanes, both reusing EXISTING machinery rather than a new sender:
 *   - `external` → `discord.reply` over the control bus, the SAME bus command
 *     `beckett discord reply --ping` posts through (`src/cli/core.ts::runDiscordReply`). Ping
 *     targets are resolved through the identity map (`resolvePingTargets`) at CREATE time, same
 *     as `discord reply`/`task create` already do — never re-resolved at fire time.
 *   - `internal` → a NEW `reminder.internal` control-bus command (`src/concierge/index.ts`,
 *     right beside `routine.self`), which frames a SYSTEM turn and hands it to `askUpdate` — the
 *     exact `SYSTEM_SCOPE` lane run/mail/routine-self updates already use. Never posts to Discord.
 *
 * `remind fire … --force`-equivalent real fires route through the SAME concierge-owned bus-
 * command indirection `routine.fire` uses (`this.remindOps` in `src/concierge/index.ts`, wired
 * from `src/shell/main.ts`) — a late-phase extension's live scheduler can't be reached any other
 * way from a bus command declared before the extension exists. `--dry` stays CLI-local (builds
 * the plan through `./reminder/plan.ts`, no daemon needed), exactly like `routine fire --dry-run`.
 */

import { join } from "node:path";
import { z } from "zod";
import { ActionClass, type Extension, type ExtensionContext } from "../../ext/contract.ts";
import { ReminderStore } from "../../reminder/store.ts";
import {
  startReminderScheduler,
  type ReminderScheduler,
  type ReminderSchedulerDeps,
} from "../../reminder/scheduler.ts";
import { buildDeliveryPlan } from "../../reminder/plan.ts";
import { isValidTimeZone, localWeekday } from "../../reminder/schedule.ts";
import { parseWhen } from "../../reminder/when.ts";
import { WeekdaySchema, type Reminder, type Recurrence } from "../../reminder/types.ts";
import { resolvePingTargets, renderMentions } from "../../discord/mentions.ts";
import { callBus } from "../../shell/control-bus.ts";
import { collectFlag, fail, out, parse } from "../../cli/io.ts";

export interface RemindersExtensionDeps {
  now?: () => Date;
  createStore?: (ctx: ExtensionContext) => ReminderStore;
  createScheduler?: (deps: ReminderSchedulerDeps) => ReminderScheduler;
  intervalMs?: number;
  /**
   * How an `internal` reminder wakes the concierge. Default: a `reminder.internal` control-bus
   * post (see the module header). Injected so a test can assert the lane posts the bus command
   * without a live socket.
   */
  wakeSelf?: (post: { reminderId: string; note: string; channelId: string | null }) => void | Promise<void>;
}

/** The built extension plus the accessors `shell/main.ts` wires into the concierge's setters. */
export interface RemindersExtension extends Extension {
  /** The daemon-owned durable reminder store. Throws before `lifecycle.init` has run. */
  store(): ReminderStore;
  /** The live tick scheduler. Throws before `lifecycle.start` (the late sweep) has run. */
  scheduler(): ReminderScheduler;
}

// ── display helpers ─────────────────────────────────────────────────────────────────────────

function describeRecurrence(recurrence: Recurrence): string {
  switch (recurrence.kind) {
    case "none":
      return "one-shot";
    case "daily":
      return "daily";
    case "weekday":
      return "every weekday";
    case "weekly":
      return `weekly (${recurrence.weekday})`;
    case "every-n-days":
      return `every ${recurrence.days}d`;
  }
}

/** "Sun 2026-07-26, 09:14 America/Los_Angeles" — a reminder's next fire, humanized. */
function describeNextFire(reminder: Reminder): string {
  const local = new Intl.DateTimeFormat("en-CA", {
    timeZone: reminder.tz,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(reminder.fireAt));
  return `${local} ${reminder.tz}`;
}

function summarizeReminder(reminder: Reminder): Record<string, unknown> {
  return {
    id: reminder.id,
    note: reminder.note,
    kind: reminder.kind,
    recurrence: describeRecurrence(reminder.recurrence),
    nextFire: describeNextFire(reminder),
    channelId: reminder.channelId,
    pingUserIds: reminder.pingUserIds,
    status: reminder.status,
  };
}

/**
 * Parse `--recurrence` into a {@link Recurrence}. There is no separate "which weekday" flag — a
 * `weekly` reminder's weekday is whatever `--when` resolved to, filled in here from
 * `initialFireAt`/`tz` so the CLI flag and the `remind.create` capability can never disagree.
 */
function parseRecurrence(raw: string | undefined, initialFireAt: Date, tz: string): Recurrence {
  const value = (raw ?? "none").trim().toLowerCase();
  if (value === "" || value === "none") return { kind: "none" };
  if (value === "daily") return { kind: "daily" };
  if (value === "weekday") return { kind: "weekday" };
  if (value === "weekly") {
    return { kind: "weekly", weekday: WeekdaySchema.parse(localWeekday(tz, initialFireAt)) };
  }
  const everyN = value.match(/^every-(\d+)d$/);
  if (everyN) return { kind: "every-n-days", days: Number(everyN[1]) };
  throw new Error(
    `--recurrence must be one of: daily, weekly, weekday, every-Nd (e.g. every-3d) — got "${raw}"`,
  );
}

// ── v6 invocation schemas ──────────────────────────────────────────────────────────────────

const CreateArgs = z.object({
  note: z.string().trim().min(1, "a reminder needs a note"),
  when: z.string().trim().min(1, "remind.create needs when"),
  tz: z.string().refine(isValidTimeZone, "tz must be a valid IANA timezone, e.g. America/Los_Angeles").optional(),
  channelId: z.string().trim().min(1).optional(),
  pingUserIds: z.array(z.string().trim().min(1)).optional(),
  internal: z.boolean().optional(),
  recurrence: z.string().optional(),
});

const RemoveArgs = z.object({
  id: z.string().trim().min(1, "remind.remove needs a reminder id"),
});

const FireArgs = z.object({
  id: z.string().trim().min(1, "remind.fire needs a reminder id"),
  /** Build and return the delivery plan WITHOUT dispatching. */
  dryRun: z.boolean().optional(),
});

export const createRemindersExtension =
  (deps: RemindersExtensionDeps) =>
  (ctx: ExtensionContext): RemindersExtension => {
    // Built by lifecycle.init; the scheduler is armed only by lifecycle.start (late sweep).
    let store: ReminderStore | null = null;
    let schedulerDeps: ReminderSchedulerDeps | null = null;
    let scheduler: ReminderScheduler | null = null;
    let primeTimer: ReturnType<typeof setTimeout> | null = null;

    function requireStore(): ReminderStore {
      if (!store) throw new Error("the reminders extension is not initialized (lifecycle.init has not run)");
      return store;
    }
    function requireScheduler(): ReminderScheduler {
      if (!scheduler) throw new Error("the reminder scheduler is not started (lifecycle.start has not run)");
      return scheduler;
    }

    function freshStore(): ReminderStore {
      return deps.createStore?.(ctx) ?? new ReminderStore(join(ctx.paths.beckettDir, "reminders.json"));
    }

    async function dispatchExternal(reminder: Reminder): Promise<void> {
      if (!reminder.channelId) throw new Error(`reminder ${reminder.id} has no channel to post to`);
      const text = renderMentions(reminder.note, reminder.pingUserIds);
      const res = await callBus(
        join(ctx.paths.beckettDir, "control.sock"),
        "discord.reply",
        {
          channelId: reminder.channelId,
          text,
          ...(reminder.pingUserIds.length > 0 ? { pingUserIds: reminder.pingUserIds } : {}),
        },
        30_000,
      );
      if (!res.ok) throw new Error(res.error ?? "discord.reply failed");
    }

    async function dispatchInternal(reminder: Reminder): Promise<void> {
      const wake =
        deps.wakeSelf ??
        (async (post: { reminderId: string; note: string; channelId: string | null }) => {
          const res = await callBus(
            join(ctx.paths.beckettDir, "control.sock"),
            "reminder.internal",
            {
              reminderId: post.reminderId,
              note: post.note,
              ...(post.channelId ? { channelId: post.channelId } : {}),
            },
            30_000,
          );
          if (!res.ok) throw new Error(res.error ?? "reminder.internal failed");
        });
      await wake({ reminderId: reminder.id, note: reminder.note, channelId: reminder.channelId });
    }

    async function dispatchReminder(reminder: Reminder): Promise<void> {
      if (reminder.kind === "external") return dispatchExternal(reminder);
      return dispatchInternal(reminder);
    }

    // ── the carried CLI verb — beckett remind list|create|remove|fire ──────────────────────
    async function runRemind(argv: string[]): Promise<void> {
      const sock = join(ctx.paths.beckettDir, "control.sock");
      const [sub, ...rest] = argv;
      const cliStore = freshStore();

      if (!sub || sub === "list") {
        const reminders = await cliStore.list();
        out(reminders.map(summarizeReminder));
      }

      if (sub === "create") {
        const { _, flags } = parse(rest);
        const note = _.join(" ").trim();
        const whenRaw = flags.when ? String(flags.when) : "";
        if (!note || !whenRaw) {
          fail(
            'usage: beckett remind create "<note>" --when <time> [--channel <id>] [--ping <target>]... ' +
              "[--internal] [--recurrence daily|weekly|weekday|every-Nd] [--tz <IANA>]",
          );
        }
        const tz = flags.tz ? String(flags.tz) : ctx.config.display.timezone;
        if (!isValidTimeZone(tz)) fail("--tz must be a valid IANA timezone, e.g. America/Los_Angeles");

        let fireAt: Date;
        try {
          fireAt = parseWhen(whenRaw, tz, (deps.now ?? (() => new Date()))());
        } catch (err) {
          fail((err as Error).message);
          return;
        }
        let recurrence: Recurrence;
        try {
          recurrence = parseRecurrence(flags.recurrence ? String(flags.recurrence) : undefined, fireAt, tz);
        } catch (err) {
          fail((err as Error).message);
          return;
        }

        const internal = flags.internal === true;
        const pingTargets = collectFlag(rest, "ping");
        let pingUserIds: string[] = [];
        if (pingTargets.length > 0) {
          try {
            pingUserIds = resolvePingTargets(pingTargets, ctx.paths.identitiesFile);
          } catch (err) {
            fail((err as Error).message);
            return;
          }
        }
        const channelId = flags.channel ? String(flags.channel).trim() : "";
        if (!internal && !channelId) fail("an external reminder needs --channel <id> (the channel it posts to)");

        try {
          const reminder = await cliStore.add({
            id: "",
            note,
            kind: internal ? "internal" : "external",
            fireAt: fireAt.toISOString(),
            tz,
            recurrence,
            channelId: channelId || null,
            pingUserIds,
            requesterId: null,
          });
          out(summarizeReminder(reminder));
        } catch (err) {
          fail((err as Error).message);
        }
      }

      if (sub === "remove" || sub === "rm") {
        const id = rest[0];
        if (!id) fail("usage: beckett remind remove <id>");
        const removed = await cliStore.remove(id!);
        if (!removed) fail(`no such reminder: ${id}`);
        out(`removed reminder ${id}`);
      }

      if (sub === "fire") {
        const { _, flags } = parse(rest);
        const id = _[0];
        if (!id) fail("usage: beckett remind fire <id> [--dry]");
        const dryRun = flags.dry === true || flags["dry-run"] === true;

        if (dryRun) {
          const reminder = await cliStore.get(id!);
          if (!reminder) fail(`no such reminder: ${id}`);
          const plan = buildDeliveryPlan(reminder!);
          out({
            dryRun: true,
            ...plan,
            notice: "dry-run did NOT dispatch. To fire for real: beckett remind fire " + id,
          });
          return;
        }
        try {
          const res = await callBus(sock, "remind.fire", { id, dryRun: false }, 30_000);
          if (!res.ok) fail(res.error ?? "remind fire failed");
          out(res.data);
        } catch (err) {
          fail((err as Error).message);
        }
      }

      fail(
        'usage: beckett remind list | create "<note>" --when <time> [--channel <id>] [--ping <target>]... ' +
          "[--internal] [--recurrence daily|weekly|weekday|every-Nd] [--tz <IANA>] | remove <id> | fire <id> [--dry]",
      );
    }

    return {
      manifest: {
        id: "reminders",
        version: "1.0.0",
        summary:
          "internal/external self-clearing reminders: a note plus a fire time, one-shot or recurring",
        actionClass: ActionClass.FREE,
        kind: "extension",
      },

      capabilities: [
        {
          id: "remind.list",
          description:
            "List every pending reminder — kind (internal/external), recurrence, and the next fire " +
            "time, humanized, sorted soonest first. Use when someone asks what's set to remind, or " +
            "what you (Beckett) still have on your own follow-up list.",
          examples: ["what reminders are pending?", "what am I set to remind you about?"],
        },
        {
          id: "remind.create",
          description:
            "Set a NEW reminder: a note plus a fire time (absolute, or relative like \"in 20m\"/" +
            '"in 3h"/"tomorrow 9am"). `internal` wakes the concierge itself on its own next turn ' +
            "(no channel post) — use for \"remind yourself to check on X\". Otherwise it posts to a " +
            "Discord channel, optionally pinging people. One-shot by default; `recurrence` " +
            "(daily/weekly/weekday/every-Nd) keeps it on the list, rolled forward, after each fire.",
          actionClass: ActionClass.HANDSHAKE_GATED,
          input: CreateArgs,
          examples: [
            "remind me in 20 minutes to check the deploy",
            "remind yourself to follow up on this tomorrow morning",
            "remind the channel every Monday at 9am to file timesheets",
          ],
        },
        {
          id: "remind.remove",
          description: "Cancel a reminder by id so it never fires again. Use for \"cancel that reminder\".",
          actionClass: ActionClass.HANDSHAKE_GATED,
          input: RemoveArgs,
          examples: ["cancel the timesheet reminder"],
        },
        {
          id: "remind.fire",
          description:
            "Fire a reminder NOW instead of waiting for its time — dryRun builds and returns the " +
            "delivery plan without posting or waking the concierge.",
          actionClass: ActionClass.ALWAYS_ASK,
          input: FireArgs,
          examples: ["fire that reminder now instead of waiting"],
        },
      ],

      invoke: async (call) => {
        try {
          switch (call.capabilityId) {
            case "remind.list": {
              const reminders = await requireStore().list();
              return { ok: true, data: { reminders: reminders.map(summarizeReminder) } };
            }
            case "remind.create": {
              if (!call.origin?.userId) {
                return { ok: false, error: "reminder changes need an authenticated authorized request" };
              }
              const a = call.args as z.infer<typeof CreateArgs>;
              // A report channel may only RESTATE the origin channel, never redirect a reminder's
              // fire somewhere the authorized request was not made (routines.add's rule, issue #62).
              const requestedChannelId = a.channelId?.trim();
              if (requestedChannelId && call.origin.channelId && requestedChannelId !== call.origin.channelId) {
                return { ok: false, error: "reminders must report to the channel where the authorized request began" };
              }
              const tz = a.tz ?? ctx.config.display.timezone;
              let fireAt: Date;
              try {
                fireAt = parseWhen(a.when, tz, (deps.now ?? (() => new Date()))());
              } catch (err) {
                return { ok: false, error: (err as Error).message };
              }
              let recurrence: Recurrence;
              try {
                recurrence = parseRecurrence(a.recurrence, fireAt, tz);
              } catch (err) {
                return { ok: false, error: (err as Error).message };
              }
              const internal = a.internal === true;
              const channelId = requestedChannelId ?? call.origin.channelId ?? null;
              if (!internal && !channelId) {
                return { ok: false, error: "an external reminder needs a channel to post to" };
              }
              const reminder = await requireStore().add({
                id: "",
                note: a.note,
                kind: internal ? "internal" : "external",
                fireAt: fireAt.toISOString(),
                tz,
                recurrence,
                channelId,
                pingUserIds: a.pingUserIds ?? [],
                requesterId: call.origin.userId,
              });
              return { ok: true, data: summarizeReminder(reminder) };
            }
            case "remind.remove": {
              if (!call.origin?.userId) {
                return { ok: false, error: "reminder changes need an authenticated authorized request" };
              }
              const a = call.args as z.infer<typeof RemoveArgs>;
              const removed = await requireStore().remove(a.id);
              if (!removed) return { ok: false, error: `no such reminder: ${a.id}` };
              return { ok: true, data: { removed: a.id } };
            }
            case "remind.fire": {
              if (!call.origin?.userId) {
                return { ok: false, error: "firing a reminder needs an authenticated authorized request" };
              }
              const a = call.args as z.infer<typeof FireArgs>;
              const plan = await requireScheduler().fireNow(a.id, {
                ...(a.dryRun !== undefined ? { dryRun: a.dryRun } : {}),
              });
              return { ok: true, data: { ...plan, dryRun: a.dryRun === true } };
            }
            default:
              return { ok: false, error: `reminders: unknown capability "${call.capabilityId}"` };
          }
        } catch (err) {
          return { ok: false, error: (err as Error).message };
        }
      },

      lifecycle: {
        // A firing reminder dispatches INTO the live system (the control bus, which needs the
        // daemon's bus handlers registered) — arm at the sanctioned LATE position, like routines.
        startPhase: "late",
        init: () => {
          store = deps.createStore?.(ctx) ?? freshStore();
          schedulerDeps = {
            store,
            logger: ctx.logger.child("reminder"),
            dispatcher: { dispatch: (reminder) => dispatchReminder(reminder) },
            ...(deps.now ? { now: deps.now } : {}),
            ...(deps.intervalMs !== undefined ? { intervalMs: deps.intervalMs } : {}),
          };
        },
        start: () => {
          if (scheduler) return;
          if (!schedulerDeps) {
            throw new Error("the reminders extension is not initialized (lifecycle.init has not run)");
          }
          const started = deps.createScheduler?.(schedulerDeps) ?? startReminderScheduler(schedulerDeps);
          scheduler = started;
          // Prime once shortly after boot, so a reminder already overdue at boot (the "late, once"
          // catch-up) fires within seconds instead of waiting a full tick.
          primeTimer = setTimeout(() => void started.tick().catch(() => {}), 5_000);
          primeTimer.unref?.();
        },
        stop: () => {
          if (primeTimer) {
            clearTimeout(primeTimer);
            primeTimer = null;
          }
          scheduler?.stop();
          scheduler = null;
        },
        health: async () => {
          if (!store) return { ok: false, detail: "not initialized" };
          try {
            const reminders = await store.list();
            const next = reminders[0] ?? null;
            return {
              ok: true,
              detail:
                `scheduler ${scheduler ? "running" : "idle"}; ${reminders.length} reminder(s) pending` +
                (next ? `; next fire ${next.fireAt}` : ""),
            };
          } catch (err) {
            return { ok: false, detail: (err as Error).message };
          }
        },
      },

      cliVerbs: [
        {
          name: "remind",
          summary: "internal/external self-clearing reminders — a note plus a fire time",
          usage:
            'beckett remind list | create "<note>" --when <time> [--channel <id>] [--ping <target>]... ' +
            "[--internal] [--recurrence daily|weekly|weekday|every-Nd] [--tz <IANA>] | remove <id> | " +
            "fire <id> [--dry]",
          run: runRemind,
        },
      ],
      busCommands: [],

      store: () => requireStore(),
      scheduler: () => requireScheduler(),
    };
  };
