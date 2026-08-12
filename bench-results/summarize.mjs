#!/usr/bin/env node
// Median + [min,max] over a bench JSONL, one report object per line.
// Usage: node bench-results/summarize.mjs bench-results/bench-1.7.2.jsonl [...]
import { readFileSync } from "node:fs";

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const fmt = (xs, unit) =>
  xs.length === 0 ? "—" : `${median(xs).toFixed(1)} ${unit} [${Math.min(...xs).toFixed(1)}, ${Math.max(...xs).toFixed(1)}]`;

for (const file of process.argv.slice(2)) {
  const rows = readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const ok = rows.filter((r) => !r.failed);
  console.log(`\n== ${file} — ${ok.length}/${rows.length} runs succeeded`);
  if (ok.length === 0) {
    console.log(`   failure: ${(rows[0]?.stderr ?? "").replace(/\s+/g, " ").slice(-400)}`);
    continue;
  }
  console.log(`   chromiumArgs        ${JSON.stringify(ok[0].chromiumArgs ?? "(default)")}`);
  console.log(`   cold acquire        ${fmt(ok.map((r) => r.coldAcquireMs), "ms")}`);
  console.log(`   warm eval p50       ${fmt(ok.map((r) => r.warmEvalMs.p50), "ms")}`);
  console.log(`   warm eval min       ${fmt(ok.map((r) => r.warmEvalMs.min), "ms")}`);
  console.log(`   warm eval p95       ${fmt(ok.map((r) => r.warmEvalMs.p95), "ms")}`);
  console.log(`   peak tree RSS       ${fmt(ok.map((r) => r.peakRssMb), "MiB")}`);
  console.log(`   active CPU-seconds  ${fmt(ok.map((r) => r.cpuSeconds), "s")}`);
}
