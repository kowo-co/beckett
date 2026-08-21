/** Built-in agents are pure DATA seeds — the social-media agent has no bespoke code module. */

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentStore } from "./store.ts";
import { builtinAgentDefs, builtinAgentIds, SOCIAL_MEDIA_AGENT_ID, X_PING_ROSTER } from "./builtins.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("ships a social-media builtin defined entirely as data (prompt + seat, no code)", () => {
  const def = builtinAgentDefs().find((a) => a.id === SOCIAL_MEDIA_AGENT_ID);
  expect(def).toBeTruthy();
  expect(def!.builtin).toBe(true);
  expect(def!.model.harness).toBe("claude");
  // The behavior — voice, target handle, how to post — is all in the prompt string.
  expect(def!.systemPrompt).toContain("@beckposting");
  expect(def!.systemPrompt.toLowerCase()).toContain("browser");
  // No credential is baked into the definition.
  expect(JSON.stringify(def).toLowerCase()).not.toContain("password");
  expect(builtinAgentIds()).toContain(SOCIAL_MEDIA_AGENT_ID);
});

test("PING SOMEONE names an explicit roster, rotates the target, and never @s a stranger (issue #107)", () => {
  const prompt = builtinAgentDefs().find((a) => a.id === SOCIAL_MEDIA_AGENT_ID)!.systemPrompt;
  const flat = prompt.toLowerCase().replace(/\s+/g, " "); // collapse the wrapped lane text

  // The roster is real and led by the established interlocutor — a single verified handle is valid
  // (and strictly safer than one padded with an unverified guess).
  expect(X_PING_ROSTER.length).toBeGreaterThanOrEqual(1);
  expect(X_PING_ROSTER).toContain("@jawrooo_");

  // No entry is a bare unverified placeholder: every roster handle is a real, specific X handle.
  for (const handle of X_PING_ROSTER) expect(handle).not.toBe("@ssh");

  // The prompt is BUILT from the roster (single source of truth), so every handle appears in the lane text.
  for (const handle of X_PING_ROSTER) expect(prompt).toContain(handle);

  // Target rotation: consecutive ping-posts must not reuse the same person, checked against recent posts.
  expect(flat).toContain("with_replies");
  expect(flat).toContain("not @ the same person two ping-posts running");

  // No path to an arbitrary follower/stranger: the roster is the COMPLETE allow-list.
  expect(flat).toContain("complete list of who you may @");
  expect(flat).toContain("never @ a stranger");

  // Existing lane-rotation instruction is untouched.
  expect(prompt).toContain("PICK A LANE (vary it — do not lean on the same lane every time):");
});

test("the prompt forbids inventing an event and requires the SOURCES block to back a factual claim (real-sources ticket, Half 1)", () => {
  const prompt = builtinAgentDefs().find((a) => a.id === SOCIAL_MEDIA_AGENT_ID)!.systemPrompt;
  const flat = prompt.toLowerCase().replace(/\s+/g, " ");

  expect(flat).toContain("grounding rule");
  // Plain-language ban on the exact fabrication categories the ticket's two real examples hit
  // (an invented npm supply-chain incident, an invented Cloudflare outage).
  expect(flat).toContain("may never invent an event, an");
  expect(flat).toContain("outage");
  expect(flat).toContain("cve");
  expect(flat).toContain("maintainer change");
  expect(flat).toContain("company statement");
  expect(flat).toContain("personal incident that did not");
  expect(flat).toContain("not even as a bit");
  // Every factual claim must trace to the SOURCES block; an opinion needs no source but its
  // object still has to be real.
  expect(flat).toContain("sources block");
  expect(flat).toContain("must trace to one of those entries");
  expect(flat).toContain("its object still has to be real");
  // The two legitimate grounding sources named explicitly, and no third.
  expect(flat).toContain("real tech news fetched just now");
  expect(flat).toContain("the run ledger, the deploy/uptime ledger, the");
  expect(flat).toContain("journal");
});

test("the STUPID ON PURPOSE / BAD OPINION lanes still need no source for the opinion itself", () => {
  const prompt = builtinAgentDefs().find((a) => a.id === SOCIAL_MEDIA_AGENT_ID)!.systemPrompt;
  expect(prompt).toContain("BAD OPINION, FULL CONFIDENCE");
  expect(prompt).toContain("STUPID ON PURPOSE");
});

test("the prompt defines a TIMELINE REPLY ROUND job, distinct from composing, with its own guardrails (Half 2)", () => {
  const prompt = builtinAgentDefs().find((a) => a.id === SOCIAL_MEDIA_AGENT_ID)!.systemPrompt;
  const flat = prompt.toLowerCase().replace(/\s+/g, " ");

  expect(flat).toContain("timeline reply round");
  // It authors a browser task instead of using the POST: contract.
  expect(flat).toContain("do not use the post: contract for this job");
  // Selectivity is explicit and skipping is normal — mirrors ro's own words ("not like everything
  // but cool posts") and the existing mention-REPLIES "forced reply is worse than no reply" rule.
  expect(flat).toContain("a handful at most per round");
  expect(flat).toContain("replying to none of them is a normal, often correct outcome");
  expect(flat).toContain("a forced reply is worse than no reply");
  // Guardrails at least as strict as an original post's.
  expect(flat).toContain("harassment");
  expect(flat).toContain("pile-on");
  expect(flat).toContain("private life");
  expect(flat).toContain("punch up or sideways only");
  expect(flat).toContain("no engagement farming");
  expect(flat).toContain("reply-guying a large account");
  // Never invents what a post says — grounded in the live page.
  expect(flat).toContain("never invent a post's content");
  // Credential discipline carried over from the compose path.
  expect(flat).toContain("never touch a credential field");
  // The existing mention-REPLIES block is untouched, not replaced.
  expect(prompt).toContain("REPLIES: when you're checking mentions");
});

test("the store seeds the social-media agent into agents.json on first load", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-builtins-"));
  dirs.push(dir);
  const store = new AgentStore(join(dir, "agents.json"), { seedBuiltins: true });
  const agents = await store.list();
  const social = agents.find((a) => a.id === SOCIAL_MEDIA_AGENT_ID);
  expect(social).toBeTruthy();
  expect(social!.builtin).toBe(true);
  expect(social!.createdAt).toBeTruthy();
});

test("a removed builtin stays gone — seeding does not resurrect it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-builtins-rm-"));
  dirs.push(dir);
  const path = join(dir, "agents.json");
  const store = new AgentStore(path, { seedBuiltins: true });
  await store.list(); // seed
  expect(await store.remove(SOCIAL_MEDIA_AGENT_ID)).toBe(true);
  const reopened = new AgentStore(path, { seedBuiltins: true });
  const agents = await reopened.list();
  expect(agents.find((a) => a.id === SOCIAL_MEDIA_AGENT_ID)).toBeUndefined();
});
