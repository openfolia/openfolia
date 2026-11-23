import { sampleConfig } from '../fixtures/config.js';
import type { Block } from './blocks.js';
import { ProjectConfig } from './config.js';
import { MAX_EXPANDED_NODES } from './expansion.js';
import { Manifest } from './manifest.js';
import { Module } from './module.js';
import { resolveManual, type ResolvedEntry } from './resolve.js';

/** #223: a module reference to one block of another module. */
const config = ProjectConfig.parse(sampleConfig);
const text = (t: string) => [{ type: 'text' as const, text: t }];
const paragraph = (id: string, t: string): Block => ({
  type: 'paragraph',
  id,
  content: text(t),
});

const module = (id: string, blocks: Block[]): Module =>
  Module.parse({
    schemaVersion: 1,
    id,
    meta: { title: id, type: 'concept', lang: 'en' },
    blocks,
  });

/** The shared module: a warning, a table in a section, and one block only one model shows. */
const shared = module('shared', [
  paragraph('intro', 'Shared intro.'),
  {
    type: 'safety',
    id: 'acid',
    severity: 'warning',
    symbols: [],
    hazard: text('Battery acid'),
    blocks: [
      {
        type: 'variant',
        id: 'acid-l400',
        when: { op: 'in', attr: 'model', values: ['l-400'] },
        blocks: [paragraph('acid-gloves', 'Wear gloves on the L-400.')],
      },
      paragraph('acid-rinse', 'Rinse with water.'),
    ],
  },
  {
    type: 'section',
    id: 'specs',
    title: text('Specifications'),
    blocks: [
      {
        type: 'variant',
        id: 'specs-l200',
        when: { op: 'in', attr: 'model', values: ['l-200'] },
        blocks: [paragraph('l200-only', 'L-200 only.')],
      },
    ],
  },
]);

const manual = (entries: string[], notices = false): Manifest =>
  Manifest.parse({
    schemaVersion: 1,
    id: 'm',
    title: 'M',
    variants: [{ model: 'l-400' }],
    entries: entries.map((id) => ({ module: id })),
    ...(notices && {
      kind: 'derived',
      rule: { source: 'elsewhere', notices: { groupBy: 'module' } },
    }),
  });

const resolve = (
  modules: Module[],
  options: { variant?: Record<string, string>; notices?: boolean } = {},
) => {
  const byId = new Map(modules.map((m) => [m.id, m]));
  const read = new Map<string, number>();
  const result = resolveManual({
    manifest: manual([modules[0]?.id ?? ''], options.notices),
    variant: options.variant ?? { model: 'l-400' },
    lang: 'en',
    config,
    loadModule: (id, lang) => {
      read.set(id, (read.get(id) ?? 0) + 1);
      return lang === 'en' ? byId.get(id) : undefined;
    },
  });
  return { ...result, read };
};

const blocksOf = (entries: readonly ResolvedEntry[]): Block[] =>
  entries.flatMap((e) =>
    e.kind === 'module' ? e.blocks : blocksOf(e.entries),
  );

const texts = (blocks: readonly Block[]): string[] =>
  JSON.stringify(blocks)
    .match(/"text":"[^"]*"/g)
    ?.map((t) => t.slice(8, -1)) ?? [];

describe('a module reference to one block (#223)', () => {
  it('places only that block, its variants applied, and follows its changes', () => {
    const page = module('page', [
      paragraph('own', 'Own text.'),
      { type: 'moduleRef', id: 'warn', module: 'shared', block: 'acid' },
    ]);
    const { manual: resolved, issues } = resolve([page, shared]);
    expect(issues).toEqual([]);
    const blocks = blocksOf(resolved.entries);
    expect(blocks.map((b) => b.id)).toEqual(['page--own', 'shared--acid']);
    expect(texts(blocks)).toEqual([
      'Own text.',
      'Battery acid',
      'Wear gloves on the L-400.',
      'Rinse with water.',
    ]);
    expect(resolved.origins['shared--acid']).toEqual({
      module: 'shared',
      block: 'acid',
    });
    // Its variant blocks follow the manual's variant.
    const l200 = resolve([page, shared], { variant: { model: 'l-200' } });
    expect(texts(blocksOf(l200.manual.entries))).not.toContain(
      'Wear gloves on the L-400.',
    );
    // A change in the shared module is what the next build places.
    const changed = module('shared', [
      {
        ...(shared.blocks[1] as Extract<Block, { type: 'safety' }>),
        hazard: text('Corrosive acid'),
      },
    ]);
    expect(texts(blocksOf(resolve([page, changed]).manual.entries))).toContain(
      'Corrosive acid',
    );
  });

  it('places a nested block, and nothing when a variant block around it is hidden', () => {
    const page = module('page', [
      {
        type: 'moduleRef',
        id: 'gloves',
        module: 'shared',
        block: 'acid-gloves',
      },
      { type: 'moduleRef', id: 'only', module: 'shared', block: 'l200-only' },
    ]);
    const { manual: resolved, issues, hidden } = resolve([page, shared]);
    expect(issues).toEqual([]);
    expect(blocksOf(resolved.entries).map((b) => b.id)).toEqual([
      'shared--acid-gloves',
    ]);
    expect(hidden).toEqual([
      expect.objectContaining({
        kind: 'block',
        module: 'shared',
        block: 'specs-l200',
      }),
    ]);
  });

  it('reports a block the module does not have, and includes nothing for it', () => {
    const page = module('page', [
      { type: 'moduleRef', id: 'gone', module: 'shared', block: 'nowhere' },
    ]);
    const { manual: resolved, issues } = resolve([page, shared]);
    expect(blocksOf(resolved.entries)).toEqual([]);
    expect(issues).toEqual([
      {
        severity: 'error',
        code: 'module-ref-unknown-block',
        message:
          'refers to the block "nowhere" of "shared", which does not exist',
        module: 'shared',
        at: { module: 'page', block: 'gone' },
        target: { module: 'shared', block: 'nowhere' },
      },
    ]);
  });

  it('lands links on the block it places, and warns of the blocks it leaves out', () => {
    const link = (id: string, block?: string): Block => ({
      type: 'paragraph',
      id,
      content: [
        {
          type: 'xref',
          module: 'shared',
          ...(block && { block }),
          text: text('see'),
        },
      ],
    });
    const page = module('page', [
      { type: 'moduleRef', id: 'warn', module: 'shared', block: 'acid' },
      link('to-acid', 'acid'),
      link('to-specs', 'specs'),
      link('to-module'),
    ]);
    const { manual: resolved, issues } = resolve([page, shared]);
    expect(resolved.anchors['shared#acid']).toBe('shared--acid');
    expect(resolved.anchors['shared']).toBeUndefined();
    // The block exists, outside the manual: a warning, never an unknown block.
    expect(issues.map((i) => [i.severity, i.code, i.target])).toEqual([
      ['warning', 'xref-outside-manual', { module: 'shared', block: 'specs' }],
      ['warning', 'xref-outside-manual', { module: 'shared' }],
    ]);
  });

  it('lands links on any block of a module the manual also includes whole, in either order', () => {
    const link: Block = {
      type: 'paragraph',
      id: 'to-specs',
      content: [
        { type: 'xref', module: 'shared', block: 'specs', text: text('see') },
      ],
    };
    const one: Block = {
      type: 'moduleRef',
      id: 'one',
      module: 'shared',
      block: 'acid',
    };
    const all: Block = { type: 'moduleRef', id: 'all', module: 'shared' };
    for (const refs of [
      [one, all],
      [all, one],
    ]) {
      const page = module('page', [...refs, link]);
      const { manual: resolved, issues } = resolve([page, shared]);
      expect(issues).toEqual([]);
      expect(resolved.anchors['shared']).toBeDefined();
    }
  });

  it('reports a cycle through a one-block reference', () => {
    const a = module('a', [
      { type: 'moduleRef', id: 'to-b', module: 'b', block: 'b-ref' },
    ]);
    const b = module('b', [
      { type: 'moduleRef', id: 'b-ref', module: 'a' },
      paragraph('b-text', 'B.'),
    ]);
    const { issues } = resolve([a, b]);
    expect(issues).toContainEqual(
      expect.objectContaining({
        code: 'module-cycle',
        message: 'module reference cycle: a → b → a',
        at: { module: 'b', block: 'b-ref' },
      }),
    );
    // A one-block reference to its own module is a cycle too.
    const self = module('self', [
      paragraph('p', 'P.'),
      { type: 'moduleRef', id: 'again', module: 'self', block: 'p' },
    ]);
    expect(resolve([self]).issues).toContainEqual(
      expect.objectContaining({
        code: 'module-cycle',
        at: { module: 'self', block: 'again' },
      }),
    );
  });

  it('counts each one-block inclusion against the expansion limits', () => {
    // A block of 1,000 paragraphs, referred to from 600 references: 600,000 nodes and more.
    const big = module('big', [
      {
        type: 'section',
        id: 'all',
        title: text('All'),
        blocks: Array.from({ length: 1000 }, (_, i) => paragraph(`p${i}`, 'x')),
      },
    ]);
    const page = module(
      'page',
      Array.from({ length: 600 }, (_, i) => ({
        type: 'moduleRef' as const,
        id: `r${i}`,
        module: 'big',
        block: 'all',
      })),
    );
    const { manual: resolved, issues, read } = resolve([page, big]);
    expect(issues).toEqual([
      expect.objectContaining({ code: 'expansion-too-large' }),
    ]);
    expect(resolved.entries).toEqual([]);
    expect(MAX_EXPANDED_NODES).toBeLessThan(600 * 1000 * 3);
    // Each module is looked up once, however many references name a block of it.
    expect(read.get('big')).toBe(1);
  });

  it('gathers only the notices of the block when a derived manual gathers notices', () => {
    const second = module('second', [
      {
        type: 'safety',
        id: 'other',
        severity: 'danger',
        symbols: [],
        hazard: text('Other hazard'),
        blocks: [],
      },
      {
        type: 'safety',
        id: 'pinch',
        severity: 'caution',
        symbols: [],
        hazard: text('Pinch point'),
        blocks: [],
      },
    ]);
    const page = module('page', [
      { type: 'moduleRef', id: 'one', module: 'second', block: 'pinch' },
      {
        type: 'safety',
        id: 'own',
        severity: 'caution',
        symbols: [],
        hazard: [
          { type: 'xref', module: 'second', block: 'other', text: text('see') },
        ],
        blocks: [],
      },
    ]);
    const { manual: resolved, issues } = resolve([page, second], {
      notices: true,
    });
    // A link to a block the manual does not gather is a warning, never an unknown block.
    expect(issues.map((i) => [i.severity, i.code])).toEqual([
      ['warning', 'xref-outside-manual'],
    ]);
    expect(blocksOf(resolved.entries).map((b) => b.id)).toEqual([
      'second--pinch',
      'page--own',
    ]);
  });
});
