// creepJS capture, 1.8.2 revision. Same shape as fp25.js from the 1.8.0 pass:
// load the public creepJS page, let its *client-side* fingerprint settle, then read
// the self-computed detection signals. The aggregate "trust score %" comes from a
// creepjs backend fetch that does not return inside betterwright's 30 s snippet cap,
// so it is deliberately not what this reads.
await page.goto('https://abrahamjuliot.github.io/creepjs/', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(21000);
const data = await page.evaluate(() => {
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const gl = (() => {
    try {
      const c = document.createElement('canvas');
      const g = c.getContext('webgl') || c.getContext('experimental-webgl');
      if (!g) return { ok: false };
      const dbg = g.getExtension('WEBGL_debug_renderer_info');
      return {
        ok: true,
        vendor: dbg ? g.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : null,
        renderer: dbg ? g.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : null,
        params: Object.keys(g.constructor.prototype).length,
      };
    } catch (e) { return { ok: false, err: String(e) }; }
  })();
  const rtc = (() => {
    try { return typeof RTCPeerConnection === 'function' ? 'available' : 'absent'; }
    catch (e) { return 'error: ' + String(e); }
  })();
  const body = clean(document.body.innerText);
  const grab = (label, span) => {
    const at = body.indexOf(label);
    return at === -1 ? null : body.slice(at, at + span);
  };
  return {
    ua: navigator.userAgent,
    webdriver: navigator.webdriver,
    platform: navigator.platform,
    cores: navigator.hardwareConcurrency,
    deviceMemory: navigator.deviceMemory,
    vendor: navigator.vendor,
    webgl: gl,
    webrtc: rtc,
    headlessSection: grab('headless', 400),
    liesSection: grab('lies', 400),
    fpId: grab('FP ID', 120),
    body: body.slice(0, 6000),
  };
});
return data;
