// The built editor (`editor:build`, `frontend/editor/dist/browser`) on a loopback port, with
// `/api` proxied to the suite's API as a deployment's reverse proxy does it: the token added
// here, never in the browser (none with sign-in on, #37: the session cookie passes through),
// and a request from another origin refused
// (`frontend/editor/tools/proxy-origin.mjs`, the dev server's own check).
//
//   node stack/editor-server.mjs   settings from the environment:
//     E2E_EDITOR_PORT  the port to listen on (127.0.0.1)
//     E2E_API_URL      the API's address, e.g. http://127.0.0.1:53211
//     E2E_API_TOKEN    the API's shared token (unset: none is added, for sign-in)
//     E2E_EDITOR_DIST  the built editor's browser folder
//     E2E_EDITOR_START_PAGE  `1`: serve `/__start` (the demo's, `scripts/demo/`), below
//   prints `ready <port>` once it listens.
//
// It answers only requests addressed to `127.0.0.1:<port>` or `localhost:<port>`, and takes a
// write only from no origin or one of those two (`foreignRequest`, below): never from another
// name pointed at this machine.
//
// `/__start?lang=de&user=demo-author&theme=light` (only with E2E_EDITOR_START_PAGE) stores the
// interface language, the demo user and the theme in the browser, as the editor's own choices
// store them, forgets the revision the browser last worked in (the take starts on fresh data)
// and opens the editor: one address that starts a take in a known state. Each value is checked
// against a narrow pattern; one left out is left as it is.
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';
import { crossSiteRefusal } from '../../editor/tools/proxy-origin.mjs';

const port = Number(process.env.E2E_EDITOR_PORT);
const api = new URL(process.env.E2E_API_URL ?? '');
const token = process.env.E2E_API_TOKEN ?? '';
const dist = process.env.E2E_EDITOR_DIST ?? '';
if (!port || !existsSync(join(dist, 'index.html'))) {
  console.error(
    'editor-server: E2E_EDITOR_PORT, E2E_API_URL and a built E2E_EDITOR_DIST are required',
  );
  process.exit(2);
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
};

/**
 * SAML's assertion consumer service (#376): the identity provider's page posts its answer here
 * from its own site, so the origin check cannot apply; never with the token, as the editor's
 * nginx has it (`deploy/docker/editor/nginx.conf`).
 */
const SAML_ACS = '/api/auth/saml/callback';

/** `/api/...` to the API, the prefix taken off and the token put in. */
function proxy(req, res) {
  const acs = req.method === 'POST' && req.url === SAML_ACS;
  const refusal = acs ? undefined : crossSiteRefusal(req);
  if (refusal) {
    res.writeHead(403, { 'Content-Type': 'application/vnd.api+json' });
    res.end(JSON.stringify(refusal));
    return;
  }
  const headers = { ...req.headers, host: api.host };
  delete headers.authorization;
  if (token && !acs) headers.authorization = `Bearer ${token}`;
  const upstream = request(
    {
      hostname: api.hostname,
      port: api.port,
      method: req.method,
      path: req.url.slice('/api'.length) || '/',
      headers,
    },
    (answer) => {
      res.writeHead(answer.statusCode ?? 502, answer.headers);
      answer.pipe(res);
    },
  );
  upstream.on('error', (error) => {
    console.error(
      `proxy: ${req.method} ${req.url} failed: ${error.code ?? ''} ${error.message}`,
    );
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'text/plain' });
    }
    res.end('API unreachable');
  });
  req.pipe(upstream);
}

/** A built file, or `index.html` for any other path (the app's own routes). */
function file(req, res) {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const target = normalize(join(dist, path));
  const inside = target === dist || target.startsWith(dist + sep);
  const found =
    inside && existsSync(target) && statSync(target).isFile()
      ? target
      : join(dist, 'index.html');
  res.writeHead(200, {
    'Content-Type': TYPES[extname(found)] ?? 'application/octet-stream',
    'Cache-Control': 'no-store',
  });
  createReadStream(found).pipe(res);
}

const startPage = process.env.E2E_EDITOR_START_PAGE === '1';
/** What `/__start` may store, by query parameter: the browser key and the values it takes. */
const START_VALUES = {
  lang: ['of-language', /^[a-z]{2}(-[A-Z]{2})?$/],
  user: ['openfolia.demo-user', /^[a-z0-9][a-z0-9-]{0,63}$/],
  theme: ['of-theme', /^(light|dark|system)$/],
};

/** The start page: stores the choices in the query, then opens the editor. */
function start(req, res) {
  const query = new URL(req.url, 'http://x').searchParams;
  const values = {};
  for (const [name, [key, pattern]] of Object.entries(START_VALUES)) {
    const value = query.get(name);
    if (value === null) continue;
    if (!pattern.test(value)) {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`${name}: not a value the start page takes`);
      return;
    }
    values[key] = value;
  }
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  // The values passed their patterns, and JSON in a script cannot close it (no `<`).
  res.end(
    `<!doctype html><meta charset="utf-8"><title>Starting</title><script>` +
      `for (const [k, v] of Object.entries(${JSON.stringify(values)})) localStorage.setItem(k, v);` +
      `localStorage.removeItem('openfolia.change-set');sessionStorage.clear();location.replace('/');</script>`,
  );
}

/**
 * The only names this server answers to: its loopback address and `localhost`, on its port. A
 * page on another site whose name was pointed at 127.0.0.1 (DNS rebinding) sends its own name as
 * `Host`, and as `Origin` too, so the origin check alone would let it through the proxy, token and
 * all: the check the dev server's `allowedHosts` does. Applies to every request, the editor's
 * files included.
 */
const OWN_HOSTS = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);

/** Why a request is refused before anything else, or nothing for one from this server's page. */
function foreignRequest(req) {
  if (!OWN_HOSTS.has(req.headers.host ?? '')) return 'host';
  // A read changes nothing (and `/api` reads keep the proxy's own origin check); a write must
  // come from this server's own page.
  // SAML's answer is posted from the identity provider's site (`SAML_ACS`, the token kept out).
  const origin = req.headers.origin;
  if (
    origin === undefined ||
    req.method === 'GET' ||
    req.method === 'HEAD' ||
    (req.method === 'POST' && req.url === SAML_ACS)
  ) {
    return undefined;
  }
  try {
    const url = new URL(origin);
    return url.protocol === 'http:' && OWN_HOSTS.has(url.host)
      ? undefined
      : 'origin';
  } catch {
    return 'origin';
  }
}

const server = createServer((req, res) => {
  const foreign = foreignRequest(req);
  if (foreign) {
    res.writeHead(foreign === 'host' ? 421 : 403, {
      'Content-Type': 'text/plain; charset=utf-8',
    });
    res.end(`Refused: the request's ${foreign} is not this server's.`);
    return;
  }
  let pathname;
  try {
    pathname = new URL(req.url, 'http://x').pathname;
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not a request target this server takes.');
    return;
  }
  if (req.url === '/api' || req.url.startsWith('/api/')) proxy(req, res);
  else if (startPage && pathname === '/__start') start(req, res);
  else file(req, res);
});
server.listen(port, '127.0.0.1', () => console.log(`ready ${port}`));

const stop = () => server.close(() => process.exit(0));
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
process.on('disconnect', stop);
