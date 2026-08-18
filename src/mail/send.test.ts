/**
 * The outbox's two safety properties (src/mail/send.ts): a missing `RESEND_API_KEY` fails with
 * the exact secret name rather than a generic auth error, and every request goes through the
 * `fetchImpl` seam so a bad test can never actually dispatch mail. Without these tests a broken
 * request shape (wrong endpoint, missing bearer header, `to` sent as a bare string instead of an
 * array) would only surface once a real message failed to arrive, and a validation regression
 * could let an empty recipient or a blank body reach the network at all.
 */

import { expect, test } from "bun:test";
import { DEFAULT_MAIL_FROM, type SendFetch, resolveFromAddress, resolveSendKey, sendMail } from "./send.ts";

// ── the missing-secret failure ────────────────────────────────────────────────────────

test("resolveSendKey names the exact missing secret", () => {
  expect(() => resolveSendKey({})).toThrow("RESEND_API_KEY");
  expect(() => resolveSendKey({ RESEND_API_KEY: "key-123" })).not.toThrow();
});

// ── from address resolution ───────────────────────────────────────────────────────────

test("resolveFromAddress defaults to the instance address and BECKETT_MAIL_FROM overrides it", () => {
  expect(resolveFromAddress({})).toBe(DEFAULT_MAIL_FROM);
  expect(resolveFromAddress({ BECKETT_MAIL_FROM: "override@example.com" })).toBe("override@example.com");
});

// ── request shape ──────────────────────────────────────────────────────────────────────

test("sendMail posts to the Resend endpoint with the authorized JSON envelope", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl: SendFetch = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ id: "email-1" }), { status: 200 });
  };
  const result = await sendMail(
    { to: "dest@example.com", subject: "Hello", body: "hi there", from: "beckett@0xbeckett.me" },
    { apiKey: "secret-key", fetchImpl },
  );
  expect(calls).toHaveLength(1);
  const { url, init } = calls[0]!;
  expect(url).toBe("https://api.resend.com/emails");
  expect(init.method).toBe("POST");
  expect((init.headers as Record<string, string>).authorization).toBe("Bearer secret-key");
  const body = JSON.parse(init.body as string);
  expect(body).toEqual({ from: "beckett@0xbeckett.me", to: ["dest@example.com"], subject: "Hello", text: "hi there" });
});

test("replyTo maps to reply_to in the body, and is absent when not supplied", async () => {
  const seen: Array<Record<string, unknown>> = [];
  const fetchImpl: SendFetch = async (_url, init) => {
    seen.push(JSON.parse(init.body as string));
    return new Response(JSON.stringify({ id: "x" }), { status: 200 });
  };
  await sendMail(
    { to: "a@example.com", subject: "s", body: "b", replyTo: "reply@example.com" },
    { apiKey: "k", fetchImpl },
  );
  await sendMail({ to: "a@example.com", subject: "s", body: "b" }, { apiKey: "k", fetchImpl });
  expect(seen[0]!.reply_to).toBe("reply@example.com");
  expect(seen[1]).not.toHaveProperty("reply_to");
});

// ── validation ─────────────────────────────────────────────────────────────────────────

test("validation refuses bad input and never calls fetch", async () => {
  let calls = 0;
  const fetchImpl: SendFetch = async () => {
    calls++;
    return new Response(JSON.stringify({ id: "x" }), { status: 200 });
  };
  const opts = { apiKey: "k", fetchImpl };
  await expect(sendMail({ to: "", subject: "s", body: "b" }, opts)).rejects.toThrow();
  await expect(sendMail({ to: "not-an-address", subject: "s", body: "b" }, opts)).rejects.toThrow();
  await expect(sendMail({ to: "a@example.com", subject: "", body: "b" }, opts)).rejects.toThrow();
  await expect(sendMail({ to: "a@example.com", subject: "s", body: "   " }, opts)).rejects.toThrow();
  expect(calls).toBe(0);
});

// ── provider response handling ────────────────────────────────────────────────────────

test("a non-2xx provider response throws with the status and the provider's message", async () => {
  const fetchImpl: SendFetch = async () => new Response("domain not verified for this account", { status: 422 });
  let message = "";
  try {
    await sendMail({ to: "a@example.com", subject: "s", body: "b" }, { apiKey: "k", fetchImpl });
  } catch (err) {
    message = (err as Error).message;
  }
  expect(message).toContain("422");
  expect(message).toContain("domain not verified for this account");
});

test("a 2xx response with an unparseable body still resolves, with an empty id", async () => {
  const fetchImpl: SendFetch = async () => new Response("not json at all", { status: 200 });
  const result = await sendMail({ to: "a@example.com", subject: "s", body: "b" }, { apiKey: "k", fetchImpl });
  expect(result.id).toBe("");
});

test("the returned result carries from, to, subject and the provider id", async () => {
  const fetchImpl: SendFetch = async () => new Response(JSON.stringify({ id: "email-42" }), { status: 200 });
  const result = await sendMail(
    { to: "dest@example.com", subject: "Subject line", body: "body text", from: "beckett@0xbeckett.me" },
    { apiKey: "k", fetchImpl },
  );
  expect(result).toEqual({
    id: "email-42",
    from: "beckett@0xbeckett.me",
    to: "dest@example.com",
    subject: "Subject line",
  });
});
