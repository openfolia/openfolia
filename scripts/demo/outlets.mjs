// Where the released manuals reach readers, for the hero (#804): the reader portal
// (`frontend/portal`) built from the demo's API at one release, served on a demo port, and an AI
// assistant's view of the same release through the MCP server (`backend/mcp`), whose real answer
// the hero draws as a layer. Both read with a service account of the demo's own: a role holding
// `content.read` alone, up to the owners' audience, as a deployment would set them up.
//
// Nothing here writes a model's answer: the assistant layer shows the question, the tool call and
// what the tool returned, word for word.

import { execFileSync, spawn } from 'node:child_process';
import { createReadStream, existsSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { extname, join, normalize, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CARD_COLORS } from './cards/cards.mjs';
import { ROOT } from './paths.mjs';

/** The audience the portal and the assistant read for: the car's owners. */
export const READER_AUDIENCE = 'owner';
/** The demo's read-only role and service account (made once per demo run). */
export const READER = {
  role: 'demo-reader',
  account: 'demo-reader',
  name: 'Demo reader',
};

/**
 * A service token that reads released content up to the owners' audience: the role and the
 * account made on the first call (the demo is fresh after every reset), a new token each time.
 */
export async function readerToken(admin) {
  const { data: roles } = await admin.get('/roles?page[size]=100');
  if (!roles.some((role) => role.id === READER.role)) {
    await admin.post('/roles', {
      data: {
        type: 'Role',
        id: READER.role,
        attributes: {
          name: READER.name,
          permissions: ['content.read'],
          scope: { maxAudience: READER_AUDIENCE },
        },
      },
    });
  }
  const { data: accounts } = await admin.get(
    '/service-accounts?page[size]=100',
  );
  if (!accounts.some((account) => account.id === READER.account)) {
    await admin.post('/service-accounts', {
      data: {
        type: 'ServiceAccount',
        id: READER.account,
        attributes: { name: READER.name },
        relationships: { roles: { data: [{ type: 'Role', id: READER.role }] } },
      },
    });
  }
  const answer = await admin.post(
    `/service-accounts/${READER.account}/tokens`,
    { data: { type: 'ServiceToken', attributes: { name: 'hero' } } },
  );
  return answer.meta.token;
}

/** Builds what the portal and the MCP server need (Nx caches it). */
export function buildOutlets() {
  execFileSync(
    'pnpm',
    [
      ...['nx', 'run-many', '-t', 'build'],
      ...['-p', 'mcp', 'render-html', 'content-model', 'theme'],
      '--output-style=static',
    ],
    { cwd: ROOT, stdio: 'inherit' },
  );
}

/**
 * The portal for the owners in `lang` at `release`, written to `outDir` (`<outDir>/<lang>/`):
 * the portal's own build (`frontend/portal/scripts/build.ts`), the token only in its
 * environment, as a deployment runs it.
 */
export function buildPortal({ apiUrl, token, lang, release, outDir }) {
  rmSync(outDir, { recursive: true, force: true });
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/build.ts'], {
      cwd: join(ROOT, 'frontend', 'portal'),
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        CCMS_PORTAL_API_URL: apiUrl,
        CCMS_PORTAL_TOKEN: token,
        CCMS_PORTAL_AUDIENCE: READER_AUDIENCE,
        CCMS_PORTAL_LANGUAGES: lang,
        CCMS_PORTAL_RELEASES: release,
        CCMS_PORTAL_OUT_DIR: outDir,
        CCMS_PORTAL_BRANDING: 'off',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '';
    child.stdout.on('data', (chunk) => (log += chunk));
    child.stderr.on('data', (chunk) => (log += chunk));
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) return resolve(outDir);
      // The build never prints its token; the last lines say why it failed.
      reject(
        new Error(
          `the portal build failed: ${log.split('\n').slice(-6).join('\n')}`,
        ),
      );
    });
  });
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.pdf': 'application/pdf',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
};

/** The file a request names under `root`, or null when it points out of it. */
export function staticFile(root, url) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(url ?? '/', 'http://x').pathname);
  } catch {
    return null;
  }
  const file = normalize(join(root, pathname));
  if (file !== root && !file.startsWith(root + sep)) return null;
  return existsSync(file) && statSync(file).isDirectory()
    ? join(file, 'index.html')
    : file;
}

/**
 * Serves a built portal as a plain static host does (a folder answers with its `index.html`,
 * nothing outside `root`), on 127.0.0.1 at a free port the system picks, so it never takes a
 * port another stack holds. Resolves to its URL and a `close()`.
 */
export function servePortal(root) {
  const server = createServer((req, res) => {
    const file = staticFile(root, req.url);
    if (!file) return void res.writeHead(403).end();
    if (!existsSync(file)) return void res.writeHead(404).end();
    res.writeHead(200, {
      'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    createReadStream(file).pipe(res);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () =>
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((done) => server.close(() => done())),
      }),
    );
  });
}

/** The words the layers show around the real data, per language. */
export const OUTLET_TEXTS = {
  en: {
    assistant: 'AI assistant',
    toolCall: 'Tool call',
    results: (n) => (n === 1 ? '1 result' : `${n} results`),
    source: 'Source',
    release: (revision) => `Release ${revision}`,
    pdf: 'PDF',
    portal: 'Reader portal',
  },
  de: {
    assistant: 'KI-Assistent',
    toolCall: 'Werkzeugaufruf',
    results: (n) => (n === 1 ? '1 Ergebnis' : `${n} Ergebnisse`),
    source: 'Quelle',
    release: (revision) => `Veröffentlichung ${revision}`,
    pdf: 'PDF',
    portal: 'Leserportal',
  },
};

/**
 * What the reader asks, and what the assistant sends the MCP server's `search` for it, per
 * language: the question is the reader's, the query the words a tool call carries.
 */
export const ASSISTANT_ASK = {
  en: {
    question: 'How tight do the wheel bolts go?',
    query: 'tighten wheel bolts',
  },
  de: {
    question: 'Wie fest werden die Radschrauben angezogen?',
    query: 'Radschrauben ziehen',
  },
};

export const escapeHtml = (text) =>
  String(text).replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ],
  );

/** The brand green's mark, as the PDF tiles have it: drawn left to right after `delay` ms. */
const MARK_STYLE = (delay) =>
  `border-radius:4px;padding:0 3px;margin:0 -3px;background-image:linear-gradient(rgba(105,153,93,.32),rgba(105,153,93,.32)),linear-gradient(#69995d,#69995d);background-repeat:no-repeat;background-position:left top,left bottom;background-size:100% 100%,100% 3px;animation:demo-mark-in 520ms cubic-bezier(.65,0,.25,1) ${delay}ms both`;

/**
 * `text` as HTML, with `phrase` (words in a row, e.g. `120 Nm`) wrapped in the green mark, or
 * plain when the text does not have it (the gap) or no phrase is given.
 */
export function markedText(text, phrase, delay = 0) {
  if (!phrase) return escapeHtml(text);
  const at = text.indexOf(phrase);
  if (at < 0) return escapeHtml(text);
  return (
    escapeHtml(text.slice(0, at)) +
    `<span style="${MARK_STYLE(delay)}">${escapeHtml(phrase)}</span>` +
    escapeHtml(text.slice(at + phrase.length))
  );
}

/** A tool call as the assistant sent it: `search({ query: "…", … })`, every value escaped. */
export function toolCallText(tool, args) {
  const values = Object.entries(args)
    .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
    .join(', ');
  return `${tool}({ ${values} })`;
}

const LAYER_KEYFRAMES = `<style>
@keyframes demo-rise { from { opacity: 0; transform: translateY(12px); filter: blur(6px) } to { opacity: 1; transform: none; filter: none } }
@keyframes demo-mark-in { from { background-size: 0% 100%, 0% 3px } to { background-size: 100% 100%, 100% 3px } }
@media (prefers-reduced-motion: reduce) { .demo-layer * { animation: none !important } }
</style>`;

const rise = (delay) =>
  `animation:demo-rise 460ms cubic-bezier(.22,.9,.3,1) ${delay}ms both`;

/** The scrim every layer sits on: the PDF tiles' own. */
const scrim = (inner, extra = '') =>
  `${LAYER_KEYFRAMES}<div style="position:absolute;inset:0;background:rgba(14,15,17,.9);display:grid;place-content:center;${extra}">${inner}</div>`;

/**
 * The assistant's card: the reader's question, the `search` call the assistant made and its real
 * answer (the first result: title, excerpt, which release it is from). `found` is
 * `{ total, title, excerpt, moduleId, blockId, release }` from `askAssistant`; `phrase` the words
 * marked in the excerpt (null on the release that does not have them).
 */
export function assistantCard(found, { lang, call, phrase, delay = 0 }) {
  const t = OUTLET_TEXTS[lang];
  const mono = `font:500 15px/1.5 'Geist Mono',ui-monospace,monospace`;
  return `<div style="width:900px;display:flex;flex-direction:column;gap:18px;font-family:Geist,system-ui,sans-serif;color:#eef0ec">
  <div style="display:flex;align-items:center;gap:10px;font:500 15px/1 Geist,system-ui,sans-serif;color:${CARD_COLORS.muted};${rise(delay)}">
    <span style="width:8px;height:8px;border-radius:50%;background:#69995d"></span>${escapeHtml(t.assistant)}
  </div>
  <div style="align-self:flex-end;max-width:640px;padding:16px 22px;border-radius:20px 20px 6px 20px;background:#2a2d33;font:500 24px/1.35 Geist,system-ui,sans-serif;${rise(delay + 150)}">${escapeHtml(ASSISTANT_ASK[lang].question)}</div>
  <div style="padding:14px 18px;border-radius:12px;border:1px solid rgba(255,255,255,.1);background:rgba(255,255,255,.03);${rise(delay + 700)}">
    <div style="font:500 13px/1 Geist,system-ui,sans-serif;color:${CARD_COLORS.muted};margin-bottom:8px">${escapeHtml(t.toolCall)} · MCP</div>
    <div style="${mono};color:#cfd3d8;overflow-wrap:anywhere">${escapeHtml(toolCallText(call.tool, call.args))}</div>
  </div>
  <div style="padding:22px 26px;border-radius:14px;background:#1d2024;border:1px solid rgba(255,255,255,.08);box-shadow:0 18px 50px rgba(0,0,0,.45);${rise(delay + 1250)}">
    <div style="display:flex;justify-content:space-between;gap:16px;font:500 13px/1 Geist,system-ui,sans-serif;color:${CARD_COLORS.muted};margin-bottom:12px"><span>${escapeHtml(t.results(found.total))}</span><span style="${mono};font-size:13px">${escapeHtml(found.moduleId)} · ${escapeHtml(found.blockId)}</span></div>
    <div style="font:600 22px/1.3 Geist,system-ui,sans-serif;margin-bottom:10px">${escapeHtml(found.title)}</div>
    <div style="font:400 26px/1.45 Literata,Georgia,serif;color:#eef0ec">${markedText(found.excerpt, phrase, delay + 1900)}</div>
    <div style="margin-top:16px;font:500 15px/1 Geist,system-ui,sans-serif;color:${CARD_COLORS.muted}">${escapeHtml(t.source)}: <span style="color:#eef0ec">${escapeHtml(t.release(found.release))}</span> · ${escapeHtml(found.title)}</div>
  </div>
</div>`;
}

/** The assistant layer (01c, 06c): its card alone on the scrim. */
export const assistantLayer = (found, options) =>
  scrim(assistantCard(found, options));

/**
 * A strip of a PDF page (a tile of `pdfTile` in `scenes/hero.mjs`: the page picture at 200 dpi,
 * the crop and the words' box in points), `width` px wide, the words marked after `delay` ms.
 */
export function pdfStrip(tile, width, delay, dpi = 200) {
  const pt = dpi / 72;
  const scale = width / (tile.crop.width * pt);
  const height = Math.round(tile.crop.height * pt * scale);
  const mark = {
    left: (tile.box.x0 - tile.crop.x) * pt * scale - 4,
    top: (tile.box.y0 - tile.crop.y) * pt * scale - 3,
    width: (tile.box.x1 - tile.box.x0) * pt * scale + 8,
    height: (tile.box.y1 - tile.box.y0) * pt * scale + 6,
  };
  return `<div style="position:relative;width:${width}px;height:${height}px;overflow:hidden;border-radius:10px;background:#fff;box-shadow:0 18px 50px rgba(0,0,0,.45);${rise(delay)}">
    <img src="${escapeHtml(tile.picture)}" style="position:absolute;left:${(-tile.crop.x * pt * scale).toFixed(1)}px;top:${(-tile.crop.y * pt * scale).toFixed(1)}px;width:${(tile.pageWidth * pt * scale).toFixed(1)}px;max-width:none;height:auto" alt="">
    <i style="position:absolute;left:${mark.left.toFixed(1)}px;top:${mark.top.toFixed(1)}px;width:${mark.width.toFixed(1)}px;height:${mark.height.toFixed(1)}px;${MARK_STYLE(delay + 500)};padding:0;margin:0"></i>
  </div>`;
}

/**
 * The last shot's layer (07a): the three places the answer reached, one under the other, each
 * as wide as the frame allows so it reads: a strip of the PDF, the portal's step and the
 * assistant's passage, each with the new words marked. `pictures.pdf` is a PDF tile (`pdfTile`),
 * `pictures.portal` `{ src, width, height }` (a data URL of the portal's step); `found` is the
 * assistant's answer.
 */
export function outletsLayer({ pictures, found, lang, phrase }) {
  const t = OUTLET_TEXTS[lang];
  const width = 900;
  const row = (text, inner, delay) =>
    `<div style="display:grid;grid-template-columns:180px ${width}px;gap:28px;align-items:center">
    <div style="font:500 18px/1.25 Geist,system-ui,sans-serif;color:#eef0ec;text-align:right;${rise(delay)}">${escapeHtml(text)}</div>
    ${inner}
  </div>`;
  const { src, width: w, height: h } = pictures.portal;
  const portal = `<div style="width:${width}px;aspect-ratio:${w} / ${h};border-radius:10px;overflow:hidden;box-shadow:0 18px 50px rgba(0,0,0,.45);${rise(140)}"><img src="${escapeHtml(src)}" alt="" style="display:block;width:100%;height:auto;max-width:none"></div>`;
  const passage = `<div style="width:${width}px;box-sizing:border-box;padding:18px 24px;border-radius:10px;background:#1d2024;border:1px solid rgba(255,255,255,.08);box-shadow:0 18px 50px rgba(0,0,0,.45);${rise(280)}">
    <div style="font:400 22px/1.45 Literata,Georgia,serif;color:#eef0ec">${markedText(found.excerpt, phrase, 980)}</div>
    <div style="margin-top:10px;font:500 14px/1 Geist,system-ui,sans-serif;color:${CARD_COLORS.muted}">${escapeHtml(found.title)} · ${escapeHtml(t.source)}: ${escapeHtml(t.release(found.release))}</div>
  </div>`;
  return scrim(
    `<div style="display:flex;flex-direction:column;gap:26px;margin-left:-208px">${[
      row(t.pdf, pdfStrip(pictures.pdf, width, 0), 0),
      row(t.portal, portal, 140),
      row(t.assistant, passage, 280),
    ].join('')}</div>`,
    // The closing picture: the page behind it all but gone.
    'background:rgba(14,15,17,.96)',
  );
}

/**
 * Asks the MCP server as an assistant would: `search` for the reader's question at one release
 * (`ref`, its tag), in the take's language; the first result is the answer the layer shows, with
 * the release's revision from `list_releases`. Every value is the server's own.
 */
export async function askAssistant(call, { lang, revision }) {
  const { releases } = await call('list_releases', {});
  const release = releases.find((r) => r.revision === revision);
  if (!release) throw new Error(`the assistant sees no release ${revision}`);
  const args = { query: ASSISTANT_ASK[lang].query, lang, ref: release.tag };
  const answer = await call('search', args);
  const first = answer.results.find((r) => r.resourceType === 'Module');
  if (!first) {
    throw new Error(`the assistant found nothing for "${args.query}"`);
  }
  return {
    call: { tool: 'search', args },
    found: {
      total: answer.total,
      title: first.title,
      excerpt: first.excerpt,
      moduleId: first.id,
      blockId: first.blockId ?? '',
      release: release.revision,
    },
  };
}

/**
 * An MCP session with the demo's MCP server (`backend/mcp/dist/main.js` over stdio, through the
 * official SDK's client), reading the demo's API with `token`. `use` gets `call(tool, args)`,
 * which resolves to the tool's structured result.
 */
export async function withAssistant({ apiUrl, token }, use) {
  const require = createRequire(join(ROOT, 'backend', 'mcp', 'package.json'));
  const load = (path) =>
    import(
      pathToFileURL(require.resolve(`@modelcontextprotocol/sdk/${path}`)).href
    );
  const { Client } = await load('client/index.js');
  const { StdioClientTransport } = await load('client/stdio.js');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(ROOT, 'backend', 'mcp', 'dist', 'main.js')],
    env: {
      PATH: process.env.PATH ?? '',
      CCMS_MCP_API_URL: apiUrl,
      CCMS_MCP_API_TOKEN: token,
    },
    stderr: 'ignore',
  });
  const client = new Client({ name: 'demo-hero', version: '1.0.0' });
  await client.connect(transport);
  try {
    return await use(async (name, args) => {
      const result = await client.callTool({ name, arguments: args });
      if (result.isError) {
        throw new Error(
          `${name}: ${result.content?.map((c) => c.text).join(' ')}`,
        );
      }
      return result.structuredContent;
    });
  } finally {
    await client.close();
  }
}
