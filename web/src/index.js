/**
 * 0xbeckett.me edge worker.
 *
 * Beckett's site is served straight from Cloudflare's edge (Workers Static Assets): no tunnel,
 * no loom-desk dependency. The only logic here is canonicalization: www.0xbeckett.me 301s to the
 * bare apex; everything else is served from ./public via the ASSETS binding.
 *
 * Subdomains (imagegen/pitch/<mockup>.0xbeckett.me) are NOT handled here; they stay on the
 * Cloudflare tunnel (`beckett deploy`). This worker only owns the apex + www.
 */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.hostname === "www.0xbeckett.me") {
      url.hostname = "0xbeckett.me";
      return Response.redirect(url.toString(), 301);
    }
    return env.ASSETS.fetch(request);
  },
};
