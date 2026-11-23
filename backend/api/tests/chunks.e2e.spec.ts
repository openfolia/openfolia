import type { z } from 'zod';
import type { Actor } from '../src/access/core/actor.js';
import { ErrorDocument, JSON_API } from '../src/base/api/json-api.js';
import { ChunkPageDocument } from '../src/chunks/api/chunk.resources.js';
import { actorWith, READER } from './fakes/actors.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * `GET /chunks` over the sample repository: on `main`, `en/charging` and
 * `de/charging` (public, both include `safety-note`, a caution), the
 * `en/safety-note` (public), `en/internals` (internal); the operating manual
 * (public: charging, internals) and the service manual (internal:
 * internals, charging). Tag `v1` is the first commit; `main` changed
 * `en/charging` since. Branch `draft` adds `en/unlabelled` (no audience).
 */
let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t?.close());
afterEach(() => t?.actAs(undefined));

const DRAFT_READER = actorWith(['content.read', 'content.read.draft']);
const PUBLIC_ONLY: Actor = {
  ...actorWith(['content.read'], { maxAudience: 'public' }),
  id: 'public-only',
};

type Page = z.infer<typeof ChunkPageDocument>;

async function chunks(actor: Actor, query = ''): Promise<Page> {
  t.actAs(actor);
  const path = `/chunks${query}`;
  const res = await t.get(path);
  expect([path, res.status]).toEqual([path, 200]);
  expect(res.headers['content-type']).toBe(JSON_API);
  return ChunkPageDocument.parse(res.body);
}

const ids = (page: Page) => page.data.map((chunk) => chunk.id);
const errors = (body: unknown) => ErrorDocument.parse(body).errors;

describe('GET /chunks', () => {
  it('lists one chunk per module and language, as Markdown with its metadata', async () => {
    const page = await chunks(READER);
    expect(ids(page)).toEqual([
      'de/charging',
      'en/charging',
      'en/internals',
      'en/safety-note',
    ]);
    expect(page.meta.page.total).toBe(4);
    const charging = page.data[1];
    const text = [
      '# Charging',
      'The {product-name} charges automatically.',
      '> **CAUTION:** Hot surface\n>\n> Let it cool down.',
      '*Figure:* The charger',
    ].join('\n\n');
    expect(charging).toEqual({
      type: 'Chunk',
      id: 'en/charging',
      attributes: {
        moduleId: 'charging',
        lang: 'en',
        title: 'Charging',
        moduleType: 'procedure',
        audience: 'public',
        facets: {},
        keywords: ['maintenance', 'battery'],
        manuals: ['operating', 'service'],
        conditions: [],
        text,
        sourceHash: expect.stringMatching(/^[0-9a-f]{64}$/),
        contentHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
      relationships: {
        module: {
          data: { type: 'Module', id: 'en/charging' },
          links: { related: `/modules/en/charging?ref=${t.commits.main}` },
        },
      },
      meta: {
        ref: 'main',
        commit: t.commits.main,
        sources: [
          { moduleId: 'charging', lang: 'en' },
          { moduleId: 'safety-note', lang: 'en' },
        ],
        // Changed on `main` since the release.
        release: { tag: 'v1', commit: t.commits.v1, same: false },
      },
    });
    // The German module includes the English safety note (no translation) and its labels are German.
    expect(page.data[0]?.attributes.text).toBe(
      [
        '# Laden',
        'Das {product-name} lädt sich selbst.',
        '> **VORSICHT:** Hot surface\n>\n> Let it cool down.',
        '*Abbildung:* The charger',
      ].join('\n\n'),
    );
    expect(page.data[3]?.meta.release).toEqual({
      tag: 'v1',
      commit: t.commits.v1,
      same: true,
    });
    // Within their audience only: the public manual names `internals` but leaves it out.
    expect(page.data[2]?.attributes.manuals).toEqual(['service']);
    expect(page.data[3]?.attributes.manuals).toEqual([]);
  });

  it('gives a reader limited to a lower audience no chunk above it, and does not count it', async () => {
    const page = await chunks(PUBLIC_ONLY);
    expect(ids(page)).toEqual(['de/charging', 'en/charging', 'en/safety-note']);
    expect(page.meta.page.total).toBe(3);
    expect(JSON.stringify(page)).not.toContain('Internal only.');
    // The internal service manual is not theirs to see either.
    expect(page.data[1]?.attributes.manuals).toEqual(['operating']);
    // Filtering for what lies outside the scope finds nothing, as for what does not exist.
    const internal = await chunks(PUBLIC_ONLY, '?filter[audience]=internal');
    expect(internal.meta.page.total).toBe(0);
    const service = await chunks(PUBLIC_ONLY, '?filter[manual]=service');
    expect(service.meta.page.total).toBe(0);
    const byModule = await chunks(PUBLIC_ONLY, '?filter[module]=internals');
    expect(byModule.meta.page.total).toBe(0);
    // A wider reader on the same commit gets its own answer, not the narrow one cached.
    expect((await chunks(READER)).meta.page.total).toBe(4);
  });

  it('filters before paging and pages like every list', async () => {
    expect(ids(await chunks(READER, '?filter[lang]=de'))).toEqual([
      'de/charging',
    ]);
    expect(ids(await chunks(READER, '?filter[module]=charging'))).toEqual([
      'de/charging',
      'en/charging',
    ]);
    expect(
      ids(await chunks(READER, '?filter[module]=charging&filter[lang]=en')),
    ).toEqual(['en/charging']);
    expect(ids(await chunks(READER, '?filter[type]=concept'))).toEqual([
      'en/internals',
      'en/safety-note',
    ]);
    expect(ids(await chunks(READER, '?filter[facet]=region:north'))).toEqual([
      'en/safety-note',
    ]);
    expect(ids(await chunks(READER, '?filter[keyword]=Akku'))).toEqual([
      'de/charging',
    ]);
    expect(ids(await chunks(READER, '?filter[manual]=operating'))).toEqual([
      'de/charging',
      'en/charging',
    ]);
    const second = await chunks(READER, '?page[number]=2&page[size]=3');
    expect(ids(second)).toEqual(['en/safety-note']);
    expect(second.meta.page).toEqual({
      currentPage: 2,
      lastPage: 2,
      perPage: 3,
      total: 4,
    });
    expect(second.links.prev).toContain('page%5Bnumber%5D=1');
  });

  it('resolves for a variant, and refuses one the configuration does not hold', async () => {
    const page = await chunks(READER, '?filter[variant]=model%3Dlarge');
    expect(page.meta.page.total).toBe(4);
    t.actAs(READER);
    const unknown = await t.get('/chunks?filter[variant]=model%3Dhuge');
    expect(unknown.status).toBe(422);
    expect(errors(unknown.body)[0]?.code).toBe('unknown-variant');
    const malformed = await t.get('/chunks?filter[variant]=large');
    expect(malformed.status).toBe(400);
    expect(errors(malformed.body)[0]?.source?.parameter).toBe(
      'filter[variant]',
    );
  });

  it('lists only what changed since a commit in the history, for incremental syncs', async () => {
    const changed = await chunks(
      READER,
      `?filter[changedSince]=${t.commits.v1}`,
    );
    expect(ids(changed)).toEqual(['en/charging']);
    expect(changed.meta.page.total).toBe(1);
    const none = await chunks(
      READER,
      `?filter[changedSince]=${t.commits.main}`,
    );
    expect(none.meta.page.total).toBe(0);

    t.actAs(READER);
    // A draft commit not merged into `main` is not in its history: nothing is told about it.
    for (const since of [
      t.commits.draft,
      '0'.repeat(40),
      '0'.repeat(64),
      'main',
    ]) {
      const res = await t.get(`/chunks?filter[changedSince]=${since}`);
      expect([since, res.status]).toEqual([since, 400]);
      expect(errors(res.body)[0]).toMatchObject({
        code: 'invalid-parameter',
        source: { parameter: 'filter[changedSince]' },
      });
    }
  });

  it('reads drafts only for a reader who may: never for a consumer of released content', async () => {
    t.actAs(READER);
    expect((await t.get('/chunks?ref=draft')).status).toBe(404);
    expect((await t.get(`/chunks?ref=${t.commits.draft}`)).status).toBe(404);
    const draft = await chunks(DRAFT_READER, '?ref=draft');
    expect(ids(draft)).toContain('en/unlabelled');
    expect(draft.data[0]?.meta.ref).toBe('draft');
    expect(ids(await chunks(READER))).not.toContain('en/unlabelled');
  });

  it('revalidates with an ETag that depends on the reader, and refuses unknown parameters', async () => {
    t.actAs(READER);
    const first = await t.get('/chunks');
    expect(first.headers['x-ccms-commit']).toBe(t.commits.main);
    const etag = first.headers['etag'] as string;
    expect((await t.get('/chunks').set('If-None-Match', etag)).status).toBe(
      304,
    );
    t.actAs(PUBLIC_ONLY);
    expect((await t.get('/chunks').set('If-None-Match', etag)).status).toBe(
      200,
    );
    const unknown = await t.get('/chunks?filter[nope]=1');
    expect(unknown.status).toBe(400);
  });

  it('refuses an actor without content.read', async () => {
    t.actAs(actorWith([]));
    const res = await t.get('/chunks');
    expect(res.status).toBe(403);
    expect(errors(res.body)[0]?.code).toBe('forbidden');
  });
});
