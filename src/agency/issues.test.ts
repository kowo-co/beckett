/**
 * The issue verbs through {@link GitHubCli} (#14). `star.test.ts` pins the REST-with-a-PAT shape and
 * `app-auth.test.ts` the installation-token chain; this pins what only the issue ops promise:
 *
 *   - create/list/comment hit the issues REST API with the resolved credential (never `gh`, never a PAT),
 *   - the token is the one minted for the TARGET repo's installation,
 *   - a long body rides the JSON body, and
 *   - the two failures that actually happen — the app isn't installed on the repo, and the
 *     installation has no Issues: Write — come back as sentences, not GitHub's bare 403/404.
 */

import { expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { GitHubCli } from "./index.ts";
import { GitHubAppAuth } from "../github/app.ts";
import type { Logger } from "../types.ts";

const quiet = { info() {}, warn() {}, debug() {}, error() {}, child() { return quiet; } } as unknown as Logger;

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
}

/** The PAT client — the simplest surface on which to assert the request shape itself. */
function patClient(handler: (call: Call) => Response): { gh: GitHubCli; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    };
    calls.push(call);
    return handler(call);
  }) as unknown as typeof fetch;
  const gh = new GitHubCli({
    pat: "test-pat",
    account: "beckett",
    apiBase: "https://api.github.com",
    resolveRepoDir: () => process.cwd(),
    logger: quiet,
    fetchImpl,
  });
  return { gh, calls };
}

/**
 * The App client: `installs` maps a repo to its installation id/token/permissions, so an issue op
 * on a repo NOT in the map exercises the real not-installed path. Everything else 404s the way
 * GitHub does for an installation that cannot see a resource.
 */
function appClient(
  installs: Record<string, { id: number; token: string; permissions?: Record<string, string> }>,
  issuesApi: (call: Call) => Response = () => Response.json({ message: "Not Found" }, { status: 404 }),
): { gh: GitHubCli; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const path = url.replace("https://api.github.com", "");
    const method = init?.method ?? "GET";

    const repo = path.match(/^\/repos\/([^/]+\/[^/]+)\/installation$/)?.[1];
    if (repo) {
      const hit = installs[repo];
      return hit
        ? Response.json({ id: hit.id, account: { login: repo.split("/")[0] }, repository_selection: "selected" })
        : Response.json({ message: "Not Found" }, { status: 404 });
    }
    const owner = path.match(/^\/(?:orgs|users)\/([^/]+)\/installation$/)?.[1];
    if (owner) {
      const hit = Object.entries(installs).find(([r]) => r.split("/")[0] === owner);
      return hit
        ? Response.json({ id: hit[1].id, account: { login: owner }, repository_selection: "selected" })
        : Response.json({ message: "Not Found" }, { status: 404 });
    }
    if (path === "/app") return Response.json({ id: 111, slug: "beckett", name: "beckett", owner: { login: "kowo-co" } });
    if (path.startsWith("/app/installations?")) {
      return Response.json(
        Object.entries(installs).map(([r, i]) => ({
          id: i.id,
          account: { login: r.split("/")[0], type: "Organization" },
          repository_selection: "selected",
        })),
      );
    }
    const mint = path.match(/^\/app\/installations\/(\d+)\/access_tokens$/)?.[1];
    if (mint && method === "POST") {
      const found = Object.values(installs).find((i) => String(i.id) === mint);
      return Response.json(
        {
          token: found?.token ?? "ghs_unknown",
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          permissions: found?.permissions ?? { issues: "write", contents: "write" },
        },
        { status: 201 },
      );
    }
    if (/^\/repos\/[^/]+\/[^/]+\/issues/.test(path)) {
      const call: Call = {
        url,
        method,
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
      };
      calls.push(call);
      return issuesApi(call);
    }
    // The unauthenticated existence probes diagnoseAccess runs on a 404.
    if (/^\/users\/[^/]+$/.test(path)) return Response.json({ login: "x" });
    if (/^\/repos\/[^/]+\/[^/]+$/.test(path)) return Response.json({ message: "Not Found" }, { status: 404 });
    return Response.json({ message: "Not Found" }, { status: 404 });
  }) as unknown as typeof fetch;

  const gh = new GitHubCli({
    pat: "", // App auth only — no PAT anywhere
    app: new GitHubAppAuth({ appId: "111", privateKeyPem: privateKey }, { fetchImpl }),
    account: "beckett[bot]",
    owner: "kowo-co",
    apiBase: "https://api.github.com",
    resolveRepoDir: () => "/repo",
    logger: quiet,
    fetchImpl,
  });
  return { gh, calls };
}

test("create posts title/body/labels and returns the issue number and html_url", async () => {
  const { gh, calls } = patClient(() =>
    Response.json(
      { number: 7, html_url: "https://github.com/frgmt0/pixe/issues/7", title: "Methodology feedback", state: "open" },
      { status: 201 },
    ),
  );

  const created = await gh.createIssue("frgmt0/pixe", {
    title: "Methodology feedback",
    body: "# Long\n\nmarkdown body",
    labels: ["feedback", " "],
  });

  expect(created).toEqual({
    repo: "frgmt0/pixe",
    number: 7,
    url: "https://github.com/frgmt0/pixe/issues/7",
    title: "Methodology feedback",
    state: "open",
  });
  expect(calls[0]!.url).toBe("https://api.github.com/repos/frgmt0/pixe/issues");
  expect(calls[0]!.method).toBe("POST");
  expect(calls[0]!.body).toEqual({
    title: "Methodology feedback",
    body: "# Long\n\nmarkdown body",
    labels: ["feedback"], // blank labels dropped
  });
  expect(calls[0]!.headers.Authorization).toBe("Bearer test-pat");
});

test("list asks for the requested state, caps the page, and drops pull requests", async () => {
  const { gh, calls } = patClient(() =>
    Response.json([
      {
        number: 4,
        title: "a real issue",
        state: "closed",
        html_url: "https://github.com/o/r/issues/4",
        user: { login: "ro" },
        labels: [{ name: "bug" }],
        comments: 2,
        created_at: "2026-08-01T00:00:00Z",
        updated_at: "2026-08-02T00:00:00Z",
      },
      { number: 5, title: "a PR", state: "closed", html_url: "https://github.com/o/r/pull/5", pull_request: {} },
    ]),
  );

  const issues = await gh.listIssues("o/r", { state: "closed", limit: 5 });

  expect(calls[0]!.url).toBe("https://api.github.com/repos/o/r/issues?state=closed&per_page=5");
  expect(issues).toEqual([
    {
      number: 4,
      title: "a real issue",
      state: "closed",
      url: "https://github.com/o/r/issues/4",
      author: "ro",
      labels: ["bug"],
      comments: 2,
      createdAt: "2026-08-01T00:00:00Z",
      updatedAt: "2026-08-02T00:00:00Z",
    },
  ]);
});

test("list defaults to open issues and a sane page size", async () => {
  const { gh, calls } = patClient(() => Response.json([]));
  await gh.listIssues("o/r");
  expect(calls[0]!.url).toBe("https://api.github.com/repos/o/r/issues?state=open&per_page=30");
});

test("comment posts the body to the issue's comments endpoint", async () => {
  const { gh, calls } = patClient(() =>
    Response.json({ id: 991, html_url: "https://github.com/o/r/issues/7#issuecomment-991" }, { status: 201 }),
  );

  const posted = await gh.commentOnIssue("o/r", 7, "the fix is out");

  expect(calls[0]!.url).toBe("https://api.github.com/repos/o/r/issues/7/comments");
  expect(calls[0]!.method).toBe("POST");
  expect(calls[0]!.body).toEqual({ body: "the fix is out" });
  expect(posted).toEqual({
    repo: "o/r",
    number: 7,
    commentId: 991,
    url: "https://github.com/o/r/issues/7#issuecomment-991",
  });
});

test("malformed repos and empty inputs are refused before any request", async () => {
  const { gh, calls } = patClient(() => Response.json({}, { status: 201 }));

  await expect(gh.createIssue("not-a-repo", { title: "x" })).rejects.toThrow("repo must be in owner/name form");
  await expect(gh.listIssues("not-a-repo")).rejects.toThrow("repo must be in owner/name form");
  await expect(gh.createIssue("o/r", { title: "   " })).rejects.toThrow("a title is required");
  await expect(gh.commentOnIssue("o/r", 7, "  ")).rejects.toThrow("a body is required");
  expect(calls).toEqual([]);
});

test("the issue call carries the installation token minted for the TARGET repo", async () => {
  const { gh, calls } = appClient(
    {
      "frgmt0/pixe": { id: 555, token: "ghs_frgmt0" },
      "kowo-co/beckett": { id: 777, token: "ghs_kowo" },
    },
    () => Response.json({ number: 1, html_url: "https://github.com/frgmt0/pixe/issues/1", title: "t", state: "open" }, { status: 201 }),
  );

  await gh.createIssue("frgmt0/pixe", { title: "t" });

  expect(calls[0]!.headers.Authorization).toBe("Bearer ghs_frgmt0");
  expect(calls[0]!.headers["X-GitHub-Api-Version"]).toBe("2022-11-28");
});

test("a repo no installation covers fails with the install link, not a bare 404", async () => {
  // Two installations, so there is no "sole installation" fallback: the app auth itself refuses.
  const { gh } = appClient({
    "kowo-co/beckett": { id: 555, token: "ghs_kowo" },
    "octocat/hello": { id: 777, token: "ghs_octocat" },
  });

  await expect(gh.createIssue("stranger/private", { title: "t" })).rejects.toThrow(
    /no installation covers stranger\/private/,
  );
  await expect(gh.createIssue("stranger/private", { title: "t" })).rejects.toThrow(
    /apps\/beckett\/installations\/new/,
  );
});

test("a 404 from the issues API names the missing installation, never the raw body", async () => {
  // The owner's installation exists (so a token IS minted) but the repo is outside its selection —
  // exactly the shape that used to surface as an unexplained "Not Found".
  const { gh } = appClient({ "frgmt0/pixe": { id: 555, token: "ghs_frgmt0" } });

  const failure = gh.createIssue("frgmt0/other", { title: "t" }).catch((e: Error) => e.message);
  const message = await failure;
  expect(message).toContain("cannot create an issue on frgmt0/other");
  expect(message).toContain("not in its repository selection");
  expect(message).toContain("https://github.com/apps/beckett/installations/new");
  expect(message).not.toMatch(/^Not Found$/);
});

test("an installation without Issues: Write is refused by name, before the request", async () => {
  const { gh, calls } = appClient({
    "frgmt0/pixe": { id: 555, token: "ghs_frgmt0", permissions: { contents: "write", issues: "read" } },
  });

  await expect(gh.createIssue("frgmt0/pixe", { title: "t" })).rejects.toThrow(
    /does not have Issues: Write \(its issues permission is read\)/,
  );
  expect(calls).toEqual([]); // never sent — a doomed write is not worth a round-trip
});

test("a 403 from the issues API is translated into the permission to grant", async () => {
  const { gh } = appClient(
    { "frgmt0/pixe": { id: 555, token: "ghs_frgmt0" } }, // token claims issues:write…
    () => Response.json({ message: "Resource not accessible by integration" }, { status: 403 }), // …GitHub disagrees
  );

  const message = await gh.commentOnIssue("frgmt0/pixe", 7, "hi").catch((e: Error) => e.message);
  expect(message).toContain("cannot comment on frgmt0/pixe#7");
  expect(message).toContain("Issues — Read and write");
  expect(message).toContain("Resource not accessible by integration");
});

test("a 404 on a comment says the issue may simply not exist", async () => {
  const { gh } = appClient(
    { "frgmt0/pixe": { id: 555, token: "ghs_frgmt0" } },
    () => Response.json({ message: "Not Found" }, { status: 404 }),
  );

  const message = await gh.commentOnIssue("frgmt0/pixe", 999, "hi").catch((e: Error) => e.message);
  expect(message).toContain("issue #999 does not exist on frgmt0/pixe");
});

test("issues turned off on a repo is its own sentence", async () => {
  const { gh } = patClient(() => Response.json({ message: "Issues are disabled for this repo" }, { status: 410 }));
  await expect(gh.createIssue("o/r", { title: "t" })).rejects.toThrow(/issues are disabled on o\/r/);
});
