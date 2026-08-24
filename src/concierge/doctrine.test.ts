import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { validateConfig } from "../config.ts";
import { renderDoctrine } from "./index.ts";

const doctrineTemplate = readFileSync(join(import.meta.dir, "concierge.md"), "utf8");

/**
 * The prompt is a CORPUS now, not a file: a small always-loaded index (`concierge.md`) plus one
 * playbook per procedure, read when its trigger fires (#128). The placeholder guarantee has to
 * hold across all of it — `{{github_owner}}` mostly lives in the playbooks now, so asserting
 * against the index alone would pass by simply no longer containing the thing under test.
 */
const playbooksDir = join(import.meta.dir, "playbooks");
const promptCorpus = [
  doctrineTemplate,
  ...readdirSync(playbooksDir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => readFileSync(join(playbooksDir, f), "utf8")),
].join("\n");

describe("concierge doctrine instance rendering", () => {
  test("renders every project repository under the configured GitHub identity", () => {
    const rendered = renderDoctrine(
      promptCorpus,
      validateConfig({ identity: { github_user: "octocat" } }),
      {},
    );

    expect(promptCorpus).toContain("{{github_owner}}/balloons");
    expect(rendered).toContain("octocat/balloons");
    expect(rendered).toContain("octocat/beckett");
    expect(rendered).not.toContain("{{github_owner}}");
    expect(rendered).not.toContain("0xbeckett/");
  });

  test("the index cites only playbook paths that exist, and leaves no placeholder unrendered", () => {
    // A dangling pointer is the one failure this architecture must not have: the model reports the
    // file missing and then proceeds from memory, which is exactly what the index exists to stop.
    const rendered = renderDoctrine(doctrineTemplate, validateConfig({ identity: { github_user: "octocat" } }), {});
    expect(rendered).not.toMatch(/\{\{[a-z_]+\}\}/);
    const cited = [...rendered.matchAll(/`(\/[^`]+\.md)`/g)].map((m) => m[1]!);
    expect(cited.length).toBeGreaterThan(10);
    expect(cited.filter((p) => !existsSync(p))).toEqual([]);
  });

  test("uses BECKETT_GH_ORG ahead of the configured user", () => {
    const rendered = renderDoctrine(
      "publish to {{github_owner}}/demo",
      validateConfig({ identity: { github_user: "octocat" } }),
      { BECKETT_GH_ORG: "acme-labs" },
    );

    expect(rendered).toBe("publish to acme-labs/demo");
  });

  test("the prompt corpus tells ambient turns to act, not to hold", () => {
    // An ambient turn used to be told, every time, that it may not deploy work — a smaller
    // license than every other turn gets. §Volition now governs ambient turns too (overhaul
    // B-P9): the doctrine bullet says so, and the old literal is gone from both the corpus and
    // the private frame-builder in index.ts (reading the source is the only way to pin a
    // private function's text without exporting it).
    expect(promptCorpus).toContain("An overheard turn is not a smaller license");
    expect(promptCorpus).not.toContain("Do not deploy any work yet");
    const conciergeIndexSrc = readFileSync(join(import.meta.dir, "index.ts"), "utf8");
    expect(conciergeIndexSrc).not.toContain("Do not deploy any work yet");
  });

  test("the corpus gives the CTO seat a job description, not a punchline", () => {
    // The seat's entire textual existence used to be one line of a user-owned persona.md — the
    // exact line the chilltext carve drops first. Doctrine is loaded fresh every session and is
    // never subject to that carve, so the job description belongs here, not in the voice file.
    expect(promptCorpus).toContain("Kowo's technical direction is yours to hold");
    expect(promptCorpus).toContain("A strategic observation is work, and it is yours to start");
    expect(promptCorpus).toContain("Write a memo");
    expect(promptCorpus).toContain("~/.beckett/company.md");
    expect(promptCorpus).toContain('Never "if you want I could…"');
  });

  test("the corpus flips memory writes to write-unless-noise, without claiming a write", () => {
    expect(promptCorpus).toContain("Write it unless it's noise");
    expect(promptCorpus).toContain("Uncertain → write it");
    expect(promptCorpus).toContain("a decision anyone makes, and the reason behind it");
    expect(promptCorpus).toContain('what did you eat');
    expect(promptCorpus).toContain("beckett memory remember");
    expect(promptCorpus).toContain("ran THIS turn and returned success");
  });
});
