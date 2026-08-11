import { describe, expect, test } from "bun:test";
import { DiscordUnknownMessageError, type DiscordGateway } from "../discord/gateway.ts";
import { DispatchDigestFeed } from "./digest-feed.ts";
import type { DispatchEvent, DispatchOutcome } from "./events.ts";

const TS = "2026-08-04T21:34:00.000Z";

function ev(stage: string, outcome: DispatchOutcome, message?: string, error?: string): DispatchEvent {
  return {
    ts: TS,
    runId: "ticket-1",
    runRef: "#2.1",
    branchRef: "beckett/task-2-1",
    stage,
    outcome,
    elapsedMs: 0,
    ...(message ? { message } : {}),
    ...(error ? { error } : {}),
  };
}

function fakeGateway() {
  const posts: string[] = [];
  const edits: { messageId: string; content: string }[] = [];
  let postFails: Error | null = null;
  let editFails: Error | null = null;
  let n = 0;
  const gateway = {
    async post(_channelId: string, content: string) {
      if (postFails) throw postFails;
      posts.push(content);
      return `msg-${++n}`;
    },
    async editMessage(_channelId: string, messageId: string, payload: { content?: string }) {
      if (editFails) throw editFails;
      edits.push({ messageId, content: payload.content ?? "" });
    },
  } as unknown as Pick<DiscordGateway, "post" | "editMessage">;
  return {
    gateway,
    posts,
    edits,
    failPosts: (e: Error | null) => (postFails = e),
    failEdits: (e: Error | null) => (editFails = e),
  };
}

const quiet = { debug() {}, info() {}, warn() {}, error() {}, child() { return quiet; } } as never;

function feed(g: ReturnType<typeof fakeGateway>) {
  return new DispatchDigestFeed({ gateway: g.gateway, channelId: "chan-1", logger: quiet });
}

describe("DispatchDigestFeed", () => {
  test("posts one message per ticket episode and edits it thereafter", async () => {
    const g = fakeGateway();
    const f = feed(g);
    await f.post(ev("implement", "started", "worker wk_1 on claude"));
    await f.post(ev("state:in_review", "info", "in_progress → in_review"));
    await f.post(ev("state:in_review", "info", "in_review → in_review")); // no-op: says nothing
    expect(g.posts).toHaveLength(1);
    expect(g.edits).toHaveLength(1);
    expect(g.edits[0]!.messageId).toBe("msg-1");
    expect(g.edits[0]!.content).toContain("moved to review");
  });

  test("a genuine failure posts its own message rather than a silent edit", async () => {
    const g = fakeGateway();
    const f = feed(g);
    await f.post(ev("implement", "started", "worker wk_1 on claude"));
    await f.post(ev("implement", "failed", "worker exited with error", "bun test exited 1"));
    expect(g.posts).toHaveLength(2);
    expect(g.posts[1]).toContain("bun test exited 1");
    // Subsequent progress edits the NEW message, not the one the alert scrolled past.
    await f.post(ev("state:todo", "held", "in_progress → todo"));
    expect(g.edits.map((e) => e.messageId)).toEqual(["msg-2"]);
  });

  test("a deleted digest is reposted; any other edit failure folds into the next update", async () => {
    const g = fakeGateway();
    const f = feed(g);
    await f.post(ev("implement", "started", "worker wk_1 on claude"));

    g.failEdits(new Error("gateway offline"));
    await f.post(ev("state:in_review", "info", "in_progress → in_review"));
    expect(g.posts).toHaveLength(1); // skipped, not reposted

    g.failEdits(null);
    await f.post(ev("state:done", "passed", "in_review → done"));
    expect(g.edits.at(-1)!.content).toContain("moved to review"); // the skipped line is still there
    expect(g.edits.at(-1)!.content).toContain("finished — moved to done");

    g.failEdits(new DiscordUnknownMessageError("chan-1", "msg-1"));
    await f.post(ev("state:in_progress", "info", "todo → in_progress"));
    expect(g.posts).toHaveLength(2); // deleted target → repost
  });

  test("never throws when Discord is unavailable", async () => {
    const g = fakeGateway();
    const f = feed(g);
    g.failPosts(new Error("discord gateway is offline"));
    await f.post(ev("implement", "started", "worker wk_1 on claude"));
    g.failPosts(null);
    await f.post(ev("state:in_review", "info", "in_progress → in_review"));
    expect(g.posts).toHaveLength(1); // recovered by posting fresh; no anchor was ever stored
    expect(g.edits).toHaveLength(0);
  });

  test("serializes per ticket so a fast second event cannot edit before the post lands", async () => {
    const g = fakeGateway();
    const f = feed(g);
    const a = f.post(ev("implement", "started", "worker wk_1 on claude"));
    const b = f.post(ev("state:in_review", "info", "in_progress → in_review"));
    await Promise.all([a, b]);
    expect(g.posts).toHaveLength(1);
    expect(g.edits).toHaveLength(1);
  });
});
