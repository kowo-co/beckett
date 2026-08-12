await page.goto('https://abrahamjuliot.github.io/creepjs/', { waitUntil: 'domcontentloaded', timeout: 60000 });
// creepJS computes asynchronously; give it time to settle before scraping.
await page.waitForTimeout(20000);
const data = await page.evaluate(() => {
  const pick = (re) => {
    const els = [...document.querySelectorAll('div,span,strong,section')];
    const hit = els.find((e) => re.test(e.textContent || '') && (e.children.length < 5));
    return hit ? (hit.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200) : null;
  };
  const reTrust = new RegExp('trust score', 'i');
  const reLies = new RegExp('\\blies\\b', 'i');
  const reBot = new RegExp('bot', 'i');
  return {
    ua: navigator.userAgent,
    webdriver: navigator.webdriver,
    platform: navigator.platform,
    hardwareConcurrency: navigator.hardwareConcurrency,
    trust: pick(reTrust),
    lies: pick(reLies),
    bot: pick(reBot),
    bodyText: document.body.innerText.replace(/\n{2,}/g, '\n').slice(0, 5000),
  };
});
return data;
