/**
 * Coverage for the company brief seed/read (`src/company.ts`). The seed must never be able to
 * overwrite a human-answered brief, and a garbled/blank/absent brief must read as "no brief",
 * never as an empty opinion.
 */

import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { companyFilePath, DEFAULT_COMPANY_BRIEF, readCompanyBrief, seedCompanyBrief } from "./company.ts";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "beckett-company-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

test("the brief is seeded with questions and never with answers", () => {
  const path = join(tmp(), "company.md");
  expect(seedCompanyBrief(path)).toBe(true);
  const content = readFileSync(path, "utf8");
  expect(content).toContain("## The portfolio");
  expect(content).toContain("## Off-limits");
  expect(content).toContain("## What a win looks like");
  expect(content).not.toContain("babble");
  expect(content).not.toContain("chilltext");
  expect(content).not.toContain("Kowo builds");
});

test("an existing brief is never overwritten", () => {
  const path = join(tmp(), "company.md");
  writeFileSync(path, "# mine");
  expect(seedCompanyBrief(path)).toBe(false);
  expect(seedCompanyBrief(path)).toBe(false);
  expect(readFileSync(path, "utf8")).toBe("# mine");
});

test("a blank or missing brief reads as null, not as an empty opinion", () => {
  const dir = tmp();
  expect(readCompanyBrief(join(dir, "missing.md"))).toBeNull();
  const blank = join(dir, "blank.md");
  writeFileSync(blank, "   \n\n  \n");
  expect(readCompanyBrief(blank)).toBeNull();
});

test("an unwritable location costs a false, not a throw", () => {
  const dir = tmp();
  const notADir = join(dir, "iam-a-file");
  writeFileSync(notADir, "x");
  expect(() => seedCompanyBrief(join(notADir, "company.md"))).not.toThrow();
  expect(seedCompanyBrief(join(notADir, "company.md"))).toBe(false);
  expect(existsSync(join(notADir, "company.md"))).toBe(false);
});

test("companyFilePath sits next to the socket", () => {
  expect(companyFilePath("/home/beckett/.beckett")).toBe("/home/beckett/.beckett/company.md");
});

test("DEFAULT_COMPANY_BRIEF is the seed content", () => {
  expect(DEFAULT_COMPANY_BRIEF).toContain("## Open questions");
});
