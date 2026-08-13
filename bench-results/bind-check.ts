// End-to-end check of the sandbox bind's gating against the real host install.
// Usage: bun bench-results/bind-check.ts
import { readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { chromiumForkLaunch } from "../src/browser/isolated.ts";

const root = join(homedir(), ".betterwright", "chromium");
const binaries = readdirSync(join(root, "linux-x64")).filter((f) => f.toLowerCase().includes("chrom"));

console.log("installed betterwright :", createRequire(import.meta.url)("betterwright/package.json").version);
console.log("host fork dir holds    :", binaries.join(", "));
console.log("default (installed ver):", JSON.stringify(chromiumForkLaunch({ chromiumForkRoot: root })));
console.log("forced 1.8.1           :", JSON.stringify(chromiumForkLaunch({ chromiumForkRoot: root, betterwrightVersion: "1.8.1" })));
console.log("kill switch \"off\"      :", JSON.stringify(chromiumForkLaunch({ chromiumForkRoot: "off" })));
