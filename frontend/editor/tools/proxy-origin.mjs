/**
 * The dev proxy's origin check (`proxy.conf.mjs`): the proxy adds the API token, so a request
 * from another site must never reach the API through it. A request whose `Origin` is not the dev
 * server's own (another site, or `null` from a sandboxed frame or a file) gets this JSON:API
 * error document, answered 403. Browsers send `Origin` on every CORS request and on every request
 * but GET and HEAD; a request without one (a same-origin read, a cross-site `<img>`, curl) passes:
 * a GET changes nothing and its answer stays unreadable. `Host` is trusted only as far as the dev
 * server's own host check (`allowedHosts`, against DNS rebinding) goes: keep it on.
 *
 * @param {{ headers: Record<string, string | string[] | undefined> }} req
 * @returns {{ errors: object[] } | undefined} the refusal, or nothing for a request that may pass
 */
export function crossSiteRefusal(req) {
  const origin = req.headers.origin;
  if (origin === undefined) return undefined;
  if (typeof origin === 'string' && originHost(origin) === req.headers.host) {
    return undefined;
  }
  return {
    errors: [
      {
        status: '403',
        title: 'Forbidden',
        code: 'cross-origin-request',
        detail:
          "The dev server's proxy forwards requests from its own origin only.",
      },
    ],
  };
}

/** `host[:port]` of an origin, or undefined for one that is no URL (`null`). */
function originHost(origin) {
  try {
    const url = new URL(origin);
    return url.protocol === 'http:' || url.protocol === 'https:'
      ? url.host
      : undefined;
  } catch {
    return undefined;
  }
}
