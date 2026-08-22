import { expect, test } from "bun:test";
import { TERMINAL_LINE_MAX_CHARS, TERMINAL_WINDOW_LINES, renderTerminalWindow } from "./terminal-window.ts";

function stamped(marker: string): string {
  return `2026-08-22T05:50:28.937Z ${marker}`;
}

test("an empty journal renders a placeholder, still fenced as a code block", () => {
  const window = renderTerminalWindow([]);
  expect(window).toBe("```\n(no activity yet)\n```");
});

test("fewer lines than the window shows all of them, oldest first", () => {
  const lines = [stamped("▸ implement worker started (claude)"), stamped("· Read  index.html")];
  const window = renderTerminalWindow(lines);
  expect(window).toBe("```\n▸ implement worker started (claude)\n· Read  index.html\n```");
});

test("more lines than the window keeps only the last N — oldest falls off the top", () => {
  const lines = Array.from({ length: TERMINAL_WINDOW_LINES + 5 }, (_, i) => stamped(`· step ${i}`));
  const window = renderTerminalWindow(lines);
  const body = window.slice(4, -4); // strip the ``` fences
  const rendered = body.split("\n");
  expect(rendered).toHaveLength(TERMINAL_WINDOW_LINES);
  expect(rendered[0]).toBe("· step 5"); // the first 5 fell off
  expect(rendered.at(-1)).toBe(`· step ${TERMINAL_WINDOW_LINES + 4}`);
  expect(window).not.toContain("step 0");
  expect(window).not.toContain("step 4");
});

test("a line past the char cap is truncated with an ellipsis, not wrapped", () => {
  const long = "x".repeat(TERMINAL_LINE_MAX_CHARS + 40);
  const window = renderTerminalWindow([stamped(`· Bash  ${long}`)]);
  const body = window.slice(4, -4);
  expect(body.split("\n")).toHaveLength(1);
  expect(body.length).toBeLessThanOrEqual(TERMINAL_LINE_MAX_CHARS);
  expect(body.endsWith("…")).toBe(true);
});

test("the leading ISO timestamp is stripped so the window reads like a terminal, not a log", () => {
  const window = renderTerminalWindow([stamped("· Bash  bun test")]);
  expect(window).not.toContain("2026-08-22T05:50:28");
  expect(window).toContain("· Bash  bun test");
});

test("blank lines are dropped, not rendered as empty rows", () => {
  const window = renderTerminalWindow(["", "  ", stamped("· Bash  bun test")]);
  expect(window).toBe("```\n· Bash  bun test\n```");
});

test("a secret in a raw journal line is redacted before it reaches the fenced window", () => {
  const window = renderTerminalWindow([stamped("· Bash  export GITHUB_TOKEN=ghp_reallySecretValue123456")]);
  expect(window).not.toContain("reallySecretValue123456");
  expect(window).toContain("[redacted]");
});
