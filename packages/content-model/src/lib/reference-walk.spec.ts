import { sampleConfig } from '../fixtures/config.js';
import { counting, diamond } from '../fixtures/diamond.js';
import type { Block } from './blocks.js';
import { ProjectConfig } from './config.js';
import { Manifest } from './manifest.js';
import { Module } from './module.js';
import { MAX_EXPANDED_NODES, MAX_NESTING_DEPTH } from './expansion.js';
import { resolveManual, type ResolvedEntry } from './resolve.js';

/**
 * #679: module references are walked once per context. A diamond of references (a module
 * referring to two, both referring to the same one, and so on down) reads each module once,
 * and a manual that expands past `MAX_EXPANDED_NODES` is refused with `expansion-too-large`.
 * Counted, never timed.
 */
const config = ProjectConfig.parse(sampleConfig);
const text = (t: string) => [{ type: 'text' as const, text: t }];

const manual = (notices = false): Manifest =>
  Manifest.parse({
    schemaVersion: 1,
    id: 'deep',
    title: 'Deep',
    variants: [{}],
    entries: [{ module: 'j0' }],
    ...(notices && {
      kind: 'derived',
      rule: { source: 'elsewhere', notices: { groupBy: 'module' } },
    }),
  });

const paragraphs = (entries: readonly ResolvedEntry[]): string[] => {
  const found: string[] = [];
  const visit = (blocks: readonly Block[]) => {
    for (const block of blocks) {
      if (block.type === 'paragraph' || block.type === 'safety') {
        const first =
          block.type === 'paragraph' ? block.content[0] : block.hazard[0];
        if (first?.type === 'text') found.push(first.text);
      }
      if (block.type === 'section') visit(block.blocks);
    }
  };
  for (const entry of entries) {
    if (entry.kind === 'module') visit(entry.blocks);
    else found.push(...paragraphs(entry.entries));
  }
  return found;
};

describe('module references walked once per context (#679)', () => {
  it('reads each module once on a diamond 12 levels deep, and still includes every path', () => {
    const { loadModule, loads, most } = counting({ en: diamond(12) });
    const { manual: resolved, issues } = resolveManual({
      manifest: manual(),
      variant: {},
      lang: 'en',
      config,
      loadModule,
    });
    expect(issues).toEqual([]);
    // 37 modules, each read once (without the walk, `j12` was read 4096 times).
    expect(loads.size).toBe(37);
    expect(most(loads)).toBe(1);
    // A module referred to over several paths appears once per path: the manual's real size.
    const texts = paragraphs(resolved.entries);
    expect(texts.filter((t) => t === 'j12')).toHaveLength(4096);
    expect(texts.filter((t) => t === 'j1')).toHaveLength(2);
    expect(texts[0]).toBe('j0');
    // Every copy gets an ID of its own, numbered in the order met.
    const copies = Object.keys(resolved.origins).filter((id) =>
      id.startsWith('j12--own'),
    );
    expect(copies).toEqual([
      'j12--own',
      ...Array.from({ length: 4095 }, (_, i) => `j12--own--${i + 2}`),
    ]);
    expect(resolved.anchors['j12']).toBe('j12--own');
  });

  it('reads a module and its fallback once each in a target language', () => {
    // Only `j0` is translated: every other module falls back to the source language.
    const de = new Map([['j0', diamond(12, { lang: 'de' }).get('j0')!]]);
    const { loadModule, loads, most } = counting({ en: diamond(12), de });
    const { issues } = resolveManual({
      manifest: manual(),
      variant: {},
      lang: 'de',
      config,
      loadModule,
    });
    expect(most(loads)).toBe(1);
    expect(loads.get('de/j12')).toBe(1);
    expect(loads.get('en/j12')).toBe(1);
    expect(loads.has('en/j0')).toBe(false);
    expect(issues.filter((i) => i.code === 'missing-translation')).toHaveLength(
      36,
    );
  });

  it('walks each module once when gathering notices from a diamond 12 levels deep', () => {
    const { loadModule, loads, blockReads, most } = counting({
      en: diamond(12, { notices: true }),
    });
    const { manual: resolved, issues } = resolveManual({
      manifest: manual(true),
      variant: {},
      lang: 'en',
      config,
      loadModule,
    });
    expect(issues).toEqual([]);
    expect(most(loads)).toBe(1);
    // Read for its size, its notices and what a link to it may land on: thrice, whatever the
    // paths (it was 4096 times for the bottom).
    expect(blockReads.size).toBe(37);
    expect(most(blockReads)).toBeLessThanOrEqual(3);
    // Each notice once, in the order the walk first meets it.
    const texts = paragraphs(resolved.entries);
    expect(texts).toHaveLength(37);
    expect(new Set(texts).size).toBe(37);
    expect(texts.slice(0, 4)).toEqual(['j0', 'a0', 'j1', 'a1']);
  });

  it('expands per reader: what one may not see is not in their manual, nor taken from another’s', () => {
    const modules = diamond(6);
    const input = {
      manifest: manual(),
      variant: {},
      lang: 'en',
      config,
      loadModule: (id: string, lang: string) =>
        lang === 'en' ? modules.get(id) : undefined,
    };
    const everyone = resolveManual(input);
    const noB = resolveManual({
      ...input,
      visible: (m) => !m.id.startsWith('b'),
    });
    const again = resolveManual(input);
    const all = paragraphs(everyone.manual.entries);
    const some = paragraphs(noB.manual.entries);
    expect(all.filter((t) => t === 'j6')).toHaveLength(64);
    // Without the `b` modules only one path is left down the diamond.
    expect(some.filter((t) => t === 'j6')).toHaveLength(1);
    expect(some.some((t) => t.startsWith('b'))).toBe(false);
    expect(noB.issues.filter((i) => i.code === 'outside-scope')).toHaveLength(
      6,
    );
    // Nothing carries over from one resolution to the next.
    expect(again).toEqual(everyone);
  });

  describe('the expanded size', () => {
    it('refuses a manual expanding past the limit with expansion-too-large, without expanding it all', () => {
      // 2^24 paths down, nested 48 deep (within the depth limit): refused once the size limit
      // is reached, never walked to the end.
      const { loadModule, loads, most } = counting({ en: diamond(24) });
      const {
        manual: resolved,
        issues,
        hidden,
      } = resolveManual({
        manifest: manual(),
        variant: {},
        lang: 'en',
        config,
        loadModule,
      });
      expect(issues).toEqual([
        {
          severity: 'error',
          code: 'expansion-too-large',
          message: expect.stringContaining(
            MAX_EXPANDED_NODES.toLocaleString('en'),
          ),
        },
      ]);
      expect(resolved.entries).toEqual([]);
      expect(resolved.origins).toEqual({});
      expect(resolved.anchors).toEqual({});
      expect(hidden).toEqual([]);
      expect(most(loads)).toBe(1);
    });

    it('refuses a notice gathering whose notices expand past it', () => {
      // A notice that refers to a deep diamond holds all of it.
      const modules = diamond(24);
      modules.set(
        'top',
        Module.parse({
          schemaVersion: 1,
          id: 'top',
          meta: { title: 'Top', type: 'concept', lang: 'en' },
          blocks: [
            {
              type: 'safety',
              id: 'n',
              severity: 'danger',
              hazard: text('Deep'),
              symbols: [],
              blocks: [{ type: 'moduleRef', id: 'to-j0', module: 'j0' }],
            },
          ],
        }),
      );
      const { issues, manual: resolved } = resolveManual({
        manifest: { ...manual(true), entries: [{ module: 'top' }] },
        variant: {},
        lang: 'en',
        config,
        loadModule: (id) => modules.get(id),
      });
      expect(issues.map((i) => i.code)).toEqual(['expansion-too-large']);
      expect(resolved.entries).toEqual([]);
    });

    it('takes a manual of exactly the limit, and refuses one content node more', () => {
      // Parsed once (#734): the module at the limit, then the same with one node more.
      const flat = Module.parse({
        schemaVersion: 1,
        id: 'flat',
        meta: { title: 'Flat', type: 'concept', lang: 'en' },
        blocks: Array.from({ length: MAX_EXPANDED_NODES / 2 }, (_, i) => ({
          type: 'paragraph',
          id: `p${i}`,
          content: text('x'),
        })),
      });
      const resolveFlat = (pageBreak = false) => {
        const module: Module = pageBreak
          ? {
              ...flat,
              blocks: [...flat.blocks, { type: 'pageBreak', id: 'end' }],
            }
          : flat;
        return resolveManual({
          manifest: { ...manual(), entries: [{ module: 'flat' }] },
          variant: {},
          lang: 'en',
          config,
          loadModule: () => module,
        });
      };
      // A paragraph of one text is two content nodes; a page break one.
      expect(resolveFlat().issues).toEqual([]);
      expect(resolveFlat(true).issues).toEqual([
        expect.objectContaining({ code: 'expansion-too-large' }),
      ]);
    });

    it('counts what each copy holds: its inline content, and references that lead round', () => {
      const bottom = (blocks?: Block[]) => {
        const modules = diamond(10);
        if (blocks) {
          modules.set(
            'j10',
            Module.parse({
              schemaVersion: 1,
              id: 'j10',
              meta: { title: 'j10', type: 'concept', lang: 'en' },
              blocks,
            }),
          );
        }
        return resolveManual({
          manifest: manual(),
          variant: {},
          lang: 'en',
          config,
          loadModule: (id) => modules.get(id),
        }).issues.map((i) => i.code);
      };
      // 1,024 paths down: well within the limits with a light bottom …
      expect(bottom()).toEqual([]);
      // … past them with a paragraph of 2,000 runs of text at the bottom,
      const runs = Array.from({ length: 2000 }, (_, i) => ({
        type: 'text' as const,
        text: `run ${i}`,
        ...(i % 2 === 0 && { marks: [{ type: 'strong' as const }] }),
      }));
      expect(
        bottom([{ type: 'paragraph', id: 'long', content: runs }]),
      ).toEqual(['expansion-too-large']);
      // … or 2,000 references back to the top, each a cycle.
      const back = Array.from({ length: 2000 }, (_, i): Block => ({
        type: 'moduleRef',
        id: `up-${i}`,
        module: 'j0',
      }));
      expect(bottom(back)).toEqual(['expansion-too-large']);
    });

    it('counts text: a long text reached often, attribute values, and the messages of cycles', () => {
      const long = Module.parse({
        schemaVersion: 1,
        id: 'long',
        meta: { title: 'long', type: 'concept', lang: 'en' },
        blocks: [
          { type: 'paragraph', id: 'p', content: text('x'.repeat(1_000_000)) },
        ],
      });
      const fan = (count: number, target = 'long'): Module =>
        Module.parse({
          schemaVersion: 1,
          id: 'fan',
          meta: { title: 'fan', type: 'concept', lang: 'en' },
          blocks: Array.from({ length: count }, (_, i) => ({
            type: 'moduleRef',
            id: `r${i}`,
            module: target,
          })),
        });
      const resolveWith = (modules: Module[], manifest = manual()) =>
        resolveManual({
          manifest: { ...manifest, entries: [{ module: modules[0]!.id }] },
          variant: {},
          lang: 'en',
          config,
          loadModule: (id) => modules.find((m) => m.id === id),
        }).issues.map((i) => i.code);
      // A few dozen nodes, but 20 MB of text: refused; 10 MB is within the limit.
      expect(resolveWith([fan(10), long])).toEqual([]);
      expect(resolveWith([fan(20), long])).toEqual(['expansion-too-large']);
      // A short `{attribute}` that fills in a long value, reached 20 times.
      const attr = Module.parse({
        schemaVersion: 1,
        id: 'long',
        meta: { title: 'long', type: 'concept', lang: 'en' },
        blocks: [
          {
            type: 'paragraph',
            id: 'p',
            content: [{ type: 'attribute', name: 'product-name' }],
          },
        ],
      });
      const named = {
        ...manual(),
        attributes: { 'product-name': 'x'.repeat(1_000_000) },
      };
      expect(resolveWith([fan(20), attr], named)).toEqual([
        'expansion-too-large',
      ]);
      // 90 modules with long IDs in a chain, the last referring 2,500 times back to the
      // first: each reference a cycle whose message names the whole way round.
      const id = (i: number) => `${'m'.repeat(60)}-${i}`;
      const chain = Array.from({ length: 90 }, (_, i) =>
        Module.parse({
          schemaVersion: 1,
          id: id(i),
          meta: { title: 'm', type: 'concept', lang: 'en' },
          blocks:
            i < 89
              ? [{ type: 'moduleRef', id: 'next', module: id(i + 1) }]
              : Array.from({ length: 2500 }, (_, k) => ({
                  type: 'moduleRef',
                  id: `back-${k}`,
                  module: id(0),
                })),
        }),
      );
      expect(resolveWith(chain)).toEqual(['expansion-too-large']);
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
            Module.parse({
              schemaVersion: 1,
              id: `c${i}`,
              meta: { title: `c${i}`, type: 'concept', lang: 'en' },
              blocks: [
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
              ],
            }),
          );
        }
        return (notices: boolean) =>
          resolveManual({
            manifest: { ...manual(notices), entries: [{ module: 'c0' }] },
            variant: {},
            lang: 'en',
            config,
            loadModule: (id) => modules.get(id),
          }).issues;
      };
      const refused = [
        {
          severity: 'error',
          code: 'expansion-too-large',
          message: expect.stringContaining(`${MAX_NESTING_DEPTH} deep`),
        },
      ];
      for (const notices of [false, true]) {
        // A module's blocks are a level, and so are a block's: the chain's last module sits at
        // its length plus one, its safety message's content one deeper.
        expect(chain(MAX_NESTING_DEPTH - 2)(notices)).toEqual([]);
        expect(chain(MAX_NESTING_DEPTH - 1)(notices)).toEqual(refused);
        // Thousands deep: refused, not a stack overflow.
        expect(chain(5000)(notices)).toEqual(refused);
        // 20 modules, each reference inside 30 notes: refused as well.
        expect(chain(20, 30)(notices)).toEqual(refused);
      }
    });

    it('numbers copies past a block ID that looks like a copy’s, as before', () => {
      const x = Module.parse({
        schemaVersion: 1,
        id: 'x',
        meta: { title: 'x', type: 'concept', lang: 'en' },
        blocks: [
          { type: 'paragraph', id: 'p', content: text('p') },
          { type: 'paragraph', id: 'p--2', content: text('p--2') },
        ],
      });
      const { manual: resolved } = resolveManual({
        manifest: {
          ...manual(),
          entries: [{ module: 'x' }, { module: 'x' }, { module: 'x' }],
        },
        variant: {},
        lang: 'en',
        config,
        loadModule: () => x,
      });
      expect(Object.keys(resolved.origins)).toEqual([
        'x--p',
        'x--p--2',
        'x--p--3',
        'x--p--2--2',
        'x--p--4',
        'x--p--2--3',
      ]);
    });
  });
});
