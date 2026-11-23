import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Actor } from '../src/access/core/actor.js';
import { DownloadVersionPageDocument } from '../src/downloads/api/download.resources.js';
import { actorWith, READER } from './fakes/actors.js';
import { manyReleases, sheetOf } from './download-releases.js';
import { createTestApp, type TestApp } from './test-app.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

/**
 * The cold work of a download's versions is bounded (#764): its releases' tags are resolved
 * from one ref listing, never a listing per release (#139's, shared only while one was under
 * way: five for 40 releases on a quiet run, more the slower git answers). Every git process the app starts is counted through a `git` on `PATH` that logs
 * its subcommand before running the real one, as `writer-processes.spec.ts` counts the
 * writer's.
 */
const bin = mkdtempSync(join(tmpdir(), 'openfolia-count-git-'));
const log = join(bin, 'log');
const realGit = execFileSync('/bin/sh', ['-c', 'command -v git'], {
  encoding: 'utf8',
}).trim();
writeFileSync(log, '');
writeFileSync(
  join(bin, 'git'),
  // The subcommand (past `-C <dir>` and `-c key=value`), one line, one write.
  [
    '#!/bin/sh',
    'sub=""; skip=0',
    'for a in "$@"; do',
    '  if [ "$skip" = 1 ]; then skip=0; continue; fi',
    '  case "$a" in -C|-c) skip=1 ;; -*) ;; *) sub="$a"; break ;; esac',
    'done',
    `printf '%s\\n' "$sub" >> '${log}'`,
    `exec '${realGit}' "$@"`,
    '',
  ].join('\n'),
);
chmodSync(join(bin, 'git'), 0o755);
const path = process.env['PATH'];

/** The git subcommands started since last asked. */
const started = (): string[] => {
  const lines = readFileSync(log, 'utf8').split('\n').filter(Boolean);
  writeFileSync(log, '');
  return lines;
};

const publicReader: Actor = {
  ...actorWith(['content.read'], { maxAudience: 'public' }),
  id: 'public-reader',
};

let t: TestApp;
beforeAll(async () => {
  // Before the app: its git reader takes the environment when it is made.
  process.env['PATH'] = `${bin}:${path}`;
  // `api`: no background loop starts a git process in a counted window.
  t = await createTestApp({ CCMS_ROLE: 'api' });
  // 40 releases of north, the sheet changing every 10; internal in the first 20.
  await manyReleases(t, 'north', 40, {
    changeEvery: 10,
    audience: (i) => (i < 20 ? 'internal' : 'public'),
  });
  await manyReleases(t, 'south', 5);
});
afterAll(async () => {
  await t?.close();
  process.env['PATH'] = path;
  rmSync(bin, { recursive: true, force: true });
});

const versions = async (id: string, as: Actor) => {
  t.actAs(as);
  return t.get(`/downloads/${encodeURIComponent(id)}/versions`);
};

it('reads a download’s versions over 40 releases with a fixed number of git processes, scoped to the reader', async () => {
  // Warms what every request starts (the file reader): a list.
  t.actAs(READER);
  expect((await t.get('/downloads?filter[product]=south')).status).toBe(200);
  started();

  const all = await versions(sheetOf('north'), READER);
  expect(all.status).toBe(200);
  const cold = started();
  // One ref listing for the latest release, one for all the others: whatever their number.
  expect(cold.filter((c) => c !== 'for-each-ref')).toEqual([]);
  expect(cold.length).toBeLessThanOrEqual(2);
  const doc = DownloadVersionPageDocument.parse(all.body);
  expect(
    doc.data.map((v) => [v.attributes.release.revision, v.attributes.state]),
  ).toEqual([
    ['r30', 'current'],
    ['r20', 'superseded'],
    ['r10', 'superseded'],
    ['r0', 'superseded'],
  ]);

  // A reader of public content only: never a version from a release where it was internal.
  const seen = await versions(sheetOf('north'), publicReader);
  expect(started().length).toBeLessThanOrEqual(2);
  expect(
    DownloadVersionPageDocument.parse(seen.body).data.map(
      (v) => v.attributes.release.revision,
    ),
  ).toEqual(['r30', 'r20']);

  // Warm: nothing read again.
  expect((await versions(sheetOf('north'), READER)).status).toBe(200);
  expect(started()).toEqual([]);

  // An ID naming nothing at the latest release: 404 after the latest release's tag alone.
  for (const id of [
    'attachment:north:datasheet:nope:en',
    'attachment:north:invented:sheet:en',
  ]) {
    expect((await versions(id, READER)).status).toBe(404);
    expect(started().length).toBeLessThanOrEqual(1);
  }
});
