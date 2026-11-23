import type { Module } from '@openfolia/content-model';
import type { z } from 'zod';
import type { Actor } from '../src/access/core/actor.js';
import { ErrorDocument, JSON_API } from '../src/base/api/json-api.js';
import { ChangeSetDocument } from '../src/change-sets/api/change-set.resources.js';
import { CommitDocument } from '../src/change-sets/api/commit.resources.js';
import { ModuleWorkingCopyDocument } from '../src/change-sets/api/working-copy.resources.js';
import { SearchPageDocument } from '../src/search/api/search.resources.js';
import { actorWith, READER } from './fakes/actors.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * `GET /search` over the sample repository: on `main`, `en/charging`
 * (title "Charging", text "The charges automatically.", an image with alt
 * "The charger"), `de/charging` ("Laden"), `en/safety-note` (public),
 * `en/internals` (internal) and the manual "Operating manual" (public).
 * Keywords: `en/charging` "maintenance", "battery"; `de/charging` "Wartung",
 * "Akku"; `en/internals` "maintenance", "internal wiring".
 * Branch `draft` adds `en/unlabelled` (no audience).
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

const q = (query: string, extra = '') =>
  `/search?filter[q]=${encodeURIComponent(query)}${extra}`;

type Page = z.infer<typeof SearchPageDocument>;

async function found(actor: Actor, path: string): Promise<Page> {
  t.actAs(actor);
  const res = await t.get(path);
  expect([path, res.status]).toEqual([path, 200]);
  expect(res.headers['content-type']).toBe(JSON_API);
  return SearchPageDocument.parse(res.body);
}

const ids = (page: Page) => page.data.map((hit) => hit.attributes.resourceId);
const errors = (body: unknown) => ErrorDocument.parse(body).errors;

describe('GET /search', () => {
  it('finds a module by text, with its block and an excerpt that is plain text with offsets', async () => {
    const page = await found(READER, q('AUTOMATICALLY'));
    expect(page.data).toEqual([
      {
        type: 'SearchResult',
        id: 'module:en/charging',
        attributes: {
          resourceType: 'Module',
          resourceId: 'en/charging',
          lang: 'en',
          title: 'Charging',
          blockId: 'intro',
        },
        relationships: {
          resource: { data: { type: 'Module', id: 'en/charging' } },
        },
        meta: {
          matchedOn: 'text',
          deprecated: false,
          excerpt: 'The charges automatically.',
          matches: [{ start: 12, end: 25 }],
        },
      },
    ]);
    expect(page.meta.page.total).toBe(1);
    expect(page.links.self).toContain('filter%5Bq%5D=AUTOMATICALLY');
  });

  it('finds modules and manuals by title, ignoring case and diacritics, title matches first', async () => {
    expect(ids(await found(READER, q('LADEN')))).toEqual(['de/charging']);
    expect(ids(await found(READER, q('operating')))).toEqual(['operating']);
    const both = await found(READER, q('charg'));
    // Titles first (Charging, de has "lädt" which is no match), then text.
    expect(both.data.map((h) => h.meta.matchedOn)).toEqual(['title', 'text']);
    expect(ids(both)).toEqual(['en/charging', 'de/charging']);
    const manual = (await found(READER, q('operating'))).data[0];
    expect(manual?.attributes).toEqual({
      resourceType: 'Manual',
      resourceId: 'operating',
      title: 'Operating manual',
    });
  });

  it('matches German text without diacritics (ä as a)', async () => {
    const page = await found(READER, q('ladt sich'));
    expect(page.data[0]?.attributes).toMatchObject({
      resourceId: 'de/charging',
      lang: 'de',
      blockId: 'intro',
    });
  });

  it('filters by language and by type, and pages with a total over all pages', async () => {
    expect(ids(await found(READER, q('charg', '&filter[lang]=de')))).toEqual([
      'de/charging',
    ]);
    expect(
      ids(await found(READER, q('operating', '&filter[type]=module'))),
    ).toEqual([]);
    const first = await found(READER, q('e', '&page[size]=2'));
    expect(first.data).toHaveLength(2);
    expect(first.meta.page.total).toBeGreaterThan(2);
    expect(first.links.next).not.toBeNull();
  });

  it('answers 400 for an empty, blank, missing, repeated or overlong query and unsupported parameters', async () => {
    t.actAs(READER);
    const bad = [
      '/search',
      '/search?filter[q]=',
      '/search?filter[q]=%20%20',
      `/search?filter[q]=${'a'.repeat(201)}`,
      '/search?filter[q]=a&filter[q]=b',
      '/search?filter[q]=a&filter[x]=b',
      '/search?filter[q]=a&q=b',
      '/search?filter[q]=a&filter[resourceType]=block',
      '/search?filter[q]=a&filter[type]=Block',
      '/search?filter[q]=a&filter[lang]=not%20a%20tag',
      '/search?filter[q]=a&page[size]=0',
      '/search?filter[q]=a&sort=title',
    ];
    for (const path of bad) {
      const res = await t.get(path);
      expect([path, res.status]).toEqual([path, 400]);
      expect(errors(res.body)[0]?.code).toMatch(
        /^(invalid-parameter|unsupported-parameter)$/,
      );
    }
    const longest = await t.get(`/search?filter[q]=${'a'.repeat(200)}`);
    expect(longest.status).toBe(200);
  });

  it('filters by resource type, and by the deprecated filter[type]=module|manual', async () => {
    for (const filter of [
      '&filter[resourceType]=Manual',
      '&filter[resourceType]=manual',
      '&filter[type]=manual',
    ]) {
      expect(ids(await found(READER, q('o', filter)))).toEqual(['operating']);
    }
    for (const filter of [
      '&filter[resourceType]=Module',
      '&filter[type]=module',
    ]) {
      const page = await found(READER, q('operating', filter));
      expect(page.data).toEqual([]);
    }
    // With filter[resourceType], filter[type] is always a module type.
    expect(
      ids(
        await found(
          READER,
          q('charg', '&filter[resourceType]=module&filter[type]=module'),
        ),
      ),
    ).toEqual([]);
  });

  it('finds a keyword by filter[q] (between titles and text) and by filter[keyword]', async () => {
    const page = await found(READER, q('maint', '&filter[lang]=en'));
    // Both by keyword; which first is the adapter's ranking (#54).
    expect(
      page.data.map((h) => [h.attributes.resourceId, h.meta.matchedOn]).sort(),
    ).toEqual([
      ['en/charging', 'keyword'],
      ['en/internals', 'keyword'],
    ]);
    expect(
      page.data.find((h) => h.attributes.resourceId === 'en/charging')?.meta,
    ).toEqual({
      matchedOn: 'keyword',
      deprecated: false,
      excerpt: 'maintenance',
      matches: [{ start: 0, end: 5 }],
    });
    const byKeyword = await found(
      READER,
      '/search?filter[keyword]=Maintenance',
    );
    expect(ids(byKeyword)).toEqual(['en/charging', 'en/internals']);
    expect(byKeyword.data[0]?.meta).toEqual({
      matchedOn: 'filter',
      deprecated: false,
      excerpt: 'Charging',
      matches: [],
    });
    // Exact, case and diacritics aside, every keyword given.
    expect(ids(await found(READER, '/search?filter[keyword]=maint'))).toEqual(
      [],
    );
    expect(
      ids(
        await found(
          READER,
          '/search?filter[keyword]=maintenance&filter[keyword]=BATTERY',
        ),
      ),
    ).toEqual(['en/charging']);
    expect(
      ids(await found(READER, q('charg', '&filter[keyword]=wartung'))),
    ).toEqual(['de/charging']);
  });

  it('combines type, audience and facet filters, and leaves manuals out', async () => {
    const all =
      '&filter[type]=concept&filter[audience]=public&filter[facet]=region:north';
    expect(ids(await found(READER, `/search?${all.slice(1)}`))).toEqual([
      'en/safety-note',
    ]);
    expect(
      ids(await found(READER, q('o', '&filter[audience]=public'))),
    ).not.toContain('operating');
    expect(
      ids(
        await found(
          READER,
          '/search?filter[facet]=region:north&filter[facet]=region:south',
        ),
      ),
    ).toEqual([]);
    // A type nobody configured is no error: it finds nothing.
    expect(
      (await found(READER, '/search?filter[type]=no-such-type')).meta.page
        .total,
    ).toBe(0);
  });

  it('answers 400 for no query and no module filter, and for malformed filters', async () => {
    t.actAs(READER);
    const bad = [
      '/search',
      '/search?filter[lang]=en',
      '/search?filter[resourceType]=module',
      '/search?filter[keyword]=a,b',
      '/search?filter[keyword]=',
      `/search?filter[keyword]=${'k'.repeat(65)}`,
      `/search?${Array.from({ length: 33 }, (_, i) => `filter[keyword]=k${i}`).join('&')}`,
      '/search?filter[facet]=region',
      '/search?filter[facet]=region:north&filter[facet]=Region:x',
      '/search?filter[audience]=Public',
    ];
    for (const path of bad) {
      const res = await t.get(path);
      expect([path, res.status]).toEqual([path, 400]);
      expect(errors(res.body)[0]?.code).toBe('invalid-parameter');
    }
    const most = Array.from(
      { length: 32 },
      (_, i) => `filter[keyword]=k${i}`,
    ).join('&');
    expect((await t.get(`/search?${most}`)).status).toBe(200);
  });

  it('needs content.read', async () => {
    t.actAs(actorWith([]));
    expect((await t.get(q('charging'))).status).toBe(403);
  });
});

describe('scope', () => {
  it('never returns, and never counts, what the reader may not see', async () => {
    // `en/internals` (audience internal) matches by title and by text.
    expect(ids(await found(READER, q('internal')))).toEqual(['en/internals']);
    const hidden = await found(PUBLIC_ONLY, q('internal'));
    const nothing = await found(PUBLIC_ONLY, q('zzzzzz'));
    expect(hidden.data).toEqual([]);
    expect(hidden.meta.page).toEqual(nothing.meta.page);
    expect(JSON.stringify(hidden)).not.toMatch(/internals|Internal only/);
    // Counts: the same query, wide and narrow.
    const wide = await found(READER, q('e', '&page[size]=200'));
    const narrow = await found(PUBLIC_ONLY, q('e', '&page[size]=200'));
    expect(wide.data.length).toBe(wide.meta.page.total);
    // The internal module and the internal service manual.
    expect(ids(wide)).toContain('en/internals');
    expect(ids(wide)).toContain('service');
    expect(narrow.meta.page.total).toBe(narrow.data.length);
    expect(ids(narrow)).not.toContain('en/internals');
    expect(ids(narrow)).not.toContain('service');
    expect(narrow.meta.page.total).toBe(wide.meta.page.total - 2);
    // Paging does not reveal it either.
    const paged = await found(PUBLIC_ONLY, q('e', '&page[size]=1'));
    expect(paged.meta.page).toMatchObject({
      total: narrow.meta.page.total,
      lastPage: narrow.meta.page.total,
    });
  });

  it('filters only within the scope: what lies outside it looks like nothing at all', async () => {
    // Both readers ask for what `en/internals` (internal) has.
    const keyword = '/search?filter[keyword]=maintenance';
    expect(ids(await found(READER, keyword))).toEqual([
      'en/charging',
      'en/internals',
    ]);
    const narrow = await found(PUBLIC_ONLY, keyword);
    expect(ids(narrow)).toEqual(['en/charging']);
    expect(narrow.meta.page.total).toBe(1);
    const outside = [
      '/search?filter[keyword]=internal%20wiring',
      '/search?filter[audience]=internal',
      q('wiring'),
    ];
    const none = await found(PUBLIC_ONLY, '/search?filter[keyword]=no-such');
    for (const path of outside) {
      const page = await found(PUBLIC_ONLY, path);
      expect([path, page.data, page.meta.page]).toEqual([
        path,
        [],
        none.meta.page,
      ]);
      expect(JSON.stringify(page.data)).not.toMatch(/internals|Internal/);
    }
    expect(
      ids(await found(READER, '/search?filter[audience]=internal')),
    ).toEqual(['en/internals']);
  });

  it('keeps one reader’s results from another, on the same commit', async () => {
    const wide = await found(READER, q('internal'));
    const narrow = await found(PUBLIC_ONLY, q('internal'));
    const again = await found(READER, q('internal'));
    expect([ids(wide), ids(narrow), ids(again)]).toEqual([
      ['en/internals'],
      [],
      ['en/internals'],
    ]);
  });

  it('finds a language only for a reader whose scope has it', async () => {
    const germanOnly: Actor = {
      ...actorWith(['content.read'], { languages: ['de'] }),
      id: 'german-only',
    };
    expect(ids(await found(germanOnly, q('charg')))).toEqual(['de/charging']);
  });

  it('opens other refs by the draft rule: a draft needs content.read.draft, and is 404 like a missing ref', async () => {
    expect(
      ids(await found(DRAFT_READER, q('unlabelled', '&ref=draft'))),
    ).toEqual(['en/unlabelled']);
    expect(await found(DRAFT_READER, q('unlabelled'))).toMatchObject({
      meta: { page: { total: 0 } },
    });
    t.actAs(READER);
    const draft = await t.get(q('unlabelled', '&ref=draft'));
    const missing = await t.get(q('unlabelled', '&ref=nope'));
    expect([draft.status, missing.status]).toEqual([404, 404]);
    expect(errors(draft.body)[0]?.detail).toBe(
      errors(missing.body)[0]?.detail?.replace('nope', 'draft'),
    );
  });

  it('answers by commit for a commit ID, immutable, and for a tag', async () => {
    t.actAs(READER);
    const main = await t.get(q('charg'));
    const commit = main.headers['x-ccms-commit'] as string;
    const byCommit = await t.get(q('charg', `&ref=${commit}`));
    expect(byCommit.headers['cache-control']).toContain('immutable');
    expect((byCommit.body as Page).data).toEqual((main.body as Page).data);
    // The first release: the text was "charges itself".
    const v1 = await found(READER, q('itself', '&ref=v1'));
    expect(ids(v1)).toEqual(['en/charging']);
    expect(ids(await found(READER, q('itself')))).toEqual([]);
  });
});

describe('a change set’s author', () => {
  const editor: Actor = {
    ...actorWith(['content.read', 'content.edit'], { maxAudience: 'public' }),
    id: 'search-plain-editor',
  };
  const other: Actor = {
    ...actorWith(['content.read', 'content.edit']),
    id: 'search-other-author',
  };
  const subject = { type: 'module', lang: 'en', moduleId: 'charging' };

  it('searches their own branch without content.read.draft, and nobody else’s', async () => {
    t.actAs(editor);
    const started = await t.post('/change-sets').send(
      JSON.stringify({
        data: { type: 'ChangeSet', attributes: { title: 'Searchable' } },
      }),
    );
    expect(started.status).toBe(201);
    const { id, attributes } = ChangeSetDocument.parse(started.body).data;
    const lock = await t
      .post(`/change-sets/${id}/locks`)
      .send(
        JSON.stringify({ data: { type: 'Lock', attributes: { subject } } }),
      );
    expect(lock.status).toBe(201);
    const path = `/change-sets/${id}/modules/en/charging/working-copy`;
    const read = await t.get(path);
    const at = ModuleWorkingCopyDocument.parse(read.body).data.attributes;
    const content: Module = {
      ...(at.content as Module),
      blocks: [
        {
          type: 'paragraph',
          id: 'typed',
          content: [{ type: 'text', text: 'A zebra crossing.' }],
        },
      ],
    };
    const saved = await t.put(path).send(
      JSON.stringify({
        data: { type: 'WorkingCopy', attributes: { content } },
        meta: { version: at.version, baseCommit: at.baseCommit },
      }),
    );
    expect(saved.status).toBe(200);
    const commit = await t.post(`/change-sets/${id}/commits`);
    expect(commit.status).toBe(201);
    CommitDocument.parse(commit.body);

    const branch = `&ref=${encodeURIComponent(attributes.branch)}`;
    const mine = await found(editor, q('zebra', branch));
    expect(mine.data[0]?.attributes).toMatchObject({
      resourceId: 'en/charging',
      blockId: 'typed',
    });
    // Still scoped: the editor's own scope leaves out the internal module.
    expect(ids(await found(editor, q('internal', branch)))).toEqual([]);
    // Not on main, and not another author's to open.
    expect(ids(await found(editor, q('zebra')))).toEqual([]);
    t.actAs(other);
    expect((await t.get(q('zebra', branch))).status).toBe(404);
  });
});
