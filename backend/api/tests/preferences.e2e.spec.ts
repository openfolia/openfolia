import type { Actor } from '../src/access/core/actor.js';
import { Seed, seedAccess } from '../src/access/repos/seed.js';
import { ErrorDocument } from '../src/base/api/json-api.js';
import { PreferencesDocument } from '../src/preferences/api/preferences.resources.js';
import { actorWith } from './fakes/actors.js';
import { createTestApp, type TestApp } from './test-app.js';

/** Each person's own preferences (#222): `GET` and `PATCH /me/preferences`. */

const alice: Actor = { ...actorWith(['content.read']), id: 'pref-alice' };
const bob: Actor = { ...actorWith(['content.edit']), id: 'pref-bob' };

let t: TestApp;
const errors = (body: unknown) => ErrorDocument.parse(body).errors;

beforeAll(async () => {
  t = await createTestApp();
  await seedAccess(
    t.database,
    Seed.parse({
      roles: [
        {
          id: 'pref-reader',
          name: 'Reader',
          permissions: ['content.read'],
          scope: {},
        },
      ],
      users: [alice, bob].map((a) => ({
        id: a.id,
        name: a.id,
        roles: ['pref-reader'],
      })),
    }),
  );
});
afterAll(() => t?.close());
afterEach(() => t?.actAs(undefined));

const patch = (attributes: Record<string, unknown>, id?: string) =>
  t.patch('/me/preferences').send(
    JSON.stringify({
      data: { type: 'Preferences', ...(id && { id }), attributes },
    }),
  );

describe('/me/preferences', () => {
  it('answers the defaults until a change, then what changed; never cached', async () => {
    t.actAs(alice);
    const before = await t.get('/me/preferences');
    expect(before.status).toBe(200);
    expect(before.headers['cache-control']).toBe('private, no-store');
    expect(PreferencesDocument.parse(before.body)).toEqual({
      data: {
        type: 'Preferences',
        id: 'pref-alice',
        attributes: { showTips: true, dismissedTips: [], tourDone: false },
        meta: { updatedAt: null },
      },
    });

    const changed = await patch(
      { tourDone: true, dismissedTips: ['content.new-module', 'shell.search'] },
      'pref-alice',
    );
    expect(changed.status).toBe(200);
    const doc = PreferencesDocument.parse(changed.body);
    expect(doc.data.attributes).toEqual({
      showTips: true,
      dismissedTips: ['content.new-module', 'shell.search'],
      tourDone: true,
    });
    expect(doc.data.meta.updatedAt).not.toBeNull();

    // Left out stays.
    const off = await patch({ showTips: false });
    expect(PreferencesDocument.parse(off.body).data.attributes).toEqual({
      showTips: false,
      dismissedTips: ['content.new-module', 'shell.search'],
      tourDone: true,
    });
    const read = await t.get('/me/preferences');
    expect(PreferencesDocument.parse(read.body).data.attributes.showTips).toBe(
      false,
    );
  });

  it('keeps each person’s own', async () => {
    t.actAs(bob);
    await patch({ dismissedTips: ['review.submit'] });
    t.actAs(alice);
    const theirs = PreferencesDocument.parse(
      (await t.get('/me/preferences')).body,
    ).data;
    expect(theirs.id).toBe('pref-alice');
    expect(theirs.attributes.dismissedTips).not.toContain('review.submit');
    // Naming another person's ID changes nothing of theirs.
    const other = await patch({ showTips: true }, 'pref-bob');
    expect(other.status).toBe(409);
    expect(errors(other.body)[0]?.code).toBe('id-mismatch');
  });

  it('refuses what is no preferences document', async () => {
    t.actAs(alice);
    for (const attributes of [
      { colour: 'red' },
      { dismissedTips: ['Not A Tip'] },
      { dismissedTips: Array.from({ length: 501 }, (_, i) => `tip-${i}`) },
      { showTips: 'yes' },
    ]) {
      const res = await patch(attributes);
      expect(res.status, JSON.stringify(attributes)).toBe(400);
    }
    const wrongType = await t
      .patch('/me/preferences')
      .send(JSON.stringify({ data: { type: 'User', attributes: {} } }));
    expect(wrongType.status).toBe(400);
  });

  it('gives a service the defaults and refuses its change', async () => {
    // No actor set: the API token's read-only service.
    const read = await t.get('/me/preferences');
    expect(read.status).toBe(200);
    expect(PreferencesDocument.parse(read.body).data).toMatchObject({
      id: 'service',
      attributes: { showTips: true, dismissedTips: [], tourDone: false },
    });
    const res = await patch({ showTips: false });
    expect(res.status).toBe(403);
    expect(errors(res.body)[0]?.code).toBe('forbidden');
  });

  it('needs an actor', async () => {
    const res = await t.anonymous().get('/me/preferences');
    expect(res.status).toBe(401);
  });
});
