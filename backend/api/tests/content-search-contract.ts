import type { Module } from '@openfolia/content-model';
import { actorWith, READER } from './fakes/actors.js';
import {
  FakeSnapshot,
  manifest,
  module,
  readable,
} from './fakes/fake-content.js';
import type { ContentSearch } from '../src/search/core/content-search.js';

const text = (id: string, title: string, body: string, lang = 'en'): Module => {
  const base = module(id, lang, body);
  return { ...base, meta: { ...base.meta, title } };
};

const ALL = { number: 1, size: 1000 };

const withMeta = (m: Module, meta: Partial<Module['meta']>): Module => ({
  ...m,
  meta: { ...m.meta, ...meta },
});

/**
 * What every `ContentSearch` adapter does alike (#54): case and
 * diacritics, deprecation, excerpts and offsets, filters, paging, terms,
 * and above all the reader's scope. Called by each adapter's spec with a
 * maker of a fresh adapter; `kept` is how many indexes it keeps.
 */
export function contentSearchContract(
  name: string,
  make: () => ContentSearch,
  kept: number,
): void {
  /** The adapter, answering with all hits in one array. */
  class Items {
    readonly #search = make();
    search(
      content: ReturnType<typeof readable>,
      query: string | undefined,
      filter: Parameters<ContentSearch['search']>[2] = {},
    ) {
      return this.#search
        .search(content, query, filter, ALL)
        .then((r) => r.items);
    }
  }
  const search = (
    content: Parameters<typeof readable>[0],
    query: string,
    actor = READER,
  ) => new Items().search(readable(content, actor), query);

  describe(`${name}`, () => {
    it('ignores case and diacritics, in the query and in the content', async () => {
      const content = {
        modules: [text('a', 'Überprüfung der Straße', 'Nichts.')],
      };
      for (const query of ['uberprufung', 'ÜBERPRÜFUNG', 'strasse', 'STRAẞE']) {
        expect((await search(content, query)).map((h) => h.id)).toEqual([
          'en/a',
        ]);
      }
      // A combining mark in the content (e + U+0301) does not get in the way either.
      const decomposed = { modules: [text('b', 'Café', 'x')] };
      expect(await search(decomposed, 'cafe')).toHaveLength(1);
    });

    it('marks deprecated modules (by their source-language file) and manuals (#266)', async () => {
      const deprecated = { reason: 'Superseded.' };
      const hits = await search(
        {
          modules: [
            withMeta(text('a', 'Charger', 'x'), { deprecated }),
            text('a', 'Charger', 'x', 'de'),
            text('b', 'Charger two', 'x'),
          ],
          manifests: [
            { ...manifest('m', ['a']), title: 'Charger manual', deprecated },
          ],
        },
        'charger',
      );
      expect(Object.fromEntries(hits.map((h) => [h.id, h.deprecated]))).toEqual(
        {
          'en/a': true,
          'de/a': true,
          'en/b': false,
          m: true,
        },
      );
    });

    it('puts title matches before text matches, and exact titles first', async () => {
      const content = {
        modules: [
          text('text', 'Other', 'The charging cable.'),
          text('sub', 'Fast recharging', 'x'),
          text('word', 'Battery charging', 'x'),
          text('prefix', 'Charging basics', 'x'),
          text('exact', 'Charging', 'x'),
        ],
        manifests: [{ ...manifest('m', ['exact']), title: 'Charging guide' }],
      };
      const hits = await search(content, 'charging');
      expect(hits.map((h) => `${h.matchedOn}:${h.id}`)).toEqual([
        'title:en/exact',
        'title:en/prefix',
        'title:m',
        'title:en/word',
        'title:en/sub',
        'text:en/text',
      ]);
    });

    it('finds a manual by title only, without a language', async () => {
      const hits = await search(
        { modules: [], manifests: [manifest('a', [])] },
        'manual a',
      );
      expect(hits).toEqual([
        {
          type: 'manual',
          id: 'a',
          title: 'Manual a',
          excerpt: 'Manual a',
          matches: [
            { start: 0, end: 6 },
            { start: 7, end: 8 },
          ],
          matchedOn: 'title',
          deprecated: false,
        },
      ]);
    });

    it('returns the block, the plain excerpt and the offsets in the original text', async () => {
      const hits = await search(
        {
          modules: [
            text('a', 'Title', 'Prüfen Sie das <b>Kabel</b> & den Stecker.'),
          ],
        },
        'kabel stecker',
      );
      expect(hits).toEqual([
        {
          type: 'module',
          id: 'en/a',
          lang: 'en',
          title: 'Title',
          blockId: 'p',
          excerpt: 'Prüfen Sie das <b>Kabel</b> & den Stecker.',
          matches: [
            { start: 18, end: 23 },
            { start: 34, end: 41 },
          ],
          matchedOn: 'text',
          deprecated: false,
        },
      ]);
      const [h] = hits;
      expect(h?.excerpt.slice(18, 23)).toBe('Kabel');
    });

    it('finds an image by its callouts’ legends, each of them whatever its condition (#546)', async () => {
      const base = text('a', 'Title', 'Nothing here.');
      const pictured: Module = {
        ...base,
        blocks: [
          ...base.blocks,
          {
            type: 'image',
            id: 'front',
            asset: `sha256:${'ab'.repeat(32)}`,
            alt: 'The front',
            callouts: [
              {
                id: 'switch',
                anchor: { x: 0.2, y: 0.2 },
                legend: [{ type: 'text', text: 'Power switch' }],
              },
              {
                id: 'fan',
                anchor: { x: 0.6, y: 0.6 },
                legend: [
                  { type: 'text', text: 'Cooling ' },
                  { type: 'text', text: 'fan', marks: [{ type: 'strong' }] },
                ],
                when: { op: 'in', attr: 'model', values: ['large'] },
              },
            ],
          },
        ],
      };
      const hits = await search({ modules: [pictured] }, 'cooling fan');
      expect(hits.map((h) => [h.id, h.blockId, h.excerpt])).toEqual([
        ['en/a', 'front', 'The front Power switch Cooling fan'],
      ]);
      expect(await search({ modules: [pictured] }, 'switch')).toHaveLength(1);
    });

    it('keeps offsets right when folding changes the length', async () => {
      const hits = await search(
        { modules: [text('a', 'T', 'Große Straße')] },
        'strasse',
      );
      expect(
        hits[0]?.excerpt.slice(
          hits[0].matches[0]?.start,
          hits[0].matches[0]?.end,
        ),
      ).toBe('Straße');
    });

    it('cuts a long text to an excerpt around the first match, with offsets into the excerpt', async () => {
      const body = `${'word '.repeat(100)}needle ${'more '.repeat(100)}`;
      const [h] = await search({ modules: [text('a', 'T', body)] }, 'needle');
      expect(h?.excerpt.length).toBeLessThanOrEqual(160);
      const match = h?.matches[0];
      expect(h?.excerpt.slice(match?.start, match?.end)).toBe('needle');
    });

    it('needs every word in the same block, and searches steps and items', async () => {
      const base = module('a');
      const content = {
        modules: [
          {
            ...base,
            blocks: [
              {
                type: 'paragraph',
                id: 'one',
                content: [{ type: 'text', text: 'red cable' }],
              },
              {
                type: 'procedure',
                id: 'proc',
                steps: [
                  {
                    id: 'step-1',
                    content: [
                      { type: 'text', text: 'Plug in the green cable' },
                    ],
                    blocks: [],
                  },
                ],
              },
            ],
          } as Module,
        ],
      };
      expect((await search(content, 'green cable'))[0]?.blockId).toBe('step-1');
      expect(await search(content, 'red green')).toEqual([]);
    });

    it('returns nothing for a query with no letters, and filters by language and type', async () => {
      const content = {
        modules: [text('a', 'Charging', 'x'), text('a', 'Laden', 'x', 'de')],
        manifests: [{ ...manifest('m', ['a']), title: 'Charging' }],
      };
      const searcher = new Items();
      const snapshot = readable(content);
      expect(await searcher.search(snapshot, '́')).toEqual([]);
      expect(
        (await searcher.search(snapshot, 'laden', { lang: 'de' })).map(
          (h) => h.id,
        ),
      ).toEqual(['de/a']);
      expect(
        (
          await searcher.search(snapshot, 'charging', {
            resourceType: 'manual',
          })
        ).map((h) => h.id),
      ).toEqual(['m']);
    });

    it('finds keywords by filter[q], between title and text matches, the keywords as excerpt', async () => {
      const content = {
        modules: [
          text('text', 'Other', 'Regular maintenance.'),
          withMeta(text('kw', 'Charging', 'x'), {
            keywords: ['Maintenance', 'battery', 'Wartungsplan'],
          }),
          withMeta(text('exact', 'Zebra', 'x'), { keywords: ['maint'] }),
          text('title', 'Maintenance plan', 'x'),
        ],
      };
      const hits = await search(content, 'maint');
      expect(hits.map((h) => `${h.matchedOn}:${h.id}`)).toEqual([
        'title:en/title',
        'keyword:en/exact',
        'keyword:en/kw',
        'text:en/text',
      ]);
      expect(hits[2]).toMatchObject({
        excerpt: 'Maintenance',
        matches: [{ start: 0, end: 5 }],
      });
      expect(hits[2]?.blockId).toBeUndefined();
      // Every word, each in some keyword; only the matching keywords are shown.
      const both = await search(content, 'battery MAINTENANCE');
      expect(both.map((h) => [h.id, h.excerpt])).toEqual([
        ['en/kw', 'Maintenance, battery'],
      ]);
    });

    it('finds FAQ questions as their own field, between keyword and text matches, naming the entry', async () => {
      const faq = (id: string, question: string, answer: string): Module => {
        const base = module(id, 'en', 'x');
        return {
          ...base,
          meta: { ...base.meta, title: `Questions ${id}` },
          blocks: [
            {
              type: 'faq',
              id: `${id}-q`,
              question: [{ type: 'text', text: question }],
              blocks: [
                {
                  type: 'paragraph',
                  id: `${id}-a`,
                  content: [{ type: 'text', text: answer }],
                },
              ],
            },
          ],
        };
      };
      const content = {
        modules: [
          text('text', 'Other', 'Charging overnight is fine.'),
          faq('q', 'Can I charge overnight?', 'Yes.'),
          withMeta(text('kw', 'Zebra', 'x'), { keywords: ['overnight'] }),
          // The answer is text, not the question.
          faq('a', 'Where is the socket?', 'Overnight it sleeps.'),
        ],
      };
      const hits = await search(content, 'overnight');
      expect(hits.map((h) => `${h.matchedOn}:${h.id}`)).toEqual([
        'keyword:en/kw',
        'question:en/q',
        // Ties by title.
        'text:en/text',
        'text:en/a',
      ]);
      expect(hits[1]).toMatchObject({
        blockId: 'q-q',
        excerpt: 'Can I charge overnight?',
        matches: [{ start: 13, end: 22 }],
      });
      expect(hits[3]?.blockId).toBe('a-a');
    });

    it('filters by module type, audience, every facet value and every keyword, before paging', async () => {
      const content = {
        modules: [
          withMeta(text('a', 'Charging', 'x'), {
            type: 'procedure',
            audience: 'public',
            facets: { region: ['north', 'south'] },
            keywords: ['Wärme', 'battery'],
          }),
          withMeta(text('b', 'Charging more', 'x'), {
            type: 'concept',
            audience: 'public',
            facets: { region: ['north'] },
            keywords: ['battery'],
          }),
        ],
        manifests: [{ ...manifest('m', ['a']), title: 'Charging' }],
      };
      const searcher = new Items();
      const snapshot = readable(content);
      const ids = async (filter: Parameters<ContentSearch['search']>[2]) =>
        (await searcher.search(snapshot, 'charging', filter)).map((h) => h.id);
      expect(await ids({})).toEqual(['m', 'en/a', 'en/b']);
      // A module filter leaves manuals out.
      expect(await ids({ type: 'procedure' })).toEqual(['en/a']);
      expect(await ids({ audience: 'public' })).toEqual(['en/a', 'en/b']);
      expect(
        await ids({
          facets: [
            { id: 'region', value: 'north' },
            { id: 'region', value: 'south' },
          ],
        }),
      ).toEqual(['en/a']);
      expect(await ids({ keywords: ['WARME'] })).toEqual(['en/a']);
      expect(await ids({ keywords: ['warm'] })).toEqual([]);
      expect(await ids({ keywords: ['battery', 'wärme'] })).toEqual(['en/a']);
      expect(await ids({ type: 'concept', keywords: ['wärme'] })).toEqual([]);
      expect(await ids({ type: 'unknown' })).toEqual([]);
      // Without a query, the filters alone: by title, the title as excerpt.
      const hits = await searcher.search(snapshot, undefined, {
        keywords: ['battery'],
      });
      expect(hits.map((h) => [h.id, h.matchedOn, h.excerpt])).toEqual([
        ['en/a', 'filter', 'Charging'],
        ['en/b', 'filter', 'Charging more'],
      ]);
      // Neither query nor module filter: nothing.
      expect(
        await searcher.search(snapshot, undefined, { lang: 'en' }),
      ).toEqual([]);
    });

    it('filters by the audience level a module counts as: none named is the last level (#699)', async () => {
      const content = {
        modules: [
          withMeta(text('open', 'Charging', 'x'), { audience: 'public' }),
          withMeta(text('inner', 'Charging inside', 'x'), {
            audience: 'internal',
          }),
          withMeta(text('unset', 'Charging unset', 'x'), {
            audience: undefined,
          }),
          withMeta(text('stale', 'Charging stale', 'x'), {
            audience: 'retired',
          }),
        ],
      };
      const config = {
        ...(await new FakeSnapshot().config()),
        audiences: [
          { id: 'public', label: 'Public' },
          { id: 'internal', label: 'Internal' },
        ],
      };
      const snapshot = readable(new FakeSnapshot({ ...content, config }));
      const searcher = new Items();
      for (const query of ['charging', undefined]) {
        const ids = async (audience: string) =>
          (await searcher.search(snapshot, query, { audience }))
            .map((h) => h.id)
            .sort();
        expect([query, await ids('internal')]).toEqual([
          query,
          ['en/inner', 'en/unset'],
        ]);
        expect([query, await ids('public')]).toEqual([query, ['en/open']]);
        // A level the configuration does not list matches nothing, a module naming it neither.
        expect([query, await ids('retired')]).toEqual([query, []]);
      }
      // Within the scope only: the last level reaches no further than the reader may read.
      const publicOnly = actorWith(['content.read'], { maxAudience: 'public' });
      const narrow = readable(
        new FakeSnapshot({ ...content, config }),
        publicOnly,
      );
      expect(
        await searcher.search(narrow, 'charging', { audience: 'internal' }),
      ).toEqual([]);
      expect(
        await searcher.search(narrow, undefined, { audience: 'internal' }),
      ).toEqual([]);
    });

    it('shows an actor only what their scope allows, and nothing of what is left out', async () => {
      const content = {
        modules: [
          text('open', 'Secret recipe', 'x'),
          {
            ...text('hidden', 'Secret plan', 'secret'),
            meta: {
              ...module('x').meta,
              title: 'Secret plan',
              audience: 'internal',
            },
          },
        ],
      };
      const config = {
        ...(await new FakeSnapshot().config()),
        audiences: [
          { id: 'public', label: 'Public' },
          { id: 'internal', label: 'Internal' },
        ],
      };
      const snapshot = new FakeSnapshot({ ...content, config });
      const searcher = new Items();
      const publicOnly = actorWith(['content.read'], { maxAudience: 'public' });
      const seen = await searcher.search(
        readable(snapshot, publicOnly),
        'secret',
      );
      expect(seen.map((h) => h.id)).toEqual(['en/open']);
      // The same commit for a wider reader is not served from the narrow one's index.
      const all = await searcher.search(readable(snapshot, READER), 'secret');
      expect(all.map((h) => h.id).sort()).toEqual(['en/hidden', 'en/open']);
      // And the narrow one again still sees only its own.
      expect(
        (await searcher.search(readable(snapshot, publicOnly), 'secret')).map(
          (h) => h.id,
        ),
      ).toEqual(['en/open']);
    });

    it('builds an index once per commit and reading scope, and keeps a bounded number', async () => {
      const searcher = new Items();
      const snapshot = new FakeSnapshot({
        modules: [text('a', 'Charging', 'x')],
      });
      let reads = 0;
      const modules = snapshot.modules.bind(snapshot);
      snapshot.modules = (lang) => {
        reads++;
        return modules(lang);
      };
      await searcher.search(readable(snapshot), 'charging');
      await searcher.search(readable(snapshot), 'other');
      expect(reads).toBe(1);
      for (let i = 0; i < kept + 1; i++) {
        await searcher.search(readable(new FakeSnapshot({ modules: [] })), 'x');
      }
      // The index was dropped, and its rankings with it.
      await searcher.search(readable(snapshot), 'charging');
      expect(reads).toBe(2);
    });

    it('does not keep an index that failed to build', async () => {
      const searcher = new Items();
      const snapshot = new FakeSnapshot({
        modules: [text('a', 'Charging', 'x')],
      });
      const modules = snapshot.modules.bind(snapshot);
      let fail = true;
      snapshot.modules = (lang) =>
        fail ? Promise.reject(new Error('git is down')) : modules(lang);
      await expect(
        searcher.search(readable(snapshot), 'charging'),
      ).rejects.toThrow('git is down');
      fail = false;
      expect(
        await searcher.search(readable(snapshot), 'charging'),
      ).toHaveLength(1);
    });
  });

  describe(`${name} paging`, () => {
    it('pages the ranked hits, counts all of them and leaves manuals out under a language filter', async () => {
      const content = {
        modules: ['a', 'b', 'c'].map((id) => text(id, `Charging ${id}`, 'x')),
        manifests: [{ ...manifest('m', ['a']), title: 'Charging' }],
      };
      const searcher = make();
      const second = await searcher.search(
        readable(content),
        'charging',
        {},
        { number: 2, size: 2 },
      );
      expect(second.total).toBe(4);
      expect(second.items).toHaveLength(2);
      const past = await searcher.search(
        readable(content),
        'charging',
        {},
        { number: 9, size: 2 },
      );
      expect(past).toEqual({ items: [], total: 4 });
      const german = await searcher.search(
        readable(content),
        'charging',
        { lang: 'en' },
        { number: 1, size: 10 },
      );
      expect(german.items.map((h) => h.type)).toEqual([
        'module',
        'module',
        'module',
      ]);
    });
  });

  describe(`${name} terms`, () => {
    const terms = {
      charger: `schemaVersion: 1
status: approved
languages:
  de:
    preferred: Ladegerät
    definition: Das Gerät, das den Akku lädt.
  en:
    preferred: charger
    forbidden:
      - term: loader
    definition: The device that charges the **battery**.
`,
      broken: 'status: [\n',
    };

    it('finds a term per language by its preferred variant, other variants and definition', async () => {
      const content = { modules: [], terms };
      const hits = await search(content, 'charger');
      expect(hits).toEqual([
        {
          type: 'term',
          id: 'charger',
          lang: 'en',
          title: 'charger',
          excerpt: 'charger',
          matches: [{ start: 0, end: 7 }],
          matchedOn: 'title',
          deprecated: false,
        },
      ]);
      expect(
        (await search(content, 'loader')).map((h) => [h.matchedOn, h.excerpt]),
      ).toEqual([['keyword', 'loader']]);
      const text = await search(content, 'charges the battery');
      expect(text).toEqual([
        expect.objectContaining({
          type: 'term',
          lang: 'en',
          matchedOn: 'text',
          deprecated: false,
          excerpt: 'The device that charges the battery.',
        }),
      ]);
      expect(text[0]?.blockId).toBeUndefined();
      expect(
        (await search(content, 'gerat')).map((h) => [h.lang, h.matchedOn]),
      ).toEqual([['de', 'title']]);
    });

    it('filters terms by language and type; module filters leave them out', async () => {
      const content = readable({
        modules: [text('m', 'Charger use', 'x')],
        terms,
      });
      const items = new Items();
      expect(
        (await items.search(content, 'charger', { resourceType: 'term' })).map(
          (h) => h.id,
        ),
      ).toEqual(['charger']);
      expect(
        (await items.search(content, 'ger', { lang: 'de' })).map(
          (h) => `${h.type}:${h.id}`,
        ),
      ).toEqual(['term:charger']);
      expect(
        (await items.search(content, 'charger', { type: 'concept' })).map(
          (h) => h.type,
        ),
      ).toEqual(['module']);
    });
  });
}
