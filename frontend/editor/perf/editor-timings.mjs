// `pnpm nx run editor:perf-scale [-- --profile large] [--only <text>] [--wait-quiet <minutes>]`:
// the editor's screens on a seeded profile (`pnpm perf:seed`), timed in a headless Chromium with
// Playwright. Not part of `pnpm check`.
//
// The production build (`frontend/editor/dist/browser`) is served by a small static server here
// that proxies `/api` to the API on the profile with the shared token added, as the dev server's
// proxy does; the browser acts as the profile's administrator (demo mode). Per screen: the time
// until its last API answer, the rows and DOM nodes it renders, the API requests it made (and the
// largest `page[size]` asked for, to see whether anything loads a whole collection), its
// JavaScript heap, and a scroll, a filter and an open where the screen has them.
//
// The report goes to `.local/perf/<profile>/reports/editor-<time>.{md,json}`. At the end the
// profile's database is dropped, unless `--keep` (scripts/perf/README.md).

import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { createRequire } from 'node:module';
import { extname, join, normalize } from 'node:path';
import { parseArgs } from 'node:util';
import { profilePaths, ROOT } from '../../../scripts/perf/paths.mjs';
import { profileOf } from '../../../scripts/perf/profiles.mjs';
import {
  assertDatabaseKept,
  dropAfterRun,
} from '../../../scripts/perf/database.mjs';
import { freePort, startServer } from '../../../scripts/perf/server.mjs';
import {
  CORES,
  LoadWindow,
  load1,
  machine,
  waitForQuiet,
} from '../../../backend/api/tests/perf-scale/measure.mjs';
import { writeReport } from '../../../backend/api/tests/perf-scale/report.mjs';

const { values } = parseArgs({
  options: {
    profile: { type: 'string', default: 'large' },
    only: { type: 'string' },
    port: { type: 'string' },
    'wait-quiet': { type: 'string', default: '0' },
    // Keep the profile's database at the end (by default the run drops it).
    keep: { type: 'boolean', default: false },
  },
  allowPositionals: true,
});
const paths = profilePaths(profileOf(values.profile).name);
const state = JSON.parse(readFileSync(paths.state, 'utf8'));
assertDatabaseKept(state, values.profile);
const dist = join(ROOT, 'frontend', 'editor', 'dist', 'browser');
if (!existsSync(join(dist, 'index.html'))) {
  throw new Error(
    'perf: no production build of the editor; run pnpm nx run editor:build first',
  );
}
const waitMs = Number(values['wait-quiet']) * 60_000;
const log = (line) =>
  console.log(`[perf-scale editor ${values.profile}] ${line}`);
const startedAt = new Date();
const { chromium } = createRequire(join(ROOT, 'package.json'))(
  'playwright-core',
);

const TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
};

/** The built editor, with `/api` proxied to `apiBase` and the token added (never sent to the browser). */
function serveEditor(apiBase, port) {
  const api = new URL(apiBase);
  const server = createServer((req, res) => {
    // Only this machine's own address: a page elsewhere rebinding a name to it gets nothing.
    if (req.headers.host !== `127.0.0.1:${port}`) {
      res.writeHead(403);
      res.end();
      return;
    }
    if (req.url.startsWith('/api/')) {
      const headers = {
        ...req.headers,
        host: api.host,
        authorization: `Bearer ${state.token}`,
      };
      delete headers.origin;
      const upstream = httpRequest(
        {
          host: api.hostname,
          port: api.port,
          method: req.method,
          path: req.url.slice(4),
          headers,
        },
        (answer) => {
          res.writeHead(answer.statusCode ?? 502, answer.headers);
          answer.pipe(res);
        },
      );
      upstream.on('error', () => {
        res.writeHead(502);
        res.end();
      });
      req.pipe(upstream);
      return;
    }
    let decoded;
    try {
      decoded = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    } catch {
      res.writeHead(400);
      res.end();
      return;
    }
    const path = normalize(decoded).replace(/^(\.\.[/\\])+/, '');
    let file = join(dist, path);
    if (
      !file.startsWith(dist) ||
      !existsSync(file) ||
      statSync(file).isDirectory()
    )
      file = join(dist, 'index.html');
    res.writeHead(200, {
      'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
    });
    createReadStream(file).pipe(res);
  });
  return new Promise((resolve) =>
    server.listen(port, '127.0.0.1', () => resolve(server)),
  );
}

// The browser first: a missing one is the likeliest first-run failure, and nothing runs yet.
if (!existsSync(chromium.executablePath())) {
  throw new Error(
    'perf: no Chromium for Playwright; run npx playwright-core install chromium once',
  );
}
const api = await startServer(state, {
  label: 'editor-api',
  env: { CCMS_JOBS_POLL_MS: '0' },
});
const port = Number(values.port ?? (await freePort()));
const base = `http://127.0.0.1:${port}`;
let editor;
let browser;
const big = state.changeSets.find((c) => c.big);
const screens = [
  { name: 'Content browser', path: '/content', filter: 'filter', open: true },
  { name: 'Module editor', path: `/content/en/${state.sampleModules[0]}` },
  { name: 'Media library', path: '/media', filter: 'filter', open: true },
  {
    name: `Manual builder (${state.counts.bigManualModules} modules)`,
    path: `/manuals/${state.bigManual}`,
  },
  { name: 'Manuals list', path: '/manuals', filter: 'manual' },
  { name: 'Translations matrix', path: '/translations', filter: 'filter' },
  { name: 'Translation jobs', path: '/translations/jobs' },
  { name: 'Audit tab', path: '/admin/audit' },
  {
    name: `Review screen (big change set, ${big?.modules ?? '?'} modules)`,
    path: `/review?cs=${big?.id}`,
  },
  { name: 'Releases', path: '/releases' },
];

const results = [];
try {
  editor = await serveEditor(api.base, port);
  browser = await chromium.launch({ headless: true });
  // Warm the browser's and the server's code once; the screens then start from the same state.
  {
    const context = await newContext();
    const page = await context.newPage();
    await page.goto(`${base}/content`, {
      waitUntil: 'networkidle',
      timeout: 300_000,
    });
    await context.close();
  }
  for (const screen of screens) {
    if (
      values.only &&
      !values.only.split('|').some((part) => screen.name.includes(part))
    )
      continue;
    await waitForQuiet(waitMs, log);
    results.push(await measure(screen));
    const r = results.at(-1);
    log(
      `${screen.name}: ${Math.round(r.loadMs ?? -1)} ms, ${r.rows} rows, ${r.apiRequests} API requests (largest page ${r.largestPage}), heap ${Math.round((r.heapBytes ?? 0) / 2 ** 20)} MiB${r.error ? ` ERROR ${r.error}` : ''}`,
    );
  }
} finally {
  await browser?.close();
  editor?.close();
  await api.stop();
}

async function newContext() {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  await context.addInitScript(() => {
    try {
      localStorage.setItem('openfolia.demo-user', 'perf-admin');
    } catch {
      // A page without storage acts as the token's service instead.
    }
  });
  return context;
}

async function measure(screen) {
  const window = new LoadWindow();
  const context = await newContext();
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send('Performance.enable');
  const requests = [];
  let lastAnswer = 0;
  page.on('request', (req) => {
    if (req.url().includes('/api/')) requests.push(req.url());
  });
  page.on('requestfinished', (req) => {
    if (req.url().includes('/api/')) lastAnswer = performance.now();
  });
  const result = {
    name: screen.name,
    path: screen.path,
    interactions: [],
    findings: [],
  };
  try {
    const started = performance.now();
    await page.goto(`${base}${screen.path}`, {
      waitUntil: 'networkidle',
      timeout: 300_000,
    });
    result.loadMs = Math.max(lastAnswer, started) - started;
    Object.assign(result, await facts(page, cdp, requests));
    const idle = async (name, act) => {
      const before = requests.length;
      const t0 = performance.now();
      lastAnswer = t0;
      const acted = await act();
      if (acted === false) return;
      await page
        .waitForLoadState('networkidle', { timeout: 120_000 })
        .catch(() => undefined);
      await page.waitForTimeout(600);
      result.interactions.push({
        name,
        ms: Math.max(lastAnswer, t0) - t0,
        requests: requests.length - before,
      });
    };
    await idle('scroll', () =>
      page.evaluate(() => {
        const scrollers = [...document.querySelectorAll('*')].filter((el) => {
          const style = getComputedStyle(el);
          return (
            /(auto|scroll)/.test(style.overflowY) &&
            el.scrollHeight > el.clientHeight + 50
          );
        });
        const target = scrollers.sort(
          (a, b) => b.scrollHeight - a.scrollHeight,
        )[0];
        if (!target) return false;
        target.scrollTop = target.scrollHeight;
        return true;
      }),
    );
    if (screen.filter) {
      await idle('filter', async () => {
        const input = page
          .locator(
            'main input[type="search"]:visible:enabled, main input[type="text"]:visible:enabled, main input:not([type]):visible:enabled',
          )
          .first();
        if ((await input.count()) === 0) return false;
        await input.fill(screen.filter, { timeout: 5_000 });
        return true;
      });
    }
    if (screen.open) {
      await idle('open', async () => {
        const link = page.locator('main a[href*="/"]').first();
        if ((await link.count()) === 0) return false;
        await link.click({ timeout: 5_000 });
        return true;
      });
    }
    const after = await facts(page, cdp, requests);
    result.heapAfterBytes = after.heapBytes;
  } catch (error) {
    result.error =
      error instanceof Error ? error.message.split('\n')[0] : String(error);
  } finally {
    await context.close();
  }
  result.load = window.close();
  if ((result.rows ?? 0) > 500)
    result.findings.push(`renders ${result.rows} rows at once`);
  if ((result.largestPage ?? 0) > 200)
    result.findings.push(`asks for page[size]=${result.largestPage}`);
  if ((result.samePathPages ?? 0) > 10)
    result.findings.push(
      `reads ${result.samePathPages} pages of one list (a whole collection)`,
    );
  return result;
}

async function facts(page, cdp, requests) {
  const dom = await page.evaluate(() => ({
    rows: document.querySelectorAll(
      'main tr, main [role="row"], main li, main [role="listitem"], main [role="option"]',
    ).length,
    domNodes: document.getElementsByTagName('*').length,
  }));
  const { metrics } = await cdp.send('Performance.getMetrics');
  const heap = metrics.find((m) => m.name === 'JSHeapUsedSize')?.value;
  const sizes = requests.map((url) =>
    Number(new URL(url).searchParams.get('page[size]') ?? 0),
  );
  const byPath = new Map();
  for (const url of requests) {
    const u = new URL(url);
    if (!u.searchParams.has('page[number]')) continue;
    byPath.set(u.pathname, (byPath.get(u.pathname) ?? 0) + 1);
  }
  // What was asked for most: the lists read, with their largest page and how many pages.
  const lists = new Map();
  for (const url of requests) {
    const u = new URL(url);
    const key = u.pathname.replace(/^\/api/, '');
    const entry = lists.get(key) ?? { path: key, requests: 0, largestPage: 0 };
    entry.requests += 1;
    entry.largestPage = Math.max(
      entry.largestPage,
      Number(u.searchParams.get('page[size]') ?? 0),
    );
    lists.set(key, entry);
  }
  return {
    ...dom,
    lists: [...lists.values()].sort((a, b) => b.requests - a.requests),
    heapBytes: heap,
    apiRequests: requests.length,
    largestPage: Math.max(0, ...sizes),
    samePathPages: Math.max(0, ...byPath.values()),
  };
}

const { execFileSync } = await import('node:child_process');
mkdirSync(paths.reports, { recursive: true });
const file = writeReport(paths.reports, 'editor', {
  kind: 'editor',
  profile: values.profile,
  startedAt: startedAt.toISOString(),
  finishedAt: new Date().toISOString(),
  commit: execFileSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim(),
  dirty:
    execFileSync(
      'git',
      ['-C', ROOT, 'status', '--porcelain', '--untracked-files=no'],
      { encoding: 'utf8' },
    ).trim() !== '',
  machine: machine(),
  cores: CORES,
  loadAtEnd: Math.round(load1() * 10) / 10,
  counts: state.counts,
  screens: results,
});
log(`report: ${file}`);
await dropAfterRun(paths.state, state, { keep: values.keep, log });
