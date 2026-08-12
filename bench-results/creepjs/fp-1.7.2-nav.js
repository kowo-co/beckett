// Longer 1.7.2 attempt: navigate and hold the session open, so the second call
// gets a fresh 30 s snippet budget on the same page rather than one capped visit.
await page.goto('https://abrahamjuliot.github.io/creepjs/', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(25000);
return 'navigated';
