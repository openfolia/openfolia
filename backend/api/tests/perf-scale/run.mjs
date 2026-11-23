// `pnpm nx run api:perf-scale [-- --profile large] [--only <text>] [--wait-quiet <minutes>]`:
// the server benchmarks on a seeded profile (`pnpm perf:seed`). Not part of `pnpm check`.
//
// Every scenario runs on a server process of its own, started for it on the profile's data,
// so "cold" means a fresh process (the database, Git's files and the blob store as they are on
// disk). Cold: the first request for each of the scenario's keys; warm: one of them repeated.
// Then: start-up time, the MCP tools, concurrency (readers and writers at once) with the
// server's memory, the import dry run and the XLIFF round trip, a release's outputs.
//
// The report goes to `.local/perf/<profile>/reports/api-<time>.{md,json}`: per row the median and
// p95, the load before and during it, and whether the machine was busy (the 1-minute load
// average above the core count, the rule of `expectWithin()`): a busy row measured the machine.
// At the end the profile's database is dropped, unless `--keep`. See scripts/perf/README.md.

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { createRequire } from 'node:module';
import pg from 'pg';
import { profilePaths, ROOT } from '../../../../scripts/perf/paths.mjs';
import { profileOf } from '../../../../scripts/perf/profiles.mjs';
import {
  assertDatabaseKept,
  dropAfterRun,
} from '../../../../scripts/perf/database.mjs';
import { startServer } from '../../../../scripts/perf/server.mjs';
import {
  CORES,
  LoadWindow,
  load1,
  machine,
  rssOf,
  stats,
  waitForQuiet,
} from './measure.mjs';
import { discover, resolveDeepPages, scenarios } from './scenarios.mjs';
import { writeReport } from './report.mjs';

const { values } = parseArgs({
  options: {
    profile: { type: 'string', default: 'large' },
    only: { type: 'string' },
    skip: { type: 'string' },
    'wait-quiet': { type: 'string', default: '0' },
    'warm-runs': { type: 'string', default: '15' },
    'concurrency-seconds': { type: 'string', default: '30' },
    // The reader counts of the concurrency rows, `,`-separated.
    readers: { type: 'string', default: '20,50' },
    // Extra Node options for every measured server (`--cpu-prof --cpu-prof-dir=<dir>`,
    // `--heapsnapshot-signal=SIGUSR2`, …), handed to it as `NODE_OPTIONS`.
    'node-options': { type: 'string' },
    // CCMS_ROLE for every measured server but the backlog row's (#527; default: the server's, all).
    role: { type: 'string' },
    // The backlog row's worker processes beside the api role, and their nice value (default:
    // the server's, CCMS_WORKER_NICE).
    'backlog-workers': { type: 'string', default: '1' },
    'worker-nice': { type: 'string' },
    // `postgres` or `memory`: every measured server's search (`CCMS_SEARCH_ADAPTER`, #54); unset, the default.
    'search-adapter': { type: 'string' },
    // Keep the profile's database at the end (by default the run drops it: a run changes it).
    keep: { type: 'boolean', default: false },
  },
  allowPositionals: true,
});
const paths = profilePaths(profileOf(values.profile).name);
const state = JSON.parse(readFileSync(paths.state, 'utf8'));
if (!state.counts)
  throw new Error(
    `perf: ${paths.state} is from a seed that did not finish; run pnpm perf:seed --profile ${values.profile}`,
  );
assertDatabaseKept(state, values.profile);
const waitMs = Number(values['wait-quiet']) * 60_000;
const warmRuns = Number(values['warm-runs']);
const wanted = (name) =>
  (!values.only ||
    values.only.split('|').some((part) => name.includes(part))) &&
  (!values.skip || !values.skip.split('|').some((part) => name.includes(part)));
const log = (line) => console.log(`[perf-scale ${values.profile}] ${line}`);
const startedAt = new Date();
const rows = [];
const notes = [];
const startups = [];
const concurrency = [];

async function serverFor(label, env = {}) {
  const server = await startServer(state, {
    label: `bench-${label.replace(/[^a-z0-9]+/gi, '-').slice(0, 60)}`,
    env: {
      CCMS_JOBS_POLL_MS: '0',
      // The per-reader search rate (#539) is a policy, not capacity: the concurrency rows
      // search far more often per reader than a person would.
      CCMS_SEARCH_PER_MINUTE: '6000',
      ...(values['node-options'] && { NODE_OPTIONS: values['node-options'] }),
      ...(values.role && { CCMS_ROLE: values.role }),
      ...(values['search-adapter'] && {
        CCMS_SEARCH_ADAPTER: values['search-adapter'],
      }),
      ...env,
    },
  });
  startups.push(server.startupMs);
  return server;
}

/** One request of a scenario, bounded by its `timeoutMs` (default 120 s); never throws. */
async function timed(api, spec, scenario) {
  const request = typeof spec === 'string' ? { path: spec } : spec;
  const started = performance.now();
  let res;
  try {
    res = await api.request(scenario.method ?? 'GET', request.path, {
      as: scenario.as,
      body: request.body,
      headers: { ...(scenario.accept && { Accept: scenario.accept }) },
      signal: AbortSignal.timeout(scenario.timeoutMs ?? 120_000),
    });
  } catch (error) {
    return {
      ms: performance.now() - started,
      status: 0,
      bytes: 0,
      ok: false,
      body: { errors: [{ detail: `no answer: ${error.message}` }] },
    };
  }
  const ok = (scenario.expect ?? [200]).includes(res.status);
  return {
    ms: res.ms,
    status: res.status,
    bytes: res.bytes,
    ok,
    body: ok ? undefined : res.body,
  };
}

/**
 * Runs one part of the benchmark; a failure is a note and the run goes on, so an hour of rows
 * is never lost to one part (the report is written at the end either way).
 */
async function guarded(label, fn) {
  try {
    await fn();
  } catch (error) {
    notes.push(`${label}: failed, ${error.message.slice(0, 500)}`);
    log(`${label}: FAILED ${error.message.slice(0, 300)}`);
  }
}

// -- Discovery: what the scenarios refer to ------------------------------------------------------

let found;
let planned;
{
  const server = await serverFor('discover');
  try {
    found = await discover(server.client, state);
    planned = await resolveDeepPages(
      server.client,
      scenarios(state, found).filter((s) => wanted(s.name)),
    );
  } finally {
    await server.stop();
  }
}

// -- Routes ------------------------------------------------------------------------------------------

for (const skipped of planned.filter((s) => s.skip)) notes.push(skipped.skip);
for (const scenario of planned.filter((s) => !s.skip)) {
  await guarded(scenario.name, async () => {
    const wasQuiet = await waitForQuiet(waitMs, log);
    const server = await serverFor(scenario.name);
    const window = new LoadWindow();
    const cold = [];
    const warm = [];
    const failures = [];
    let bytes = 0;
    try {
      for (const spec of scenario.cold) {
        const r = await timed(server.client, spec, scenario);
        cold.push(r.ms);
        bytes = Math.max(bytes, r.bytes);
        if (!r.ok)
          failures.push(
            `${r.status} ${JSON.stringify(r.body?.errors?.[0] ?? '').slice(0, 300)}`,
          );
      }
      for (let i = 0; i < (scenario.warmRuns ?? warmRuns); i++) {
        const r = await timed(server.client, scenario.warm, scenario);
        warm.push(r.ms);
        if (!r.ok)
          failures.push(
            `${r.status} ${JSON.stringify(r.body?.errors?.[0] ?? '').slice(0, 300)}`,
          );
      }
    } finally {
      await server.stop();
    }
    const load = window.close();
    const row = {
      name: scenario.name,
      group: scenario.group,
      cold: stats(cold),
      first: Math.round(cold[0] ?? 0),
      warm: stats(warm),
      bytes,
      load,
      waitedForQuiet: wasQuiet,
      failures: [...new Set(failures)],
    };
    rows.push(row);
    log(
      `${scenario.name}: first ${row.first} ms, cold median ${row.cold.median} ms, warm median ${row.warm.median} / p95 ${row.warm.p95} ms${load.busy ? ` (busy: load up to ${load.max})` : ''}${row.failures.length ? ` FAILED: ${row.failures[0]}` : ''}`,
    );
  });
}

// -- Import dry run: a bundle of new modules -----------------------------------------------------------

if (wanted('POST /imports'))
  await guarded('POST /imports', async () => {
    const requireFromApi = createRequire(
      join(ROOT, 'backend', 'api', 'package.json'),
    );
    const { zipSync, strToU8 } = requireFromApi('fflate');
    const modules = Array.from({ length: 1_000 }, (_, i) => ({
      schemaVersion: 1,
      id: `imported-module-${String(i + 1).padStart(4, '0')}`,
      meta: {
        title: `Imported module ${i + 1}`,
        type: 'concept',
        lang: 'en',
        audience: 'public',
        facets: {},
      },
      blocks: Array.from({ length: 8 }, (_, b) => ({
        type: 'paragraph',
        id: `p${b}`,
        content: [
          {
            type: 'text',
            text: `Check the filter of part ${i}-${b} at least once a month and replace it when the indicator turns red.`,
          },
        ],
      })),
    }));
    const bundle = Buffer.from(
      zipSync({
        'import.json': strToU8(
          JSON.stringify({
            formatVersion: 1,
            source: { system: 'perf' },
            modules,
          }),
        ),
      }),
    );
    await measureUploads(
      'POST /imports, dry run (1,000 new modules)',
      'import',
      '/imports',
      bundle,
      'bundle.zip',
      { importer: 'bundle', dryRun: 'true' },
      'perf-admin',
      [200],
    );
  });

// -- XLIFF: the big job's file, translated, checked as an import (dry run) ---------------------------

if (wanted('POST /translations/imports') && found.bigJob)
  await guarded('POST /translations/imports', async () => {
    const server = await serverFor('xliff-download');
    const lang = found.bigJob.attributes.languages[0];
    const translator = state.users.translator[lang];
    let xliff;
    try {
      const res = await fetch(
        `${server.base}/translations/exports/${found.bigJob.id}/file?lang=${lang}`,
        {
          headers: {
            Authorization: `Bearer ${state.token}`,
            'X-Ccms-User': translator,
          },
        },
      );
      xliff = Buffer.from(await res.arrayBuffer()).toString('utf8');
      if (!res.ok) {
        throw new Error(
          `the job's file answered ${res.status}: ${xliff.slice(0, 300)}`,
        );
      }
    } finally {
      await server.stop();
    }
    // Every unit "translated": its source copied as the target, codes and all.
    const translated = xliff.replace(
      /(<source(?:\s[^>]*)?>([\s\S]*?)<\/source>)(?!\s*<target)/g,
      (_, source, inner) => `${source}<target>${inner}</target>`,
    );
    const units = (translated.match(/<target[\s>]/g) ?? []).length;
    notes.push(
      `XLIFF import: the big job's ${lang} file, ${units} units, ${Math.round(Buffer.byteLength(translated) / 1024)} KiB.`,
    );
    await measureUploads(
      `POST /translations/imports, dry run (${units} units)`,
      'xliff',
      '/translations/imports',
      Buffer.from(translated),
      `translation-${lang}.xlf`,
      { dryRun: 'true' },
      translator,
      [200, 201],
    );
  });

async function measureUploads(
  name,
  group,
  path,
  bytes,
  fileName,
  fields,
  as,
  expect,
) {
  const wasQuiet = await waitForQuiet(waitMs, log);
  const server = await serverFor(name);
  const window = new LoadWindow();
  const times = [];
  const failures = [];
  try {
    for (let i = 0; i < 4; i++) {
      const form = new FormData();
      for (const [k, v] of Object.entries(fields)) form.set(k, v);
      form.set('file', new Blob([bytes]), fileName);
      const started = performance.now();
      const res = await fetch(`${server.base}${path}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${state.token}`,
          'X-Ccms-User': as,
          'X-Ccms-Request': '1',
          Accept: 'application/vnd.api+json',
        },
        body: form,
      });
      const text = await res.text();
      times.push(performance.now() - started);
      if (!expect.includes(res.status))
        failures.push(`${res.status} ${text.slice(0, 300)}`);
    }
  } finally {
    await server.stop();
  }
  const load = window.close();
  const row = {
    name,
    group,
    cold: stats(times.slice(0, 1)),
    first: Math.round(times[0]),
    warm: stats(times.slice(1)),
    bytes: bytes.length,
    load,
    waitedForQuiet: wasQuiet,
    failures: [...new Set(failures)],
  };
  rows.push(row);
  log(
    `${name}: first ${row.first} ms, then median ${row.warm.median} ms${load.busy ? ' (busy)' : ''}${failures.length ? ` FAILED: ${failures[0]}` : ''}`,
  );
}

// -- A release's outputs: planning them for the newest release ---------------------------------------

if (wanted('release outputs'))
  await guarded('release outputs', async () => {
    const wasQuiet = await waitForQuiet(waitMs, log);
    const server = await serverFor('release-outputs', {
      CCMS_JOBS_POLL_MS: '500',
    });
    const window = new LoadWindow();
    const release = found.releases[0];
    const totalOf = async () =>
      (
        await server.client.must(
          'GET',
          `/releases/${release.id}/outputs?page[size]=1`,
          { as: 'perf-admin' },
        )
      ).body.meta.page.total;
    let outcome;
    let refusedAtOnce = false;
    // Planning is kept and idempotent: only a release without outputs measures it.
    const before = await totalOf().catch(async (error) => {
      await server.stop();
      throw error;
    });
    if (before > 0) {
      await server.stop();
      window.close();
      notes.push(
        `release outputs: the newest release already has ${before} outputs (an earlier run planned them); seed again to measure planning`,
      );
      return;
    }
    const started = performance.now();
    try {
      const plan = await server.client.must(
        'POST',
        `/releases/${release.id}/outputs/plan`,
        { as: 'perf-admin', body: {} },
        (status) => status === 202 || status === 422,
      );
      // Over CCMS_RELEASE_MAX_OUTPUTS (#477): refused at once, with the count and the limit.
      const refused =
        plan.status === 422 ? plan.body?.errors?.[0]?.meta : undefined;
      if (refused) {
        refusedAtOnce = true;
        outcome = `refused: ${refused.wanted} outputs, more than the limit of ${refused.max} (CCMS_RELEASE_MAX_OUTPUTS)`;
      }
      // Planned when the count stops growing for three polls in a row.
      let last = 0;
      let same = 0;
      for (; !refused;) {
        const total = await totalOf();
        same = total > 0 && total === last ? same + 1 : 0;
        last = total;
        if (same >= 3) {
          outcome = `${total} outputs planned`;
          break;
        }
        if (performance.now() - started > 120_000) {
          outcome =
            total > 0
              ? `${total} outputs after 120 s, still growing`
              : 'no outputs planned within 120 s (see the release’s meta.outputs and the server log)';
          break;
        }
        await new Promise((r) => setTimeout(r, 500));
      }
    } finally {
      await server.stop();
    }
    const ms = performance.now() - started;
    const load = window.close();
    rows.push({
      name: 'POST /releases/:id/outputs/plan until planned (newest release)',
      group: 'outputs',
      cold: stats([ms]),
      first: Math.round(ms),
      warm: { n: 0 },
      bytes: 0,
      load,
      waitedForQuiet: wasQuiet,
      failures: [],
      note: refusedAtOnce
        ? outcome
        : `${outcome}; the time includes the three confirming polls (1.5 s)`,
    });
    log(`release outputs: ${outcome} after ${Math.round(ms)} ms`);
  });

// -- The render queue (#497): a new release's first file, behind older releases' backlog -------------

// It cuts a release (`perf-queue-<time>`) in the seeded repository, and every planned release's
// files are left queued or rendered: a later run's release scenarios then find that release and
// its planned outputs, so seed again for comparable numbers after it.
if (wanted('render queue'))
  await guarded('render queue', async () => {
    const wasQuiet = await waitForQuiet(waitMs, log);
    // Jobs on, as a deployment runs them: the seeded releases' plannings are still queued, so
    // their files pile up while this runs.
    const server = await serverFor('render-queue', {
      CCMS_JOBS_POLL_MS: '500',
    });
    const window = new LoadWindow();
    const as = { as: 'perf-admin' };
    const progressOf = async (id) =>
      (await server.client.must('GET', `/releases/${id}`, as)).body.data.meta
        .outputs;
    /** Every release's files still to render (queued or rendering), from the list's progress. */
    const backlog = async () => {
      let pending = 0;
      for (let number = 1; ; number++) {
        const page = await server.client.must(
          'GET',
          `/releases?page[size]=50&page[number]=${number}`,
          as,
        );
        for (const r of page.body.data) {
          const o = r.meta.outputs;
          if (o) pending += o.queued + o.rendering;
        }
        if (page.body.data.length < 50) return pending;
      }
    };
    const BACKLOG = 2_000;
    try {
      // 1. A backlog of older releases' files: until there are BACKLOG, or 5 minutes.
      const filling = performance.now();
      let before = 0;
      let still = 0;
      for (;;) {
        const now = await backlog();
        // No longer growing (planning ended below BACKLOG): no use waiting.
        still = now > 0 && now === before ? still + 1 : 0;
        before = now;
        if (before >= BACKLOG || still >= 3) break;
        if (performance.now() - filling > 300_000) break;
        await new Promise((r) => setTimeout(r, 5_000));
      }
      log(
        `render queue: ${before} older files queued or rendering after ${Math.round((performance.now() - filling) / 1000)} s`,
      );
      // 2. A new release of the newest release's product, at main.
      const product = found.releases[0].attributes.product;
      const revision = `perf-queue-${Date.now()}`;
      const cut = performance.now();
      const created = await server.client.must('POST', '/releases', {
        ...as,
        body: {
          data: { type: 'Release', attributes: { product, revision } },
        },
      });
      const id = created.body.data.id;
      const cutMs = performance.now() - cut;
      // 3. Its first file done (rendered or reused), then how many in the minute after.
      let planned;
      let firstMs;
      let ahead;
      let last;
      for (;;) {
        last = await progressOf(id);
        const at = performance.now() - cut;
        if (last && planned === undefined && last.total > 0) planned = at;
        if (last?.queue?.ahead != null)
          ahead = Math.max(ahead ?? 0, last.queue.ahead);
        if (last && last.done > 0 && firstMs === undefined) firstMs = at;
        if (firstMs !== undefined && at - firstMs >= 60_000) break;
        if (firstMs === undefined && at > 600_000) break;
        await new Promise((r) => setTimeout(r, 500));
      }
      const after = await backlog();
      const said = [
        `CCMS_RENDER_CONCURRENCY default`,
        `${before} older files queued or rendering at the cut, ${after} at the end`,
        `cut ${Math.round(cutMs)} ms`,
        planned === undefined
          ? 'never planned'
          : `planned (first rows) after ${Math.round(planned / 1000)} s`,
        firstMs === undefined
          ? `no file done within 10 min (${last?.done ?? 0} of ${last?.total ?? 0})`
          : `first file after ${(firstMs / 1000).toFixed(1)} s; ${last.done} of ${last.total} done a minute later`,
        ...(ahead === undefined ? [] : [`at most ${ahead} files ahead of it`]),
      ];
      rows.push({
        name: 'POST /releases until its first file is done (behind older releases’ backlog)',
        group: 'outputs',
        cold: stats([firstMs ?? 600_000]),
        first: Math.round(firstMs ?? 600_000),
        warm: { n: 0 },
        bytes: 0,
        load: window.close(),
        waitedForQuiet: wasQuiet,
        failures: firstMs === undefined ? ['no file done within 10 min'] : [],
        note: said.join('; '),
      });
      log(`render queue: ${said.join('; ')}`);
    } finally {
      await server.stop();
    }
  });

// -- Readers while a backlog renders, by role (#527) -------------------------------------------------

// The same mix as the concurrency rows (readers, 3 writers) plus one reader asking for manuals'
// PDFs, with one process doing it all (`CCMS_ROLE=all`, as before #527) and with `CCMS_ROLE=api`
// beside `--backlog-workers` worker processes (default 1, at their default CPU priority,
// `CCMS_WORKER_NICE`), each first with nothing rendering (no job consumed: the baseline) and
// then while release files render. It also checks, from the database, that no file was rendered
// twice and that no release had more than its cap of files scheduled at once. The seeded
// releases' plannings are still queued (the seed runs no jobs), so there is a backlog; a run
// renders part of it (seed again for comparable numbers).
if (wanted('backlog'))
  await guarded('backlog', async () => {
    const readers = Number(values.readers.split(',')[0]);
    const ms = Number(values['concurrency-seconds']) * 1000;
    const as = { as: 'perf-admin' };
    const tags = found.releases.map((r) => r.attributes.tag);
    const pdfPaths = tags.flatMap((tag) =>
      found.otherSlugs
        .slice(0, 2)
        .map(
          (slug) =>
            `/manuals/${found.otherManual}/variants/${encodeURIComponent(slug)}/en/pdf?ref=${encodeURIComponent(tag)}`,
        ),
    );
    // The editor's preview of a manual (#527): page images of the same PDFs, as the manual
    // builder asks for them; each page and width once per server, then from its cache.
    const previewPaths = pdfPaths.flatMap((path) =>
      [1, 2, 3].map((page) => {
        const [base, query] = path.split('?');
        return `${base}/pages/${page}.png?width=800&${query}`;
      }),
    );
    /**
     * Waits until there is a backlog: attempts running and at least 40 jobs waiting (planning
     * done far enough), at most 3 minutes, so both rows measure readers beside the same work.
     */
    const untilRendering = async (api) => {
      const until = performance.now() + 180_000;
      for (;;) {
        const s = (await api.must('GET', '/jobs/status', as)).body.data;
        if (s.attributes.running > 0 && s.attributes.ready >= 40) return s;
        if (performance.now() > until) return s;
        await new Promise((r) => setTimeout(r, 2_000));
      }
    };
    const doneFiles = async (api) => {
      let done = 0;
      for (let number = 1; ; number++) {
        const page = await api.must(
          'GET',
          `/releases?page[size]=50&page[number]=${number}`,
          as,
        );
        for (const r of page.body.data) done += r.meta.outputs?.done ?? 0;
        if (page.body.data.length < 50) return done;
      }
    };
    // The same number of release renders at once in each (8: `all`'s 8 of its 10 PDF workers,
    // or the workers' 8 between them), so the rows differ only in where they run, not in how
    // much.
    const workerCount = Number(values['backlog-workers']);
    if (!Number.isInteger(workerCount) || workerCount < 1 || workerCount > 8)
      throw new Error('--backlog-workers must be a whole number from 1 to 8');
    /** Worker `n`'s share of the 8 renders at once (and as many PDF workers). */
    const shareOf = (n) =>
      String(Math.floor(8 / workerCount) + (n < 8 % workerCount ? 1 : 0));
    const variants = [
      { split: false, rendering: false },
      { split: true, rendering: false },
      { split: false, rendering: true },
      { split: true, rendering: true },
    ];
    for (const { split, rendering } of variants) {
      const wasQuiet = await waitForQuiet(waitMs, log);
      const label = `${split ? `api + ${workerCount} worker${workerCount > 1 ? 's' : ''}` : 'all'}, ${rendering ? 'backlog rendering' : 'nothing rendering'}`;
      const poll = rendering ? '500' : '0';
      const api = await serverFor(`backlog-${split ? 'api' : 'all'}`, {
        ...(split
          ? { CCMS_ROLE: 'api' }
          : {
              CCMS_JOBS_POLL_MS: poll,
              CCMS_PDF_WORKERS: '10',
              CCMS_RENDER_CONCURRENCY: '8',
            }),
      });
      const workers = split
        ? await Promise.all(
            Array.from({ length: workerCount }, (_, n) =>
              serverFor(`backlog-worker-${n + 1}`, {
                CCMS_JOBS_POLL_MS: poll,
                CCMS_ROLE: 'worker',
                CCMS_PDF_WORKERS: shareOf(n),
                CCMS_RENDER_CONCURRENCY: shareOf(n),
                ...(values['worker-nice'] !== undefined && {
                  CCMS_WORKER_NICE: values['worker-nice'],
                }),
              }),
            ),
          )
        : [];
      const db = new pg.Client({ connectionString: state.databaseUrl });
      await db.connect();
      // Each output's attempts before the row. An attempt cut off by the previous row's
      // shutdown runs again (at least once): one more attempt. Two or more more in one row is
      // a file rendered twice.
      const attemptsOf = async () =>
        new Map(
          (await db.query('select id, attempts from release_outputs')).rows.map(
            (r) => [r.id, r.attempts],
          ),
        );
      const attemptsBefore = await attemptsOf();
      let maxScheduled = 0;
      const capSampler = setInterval(() => {
        db.query(
          `select count(*)::int as n from release_outputs where scheduled_at is not null and state in ('queued', 'rendering') group by release_id order by 1 desc limit 1`,
        ).then(
          (r) => (maxScheduled = Math.max(maxScheduled, r.rows[0]?.n ?? 0)),
          () => undefined,
        );
      }, 500);
      try {
        const status = rendering
          ? await untilRendering(api.client)
          : (await api.client.must('GET', '/jobs/status', as)).body.data;
        const before = await doneFiles(api.client);
        const row = await mix(api, readers, 3, ms, {
          pdfPaths,
          previewPaths,
          rssOf: [api.pid, ...workers.map((w) => w.pid)],
        });
        clearInterval(capSampler);
        const after = await doneFiles(api.client);
        let attempts = 0;
        let twice = 0;
        for (const [id, n] of await attemptsOf()) {
          const more = n - (attemptsBefore.get(id) ?? 0);
          attempts += more;
          if (more > 1) twice += 1;
        }
        concurrency.push({
          ...row,
          name: `backlog, ${label}: ${row.name} + 1 PDF reader + 1 preview reader`,
          backlog: {
            role: label,
            readyAtStart: status.attributes.ready,
            runningAtStart: status.attributes.running,
            filesDone: after - before,
            attempts,
            renderedTwice: twice,
            maxScheduled,
          },
          waitedForQuiet: wasQuiet,
        });
        const c = concurrency.at(-1);
        log(
          `backlog, ${label}: read median ${c.read.median} / p95 ${c.read.p95} ms, ${c.pdf ? `PDF median ${c.pdf.median} / p95 ${c.pdf.p95} ms (${c.pdf.n} answered, ${c.pdfRefused} refused)` : 'no PDF reader'}, ${c.preview ? `preview median ${c.preview.median} / p95 ${c.preview.p95} ms (${c.preview.n} answered, ${c.previewRefused} refused)` : 'no preview reader'}, ${c.errorRate}% errors, ${c.backlog.filesDone} release files done meanwhile (${attempts} attempts; ${twice} files rendered more than once; at most ${maxScheduled} of a release scheduled at once)${c.load.busy ? ' (busy)' : ''}`,
        );
        if (twice > 0)
          notes.push(`backlog: ${twice} files were rendered more than once`);
        if (maxScheduled > 40)
          notes.push(
            `backlog: ${maxScheduled} files of one release were scheduled at once, past the cap of 40`,
          );
      } finally {
        clearInterval(capSampler);
        await db.end();
        await Promise.all(workers.map((w) => w.stop()));
        await api.stop();
      }
    }
  });

// -- The MCP tools -------------------------------------------------------------------------------------

if (wanted('MCP'))
  await guarded('MCP', async () => {
    const wasQuiet = await waitForQuiet(waitMs, log);
    const requireFromApi = createRequire(
      join(ROOT, 'backend', 'api', 'package.json'),
    );
    const sdk = requireFromApi.resolve(
      '@modelcontextprotocol/sdk/client/index.js',
    );
    const { Client } = await import(pathToFileURL(sdk).href);
    const { StdioClientTransport } = await import(
      pathToFileURL(
        requireFromApi.resolve('@modelcontextprotocol/sdk/client/stdio.js'),
      ).href
    );
    const server = await serverFor('mcp');
    const window = new LoadWindow();
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(ROOT, 'backend', 'mcp', 'dist', 'main.js')],
      env: {
        PATH: process.env.PATH,
        CCMS_MCP_API_URL: server.base,
        CCMS_MCP_API_TOKEN: state.agentToken,
      },
      stderr: 'ignore',
    });
    const client = new Client({ name: 'perf-scale', version: '1.0.0' });
    const results = [];
    try {
      await client.connect(transport);
      const manuals = await client.callTool({
        name: 'list_manuals',
        arguments: {},
      });
      const manualText = JSON.stringify(manuals.content);
      const manualId = /manual-\d{4}/.exec(manualText)?.[0] ?? state.bigManual;
      const variant = /model=m\d+/.exec(manualText)?.[0] ?? 'model=m100';
      const search = await client.callTool({
        name: 'search',
        arguments: { query: 'filter' },
      });
      const moduleId =
        /[a-z]+-[a-z]+-\d{5}/.exec(JSON.stringify(search.content))?.[0] ??
        state.sampleModules[0];
      const calls = [
        ['search', { query: 'replace the valve' }],
        ['search', { query: 'bearing', lang: 'de' }],
        ['read_module', { id: moduleId, lang: 'en' }],
        ['get_chunks', { lang: 'en' }],
        ['get_chunks', { manual: manualId }],
        ['list_manuals', {}],
        ['read_manual', { id: manualId, variant, lang: 'en' }],
        ['list_variants', {}],
        ['list_releases', {}],
      ];
      for (const [name, args] of calls) {
        const times = [];
        let error;
        for (let i = 0; i < 4; i++) {
          const t0 = performance.now();
          const res = await client.callTool({ name, arguments: args });
          times.push(performance.now() - t0);
          if (res.isError) error = JSON.stringify(res.content).slice(0, 300);
        }
        results.push({
          name: `MCP ${name} ${JSON.stringify(args)}`,
          times,
          error,
        });
      }
    } finally {
      await client.close().catch(() => undefined);
      await server.stop();
    }
    const load = window.close();
    for (const { name, times, error } of results) {
      rows.push({
        name,
        group: 'mcp',
        cold: stats(times.slice(0, 1)),
        first: Math.round(times[0]),
        warm: stats(times.slice(1)),
        bytes: 0,
        load,
        waitedForQuiet: wasQuiet,
        failures: error ? [error] : [],
      });
      log(
        `${name}: first ${Math.round(times[0])} ms, then median ${stats(times.slice(1)).median} ms${error ? ` ERROR ${error}` : ''}`,
      );
    }
  });

// -- Concurrency and memory ----------------------------------------------------------------------------

if (wanted('concurrency'))
  await guarded('concurrency', async () => {
    for (const readers of values.readers.split(',').map(Number)) {
      const wasQuiet = await waitForQuiet(waitMs, log);
      const server = await serverFor(`concurrency-${readers}`);
      try {
        concurrency.push({
          ...(await mix(
            server,
            readers,
            3,
            Number(values['concurrency-seconds']) * 1000,
          )),
          waitedForQuiet: wasQuiet,
        });
      } finally {
        await server.stop();
      }
      const c = concurrency.at(-1);
      log(
        `concurrency ${readers}+3: ${c.requests} requests, ${c.errorRate}% errors, read median ${c.read.median} / p95 ${c.read.p95} ms, write median ${c.write.median} ms, RSS ${Math.round(c.rss.max / 2 ** 20)} MiB max${c.load.busy ? ' (busy)' : ''}`,
      );
    }
  });

/**
 * `readers` loops reading a mix of routes as an author and a public reader would, and
 * `writers` loops saving a working copy each, for `ms`; the server's RSS sampled every second.
 */
async function mix(
  server,
  readers,
  writers,
  ms,
  { pdfPaths = [], previewPaths = [], rssOf: pids } = {},
) {
  const api = server.client;
  const modules = state.sampleModules;
  const reads = [
    (i) => `/modules?page[size]=50&page[number]=${1 + (i % 20)}`,
    (i) => `/modules/en/${modules[i % modules.length]}`,
    (i) => `/modules/en/${modules[i % modules.length]}/preview`,
    (i) => `/search?filter[q]=${['filter', 'valve', 'motor', 'cover'][i % 4]}`,
    () => '/manuals?page[size]=50',
    (i) => `/assets?page[size]=50&page[number]=${1 + (i % 10)}`,
    () => '/change-sets?page[size]=20',
    (i) => `/translations/status?page[size]=50&page[number]=${1 + (i % 5)}`,
  ];
  const readTimes = [];
  const writeTimes = [];
  const pdfTimes = [];
  let pdfRefused = 0;
  const previewTimes = [];
  let previewRefused = 0;
  let errors = 0;
  let clientErrors = 0;
  const refused = new Map();
  let requests = 0;
  const rss = [];
  const sampler = setInterval(() => {
    const v = (pids ?? [server.pid])
      .map((pid) => rssOf(pid) ?? 0)
      .reduce((a, b) => a + b, 0);
    if (v) rss.push(v);
  }, 1_000);
  // The writers' change sets: one each, holding the lock of a module nobody else holds.
  // Abandoned at the end whatever happens, so their locks never stand in a later run's way.
  const candidates = [...state.sampleModules].reverse();
  const writerSets = [];
  const created = [];
  try {
    for (let w = 0; w < writers; w++) {
      const as = state.users.author[(w + 7) % state.users.author.length];
      const cs = await api.must('POST', '/change-sets', {
        as,
        body: {
          data: {
            type: 'ChangeSet',
            attributes: { title: `Concurrency writer ${w + 1}` },
          },
        },
      });
      const id = cs.body.data.id;
      created.push({ id, as });
      let moduleId;
      while (!moduleId && candidates.length > 0) {
        const candidate = candidates.shift();
        const lock = await api.request('POST', `/change-sets/${id}/locks`, {
          as,
          body: {
            data: {
              type: 'Lock',
              attributes: {
                subject: { type: 'module', lang: 'en', moduleId: candidate },
              },
            },
          },
        });
        if (lock.status === 201) moduleId = candidate;
      }
      if (!moduleId) {
        notes.push(
          `concurrency: writer ${w + 1} found no module to lock; it writes nothing`,
        );
        continue;
      }
      const read = await api.must(
        'GET',
        `/change-sets/${id}/modules/en/${moduleId}/working-copy`,
        { as },
      );
      writerSets.push({
        as,
        id,
        moduleId,
        content: read.body.data.attributes.content,
        version: 0,
        baseCommit: read.body.data.attributes.baseCommit,
      });
    }
    return await measureMix();
  } finally {
    clearInterval(sampler);
    for (const c of created) {
      await api
        .request('POST', `/change-sets/${c.id}/abandon`, { as: c.as, body: {} })
        .catch(() => undefined);
    }
  }

  async function measureMix() {
    const window = new LoadWindow();
    const until = performance.now() + ms;
    const reader = async (r) => {
      let i = r;
      const as =
        r % 2 === 0 ? 'perf-admin' : (state.users.reader?.[0] ?? 'perf-admin');
      while (performance.now() < until) {
        const path = reads[i % reads.length](i);
        i += readers;
        try {
          const res = await api.request('GET', path, {
            as,
            headers: path.endsWith('/preview') ? { Accept: 'text/html' } : {},
          });
          // Only answered reads are read times: a refusal (403, 404) is fast and says nothing.
          if (res.status < 400) readTimes.push(res.ms);
          if (res.status >= 500) errors += 1;
          else if (res.status >= 400) {
            clientErrors += 1;
            const key = `${res.status} ${path.split('?')[0].replace(/\/[a-z]+-[a-z]+-\d{5}/, '/:id')}`;
            refused.set(key, (refused.get(key) ?? 0) + 1);
          }
        } catch {
          errors += 1;
        }
        requests += 1;
      }
    };
    const writer = async (w) => {
      let n = 0;
      while (performance.now() < until) {
        n += 1;
        const content = {
          ...w.content,
          blocks: [
            {
              type: 'paragraph',
              id: 'perf-concurrent',
              content: [
                { type: 'text', text: `Saved ${n} times while others read.` },
              ],
            },
            ...w.content.blocks,
          ],
        };
        try {
          const res = await api.request(
            'PUT',
            `/change-sets/${w.id}/modules/en/${w.moduleId}/working-copy`,
            {
              as: w.as,
              body: {
                data: { type: 'WorkingCopy', attributes: { content } },
                meta: { version: w.version, baseCommit: w.baseCommit },
              },
            },
          );
          writeTimes.push(res.ms);
          if (res.status === 200) w.version = res.body.data.attributes.version;
          else if (res.status >= 500) errors += 1;
          else clientErrors += 1;
        } catch {
          errors += 1;
        }
        requests += 1;
        await new Promise((r) => setTimeout(r, 200));
      }
    };
    // A reader asking for manuals' PDFs one after the other (interactive renders, #527), when
    // the row names some: each path once, round and round (the renderer caches what it made).
    const pdfReader = async () => {
      let i = 0;
      while (performance.now() < until && pdfPaths.length > 0) {
        const path = pdfPaths[i % pdfPaths.length];
        i += 1;
        try {
          const res = await api.request('GET', path, {
            as: 'perf-admin',
            headers: { Accept: 'application/pdf' },
            signal: AbortSignal.timeout(120_000),
          });
          if (res.status === 200) pdfTimes.push(res.ms);
          else if (res.status >= 500) errors += 1;
          else pdfRefused += 1;
        } catch {
          errors += 1;
        }
        requests += 1;
      }
    };
    // A reader looking at a manual's preview, page after page (#527): page images, each one
    // interactive render (or the renderer's cache), with a pause as a person turning pages.
    const previewReader = async () => {
      let i = 0;
      while (performance.now() < until && previewPaths.length > 0) {
        const path = previewPaths[i % previewPaths.length];
        i += 1;
        try {
          const res = await api.request('GET', path, {
            as: 'perf-admin',
            headers: { Accept: 'image/png' },
            signal: AbortSignal.timeout(120_000),
          });
          if (res.status === 200) previewTimes.push(res.ms);
          else if (res.status >= 500) errors += 1;
          else previewRefused += 1;
        } catch {
          errors += 1;
        }
        requests += 1;
        await new Promise((r) => setTimeout(r, 250));
      }
    };
    const t0 = performance.now();
    await Promise.all([
      ...Array.from({ length: readers }, (_, r) => reader(r)),
      ...writerSets.map(writer),
      pdfReader(),
      previewReader(),
    ]);
    const seconds = (performance.now() - t0) / 1000;
    clearInterval(sampler);
    return {
      name: `${readers} readers + ${writerSets.length} writers, ${Math.round(seconds)} s`,
      readers,
      writers: writerSets.length,
      requests,
      throughput: Math.round(requests / seconds),
      errorRate: requests ? Math.round((errors / requests) * 1000) / 10 : 0,
      clientErrors,
      refused: Object.fromEntries(refused),
      read: stats(readTimes),
      readP99: stats(readTimes).n
        ? [...readTimes].sort((a, b) => a - b)[
            Math.ceil(readTimes.length * 0.99) - 1
          ]
        : undefined,
      write: stats(writeTimes),
      ...(pdfPaths.length > 0 && {
        pdf: stats(pdfTimes),
        pdfRefused,
      }),
      ...(previewPaths.length > 0 && {
        preview: stats(previewTimes),
        previewRefused,
      }),
      rss: {
        start: rss[0] ?? 0,
        max: Math.max(0, ...rss),
        end: rss.at(-1) ?? 0,
      },
      load: window.close(),
    };
  }
}

// -- The report --------------------------------------------------------------------------------------

const commit = execFileSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], {
  encoding: 'utf8',
}).trim();
const dirty =
  execFileSync(
    'git',
    ['-C', ROOT, 'status', '--porcelain', '--untracked-files=no'],
    { encoding: 'utf8' },
  ).trim() !== '';
mkdirSync(paths.reports, { recursive: true });
const report = {
  kind: 'api',
  profile: values.profile,
  startedAt: startedAt.toISOString(),
  finishedAt: new Date().toISOString(),
  commit,
  dirty,
  machine: machine(),
  loadAtEnd: Math.round(load1() * 10) / 10,
  cores: CORES,
  counts: state.counts,
  seedTimings: state.timings,
  startup: {
    ...stats(startups),
    note: 'from spawning the server to GET /health/ready answering 200, every server started above',
  },
  rows,
  concurrency,
  notes,
};
const file = writeReport(paths.reports, 'api', report);
log(`report: ${file}`);
await dropAfterRun(paths.state, state, { keep: values.keep, log });
