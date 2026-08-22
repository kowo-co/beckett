import { expect, test } from "bun:test";
import {
  ReminderSchema,
  ReminderRegistrySchema,
  RecurrenceSchema,
  ReminderKindSchema,
  ReminderStatusSchema,
  type ReminderKind,
  type ReminderStatus,
  type Weekday,
} from "./types.ts";

const VALID_REMINDER = {
  id: "r1",
  note: "check the deploy",
  kind: "external",
  fireAt: "2026-07-20T19:00:00.000Z",
  tz: "America/Los_Angeles",
  recurrence: { kind: "none" },
  channelId: "chan-1",
  pingUserIds: [],
  status: "pending",
  requesterId: null,
  createdAt: "2026-07-20T18:00:00.000Z",
  updatedAt: "2026-07-20T18:00:00.000Z",
};

test("ReminderSchema accepts a well-formed reminder", () => {
  expect(() => ReminderSchema.parse(VALID_REMINDER)).not.toThrow();
});

test("ReminderSchema rejects an empty note", () => {
  expect(() => ReminderSchema.parse({ ...VALID_REMINDER, note: "" })).toThrow();
});

test("ReminderKindSchema only accepts internal/external", () => {
  expect(ReminderKindSchema.parse("internal")).toBe("internal");
  expect(ReminderKindSchema.parse("external")).toBe("external");
  expect(() => ReminderKindSchema.parse("both")).toThrow();
});

test("ReminderStatusSchema only accepts pending/firing", () => {
  expect(ReminderStatusSchema.parse("pending")).toBe("pending");
  expect(ReminderStatusSchema.parse("firing")).toBe("firing");
  expect(() => ReminderStatusSchema.parse("done")).toThrow();
});

test("RecurrenceSchema accepts every documented kind and rejects an unknown one", () => {
  expect(RecurrenceSchema.parse({ kind: "none" })).toEqual({ kind: "none" });
  expect(RecurrenceSchema.parse({ kind: "daily" })).toEqual({ kind: "daily" });
  expect(RecurrenceSchema.parse({ kind: "weekly", weekday: "monday" })).toEqual({
    kind: "weekly",
    weekday: "monday",
  });
  expect(RecurrenceSchema.parse({ kind: "weekday" })).toEqual({ kind: "weekday" });
  expect(RecurrenceSchema.parse({ kind: "every-n-days", days: 3 })).toEqual({
    kind: "every-n-days",
    days: 3,
  });
  expect(() => RecurrenceSchema.parse({ kind: "monthly" })).toThrow();
  expect(() => RecurrenceSchema.parse({ kind: "every-n-days", days: 0 })).toThrow();
});

test("ReminderRegistrySchema defaults an empty registry and validates its reminders array", () => {
  expect(ReminderRegistrySchema.parse({ version: 1 })).toEqual({ version: 1, reminders: [] });
  expect(ReminderRegistrySchema.parse({ version: 1, reminders: [VALID_REMINDER] }).reminders.length).toBe(1);
});

test("the inferred ReminderKind/ReminderStatus/Weekday types match their schemas' output", () => {
  const kind: ReminderKind = ReminderKindSchema.parse("internal");
  const status: ReminderStatus = ReminderStatusSchema.parse("firing");
  const weekday: Weekday = RecurrenceSchema.parse({ kind: "weekly", weekday: "friday" }).kind === "weekly"
    ? "friday"
    : "monday";
  expect(kind).toBe("internal");
  expect(status).toBe("firing");
  expect(weekday).toBe("friday");
});
