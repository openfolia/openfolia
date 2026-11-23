import {
  CHUNK_SET_KEPT_AT_LIMITS,
  CHUNK_SET_MODULES_AT_LIMITS,
  MAX_EXPANDED_CHARS,
  MAX_EXPANDED_NODES,
  MAX_EXPANDED_TABLE_CELLS,
  ProjectConfig,
  type ExpansionLimits,
  type Block,
  type Module,
} from '@openfolia/content-model';
import {
  ForbiddenError,
  InvalidParameterError,
  UnprocessableError,
} from '../../../base/core/errors.js';
import { actorWith, NOBODY, READER } from '../../../../tests/fakes/actors.js';
import { FakeContentChanges } from '../../../../tests/fakes/fake-content-changes.js';
import {
  FakeSnapshot,
  manifest,
  module,
  readable,
  type FakeContent,
} from '../../../../tests/fakes/fake-content.js';
import {
  ChunkSetTooLargeError,
  LARGEST_NAMED,
} from '../chunk-set-too-large.js';
import {
  CHUNK_SET_BUILDS_WAITING,
  ListChunksAction,
  VARIANT_SLACK,
  variantBudget,
  type ChunkFilter,
} from './list-chunks.action.js';

const config = ProjectConfig.parse({
  languages: { source: 'en', targets: ['de'] },
  moduleTypes: [
    { id: 'concept', label: 'Concept' },
    { id: 'procedure', label: 'Procedure' },
  ],
  audiences: [
    { id: 'public', label: 'Public' },
    { id: 'internal', label: 'Internal' },
  ],
  facets: [
    {
      id: 'region',
      label: 'Region',
      values: [
        { id: 'north', label: 'North' },
        { id: 'south', label: 'South' },
      ],
    },
  ],
  variantAttributes: [
    {
      id: 'model',
      label: 'Model',
      kind: 'enum',
      values: [
        { id: 'small', label: 'Small' },
        { id: 'large', label: 'Large' },
      ],
    },
  ],
  textAttributes: [],
  safetySymbols: [],
});

const PAGE = { number: 1, size: 50 };

/**
 * A 128th of the limits of #679 (#726): the diamonds below are 7 levels (2^7 times) shallower
 * than content that crosses the real ones, so they cross these the same way, in a 128th of the
 * work. The depth limit half the real one: above what the diamonds nest (about 25), below the
 * chain of 60 references. The real limits are held in the content model's specs (exactly the
 * limit, and one node more), and here by the action that is given none.
 */
const SMALL: ExpansionLimits = {
  nodes: Math.floor(MAX_EXPANDED_NODES / 128),
  chars: Math.floor(MAX_EXPANDED_CHARS / 128),
  cells: Math.floor(MAX_EXPANDED_TABLE_CELLS / 128),
  depth: 50,
};
/** An action cutting chunks to `SMALL`. */
const smallAction = () => new ListChunksAction(new FakeContentChanges(), SMALL);
const PUBLIC_ONLY = actorWith(['content.read'], { maxAudience: 'public' });

const withMeta = (m: Module, meta: Partial<Module['meta']>): Module => ({
  ...m,
  meta: { ...m.meta, ...meta },
});
const withBlocks = (m: Module, blocks: Block[]): Module => ({
  ...m,
  blocks: [...m.blocks, ...blocks],
});

const forLarge: Block = {
  type: 'variant',
  id: 'v',
  when: { op: 'in', attr: 'model', values: ['large'] },
  blocks: [
    {
      type: 'paragraph',
      id: 'vp',
      content: [{ type: 'text', text: 'Only for the large model.' }],
    },
  ],
};

const internals = withMeta(module('internals', 'en', 'Internal only.'), {
  audience: 'internal',
});
const shared = withBlocks(module('shared', 'en', 'Shared text.'), [
  { type: 'moduleRef', id: 'r', module: 'internals' },
]);
const host = withBlocks(
  withMeta(module('host', 'en', 'Host text.'), {
    type: 'procedure',
    facets: { region: ['north'] },
    keywords: ['battery'],
  }),
  [{ type: 'moduleRef', id: 'r', module: 'shared' }, forLarge],
);
const hostDe = withMeta(module('host', 'de', 'Gastgeber.'), {
  type: 'procedure',
  facets: { region: ['north'] },
});

const content: FakeContent = {
  config,
  modules: [host, hostDe, shared, internals],
  manifests: [
    {
      ...manifest('public-manual', ['host', 'internals']),
      entries: [
        { module: 'host' },
        {
          module: 'shared',
          when: { op: 'in', attr: 'model', values: ['small'] },
        },
        { module: 'internals' },
      ],
    },
    { ...manifest('service', ['internals', 'shared']), audience: 'internal' },
  ],
};

async function list(
  filter: ChunkFilter = {},
  options: {
    actor?: typeof READER;
    snapshot?: FakeSnapshot;
    changes?: FakeContentChanges;
    page?: { number: number; size: number };
  } = {},
) {
  const actor = options.actor ?? READER;
  const action = new ListChunksAction(
    options.changes ?? new FakeContentChanges(),
  );
  return action.handle({
    actor,
    snapshot: readable(options.snapshot ?? content, actor),
    filter,
    page: options.page ?? PAGE,
  });
}

const ids = (result: { items: { lang: string; moduleId: string }[] }) =>
  result.items.map((c) => `${c.lang}/${c.moduleId}`);

describe('ListChunksAction', () => {
  it('lists one chunk per module and language, ordered by module ID and language, with its manuals', async () => {
    const result = await list();
    expect(ids(result)).toEqual([
      'de/host',
      'en/host',
      'en/internals',
      'en/shared',
    ]);
    expect(result.total).toBe(4);
    const enHost = result.items[1];
    expect(enHost?.text).toBe(
      [
        '# Title of host',
        'Host text.',
        // `internals` is more restricted than `host`: never in its text.
        'Shared text.',
        '> **when** `model in (large)`\n>\n> Only for the large model.',
      ].join('\n\n'),
    );
    // Within its audience only: the public manual names `internals` but leaves it out.
    expect(result.items.map((c) => [c.moduleId, c.manuals])).toEqual([
      ['host', ['public-manual']],
      ['host', ['public-manual']],
      ['internals', ['service']],
      ['shared', ['public-manual', 'service']],
    ]);
    expect(enHost?.conditions).toEqual(['model in (large)']);
    expect(enHost?.sources).toEqual([
      { moduleId: 'host', lang: 'en' },
      { moduleId: 'shared', lang: 'en' },
    ]);
  });

  it('never lists, counts or inlines what lies outside the reader’s scope', async () => {
    const result = await list({}, { actor: PUBLIC_ONLY });
    expect(ids(result)).toEqual(['de/host', 'en/host', 'en/shared']);
    expect(result.total).toBe(3);
    expect(result.items.map((c) => c.text).join('\n')).not.toContain(
      'Internal only.',
    );
    // A module the reader may not see is not inlined into one they may.
    const procedures = await list(
      {},
      { actor: actorWith(['content.read'], { moduleTypes: ['procedure'] }) },
    );
    expect(ids(procedures)).toEqual(['de/host', 'en/host']);
    expect(procedures.items[1]?.text).not.toContain('Shared text.');
    expect(procedures.items[1]?.sources).toEqual([
      { moduleId: 'host', lang: 'en' },
    ]);
    // The internal manual is not readable, so it is named nowhere.
    expect(result.items.find((c) => c.moduleId === 'shared')?.manuals).toEqual([
      'public-manual',
    ]);
    // A manual outside the scope includes nothing, like one that does not exist.
    expect(
      (await list({ manual: 'service' }, { actor: PUBLIC_ONLY })).total,
    ).toBe(0);
    expect((await list({ manual: 'nope' })).total).toBe(0);
  });

  it('filters before paging: language, type, audience, facet, keyword', async () => {
    expect(ids(await list({ lang: 'de' }))).toEqual(['de/host']);
    expect(ids(await list({ type: 'procedure' }))).toEqual([
      'de/host',
      'en/host',
    ]);
    expect(ids(await list({ audience: 'internal' }))).toEqual(['en/internals']);
    expect(
      ids(await list({ facets: [{ id: 'region', value: 'north' }] })),
    ).toEqual(['de/host', 'en/host']);
    expect(ids(await list({ keywords: ['BATTERY'] }))).toEqual(['en/host']);
    const paged = await list({}, { page: { number: 2, size: 3 } });
    expect(ids(paged)).toEqual(['en/shared']);
    expect(paged.total).toBe(4);
  });

  it('with a module ID, lists that module’s chunks only, in the languages the reader may read', async () => {
    expect(ids(await list({ module: 'host' }))).toEqual(['de/host', 'en/host']);
    expect(ids(await list({ module: 'host', lang: 'de' }))).toEqual([
      'de/host',
    ]);
    expect(ids(await list({ module: 'missing' }))).toEqual([]);
  });

  it('with a manual, lists what it includes; with a variant too, only the entries it includes for it', async () => {
    expect(ids(await list({ manual: 'public-manual' }))).toEqual([
      'de/host',
      'en/host',
      'en/shared',
    ]);
    expect(
      ids(await list({ manual: 'public-manual', variant: { model: 'large' } })),
    ).toEqual(['de/host', 'en/host']);
  });

  it('with a variant, resolves variant blocks: one for another model is absent', async () => {
    const small = await list({ lang: 'en', variant: { model: 'small' } });
    const text = small.items.find((c) => c.moduleId === 'host')?.text;
    expect(text).not.toContain('Only for the large model.');
    expect(text).not.toContain('**when**');
    const large = await list({ lang: 'en', variant: { model: 'large' } });
    expect(large.items.find((c) => c.moduleId === 'host')?.text).toContain(
      'Only for the large model.',
    );
  });

  it('shares one set of chunks across variants, making the page’s text for the variant asked', async () => {
    const action = new ListChunksAction(new FakeContentChanges());
    const snapshot = readable(content);
    const ask = (filter: ChunkFilter) =>
      action.handle({
        actor: READER,
        snapshot,
        filter: { lang: 'en', ...filter },
        page: PAGE,
      });
    const host = (r: Awaited<ReturnType<typeof ask>>) =>
      r.items.find((c) => c.moduleId === 'host');
    expect(host(await ask({}))?.text).toContain('**when**');
    const small = host(await ask({ variant: { model: 'small' } }));
    expect(small?.text).not.toContain('Only for the large model.');
    expect(small?.manuals).toEqual(['public-manual']);
    expect(host(await ask({ variant: { model: 'large' } }))?.text).toContain(
      'Only for the large model.',
    );
    expect(host(await ask({}))?.text).toContain('**when**');
  });

  it('gives each FAQ entry a chunk of its own after its module’s, leaving out one its variant excludes', async () => {
    const entry = (id: string, question: string, answer: string): Block => ({
      type: 'faq',
      id,
      question: [{ type: 'text', text: question }],
      blocks: [
        {
          type: 'paragraph',
          id: `${id}-a`,
          content: [{ type: 'text', text: answer }],
        },
      ],
    });
    const faq = withBlocks(module('faq', 'en', 'Common questions.'), [
      entry('reset', 'How do I reset it?', 'Hold the button.'),
      {
        type: 'variant',
        id: 'v',
        when: { op: 'in', attr: 'model', values: ['large'] },
        blocks: [entry('lift', 'Can it lift?', 'Up to one tonne.')],
      },
    ]);
    const snapshot = new FakeSnapshot({
      ...content,
      modules: [...(content.modules ?? []), faq],
    });
    const keys = (result: Awaited<ReturnType<typeof list>>) =>
      result.items.map((c) =>
        c.entry ? `${c.moduleId}/${c.entry.blockId}` : c.moduleId,
      );
    const all = await list({ module: 'faq' }, { snapshot });
    expect(keys(all)).toEqual(['faq', 'faq/reset', 'faq/lift']);
    expect(all.total).toBe(3);
    expect(all.items[1]).toMatchObject({
      text: '# How do I reset it?\n\nHold the button.',
      entry: { blockId: 'reset', question: 'How do I reset it?' },
    });
    expect(all.items[2]?.conditions).toEqual(['model in (large)']);
    // Before paging: the entry the variant leaves out is not counted.
    const small = await list(
      { module: 'faq', variant: { model: 'small' } },
      { snapshot },
    );
    expect(keys(small)).toEqual(['faq', 'faq/reset']);
    expect(small.total).toBe(2);
    expect(small.items[0]?.text).not.toContain('Can it lift?');
    const large = await list(
      { module: 'faq', variant: { model: 'large' } },
      { snapshot, page: { number: 2, size: 2 } },
    );
    expect(keys(large)).toEqual(['faq/lift']);
    expect(large.items[0]?.text).toBe('# Can it lift?\n\nUp to one tonne.');
  });

  it('refuses a variant the configuration does not hold (422 unknown-variant)', async () => {
    const error = await list({ variant: { model: 'huge' } }).catch((e) => e);
    expect(error).toBeInstanceOf(UnprocessableError);
    expect(error.code).toBe('unknown-variant');
  });

  describe('everyChunk, for the change feed (#43, #527)', () => {
    const action = () => new ListChunksAction(new FakeContentChanges());

    it('gives every chunk the reader may read, as the list does', async () => {
      const set = await action().everyChunk({
        actor: PUBLIC_ONLY,
        snapshot: readable(content, PUBLIC_ONLY),
      });
      expect(set.chunks.map((c) => `${c.lang}/${c.moduleId}`)).toEqual([
        'de/host',
        'en/host',
        'en/shared',
      ]);
      expect(set.source).toBe('en');
    });

    it('holds the action’s policy: an actor without content.read is refused', async () => {
      await expect(
        action().everyChunk({
          actor: NOBODY,
          snapshot: readable(content, NOBODY),
        }),
      ).rejects.toBeInstanceOf(ForbiddenError);
      await expect(
        action().everyChunk({
          actor: undefined as unknown as typeof READER,
          snapshot: readable(content, READER),
        }),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });

    it('refuses content opened for another reader, or for drafts, before cutting a chunk', async () => {
      // Opened for a reader who sees more: the narrower reader never gets its chunks.
      await expect(
        action().everyChunk({
          actor: PUBLIC_ONLY,
          snapshot: readable(content, READER),
        }),
      ).rejects.toBeInstanceOf(ForbiddenError);
      const drafts = actorWith(['content.read', 'content.read.draft']);
      await expect(
        action().everyChunk({
          actor: drafts,
          snapshot: readable(content, drafts, 'content.read.draft'),
        }),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });
  });

  describe('a module too large to cut (#681, #688)', () => {
    // `j0` → `a0`, `b0` → `j1` → …: 2^11 paths down; the `b` modules are for the north only.
    // The modules of the top levels pass the limits (`SMALL`), within the room of the set's
    // budget for them (#684, `CHUNK_SET_MODULES_AT_LIMITS`).
    const DEPTH = 11;
    const refs = (id: string, to: string[], north = false): Module =>
      withMeta(
        withBlocks(
          module(id),
          to.map((ref): Block => ({
            type: 'moduleRef',
            id: `to-${ref}`,
            module: ref,
          })),
        ),
        north ? { facets: { region: ['north'] } } : {},
      );
    const modules: Module[] = [];
    for (let level = 0; level < DEPTH; level++) {
      const next = `j${level + 1}`;
      modules.push(
        refs(`j${level}`, [`a${level}`, `b${level}`]),
        refs(`a${level}`, [next]),
        refs(`b${level}`, [next], true),
      );
    }
    modules.push(refs(`j${DEPTH}`, []));
    const snapshot = new FakeSnapshot({ config, modules, manifests: [] });
    const SOUTH = actorWith(['content.read'], {
      facets: { region: ['south'] },
    });

    const listAs = (
      action: ListChunksAction,
      actor: typeof READER,
      filter: ChunkFilter = {},
    ) =>
      action.handle({
        actor,
        snapshot: readable(snapshot, actor),
        filter,
        page: { number: 1, size: 200 },
      });

    it('leaves out only the modules too large to cut, each on a count of its own, per reader (#688)', async () => {
      const action = smallAction();
      const all = await listAs(action, READER);
      const leftOut = all.leftOut ?? [];
      const names = leftOut.map((m) => m.moduleId);
      // The top of the diamond holds 2^11 paths, its bottom one: the top is left out, …
      expect(names).toEqual(expect.arrayContaining(['a0', 'b0', 'j0']));
      expect(leftOut.every((m) => m.lang === 'en' && m.reason === 'size')).toBe(
        true,
      );
      // … in module ID order, and nothing else is: a module's count is never another's.
      expect(names).toEqual([...names].sort());
      expect(all.total).toBe(3 * DEPTH + 1 - leftOut.length);
      expect(all.items.map((c) => c.moduleId)).toEqual(
        expect.arrayContaining([`j${DEPTH}`, `a${DEPTH - 1}`, `j${DEPTH - 1}`]),
      );
      expect(all.items.some((c) => names.includes(c.moduleId))).toBe(false);
      // One who may not see the `b` modules has a single path down: every chunk, nothing left out.
      const south = await listAs(action, SOUTH);
      expect(south.total).toBe(2 * DEPTH + 1);
      expect(south.leftOut).toBeUndefined();
      expect(south.items.some((c) => c.moduleId.startsWith('b'))).toBe(false);
      // Nothing of either is taken for the other.
      expect((await listAs(action, READER)).leftOut).toEqual(leftOut);
    });

    it('holds content to the limits of #679 unless given others (#726: tests only)', async () => {
      // The same diamond is far within the limits of #679: nothing is left out.
      const real = await listAs(
        new ListChunksAction(new FakeContentChanges()),
        READER,
      );
      expect(real.leftOut).toBeUndefined();
      expect(real.total).toBe(3 * DEPTH + 1);
      // Limits given are checked: never one that passes everything, or nothing.
      // Nor one above the limits of #679: the seam only lowers them.
      for (const nodes of [
        0,
        -1,
        1.5,
        Number.NaN,
        Infinity,
        MAX_EXPANDED_NODES + 1,
      ]) {
        expect(
          () =>
            new ListChunksAction(new FakeContentChanges(), { ...SMALL, nodes }),
        ).toThrow(TypeError);
      }
    });

    it('names a module left out only where the filters ask for it', async () => {
      const action = smallAction();
      const top = await listAs(action, READER, { module: 'a0' });
      expect(top.items).toEqual([]);
      expect(top.leftOut).toEqual([
        { moduleId: 'a0', lang: 'en', reason: 'size' },
      ]);
      const bottom = await listAs(action, READER, { module: `j${DEPTH}` });
      expect(bottom.total).toBe(1);
      expect(bottom.leftOut).toBeUndefined();
      expect(
        (await listAs(action, READER, { lang: 'de' })).leftOut,
      ).toBeUndefined();
      expect(
        (
          await listAs(action, READER, {
            facets: [{ id: 'region', value: 'north' }],
          })
        ).leftOut?.every((m) => m.moduleId.startsWith('b')),
      ).toBe(true);
    });

    it('keeps the set with what it left out, for the commit and reader', async () => {
      const action = smallAction();
      const modulesRead = vi.spyOn(snapshot, 'modules');
      for (let i = 0; i < 3; i++) {
        expect((await listAs(action, READER)).leftOut?.[0]).toEqual({
          moduleId: 'a0',
          lang: 'en',
          reason: 'size',
        });
      }
      expect(modulesRead).toHaveBeenCalledTimes(1);
      modulesRead.mockRestore();
    });

    it('leaves out a chain of references nested past the depth limit, with reason depth', async () => {
      const chain = Array.from({ length: 60 }, (_, i) =>
        refs(
          `c${String(i).padStart(3, '0')}`,
          i < 59 ? [`c${String(i + 1).padStart(3, '0')}`] : [],
        ),
      );
      const result = await smallAction().handle({
        actor: READER,
        snapshot: readable(
          new FakeSnapshot({ config, modules: chain, manifests: [] }),
          READER,
        ),
        filter: {},
        page: { number: 1, size: 100 },
      });
      expect(result.leftOut?.[0]).toEqual({
        moduleId: 'c000',
        lang: 'en',
        reason: 'depth',
      });
      expect(result.leftOut?.every((m) => m.reason === 'depth')).toBe(true);
      expect(result.total).toBe(60 - (result.leftOut?.length ?? 0));
    });
  });

  describe('the chunk set as a whole (#684)', () => {
    // A diamond 7 levels deep: its top, `j0`, expands to about 2,000 content nodes, within the
    // limits (`SMALL.nodes`, 3,906), from a few dozen of its own.
    const DEPTH = 7;
    const refs = (id: string, to: string[], north = false): Module =>
      withMeta(
        withBlocks(
          module(id),
          to.map((ref): Block => ({
            type: 'moduleRef',
            id: `to-${ref}`,
            module: ref,
          })),
        ),
        north ? { facets: { region: ['north'] } } : {},
      );
    /** The diamond, `count` small modules each referring to its top, and the top's reads. */
    const commit = (count: number, options: { north?: boolean } = {}) => {
      const modules: Module[] = [];
      let topReads = 0;
      for (let level = 0; level < DEPTH; level++) {
        const next = `j${level + 1}`;
        const top = refs(`j${level}`, [`a${level}`, `b${level}`]);
        if (level === 0) {
          const { blocks } = top;
          Object.defineProperty(top, 'blocks', {
            get() {
              topReads++;
              return blocks;
            },
          });
        }
        modules.push(top, refs(`a${level}`, [next]), refs(`b${level}`, [next]));
      }
      modules.push(refs(`j${DEPTH}`, []));
      for (let i = 0; i < count; i++) {
        modules.push(
          refs(`r${String(i).padStart(3, '0')}`, ['j0'], options.north),
        );
      }
      return {
        snapshot: new FakeSnapshot({ config, modules, manifests: [] }),
        reads: () => topReads,
      };
    };
    const SOUTH = actorWith(['content.read'], {
      facets: { region: ['south'] },
    });
    const listIn = (
      snapshot: FakeSnapshot,
      action = smallAction(),
      actor: typeof READER = READER,
      filter: ChunkFilter = {},
    ) =>
      action.handle({
        actor,
        snapshot: readable(snapshot, actor),
        filter,
        page: { number: 1, size: 10 },
      });
    const refusal = async (go: Promise<unknown>) => {
      try {
        await go;
      } catch (error) {
        if (error instanceof ChunkSetTooLargeError) return error;
        throw error;
      }
      throw new Error('not refused');
    };

    it('lists a commit of a few modules each near the limits, as before', async () => {
      const { snapshot } = commit(5);
      const action = smallAction();
      const result = await listIn(snapshot, action);
      expect(result.total).toBe(3 * DEPTH + 1 + 5);
      expect(result.leftOut).toBeUndefined();
      // A page for a variant is made within a budget of its own: about its modules. (Under
      // `SMALL`, `VARIANT_SLACK` alone exceeds a module's limits; `reference-walk.e2e` holds the
      // variant budget at the real ones.)
      const variant = await listIn(snapshot, action, READER, {
        variant: { model: 'large' },
      });
      expect(variant.items.map((c) => c.moduleId)).toEqual(
        result.items.map((c) => c.moduleId),
      );
      expect(variant.leftOut).toBeUndefined();
    });

    it('refuses a commit of many, without chunking them all: 422 chunk-set-too-large', async () => {
      const { snapshot, reads } = commit(100);
      const error = await refusal(listIn(snapshot));
      expect(error).toBeInstanceOf(UnprocessableError);
      expect(error.code).toBe('chunk-set-too-large');
      // Each module including the top reads its blocks twice (its weight, its walk). Each
      // keeps about 20,000 characters, so the room for the text kept
      // (`CHUNK_SET_KEPT_AT_LIMITS` modules at `SMALL.chars`) is spent at about 40 of them,
      // before the room for the work: never all 100.
      expect(reads()).toBeLessThan(2 * 45);
      expect(reads()).toBeGreaterThan(2 * 35);
      // The budget is the room for modules at the limits: the content itself is small.
      expect(error.limit.nodes).toBeLessThan(
        CHUNK_SET_MODULES_AT_LIMITS * SMALL.nodes + 10_000,
      );
      expect(error.limit.chars).toBeLessThan(
        CHUNK_SET_KEPT_AT_LIMITS * SMALL.chars + 100_000,
      );
      // The room for the text kept was passed, and the error says so.
      expect(error.kept).toBe(true);
      expect(error.meta).toMatchObject({ kept: true });
      // The modules that spent the most, most first: the top, then those referring to it.
      expect(error.largest).toHaveLength(LARGEST_NAMED);
      expect(error.largest[0]?.nodes).toBeGreaterThan(SMALL.nodes * 0.4);
      expect(error.largest[0]?.nodes).toBeLessThan(SMALL.nodes);
      expect(
        error.largest.every(
          (m) => m.moduleId === 'j0' || m.moduleId.startsWith('r'),
        ),
      ).toBe(true);
      expect(error.meta).toMatchObject({
        nodes: error.limit.nodes,
        chars: error.limit.chars,
        tableCells: error.limit.cells,
      });
    });

    it('keeps the refusal for the commit and reader: asking again chunks nothing', async () => {
      const { snapshot, reads } = commit(100);
      const action = smallAction();
      await refusal(listIn(snapshot, action));
      const once = reads();
      await refusal(listIn(snapshot, action));
      await refusal(
        action.everyChunk({
          actor: READER,
          snapshot: readable(snapshot, READER),
        }),
      );
      expect(reads()).toBe(once);
    });

    it('tells whether a commit’s set fits, for the checks (#710), keeping only the verdict of one that fits', async () => {
      const { snapshot, reads } = commit(100);
      const action = smallAction();
      const verdict = await action.tooLarge(readable(snapshot, READER));
      expect(verdict).toBeInstanceOf(ChunkSetTooLargeError);
      expect(verdict?.largest.length).toBe(LARGEST_NAMED);
      const once = reads();
      // Asked again, or listed: the refusal is kept for both, so nothing is chunked again.
      expect(await action.tooLarge(readable(snapshot, READER))).toBe(verdict);
      await refusal(listIn(snapshot, action));
      expect(reads()).toBe(once);
      // A reader who may not see the modules that multiply: it fits.
      const { snapshot: north } = commit(100, { north: true });
      expect(await action.tooLarge(readable(north, SOUTH))).toBeUndefined();
      // A set that fits is not kept for the verdict alone: only that it fits.
      const { snapshot: small, reads: smallReads } = commit(5);
      expect(await action.tooLarge(readable(small, READER))).toBeUndefined();
      const told = smallReads();
      expect(await action.tooLarge(readable(small, READER))).toBeUndefined();
      expect(smallReads()).toBe(told);
      await listIn(small, action);
      expect(smallReads()).toBeGreaterThan(told);
    });

    it('builds one set at a time for verdicts, and refuses more than a few waiting: 503 (#710)', async () => {
      const action = smallAction();
      const asks = Array.from({ length: CHUNK_SET_BUILDS_WAITING + 1 }, () =>
        action.tooLarge(readable(commit(1).snapshot, READER)),
      );
      const settled = await Promise.allSettled(asks);
      const refused = settled.filter((r) => r.status === 'rejected');
      expect(refused).toHaveLength(1);
      expect((refused[0] as PromiseRejectedResult).reason).toMatchObject({
        code: 'chunk-sets-busy',
      });
      // Once they are done, it takes them again.
      expect(
        await action.tooLarge(readable(commit(1).snapshot, READER)),
      ).toBeUndefined();
    });

    it('serves a reader who may not see the modules that multiply', async () => {
      const { snapshot } = commit(100, { north: true });
      const action = smallAction();
      await refusal(listIn(snapshot, action));
      const south = await listIn(snapshot, action, SOUTH);
      expect(south.total).toBe(3 * DEPTH + 1);
    });

    it('holds each module of a variant page to a budget of its own: twice its text, plus a little', () => {
      expect(variantBudget({ nodes: 100, chars: 5_000, cells: 3 })).toEqual({
        nodes: 200 + VARIANT_SLACK.nodes,
        chars: 10_000 + VARIANT_SLACK.chars,
        cells: 6 + VARIANT_SLACK.cells,
      });
      expect(variantBudget(undefined)).toEqual(VARIANT_SLACK);
      // A page of 200 such modules near the limits costs about twice its text, never the set.
      expect(
        variantBudget({ nodes: 0, chars: 0, cells: 0 }).chars,
      ).toBeLessThan(MAX_EXPANDED_CHARS / 100);
    });

    it('counts a module left out (#688) as far as it was walked', async () => {
      // `x` refers to the top over four paths: past the limits, so left out after walking
      // `SMALL.nodes`. `CHUNK_SET_MODULES_AT_LIMITS` such use up the room alone, the content
      // still small.
      const { snapshot: few } = commit(0);
      const quad = (id: string) => refs(id, ['j0', 'j0', 'j0', 'j0'], false);
      const withQuads = (count: number) =>
        new FakeSnapshot({
          config,
          modules: [
            ...(few.content.modules ?? []),
            ...Array.from({ length: count }, (_, i) => quad(`x${i}`)),
          ],
          manifests: [],
        });
      const some = await listIn(withQuads(3));
      expect(some.leftOut?.map((m) => m.moduleId)).toEqual(['x0', 'x1', 'x2']);
      const error = await refusal(
        listIn(withQuads(CHUNK_SET_MODULES_AT_LIMITS)),
      );
      expect(error.code).toBe('chunk-set-too-large');
    });
  });

  describe('changedSince', () => {
    const snapshot = new FakeSnapshot(content);
    const before = 'b'.repeat(40);
    const history = { [snapshot.commit]: [before] };
    const changedFrom = (paths: string[]) =>
      new FakeContentChanges(history, {
        [`${before}..${snapshot.commit}`]: paths,
      });

    it('lists the chunks a changed module file went into: its own and those including it', async () => {
      const changes = changedFrom(['modules/en/shared.adoc', 'symbols/x.svg']);
      const result = await list(
        { changedSince: before },
        { snapshot, changes },
      );
      expect(ids(result)).toEqual(['en/host', 'en/shared']);
      expect(result.total).toBe(2);
      expect(changes.asked).toEqual([{ from: before, to: snapshot.commit }]);
    });

    it('lists every chunk when the configuration changed, and those a changed manifest names', async () => {
      expect(
        (
          await list(
            { changedSince: before },
            { snapshot, changes: changedFrom(['openfolia.yaml']) },
          )
        ).total,
      ).toBe(4);
      expect(
        ids(
          await list(
            { changedSince: before },
            { snapshot, changes: changedFrom(['manuals/service.yaml']) },
          ),
        ),
      ).toEqual(['en/internals', 'en/shared']);
    });

    it('lists a chunk when a readable file of a module it depends on appeared: a translation it falls back from', async () => {
      const sharedDe = withMeta(module('shared', 'de', 'Geteilt.'), {});
      const hostDeRef = withBlocks(hostDe, [
        { type: 'moduleRef', id: 'r', module: 'shared' },
      ]);
      const now = new FakeSnapshot({
        ...content,
        modules: [host, hostDeRef, shared, sharedDe, internals],
      });
      const changes = new FakeContentChanges(
        { [now.commit]: [before] },
        { [`${before}..${now.commit}`]: ['modules/de/shared.adoc'] },
      );
      expect(
        ids(await list({ changedSince: before }, { snapshot: now, changes })),
      ).toEqual(['de/host', 'de/shared']);
    });

    it('tells nothing of a changed file the reader may not see', async () => {
      // `shared` names `internals` (internal): a public reader does not see it.
      const changes = changedFrom(['modules/en/internals.adoc']);
      expect(
        (
          await list(
            { changedSince: before },
            { snapshot, changes, actor: PUBLIC_ONLY },
          )
        ).total,
      ).toBe(0);
    });

    it('lists nothing for no change, and refuses a commit not in the history', async () => {
      expect(
        (
          await list(
            { changedSince: snapshot.commit },
            { snapshot, changes: changedFrom([]) },
          )
        ).total,
      ).toBe(0);
      const error = await list(
        { changedSince: 'a'.repeat(40) },
        { snapshot, changes: changedFrom([]) },
      ).catch((e) => e);
      expect(error).toBeInstanceOf(InvalidParameterError);
      expect(error.parameter).toBe('filter[changedSince]');
    });
  });

  it('refuses an actor who may not read, before reading', async () => {
    const changes = new FakeContentChanges();
    await expect(
      new ListChunksAction(changes).handle({
        actor: NOBODY,
        snapshot: readable(content),
        filter: { changedSince: 'a'.repeat(40) },
        page: PAGE,
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(changes.asked).toEqual([]);
  });
});
