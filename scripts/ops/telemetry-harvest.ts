#!/usr/bin/env bun
import { defaultOptions, harvest } from "../../src/telemetry/harvest.ts";

const options = defaultOptions();
const args = process.argv.slice(2);

function take(flag: string): string {
  const value = args.shift();
  if (!value) throw new Error(`${flag} requires a path`);
  return value;
}

while (args.length) {
  const flag = args.shift()!;
  switch (flag) {
    case "--output": options.output = take(flag); break;
    case "--rates": options.rates = take(flag); break;
    case "--claude-dir": options.claudeDir = take(flag); break;
    case "--pi-dir": options.piDir = take(flag); break;
    case "--codex-dir": options.codexDir = take(flag); break;
    case "--run-events": options.runEventsPath = take(flag); break;
    case "--help":
      console.log("Usage: bun run telemetry:refresh [--output PATH] [--claude-dir PATH] [--pi-dir PATH] [--codex-dir PATH] [--run-events PATH] [--rates PATH]");
      process.exit(0);
    default: throw new Error(`unknown option: ${flag}`);
  }
}

await harvest(options);
