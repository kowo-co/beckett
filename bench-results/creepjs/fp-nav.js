// First call: navigate to creepjs and let it start computing. Do NOT close —
// keep the session resident so a second call can read the settled fingerprint.
await page.goto('https://abrahamjuliot.github.io/creepjs/', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(25000);
return 'nav done: ' + (await page.title());
