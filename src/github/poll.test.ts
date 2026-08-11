import { describe, expect, test } from "bun:test";
import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitHubPrPoller } from "./poll.ts";
import { parsePrUrl, type GitHubPrReader, type PrSignals } from "./types.ts";

const quiet = { info() {}, warn() {}, debug() {}, error() {}, child() { return quiet; } } as const;

function signals(over: Partial<PrSignals> = {}): PrSignals {
  return {
    number: over.number ?? 96,
    url: over.url ?? "https://github.com/0xbeckett/foo/pull/96",
    title: over.title ?? "Add sense",
    state: over.state ?? "OPEN",
    isDraft: over.isDraft ?? false,
    headRefOid: over.headRefOid ?? "sha1",
    reviewDecision: over.reviewDecision ?? "",
    reviews: over.reviews ?? [],
    comments: over.comments ?? [],
    checkConclusion: over.checkConclusion ?? "NONE",
  };
}

/** A reader that returns a scripted queue of signals per `repo#number` (last value sticks). */
class FakeReader {
  queues = new Map<string, PrSignals[]>();
  calls: string[] = [];
  set(repo: string, n: number, seq: PrSignals[]) {
    this.queues.set(`${repo}#${n}`, seq);
  }
  async prSignals(repo: string, n: number): Promise<PrSignals> {
    this.calls.push(`${repo}#${n}`);
    const q = this.queues.get(`${repo}#${n}`);
    if (!q || q.length === 0) throw new Error("no signals scripted");
    return q.length === 1 ? q[0]! : q.shift()!;
  }
}

function poller(reader: FakeReader, over: { account?: string; statePath?: string } = {}): GitHubPrPoller {
  return new GitHubPrPoller({
    reader,
    account: over.account ?? "0xbeckett",
    logger: quiet as never,
    statePath: over.statePath,
    now: () => 1_000,
  });
}

const WATCH = {
  repo: "0xbeckett/foo",
  number: 96,
  url: "https://github.com/0xbeckett/foo/pull/96",
  title: "Add sense",
  runId: "OPS-124",
  channel: "chan-1",
};

describe("parsePrUrl", () => {
  test("parses org/repo and number from a PR web URL", () => {
    expect(parsePrUrl("https://github.com/0xbeckett/foo/pull/96")).toEqual({ repo: "0xbeckett/foo", number: 96 });
  });
  test("rejects non-PR URLs (a direct push link)", () => {
    expect(parsePrUrl("https://github.com/0xbeckett/foo")).toBeNull();
    expect(parsePrUrl("https://x.0xbeckett.me")).toBeNull();
  });
});

describe("GitHubPrPoller", () => {
  test("the baseline read emits nothing (seeds without replaying history)", async () => {
    const r = new FakeReader();
    r.set("0xbeckett/foo", 96, [signals({ reviews: [rev("r1", "ro", "CHANGES_REQUESTED")] })]);
    const p = poller(r);
    p.watch(WATCH);
    expect(await p.poll()).toEqual([]);
  });

  test("a new requested-changes review after seeding fires once, routed to the origin channel", async () => {
    const r = new FakeReader();
    r.set("0xbeckett/foo", 96, [
      signals(), // seed
      signals({ reviews: [rev("r1", "ro", "CHANGES_REQUESTED")] }),
      signals({ reviews: [rev("r1", "ro", "CHANGES_REQUESTED")] }), // unchanged → deduped
    ]);
    const p = poller(r);
    p.watch(WATCH);
    await p.poll();
    const first = await p.poll();
    expect(first).toHaveLength(1);
    expect(first[0]!.kind).toBe("review");
    expect(first[0]!.pr.channel).toBe("chan-1");
    expect(first[0]!.pr.runId).toBe("OPS-124");
    expect(await p.poll()).toEqual([]); // dedup
  });

  test("approval and plain review comments are material; PENDING/DISMISSED are not", async () => {
    const r = new FakeReader();
    r.set("0xbeckett/foo", 96, [
      signals(),
      signals({ reviews: [rev("a", "ro", "APPROVED"), rev("b", "ro", "COMMENTED"), rev("c", "ro", "PENDING")] }),
    ]);
    const p = poller(r);
    p.watch(WATCH);
    await p.poll();
    const kinds = (await p.poll()).map((e) => (e.kind === "review" ? e.review.state : e.kind));
    expect(kinds).toEqual(["APPROVED", "COMMENTED"]);
  });

  test("Beckett's own reviews and comments are skipped", async () => {
    const r = new FakeReader();
    r.set("0xbeckett/foo", 96, [
      signals(),
      signals({
        reviews: [rev("r1", "0xbeckett", "APPROVED")],
        comments: [com("c1", "0xbeckett", "ping")],
      }),
    ]);
    const p = poller(r);
    p.watch(WATCH);
    await p.poll();
    expect(await p.poll()).toEqual([]);
  });

  test("a new conversation comment from someone else fires", async () => {
    const r = new FakeReader();
    r.set("0xbeckett/foo", 96, [signals(), signals({ comments: [com("c1", "ro", "looks good?")] })]);
    const p = poller(r);
    p.watch(WATCH);
    await p.poll();
    const ev = await p.poll();
    expect(ev).toHaveLength(1);
    expect(ev[0]!.kind).toBe("comment");
  });

  test("CI: failure fires once per head sha, and re-arms on a new push", async () => {
    const r = new FakeReader();
    r.set("0xbeckett/foo", 96, [
      signals({ checkConclusion: "PENDING" }), // seed while running
      signals({ checkConclusion: "FAILURE" }), // fail → fire
      signals({ checkConclusion: "FAILURE" }), // same sha → deduped
      signals({ headRefOid: "sha2", checkConclusion: "FAILURE" }), // new push → re-armed → fire again
    ]);
    const p = poller(r);
    p.watch(WATCH);
    await p.poll();
    expect((await p.poll()).map((e) => e.kind)).toEqual(["ci"]);
    expect(await p.poll()).toEqual([]);
    const rearmed = await p.poll();
    expect(rearmed).toHaveLength(1);
    expect(rearmed[0]).toMatchObject({ kind: "ci", conclusion: "FAILURE" });
  });

  test("a head-sha move alone (Beckett's own push) emits nothing", async () => {
    const r = new FakeReader();
    r.set("0xbeckett/foo", 96, [signals(), signals({ headRefOid: "sha2" })]);
    const p = poller(r);
    p.watch(WATCH);
    await p.poll();
    expect(await p.poll()).toEqual([]);
  });

  test("draft churn is suppressed but not replayed once it leaves draft", async () => {
    const r = new FakeReader();
    r.set("0xbeckett/foo", 96, [
      signals(),
      signals({ isDraft: true, reviews: [rev("r1", "ro", "CHANGES_REQUESTED")] }), // draft → suppressed
      signals({ isDraft: false, reviews: [rev("r1", "ro", "CHANGES_REQUESTED")] }), // same review → still no replay
    ]);
    const p = poller(r);
    p.watch(WATCH);
    await p.poll();
    expect(await p.poll()).toEqual([]);
    expect(await p.poll()).toEqual([]);
  });

  test("merged fires once, then the entry is pruned and never re-polled", async () => {
    const r = new FakeReader();
    r.set("0xbeckett/foo", 96, [signals(), signals({ state: "MERGED" }), signals({ state: "MERGED" })]);
    const p = poller(r);
    p.watch(WATCH);
    await p.poll();
    const merged = await p.poll();
    expect(merged.map((e) => e.kind)).toEqual(["merged"]);
    r.calls = [];
    expect(await p.poll()).toEqual([]); // terminal pruned
    expect(r.calls).toEqual([]); // no further reads for the dead PR
  });

  test("closed-without-merge fires once", async () => {
    const r = new FakeReader();
    r.set("0xbeckett/foo", 96, [signals(), signals({ state: "CLOSED" })]);
    const p = poller(r);
    p.watch(WATCH);
    await p.poll();
    expect((await p.poll()).map((e) => e.kind)).toEqual(["closed"]);
  });

  test("a cross-org PR we opened is watched and polled (#31 — no org gate)", async () => {
    const r = new FakeReader();
    r.set("betterwright/betterwright", 65, [
      signals({ url: "https://github.com/betterwright/betterwright/pull/65", number: 65 }),
      signals({
        url: "https://github.com/betterwright/betterwright/pull/65",
        number: 65,
        reviews: [rev("r1", "upstreamer", "CHANGES_REQUESTED")],
      }),
    ]);
    const p = poller(r);
    p.watch({
      ...WATCH,
      repo: "betterwright/betterwright",
      url: "https://github.com/betterwright/betterwright/pull/65",
      number: 65,
    });
    expect(p.stats().watching).toBe(1);
    await p.poll(); // seed
    const ev = await p.poll();
    expect(ev).toHaveLength(1);
    expect(ev[0]!.kind).toBe("review");
    expect(ev[0]!.pr.repo).toBe("betterwright/betterwright");
  });

  test("the defensive author check refuses a PR we did not author", async () => {
    const r = new FakeReader();
    const p = poller(r);
    // A registration that stamps an author who is NOT us is the one thing the gate rejects.
    p.watch({ ...WATCH, repo: "someoneelse/foo", number: 1, author: "someoneelse" });
    expect(p.stats().watching).toBe(0);
    // An absent author is the vouched-ours common case and IS watched, even cross-org.
    p.watch({ ...WATCH, repo: "someoneelse/foo", number: 1 });
    expect(p.stats().watching).toBe(1);
    // Our own login stamped explicitly is fine too (case-insensitive).
    p.watch({ ...WATCH, repo: "someoneelse/bar", number: 2, author: "0XBECKETT" });
    expect(p.stats().watching).toBe(2);
  });

  test("a watched repo that stays unreadable (404) is dropped once after N consecutive hard failures", async () => {
    // A reader that throws a 404-style message for a repo that vanished under us, every tick.
    const gone: GitHubPrReader = {
      async prSignals() {
        throw new Error("gh pr view (signals) failed (1): GraphQL: Could not resolve to a Repository with the name 'x/y'. (repository)");
      },
    };
    const dir = mkdtempSync(join(tmpdir(), "gh-poll-"));
    const statePath = join(dir, "github-prs.json");
    try {
      const p = new GitHubPrPoller({ reader: gone, account: "0xbeckett", logger: quiet as never, statePath, now: () => 1_000 });
      p.watch({ ...WATCH });
      expect(p.stats().watching).toBe(1);
      // A SINGLE hard failure must NOT drop the watch — one bad response is never enough.
      expect(await p.poll()).toEqual([]);
      expect(p.stats().watching).toBe(1); // still watched after 1 hard tick
      expect(await p.poll()).toEqual([]);
      expect(p.stats().watching).toBe(1); // still watched after 2 hard ticks
      // The third consecutive hard failure crosses the threshold → dropped, no throw, no event.
      expect(await p.poll()).toEqual([]);
      expect(p.stats().watching).toBe(0);
      // The drop is durable: it is gone from the registry file, so it is never re-polled.
      const reloaded = new GitHubPrPoller({ reader: gone, account: "0xbeckett", logger: quiet as never, statePath, now: () => 1_000 });
      expect(reloaded.stats().watching).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a transient failure NEVER drops a watch, however many times it recurs", async () => {
    // Each of these is transient — a 5xx, a timeout, a secondary rate-limit / abuse block (both
    // surface as 403s and must NOT be mistaken for a gone repo), and a raw network error.
    const transientMessages = [
      "gh: HTTP 503 Service Unavailable (https://api.github.com)",
      "request to https://api.github.com failed, reason: ETIMEDOUT",
      "You have exceeded a secondary rate limit. Please wait a few minutes (HTTP 403)",
      "API rate limit exceeded (HTTP 403)",
      "was submitted too quickly. Please retry — abuse detection (HTTP 403)",
      "getaddrinfo ENOTFOUND api.github.com",
    ];
    let i = 0;
    const flaky: GitHubPrReader = {
      async prSignals() {
        throw new Error(transientMessages[i++ % transientMessages.length]!);
      },
    };
    const dir = mkdtempSync(join(tmpdir(), "gh-poll-"));
    const statePath = join(dir, "github-prs.json");
    try {
      const p = new GitHubPrPoller({ reader: flaky, account: "0xbeckett", logger: quiet as never, statePath, now: () => 1_000 });
      p.watch({ ...WATCH });
      expect(p.stats().watching).toBe(1);
      // Far more ticks than the hard-failure threshold — the registry must stay intact throughout.
      for (let tick = 0; tick < 10; tick++) {
        expect(await p.poll()).toEqual([]);
        expect(p.stats().watching).toBe(1);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("one hard failure then a good read resets the streak — a blip never drops a watch", async () => {
    let call = 0;
    const blip: GitHubPrReader = {
      async prSignals() {
        call++;
        // First read seeds. Second read hard-404s (a momentary edge blip). Every read after is fine.
        if (call === 2) throw new Error("HTTP 404: Not Found");
        return signals();
      },
    };
    const p = new GitHubPrPoller({ reader: blip, account: "0xbeckett", logger: quiet as never, now: () => 1_000 });
    p.watch({ ...WATCH });
    expect(await p.poll()).toEqual([]); // seed
    expect(await p.poll()).toEqual([]); // hard blip (streak = 1)
    expect(p.stats().watching).toBe(1);
    // Two more good reads: the streak was reset to 0 by the recovery, so nothing ever drops.
    expect(await p.poll()).toEqual([]);
    expect(await p.poll()).toEqual([]);
    expect(p.stats().watching).toBe(1);
  });

  test("a shared hard fault never clears more than one watch in a single sweep", async () => {
    // Two watched PRs on repos that BOTH hard-fail every tick (a shared org-wide outage look-alike).
    const gone: GitHubPrReader = {
      async prSignals() {
        throw new Error("HTTP 404: Not Found");
      },
    };
    const p = new GitHubPrPoller({ reader: gone, account: "0xbeckett", logger: quiet as never, now: () => 1_000 });
    p.watch({ ...WATCH, repo: "0xbeckett/a", number: 1 });
    p.watch({ ...WATCH, repo: "0xbeckett/b", number: 2 });
    expect(p.stats().watching).toBe(2);
    await p.poll(); // both: streak 1
    await p.poll(); // both: streak 2
    await p.poll(); // both hit threshold on the SAME sweep — but only ONE may drop
    expect(p.stats().watching).toBe(1);
    await p.poll(); // the deferred one drops on the next sweep
    expect(p.stats().watching).toBe(0);
  });

  test("a hand-opened cross-org PR survives a simulated restart (persisted registry)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-poll-"));
    const statePath = join(dir, "github-prs.json");
    try {
      // Open by hand on a third-party upstream: registered + persisted, never seeded (no poll yet).
      const r1 = new FakeReader();
      const p1 = poller(r1, { statePath });
      p1.watch({
        repo: "betterwright/betterwright",
        number: 66,
        url: "https://github.com/betterwright/betterwright/pull/66",
        title: "reimplement #65",
        channel: "chan-open",
      });
      expect(existsSync(statePath)).toBe(true);

      // Restart: a fresh poller re-loads it from the registry file with its routing intact, then
      // baselines on the first read and emits nothing (no spurious refire of pre-existing history).
      const r2 = new FakeReader();
      r2.set("betterwright/betterwright", 66, [
        signals({ url: "https://github.com/betterwright/betterwright/pull/66", number: 66 }),
      ]);
      const p2 = poller(r2, { statePath });
      expect(p2.stats().watching).toBe(1);
      expect(await p2.poll()).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("persisted state means a restart never re-fires an already-surfaced review", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-poll-"));
    const statePath = join(dir, "github-prs.json");
    try {
      const r1 = new FakeReader();
      r1.set("0xbeckett/foo", 96, [signals(), signals({ reviews: [rev("r1", "ro", "CHANGES_REQUESTED")] })]);
      const p1 = poller(r1, { statePath });
      p1.watch(WATCH);
      await p1.poll(); // seed
      expect(await p1.poll()).toHaveLength(1); // fires once
      expect(existsSync(statePath)).toBe(true);

      // Restart: a fresh poller loads the persisted snapshot; the SAME review must not re-fire.
      const r2 = new FakeReader();
      r2.set("0xbeckett/foo", 96, [signals({ reviews: [rev("r1", "ro", "CHANGES_REQUESTED")] })]);
      const p2 = poller(r2, { statePath });
      expect(p2.stats().watching).toBe(1);
      expect(await p2.poll()).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a read failure for one PR is swallowed and retried next tick", async () => {
    const r = new FakeReader();
    // first call throws (empty queue), second returns fine
    r.queues.set("0xbeckett/foo#96", []);
    const p = poller(r);
    p.watch(WATCH);
    expect(await p.poll()).toEqual([]); // did not throw
    r.set("0xbeckett/foo", 96, [signals()]);
    expect(await p.poll()).toEqual([]); // seeds cleanly on retry
  });

  test("a pr-open-style registration stamps the origin channel onto the persisted watch and the relay event", async () => {
    // Register exactly the way the manual pr-create path does (repo/number/url/title + origin
    // channel, no ticket): a hand-opened cross-org PR that has no origin TICKET channel, so the
    // stamped `channel` is the ONLY thing that can route its events — the relay drops any PR event
    // whose resolved channel is empty.
    const dir = mkdtempSync(join(tmpdir(), "gh-poll-"));
    const statePath = join(dir, "github-prs.json");
    try {
      const r = new FakeReader();
      r.set("betterwright/betterwright", 66, [
        signals({ url: "https://github.com/betterwright/betterwright/pull/66", number: 66 }), // seed
        signals({
          url: "https://github.com/betterwright/betterwright/pull/66",
          number: 66,
          reviews: [rev("r1", "upstreamer", "CHANGES_REQUESTED")],
        }),
      ]);
      const p = poller(r, { statePath });
      p.watch({
        repo: "betterwright/betterwright",
        number: 66,
        url: "https://github.com/betterwright/betterwright/pull/66",
        title: "reimplement #65",
        channel: "chan-open",
        // no ticket — a hand-opened PR outside any ticket
      });

      // (1) The persisted watch record the relay's routing reads MUST carry the origin channel.
      const persisted = JSON.parse(readFileSync(statePath, "utf8")) as Record<string, { channel?: string }>;
      expect(persisted["betterwright/betterwright#66"]!.channel).toBe("chan-open");

      // (2) And it must reach the relay: the event's PrRef carries that channel through, which is
      // exactly what `Concierge.channelForPr` falls back to when there's no ticket/workspace route.
      await p.poll(); // seed
      const ev = await p.poll();
      expect(ev).toHaveLength(1);
      expect(ev[0]!.kind).toBe("review");
      expect(ev[0]!.pr.channel).toBe("chan-open");
      expect(ev[0]!.pr.runId).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("re-watch refreshes a previously-unknown channel without replaying history", async () => {
    const r = new FakeReader();
    r.set("0xbeckett/foo", 96, [signals(), signals({ reviews: [rev("r1", "ro", "APPROVED")] })]);
    const p = poller(r);
    p.watch({ ...WATCH, channel: undefined }); // opened before we knew the channel
    await p.poll(); // seed
    p.watch({ ...WATCH, channel: "chan-late" }); // channel learned later
    const ev = await p.poll();
    expect(ev).toHaveLength(1);
    expect(ev[0]!.pr.channel).toBe("chan-late");
  });
});

function rev(id: string, author: string, state: string): PrSignals["reviews"][number] {
  return { id, author, state: state as never, submittedAt: `2026-01-01T00:00:0${id.length}.000Z`, body: "note" };
}
function com(id: string, author: string, body: string): PrSignals["comments"][number] {
  return { id, author, createdAt: `2026-01-01T00:01:0${id.length}.000Z`, body };
}

describe("legacy state files", () => {
  test("a pre-v7 github-prs.json keyed `ticket` reloads with its routing intact as runId", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-poll-legacy-"));
    const statePath = join(dir, "github-prs.json");
    try {
      writeFileSync(
        statePath,
        JSON.stringify({
          "0xbeckett/foo#96": {
            repo: "0xbeckett/foo", number: 96, url: "https://github.com/0xbeckett/foo/pull/96",
            title: "Add sense", ticket: "OPS-124", channel: "chan-1",
            addedAt: "2026-07-01T00:00:00.000Z", seeded: true, state: "OPEN", isDraft: false,
            headRefOid: "sha-1", ciConclusion: "NONE", seenReviewIds: [], seenCommentIds: [],
            terminal: false,
          },
        }),
        "utf8",
      );
      const reader: GitHubPrReader = { async prSignals() { return signals({ state: "MERGED" }); } };
      const p = new GitHubPrPoller({ reader, account: "0xbeckett", logger: quiet as never, statePath, now: () => 1_000 });
      expect(p.stats().watching).toBe(1);
      // The tracker identifier was the routing handle; it carries across onto `runId` rather than
      // silently dropping a live PR's origin on the first restart after the rip-out.
      const [event] = await p.poll();
      expect(event!.pr.runId).toBe("OPS-124");
      expect(event!.pr.channel).toBe("chan-1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
