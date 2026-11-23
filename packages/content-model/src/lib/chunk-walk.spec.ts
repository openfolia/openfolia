import { sampleConfig } from '../fixtures/config.js';
import { counting, diamond } from '../fixtures/diamond.js';
import type { Block } from './blocks.js';
import { toChunk, toChunks, type ChunkInput } from './chunk.js';
import { ProjectConfig } from './config.js';
import {
  ExpansionBudget,
  ExpansionBudgetError,
  CHUNK_SET_KEPT_AT_LIMITS,
  CHUNK_SET_MODULES_AT_LIMITS,
  EXPANSION_LIMITS,
  ExpansionTooLargeError,
  MAX_CHUNK_SET_FACTOR,
  MAX_EXPANDED_CHARS,
  MAX_EXPANDED_NODES,
  MAX_EXPANDED_TABLE_CELLS,
  MAX_NESTING_DEPTH,
  weightOf,
} from './expansion.js';
import { Module } from './module.js';

/**
 * #681: the module references of a chunk are walked as `resolveManual` walks them (#679).
 * Each module is read once however many paths lead to it, and a chunk that expands past the
 * limits is refused with `ExpansionTooLargeError`. Counted, never timed.
 */
// Some tests make content of hundreds of thousands of nodes: seconds on a loaded machine.
vi.setConfig({ testTimeout: 30_000 });

const config = ProjectConfig.parse(sampleConfig);

const text = (t: string) => [{ type: 'text' as const, text: t }];
const concept = (id: string, blocks: unknown[]): Module =>
  Module.parse({
    schemaVersion: 1,
    id,
    meta: { title: id, type: 'concept', lang: 'en', audience: 'public' },
    blocks,
  });
/** The chunks of `root`, the others to include found in `modules` (any language: English). */
const chunksOf = (
  root: string,
  modules: ReadonlyMap<string, Module>,
  options: Partial<ChunkInput> = {},
) =>
  toChunks({
    module: modules.get(root)!,
    config,
    loadModule: (id) => modules.get(id),
    ...options,
  });
/** What `go` throws: an `ExpansionTooLargeError`, said whether for the depth. */
const refusal = (go: () => unknown) => {
  try {
    go();
  } catch (error) {
    if (error instanceof ExpansionTooLargeError) {
      return error.depth ? 'too deep' : 'too large';
    }
    throw error;
  }
  return 'made';
};

const count = (text: string, word: string) =>
  text.split('\n').filter((line) => line === word).length;

describe('the module references of a chunk (#681)', () => {
  it('reads each module once on a diamond 12 levels deep, and still includes every path', () => {
    const { loadModule, loads, most } = counting({ en: diamond(12) });
    const modules = diamond(12);
    const [chunk, ...entries] = toChunks({
      module: modules.get('j0')!,
      config,
      loadModule,
    });
    expect(entries).toEqual([]);
    // 36 modules referred to, each read once (without the walk, `j12` was read 4096 times).
    expect(loads.size).toBe(36);
    expect(most(loads)).toBe(1);
    // A module referred to over several paths is in the text once per path.
    expect(count(chunk!.text, 'j12')).toBe(4096);
    expect(count(chunk!.text, 'j1')).toBe(2);
    expect(chunk!.sources).toHaveLength(37);
  });

  it('reads a module and its fallback once each in a target language', () => {
    // Only `j0` is translated: every other module falls back to the source language.
    const de = new Map([['j0', diamond(12, { lang: 'de' }).get('j0')!]]);
    const { loadModule, loads, most } = counting({ en: diamond(12), de });
    toChunks({ module: de.get('j0')!, config, loadModule });
    expect(most(loads)).toBe(1);
    expect(loads.get('de/j12')).toBe(1);
    expect(loads.get('en/j12')).toBe(1);
  });

  it('reads a cross-reference target once, however many paths reach the reference', () => {
    const modules = diamond(10);
    modules.set(
      'j10',
      concept('j10', [
        {
          type: 'paragraph',
          id: 'see',
          content: [{ type: 'xref', module: 'elsewhere' }],
        },
      ]),
    );
    modules.set('elsewhere', concept('elsewhere', []));
    const { loadModule, loads, most } = counting({ en: modules });
    const [chunk] = toChunks({
      module: modules.get('j0')!,
      config,
      loadModule,
    });
    expect(most(loads)).toBe(1);
    expect(loads.get('en/elsewhere')).toBe(1);
    expect(chunk!.dependsOn).toContain('elsewhere');
  });

  it('expands per reader: what one may not see is not in their chunk, nor taken from another’s', () => {
    const modules = diamond(6);
    const everyone = chunksOf('j0', modules);
    const noB = chunksOf('j0', modules, {
      loadModule: (id) => (id.startsWith('b') ? undefined : modules.get(id)),
    });
    const again = chunksOf('j0', modules);
    expect(count(everyone[0]!.text, 'j6')).toBe(64);
    // Without the `b` modules only one path is left down the diamond.
    expect(count(noB[0]!.text, 'j6')).toBe(1);
    expect(noB[0]!.text).not.toMatch(/^b\d/m);
    expect(noB[0]!.sources.some((s) => s.moduleId.startsWith('b'))).toBe(false);
    // Nothing carries over from one call to the next.
    expect(again).toEqual(everyone);
    // A reader who may not see half of a diamond too large for the other gets its chunk.
    const deep = diamond(24);
    expect(refusal(() => chunksOf('j0', deep))).toBe('too large');
    expect(
      refusal(() =>
        chunksOf('j0', deep, {
          loadModule: (id) => (id.startsWith('b') ? undefined : deep.get(id)),
        }),
      ),
    ).toBe('made');
    expect(refusal(() => chunksOf('j0', deep))).toBe('too large');
  });

  describe('the expanded size', () => {
    it('refuses a chunk expanding past the limit, without expanding it all', () => {
      // 2^24 paths down, nested 49 deep (within the depth limit): refused once the size limit
      // is reached, never walked to the end.
      const { loadModule, loads, most } = counting({ en: diamond(24) });
      const module = diamond(24).get('j0')!;
      expect(refusal(() => toChunks({ module, config, loadModule }))).toBe(
        'too large',
      );
      expect(most(loads)).toBe(1);
      expect(refusal(() => toChunk({ module, config, loadModule }))).toBe(
        'too large',
      );
      // With a variant too.
      expect(
        refusal(() =>
          toChunks({ module, config, loadModule, variant: { model: 'large' } }),
        ),
      ).toBe('too large');
    });

    it('takes a chunk of exactly the limit, and refuses one content node more', () => {
      // Parsed once (#734): the module at the limit, then the same with one node more.
      const flat = concept(
        'flat',
        Array.from({ length: MAX_EXPANDED_NODES / 2 }, (_, i) => ({
          type: 'paragraph',
          id: `p${i}`,
          content: text('x'),
        })),
      );
      const make = (module: Module) => () =>
        toChunks({ module, config, loadModule: () => undefined });
      // A paragraph of one text is two content nodes; a page break one.
      expect(refusal(make(flat))).toBe('made');
      expect(
        refusal(
          make({
            ...flat,
            blocks: [...flat.blocks, { type: 'pageBreak', id: 'end' }],
          }),
        ),
      ).toBe('too large');
    });

    it('counts what each copy holds: its inline content, and references that lead round', () => {
      const bottom = (blocks?: unknown[]) => {
        const modules = diamond(10);
        if (blocks) modules.set('j10', concept('j10', blocks));
        return refusal(() => chunksOf('j0', modules));
      };
      // 1,024 paths down: well within the limits with a light bottom …
      expect(bottom()).toBe('made');
      // … past them with a paragraph of 2,000 runs of text at the bottom,
      const runs = Array.from({ length: 2000 }, (_, i) => ({
        type: 'text' as const,
        text: `run ${i}`,
        ...(i % 2 === 0 && { marks: [{ type: 'strong' as const }] }),
      }));
      expect(bottom([{ type: 'paragraph', id: 'long', content: runs }])).toBe(
        'too large',
      );
      // … or 2,000 references back to the top, each a cycle.
      const back = Array.from({ length: 2000 }, (_, i) => ({
        type: 'moduleRef',
        id: `up-${i}`,
        module: 'j0',
      }));
      expect(bottom(back)).toBe('too large');
    });

    it('counts text: a long text reached often, a long cross-reference title, and what quotes add', () => {
      const fan = (count: number, target: string, wrap = false): Module =>
        concept(
          'fan',
          Array.from({ length: count }, (_, i) => {
            const ref = { type: 'moduleRef', id: `r${i}`, module: target };
            return wrap
              ? { type: 'admonition', id: `n${i}`, kind: 'note', blocks: [ref] }
              : ref;
          }),
        );
      const chunk = (...modules: Module[]) =>
        refusal(() =>
          chunksOf(modules[0]!.id, new Map(modules.map((m) => [m.id, m]))),
        );
      // A few dozen nodes, but 20 MB of text: refused; 10 MB is within the limit.
      const long = concept('long', [
        { type: 'paragraph', id: 'p', content: text('x'.repeat(1_000_000)) },
      ]);
      expect(chunk(fan(10, 'long'), long)).toBe('made');
      expect(chunk(fan(20, 'long'), long)).toBe('too large');
      // A cross-reference showing a title of 1,000,000 characters, reached 20 times.
      const titled = Module.parse({
        ...concept('titled', []),
        meta: {
          title: 't'.repeat(1_000_000),
          type: 'concept',
          lang: 'en',
          audience: 'public',
        },
      });
      const see = concept('see', [
        {
          type: 'paragraph',
          id: 'p',
          content: [{ type: 'xref', module: 'titled' }],
        },
      ]);
      expect(chunk(fan(10, 'see'), see, titled)).toBe('made');
      expect(chunk(fan(20, 'see'), see, titled)).toBe('too large');
      // A literal of 200,000 line breaks: 0.2 MB of text, but each note it is quoted in adds
      // two characters a line, and a chain of notes writes it again at each level.
      const lines = (breaks: boolean) =>
        concept('lines', [
          {
            type: 'literal',
            id: 'l',
            text: breaks ? '\n'.repeat(200_000) : 'x'.repeat(200_000),
          },
        ]);
      const chain = Array.from({ length: 10 }, (_, i) =>
        concept(`c${i}`, [
          {
            type: 'admonition',
            id: 'n',
            kind: 'note',
            blocks: [
              {
                type: 'moduleRef',
                id: 'next',
                module: i < 9 ? `c${i + 1}` : 'lines',
              },
            ],
          },
        ]),
      );
      expect(chunk(...chain, lines(false))).toBe('made');
      expect(chunk(...chain, lines(true))).toBe('too large');
    });

    it('counts a table’s grid before making it: few cells may span a large area', () => {
      // Tables within the caps (#686: 1,000 columns, 50,000 cells), each 901 columns by 50 rows:
      // a cell a row in the first column, and at the top 9 cells spanning 100 columns by 50 rows
      // over the others: a few hundred nodes, but 45,050 grid places. One module may hold 22
      // (`MAX_MODULE_TABLE_CELLS`), so a chunk reaches more only through references: each
      // inclusion is counted, and 23 pass `MAX_EXPANDED_TABLE_CELLS`.
      const table = (n: number): Block => ({
        type: 'table',
        id: `t${n}`,
        header: false,
        columns: Array.from({ length: 901 }, () => ({ width: 1 })),
        rows: Array.from({ length: 50 }, (_, r) => ({
          cells: [
            {
              blocks: [
                { type: 'paragraph', id: `p${n}-${r}`, content: text('x') },
              ],
            },
            ...(r === 0
              ? Array.from({ length: 9 }, (_, c) => ({
                  colspan: 100,
                  rowspan: 50,
                  blocks: [
                    {
                      type: 'paragraph' as const,
                      id: `p${n}-${r}-${c}`,
                      content: text('x'),
                    },
                  ],
                }))
              : []),
          ],
        })),
      });
      const wide = concept('wide', [table(0)]);
      const make = (refs: number) => () =>
        toChunks({
          module: concept(
            'hub',
            Array.from({ length: refs }, (_, n) => ({
              type: 'moduleRef',
              id: `r${n}`,
              module: 'wide',
            })),
          ),
          config,
          loadModule: (id) => (id === 'wide' ? wide : undefined),
        });
      expect(refusal(make(22))).toBe('made');
      expect(refusal(make(23))).toBe('too large');
    });

    it('refuses content nested deeper than the depth limit, references or blocks', () => {
      const chain = (length: number, wrap = 0) => {
        const modules = new Map<string, Module>();
        const around = (inner: Block[]): Block[] => {
          let blocks = inner;
          for (let n = 0; n < wrap; n++) {
            blocks = [
              { type: 'admonition', id: `a${n}`, kind: 'note', blocks },
            ];
          }
          return blocks;
        };
        for (let i = 0; i <= length; i++) {
          modules.set(
            `c${i}`,
            concept(`c${i}`, [
              {
                type: 'safety',
                id: 'own',
                severity: 'warning',
                hazard: text(`c${i}`),
                symbols: [],
                blocks: [],
              },
              ...(i < length
                ? around([
                    { type: 'moduleRef', id: 'next', module: `c${i + 1}` },
                  ])
                : []),
            ]),
          );
        }
        return refusal(() => chunksOf('c0', modules));
      };
      // A module's blocks are a level, and so are a block's: the chain's last module sits at
      // its length plus one, its safety message's content one deeper.
      expect(chain(MAX_NESTING_DEPTH - 2)).toBe('made');
      expect(chain(MAX_NESTING_DEPTH - 1)).toBe('too deep');
      // Thousands deep: refused, not a stack overflow.
      expect(chain(5000)).toBe('too deep');
      // 20 modules, each reference inside 30 notes: refused as well.
      expect(chain(20, 30)).toBe('too deep');
    });

    it('counts an FAQ entry’s chunk with the module’s, in one call', () => {
      // A module of one FAQ entry whose answer refers to a long module ten times: its chunk and
      // the entry's each hold 10 MB, past the limit together.
      const long = concept('long', [
        { type: 'paragraph', id: 'p', content: text('x'.repeat(1_000_000)) },
      ]);
      const faq = (count: number) =>
        concept('faq', [
          {
            type: 'faq',
            id: 'q',
            question: text('Why?'),
            blocks: Array.from({ length: count }, (_, i) => ({
              type: 'moduleRef',
              id: `r${i}`,
              module: 'long',
            })),
          },
        ]);
      const modules = (count: number) =>
        new Map([
          ['faq', faq(count)],
          ['long', long],
        ]);
      expect(refusal(() => chunksOf('faq', modules(5)))).toBe('made');
      expect(refusal(() => chunksOf('faq', modules(7)))).toBe('too large');
      expect(
        refusal(() =>
          toChunk({
            module: faq(7),
            config,
            loadModule: (id) => modules(7).get(id),
          }),
        ),
      ).toBe('made');
    });
  });

  describe('a budget several calls share (#684)', () => {
    const unbounded = () =>
      new ExpansionBudget({
        nodes: Infinity,
        chars: Infinity,
        cells: Infinity,
      });

    it('spends what each call counts, with the same counters', () => {
      const modules = diamond(8);
      const spentOn = (root: string) => {
        const budget = unbounded();
        chunksOf(root, modules, { budget });
        return budget.spent;
      };
      const j0 = spentOn('j0');
      const a3 = spentOn('a3');
      // The diamond's bottom, `j8`, is in `j0`'s text over 256 paths: each counted.
      expect(j0.nodes).toBeGreaterThan(
        256 * weightOf(modules.get('j8')!.blocks).nodes,
      );
      const shared = unbounded();
      chunksOf('j0', modules, { budget: shared });
      chunksOf('a3', modules, { budget: shared });
      expect(shared.spent).toEqual({
        nodes: j0.nodes + a3.nodes,
        chars: j0.chars + a3.chars,
        cells: j0.cells + a3.cells,
      });
    });

    it('stops the call that spends it, without expanding it all, and every call after', () => {
      const modules = diamond(14);
      const one = unbounded();
      chunksOf('j0', modules, { budget: one });
      // Each call alone is within the limits of #679; two together pass the budget.
      const budget = new ExpansionBudget({
        nodes: Math.floor(one.spent.nodes * 1.5),
        chars: Infinity,
        cells: Infinity,
      });
      chunksOf('j0', modules, { budget });
      expect(() => chunksOf('j0', modules, { budget })).toThrow(
        ExpansionBudgetError,
      );
      // The second call stopped once past it: one charge past, not a whole chunk more.
      expect(budget.spent.nodes).toBeLessThan(one.spent.nodes * 1.5 + 10);
      expect(() => chunksOf('j1', modules, { budget })).toThrow(
        ExpansionBudgetError,
      );
      expect(() => chunksOf('a0', modules, { budget })).toThrow(
        ExpansionBudgetError,
      );
    });

    it('is checked before the limits of #679: a call past both reports the budget', () => {
      const deep = diamond(24);
      expect(refusal(() => chunksOf('j0', deep))).toBe('too large');
      // The same limit as the walk's own: the charge that passes one passes both.
      const budget = new ExpansionBudget({
        nodes: MAX_EXPANDED_NODES,
        chars: Infinity,
        cells: Infinity,
      });
      expect(() => chunksOf('j0', deep, { budget })).toThrow(
        ExpansionBudgetError,
      );
      expect(budget.spent.nodes).toBeLessThan(MAX_EXPANDED_NODES + 10);
    });

    it('counts a module past the limits of #679 as far as it was walked', () => {
      const deep = diamond(24);
      const budget = unbounded();
      expect(refusal(() => chunksOf('j0', deep, { budget }))).toBe('too large');
      expect(budget.spent.nodes).toBeGreaterThan(MAX_EXPANDED_NODES);
    });

    it('scales with the content it is made from, with room for a few modules at the limits', () => {
      const room = {
        nodes: CHUNK_SET_MODULES_AT_LIMITS * MAX_EXPANDED_NODES,
        chars: CHUNK_SET_MODULES_AT_LIMITS * MAX_EXPANDED_CHARS,
        cells: CHUNK_SET_MODULES_AT_LIMITS * MAX_EXPANDED_TABLE_CELLS,
      };
      expect(ExpansionBudget.forContent([]).limit).toEqual(room);
      const big = { nodes: 400_000, chars: 10_000_000, cells: 300_000 };
      expect(ExpansionBudget.forContent([big, big]).limit).toEqual({
        nodes: 800_000 * MAX_CHUNK_SET_FACTOR + room.nodes,
        chars: 20_000_000 * MAX_CHUNK_SET_FACTOR + room.chars,
        cells: 600_000 * MAX_CHUNK_SET_FACTOR + room.cells,
      });
    });
  });
  describe('the limits given (#726: tests only)', () => {
    const small = { nodes: 100, chars: 1_000, cells: 50, depth: 4 };
    const flat = (count: number) =>
      concept(
        'flat',
        Array.from({ length: count }, (_, i) => ({
          type: 'paragraph',
          id: `p${i}`,
          content: text('x'),
        })),
      );
    const message = (go: () => unknown) => {
      try {
        go();
      } catch (error) {
        if (error instanceof ExpansionTooLargeError) return error.message;
        throw error;
      }
      return 'made';
    };

    it('are the limits of #679 unless given, frozen', () => {
      expect(EXPANSION_LIMITS).toEqual({
        nodes: MAX_EXPANDED_NODES,
        chars: MAX_EXPANDED_CHARS,
        cells: MAX_EXPANDED_TABLE_CELLS,
        depth: MAX_NESTING_DEPTH,
      });
      expect(Object.isFrozen(EXPANSION_LIMITS)).toBe(true);
      // The message names the limits held to: those of #679 by default.
      expect(new ExpansionTooLargeError(false).message).toContain('500,000');
      expect(new ExpansionTooLargeError(true).message).toContain('100 deep');
      expect(ExpansionBudget.forContent([]).keptChars).toBe(
        CHUNK_SET_KEPT_AT_LIMITS * MAX_EXPANDED_CHARS,
      );
    });

    it('hold a call to exactly the nodes given, and name them', () => {
      const make = (module: Module) => () =>
        toChunks({
          module,
          config,
          loadModule: () => undefined,
          limits: small,
        });
      // A paragraph of one text is two content nodes.
      expect(message(make(flat(50)))).toBe('made');
      expect(message(make(flat(51)))).toContain('more than 100 content nodes');
      // Without limits, the same is far within those of #679.
      expect(
        message(() =>
          toChunks({ module: flat(51), config, loadModule: () => undefined }),
        ),
      ).toBe('made');
    });

    it('hold a call to the depth given', () => {
      const nested = (levels: number): Block[] => {
        let blocks: Block[] = [
          { type: 'paragraph', id: 'p', content: text('x') },
        ];
        for (let n = 0; n < levels; n++) {
          blocks = [{ type: 'admonition', id: `a${n}`, kind: 'note', blocks }];
        }
        return blocks;
      };
      const make = (levels: number) => () =>
        toChunks({
          module: concept('deep', nested(levels)),
          config,
          loadModule: () => undefined,
          limits: small,
        });
      // The module's blocks are a level, and each note's blocks one more: four levels of
      // blocks fit, five do not.
      expect(message(make(3))).toBe('made');
      expect(message(make(4))).toContain('nest more than 4 deep');
    });

    it('give a set room for modules at the limits given', () => {
      const budget = ExpansionBudget.forContent(
        [{ nodes: 10, chars: 100, cells: 1 }],
        small,
      );
      expect(budget.limit).toEqual({
        nodes: 10 * MAX_CHUNK_SET_FACTOR + CHUNK_SET_MODULES_AT_LIMITS * 100,
        chars: 100 * MAX_CHUNK_SET_FACTOR + CHUNK_SET_MODULES_AT_LIMITS * 1_000,
        cells: 1 * MAX_CHUNK_SET_FACTOR + CHUNK_SET_MODULES_AT_LIMITS * 50,
      });
      expect(budget.keptChars).toBe(
        100 * MAX_CHUNK_SET_FACTOR + CHUNK_SET_KEPT_AT_LIMITS * 1_000,
      );
    });
  });
});
