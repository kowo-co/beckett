await page.goto('https://abrahamjuliot.github.io/creepjs/', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(25000);
const data = await page.evaluate(() => {
  const clean = (s) => (s || '').replace(/[ \t]+/g, ' ');
  const gl = (() => {
    try {
      const c = document.createElement('canvas');
      const g = c.getContext('webgl') || c.getContext('experimental-webgl');
      if (!g) return { ok: false };
      const dbg = g.getExtension('WEBGL_debug_renderer_info');
      return { ok: true, vendor: dbg ? g.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : null, renderer: dbg ? g.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : null };
    } catch (e) { return { ok: false, err: String(e) }; }
  })();
  return {
    ua: navigator.userAgent,
    webdriver: navigator.webdriver,
    platform: navigator.platform,
    cores: navigator.hardwareConcurrency,
    deviceMemory: navigator.deviceMemory,
    vendor: navigator.vendor,
    webgl: gl,
    body: clean(document.body.innerText),
  };
});
return data;
