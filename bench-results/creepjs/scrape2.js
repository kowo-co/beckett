await page.goto('https://abrahamjuliot.github.io/creepjs/', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(22000);
const data = await page.evaluate(() => {
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  // creepJS renders the trust score and lies badge into the header block.
  const els = [...document.querySelectorAll('div,span,strong,a')];
  const pctNodes = els
    .filter((e) => e.children.length === 0 && /%/.test(e.textContent || ''))
    .map((e) => clean(e.textContent))
    .filter((t) => t.length < 60);
  const trustNode = els.find((e) => /trust score/i.test(e.textContent || '') && e.children.length < 6);
  const liesNode = els.find((e) => /\blie(s)?\b/i.test(e.textContent || '') && /\d/.test(e.textContent || '') && e.children.length < 4);
  const headlessNode = els.find((e) => /headless/i.test(e.textContent || '') && e.children.length < 8);
  return {
    trustText: trustNode ? clean(trustNode.textContent).slice(0, 220) : null,
    liesText: liesNode ? clean(liesNode.textContent).slice(0, 220) : null,
    headlessText: headlessNode ? clean(headlessNode.textContent).slice(0, 300) : null,
    percentages: [...new Set(pctNodes)].slice(0, 25),
  };
});
return data;
