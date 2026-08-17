import { expect, test } from "bun:test";
import { blockerFromDeath, classifyDeath } from "./death.ts";

test("a wall-clock timeout is self-inflicted", () => {
  expect(classifyDeath({ timedOut: true, shuttingDown: false })).toBe("self-inflicted");
});

test("a shutdown kill is self-inflicted", () => {
  expect(classifyDeath({ timedOut: false, shuttingDown: true })).toBe("self-inflicted");
});

test("an auth failure is external and maps to credential", () => {
  expect(classifyDeath({ timedOut: false, shuttingDown: false, errorClass: "auth" })).toBe("external");
  const b = blockerFromDeath(
    { timedOut: false, shuttingDown: false, errorClass: "auth" },
    "the implement worker died: no auth",
    "run-1",
    () => new Date("2026-08-16T00:00:00.000Z"),
  );
  expect(b.class).toBe("credential");
  expect(b.actor).toBe("human");
  expect(b.remedy).toContain("fix the credential");
});

test("an unknown error class is external and transient", () => {
  expect(classifyDeath({ timedOut: false, shuttingDown: false })).toBe("external");
  const b = blockerFromDeath(
    { timedOut: false, shuttingDown: false },
    "the review worker died: unnamed cause",
    "run-2",
    () => new Date("2026-08-16T00:00:00.000Z"),
  );
  expect(b.class).toBe("transient");
  expect(b.remedy).toBe("`beckett task resume run-2`");
  expect(b.detail).toBe("the review worker died: unnamed cause");
});

test("spawn/rate_limit/crash all map to transient", () => {
  for (const errorClass of ["spawn", "rate_limit", "crash"] as const) {
    const b = blockerFromDeath({ timedOut: false, shuttingDown: false, errorClass }, "died", "run-3");
    expect(b.class).toBe("transient");
  }
});

test("a cancelled death is `cancelled`, even carrying a crash errorClass from a raced terminal event", () => {
  expect(classifyDeath({ timedOut: false, shuttingDown: false, cancelled: true, errorClass: "crash" })).toBe(
    "cancelled",
  );
});

test("cancelled wins over timedOut and shuttingDown — a human's cancel is never re-read as beckett's own stop", () => {
  expect(classifyDeath({ timedOut: true, shuttingDown: true, cancelled: true })).toBe("cancelled");
});
