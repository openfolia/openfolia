import { DownloadVersionPageDocument } from '../../src/downloads/api/download.resources.js';
import { READER } from '../fakes/actors.js';
import { manyReleases, sheetOf } from '../download-releases.js';
import { createTestApp, type TestApp } from '../test-app.js';
import { expectWithin } from './budget.js';

/**
 * #764's acceptance criterion: a download's versions across 300 releases, cold, in under 2 s
 * (#139's walk took 18.5 s there). The releases are made in one `git fast-import`
 * (`manyReleases`), the attachment changing every 20. Run by `api:perf`, never in the default
 * suite.
 */
vi.setConfig({ testTimeout: 240_000, hookTimeout: 240_000 });

let t: TestApp;

beforeAll(async () => {
  t = await createTestApp();
  // South's 60 releases first, then north's 300, on the same line.
  await manyReleases(t, 'south', 60);
  await manyReleases(t, 'north', 300);
});
afterAll(() => t?.close());

const versions = async (product: string) => {
  t.actAs(READER);
  const started = performance.now();
  const res = await t.get(
    `/downloads/${encodeURIComponent(sheetOf(product))}/versions`,
  );
  const took = performance.now() - started;
  expect(res.status).toBe(200);
  return { took, doc: DownloadVersionPageDocument.parse(res.body) };
};

it('lists a download’s versions across 60 and 300 releases, cold, in under 2 s', async () => {
  // The first request of a process pays for loading code: a list, which reads one tag.
  t.actAs(READER);
  expect((await t.get('/downloads?filter[product]=north')).status).toBe(200);

  const south = await versions('south');
  expect(south.doc.meta.page.total).toBe(3);
  expectWithin('download versions, cold, 60 releases', south.took, 2000);
  const southWarm = await versions('south');
  expectWithin('download versions, warm, 60 releases', southWarm.took, 300);

  const north = await versions('north');
  expect(north.doc.meta.page.total).toBe(15);
  expect(north.doc.data[0]?.attributes.state).toBe('current');
  expectWithin('download versions, cold, 300 releases', north.took, 2000);
  const northWarm = await versions('north');
  expectWithin('download versions, warm, 300 releases', northWarm.took, 300);
});
