import type { Actor } from '../src/access/core/actor.js';
import { JSON_API } from '../src/base/api/json-api.js';
import { ChunkPageDocument } from '../src/chunks/api/chunk.resources.js';
import { ModulePageDocument } from '../src/modules/api/module.resources.js';
import { ModuleSummaryPageDocument } from '../src/modules/api/module-summary.resources.js';
import { SearchPageDocument } from '../src/search/api/search.resources.js';
import { actorWith } from './fakes/actors.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * `filter[audience]` matches the level a module counts as (#699): its own,
 * or the last, most restricted level when it names none, the rule
 * resolution and the access check use (#693). On branch `draft` of the
 * sample (levels `public`, `internal`): `charging` and `safety-note` are
 * public, `internals` internal, `unlabelled` names no audience.
 */
let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t?.close());
afterEach(() => t?.actAs(undefined));

const DRAFT_READER = actorWith(['content.read', 'content.read.draft']);
const DRAFT_PUBLIC_ONLY: Actor = {
  ...actorWith(['content.read', 'content.read.draft'], {
    maxAudience: 'public',
  }),
  id: 'draft-public-only',
};

/** The module IDs (without language) one route lists for `audience`, and its total. */
const routes: Record<
  string,
  (actor: Actor, audience: string) => Promise<[string[], number]>
> = {
  '/modules': async (actor, audience) => {
    const body = ModulePageDocument.parse(
      await get(actor, `/modules?ref=draft&filter[audience]=${audience}`),
    );
    return [body.data.map((m) => m.id.split('/')[1] ?? ''), total(body)];
  },
  '/module-summaries': async (actor, audience) => {
    const body = ModuleSummaryPageDocument.parse(
      await get(
        actor,
        `/module-summaries?ref=draft&filter[audience]=${audience}`,
      ),
    );
    return [body.data.map((m) => m.id), total(body)];
  },
  '/search without a query': async (actor, audience) => {
    const body = SearchPageDocument.parse(
      await get(actor, `/search?ref=draft&filter[audience]=${audience}`),
    );
    return [
      body.data.map((h) => h.attributes.resourceId.split('/')[1] ?? ''),
      total(body),
    ];
  },
  '/search with a query': async (actor, audience) => {
    // Every sample module's text has an `e`.
    const body = SearchPageDocument.parse(
      await get(
        actor,
        `/search?ref=draft&filter[q]=e&filter[lang]=en&filter[audience]=${audience}`,
      ),
    );
    return [
      body.data.map((h) => h.attributes.resourceId.split('/')[1] ?? ''),
      total(body),
    ];
  },
  '/chunks': async (actor, audience) => {
    const body = ChunkPageDocument.parse(
      await get(actor, `/chunks?ref=draft&filter[audience]=${audience}`),
    );
    return [
      body.data
        .filter((c) => c.attributes.entry === undefined)
        .map((c) => c.attributes.moduleId),
      total(body),
    ];
  },
};

async function get(actor: Actor, path: string): Promise<unknown> {
  t.actAs(actor);
  const res = await t.get(path);
  expect([path, res.status]).toEqual([path, 200]);
  expect(res.headers['content-type']).toBe(JSON_API);
  return res.body;
}

const total = (body: { meta: { page: { total: number } } }) =>
  body.meta.page.total;

const unique = (ids: string[]) => [...new Set(ids)].sort();

describe.each(Object.keys(routes))('filter[audience] on %s', (route) => {
  const list = routes[route] as (typeof routes)[string];

  it('by the last level includes the modules that name no audience', async () => {
    const [ids] = await list(DRAFT_READER, 'internal');
    expect(unique(ids)).toEqual(['internals', 'unlabelled']);
  });

  it('by another level leaves them out', async () => {
    const [ids] = await list(DRAFT_READER, 'public');
    expect(unique(ids)).not.toContain('unlabelled');
    expect(unique(ids)).not.toContain('internals');
    expect(unique(ids)).toContain('charging');
  });

  it('never reaches past the reader’s scope: the last level finds nothing for a public-only reader', async () => {
    expect(await list(DRAFT_PUBLIC_ONLY, 'internal')).toEqual([[], 0]);
    const [ids] = await list(DRAFT_PUBLIC_ONLY, 'public');
    expect(unique(ids)).not.toContain('unlabelled');
  });

  it('matches nothing for a level the configuration does not list', async () => {
    expect(await list(DRAFT_READER, 'nobody')).toEqual([[], 0]);
  });
});
