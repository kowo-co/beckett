// Finding A, reproduced against each version's own arg validator, straight from the
// bun install cache so it does not depend on which version is currently installed.
// Usage: node bench-results/reserved-check.mjs
const STOCK = ["--disable-gpu", "--disable-software-rasterizer"]; // Beckett's default
for (const v of ["1.7.2", "1.8.0", "1.8.1"]) {
  const url = "/home/beckett/.bun/install/cache/betterwright@" + v + "@@@1/dist/src/chromium-args.js";
  const m = await import(url).catch(() => null);
  if (!m || !m.normalizeChromiumArgs) {
    console.log(v + ": no arg validator in this version (switch not policed)");
    continue;
  }
  try {
    console.log(v + ": ACCEPTED -> " + JSON.stringify(m.normalizeChromiumArgs(STOCK, "browser_chromium_args")));
  } catch (e) {
    console.log(v + ": REJECTED -> " + e.message);
  }
}
