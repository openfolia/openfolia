import type { Actor } from '../src/access/core/actor.js';
import type { Permission } from '../src/access/core/permissions.js';
import { ErrorDocument } from '../src/base/api/json-api.js';
import {
  ReleaseDetailDocument,
  ReleaseDocument,
} from '../src/releases/api/release.resources.js';
import { actorWith, READER } from './fakes/actors.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * #477: a release of more outputs than `CCMS_RELEASE_MAX_OUTPUTS` gets
 * none, and says so: in its `meta.outputs` and in the answer of planning
 * it again. The sample content's first release has 9 outputs; the limit
 * here is 2.
 */
const user = (id: string, permissions: Permission[]): Actor => ({
  ...actorWith(permissions),
  id,
});
const publisher = user('sample-publisher', ['content.read', 'release.publish']);

let t: TestApp;

beforeAll(async () => {
  t = await createTestApp({ CCMS_RELEASE_MAX_OUTPUTS: '2' });
});
afterAll(() => t?.close());
afterEach(() => t?.actAs(undefined));

const progress = async (id: string, as: Actor) => {
  t.actAs(as);
  const res = await t.get(`/releases/${id}`);
  expect(res.status).toBe(200);
  return ReleaseDetailDocument.parse(res.body).data.meta.outputs;
};

describe('a release over the limit of outputs', () => {
  it('plans none, is failed with the reason, and planning it again is 422 too-many-outputs', async () => {
    t.actAs(publisher);
    const created = await t.post('/releases').send(
      JSON.stringify({
        data: {
          type: 'Release',
          attributes: { product: 'north', revision: '1.0' },
        },
      }),
    );
    expect(created.status).toBe(201);
    const release = ReleaseDocument.parse(created.body).data;
    await t.runJobs();

    expect(await progress(release.id, publisher)).toEqual({
      state: 'failed',
      total: 0,
      queued: 0,
      rendering: 0,
      done: 0,
      failed: 0,
      refused: { reason: 'too-many-outputs', wanted: 9, max: 2 },
      queue: null,
    });
    // A reader is not told how many manuals the tag holds.
    expect((await progress(release.id, READER))?.refused).toEqual({
      reason: 'too-many-outputs',
      wanted: null,
      max: 2,
    });

    t.actAs(publisher);
    const outputs = await t.get(`/releases/${release.id}/outputs`);
    expect(outputs.body.meta.page.total).toBe(0);

    const replan = await t.post(`/releases/${release.id}/outputs/plan`).send();
    expect(replan.status).toBe(422);
    const error = ErrorDocument.parse(replan.body).errors[0];
    expect(error).toMatchObject({
      status: '422',
      code: 'too-many-outputs',
      meta: { wanted: 9, max: 2 },
    });
    // Nothing was queued: still refused, nothing planning.
    expect((await progress(release.id, publisher))?.state).toBe('failed');
  });
});
