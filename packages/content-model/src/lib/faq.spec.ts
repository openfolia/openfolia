import { sampleConfig } from '../fixtures/config.js';
import { parseModule } from './asciidoc/parse.js';
import { printModule } from './asciidoc/print.js';
import type { Block } from './blocks.js';
import { toChunk, toChunks } from './chunk.js';
import { ProjectConfig } from './config.js';
import { Module } from './module.js';
import { checkStructure } from './structure.js';
import { translatableUnits } from './translation.js';
import { validateModule } from './validate.js';

const config = ProjectConfig.parse(sampleConfig);
const header =
  '= Questions\n:schema-version: 1\n:module-type: concept\n:lang: en\n';
const parse = (body: string) =>
  parseModule(`${header}\n${body}\n`, { id: 'faq' });

const t = (text: string) => ({ type: 'text' as const, text });
const para = (id: string, text: string): Block => ({
  type: 'paragraph',
  id,
  content: [t(text)],
});
const faq = (id: string, question: string, blocks: Block[]): Block => ({
  type: 'faq',
  id,
  question: [t(question)],
  blocks,
});
const module = (blocks: Block[]): Module =>
  Module.parse({
    schemaVersion: 1,
    id: 'faq',
    meta: { title: 'Questions', type: 'concept', lang: 'en', facets: {} },
    blocks,
  });

describe('an FAQ entry in AsciiDoc', () => {
  it('prints as a [faq] block, the question as its title, and reads back exactly', () => {
    const m = module([
      faq('reset', 'How do I reset the charger?', [
        para('reset-a', 'Hold the button for five seconds.'),
        {
          type: 'list',
          id: 'reset-l',
          ordered: false,
          items: [
            { id: 'reset-i', content: [t('It blinks once.')], blocks: [] },
          ],
        },
        {
          type: 'admonition',
          id: 'reset-n',
          kind: 'note',
          blocks: [para('reset-n1', 'Settings stay.')],
        },
      ]),
    ]);
    const source = printModule(m);
    expect(source).toContain(
      '[faq#reset]\n.How do I reset the charger?\n====\n[#reset-a]\nHold the button for five seconds.',
    );
    // The note inside takes a longer delimiter.
    expect(source).toContain('[NOTE#reset-n]\n=====\n');
    expect(parseModule(source, { id: 'faq' })).toEqual(m);
    expect(printModule(parseModule(source, { id: 'faq' }))).toBe(source);
  });

  it('refuses an entry without a question or an answer', () => {
    expect(() => parse('[faq#q]\n====\n[#p]\nText.\n====')).toThrow(
      /needs its question as a title line/,
    );
    expect(() => parse('[faq#q]\n.Why?\n====\n====')).toThrow(/invalid module/);
  });

  it('reads a Q&A list as one FAQ entry per question', () => {
    const m = parse(
      [
        '[qanda#first]',
        'Does it charge itself?:: [[first-a]]Yes, at the *station*.',
        '',
        '[[second]]How long does charging take?::',
        '[[second-a]]About two hours,',
        'or longer when cold.',
        '+',
        '[#second-tip]',
        'TIP: never used',
        '[[third]]Where is the socket?::',
        '+',
        '[#third-img]',
        'image::sha256:' + 'ab'.repeat(32) + '["The socket"]',
        '',
        '[#after]',
        'After the list.',
      ].join('\n'),
    );
    expect(m.blocks.map((b) => [b.type, b.id])).toEqual([
      ['faq', 'first'],
      ['faq', 'second'],
      ['faq', 'third'],
      ['paragraph', 'after'],
    ]);
    expect(m.blocks[0]).toEqual({
      type: 'faq',
      id: 'first',
      question: [t('Does it charge itself?')],
      blocks: [para('first-a', 'Yes, at the *station*.')],
    });
    const second = m.blocks[1] as Extract<Block, { type: 'faq' }>;
    expect(second.blocks.map((b) => b.id)).toEqual(['second-a', 'second-tip']);
    expect(second.blocks[0]).toEqual({
      type: 'paragraph',
      id: 'second-a',
      // A soft-wrapped line, as in a paragraph.
      content: [t('About two hours, or longer when cold.')],
    });
    expect(
      (m.blocks[2] as Extract<Block, { type: 'faq' }>).blocks[0]?.type,
    ).toBe('image');
    // Written back as FAQ blocks, which read back the same.
    const source = printModule(m);
    expect(source).not.toContain('qanda');
    expect(parseModule(source, { id: 'faq' })).toEqual(m);
  });

  it('refuses a Q&A entry or answer without an ID', () => {
    expect(() => parse('[qanda]\nWhy?:: [[a]]Because.')).toThrow(
      /line 7: a Q&A entry has no id/,
    );
    expect(() =>
      parse('[qanda#q1]\nWhy?:: [[a]]Because.\n\nAnd how?:: [[b]]So.'),
    ).toThrow(/line 9: a Q&A entry has no id/);
    expect(() => parse('[qanda#q1]\nWhy?:: Because.')).toThrow(
      /line 7: a Q&A entry's answer has no id/,
    );
    expect(() => parse('[qanda#q1]\n[#p]\nText.')).toThrow(
      /expected a Q&A entry/,
    );
  });
});

describe('an FAQ entry in the model', () => {
  it('holds no section or page break in its answer', () => {
    expect(
      checkStructure([
        faq('q', 'Why?', [
          { type: 'section', id: 's', title: [t('S')], blocks: [] },
          { type: 'pageBreak', id: 'pb' },
        ]),
      ]),
    ).toEqual(
      expect.arrayContaining([
        'section "s" must be at module level or inside another section',
        'page break "pb" must be at module level or directly inside a section',
      ]),
    );
  });

  it('needs a one-line question', () => {
    expect(
      Module.safeParse({
        ...module([faq('q', 'Why?', [para('a', 'Because.')])]),
        blocks: [
          {
            type: 'faq',
            id: 'q',
            question: [t('Why'), { type: 'hardBreak' }, t('?')],
            blocks: [para('a', 'Because.')],
          },
        ],
      }).success,
    ).toBe(false);
  });

  it('has its question as a translation unit, and its answer’s blocks as theirs', () => {
    const units = translatableUnits(
      module([faq('q', 'Why?', [para('a', 'Because.')])]),
    );
    expect(units).toEqual([
      {
        blockId: 'q',
        kind: 'faq',
        parts: [{ field: 'question', content: [t('Why?')] }],
      },
      {
        blockId: 'a',
        kind: 'paragraph',
        parts: [{ field: 'content', content: [t('Because.')] }],
      },
    ]);
  });

  it('checks the question’s inline content', () => {
    const issues = validateModule(
      module([
        {
          type: 'faq',
          id: 'q',
          question: [
            t('Is '),
            { type: 'attribute', name: 'nope' },
            t(' fast?'),
          ],
          blocks: [para('a', 'Yes.')],
        },
      ]),
      config,
    );
    expect(issues.map((i) => [i.code, i.at])).toContainEqual([
      'unknown-text-attribute',
      'q',
    ]);
  });
});

describe('retrieval chunks of FAQ entries', () => {
  const m = module([
    para('intro', 'Answers to common questions.'),
    faq('reset', 'How do I reset it?', [para('reset-a', 'Hold the button.')]),
    {
      type: 'variant',
      id: 'v',
      when: { op: 'in', attr: 'model', values: ['l-400'] },
      blocks: [
        faq('lift', 'Can it lift?', [para('lift-a', 'Up to one tonne.')]),
      ],
    },
  ]);
  const input = { module: m, config, loadModule: () => undefined };

  it('gives the module’s chunk first, with the entries in its text, then one chunk per entry', () => {
    const chunks = toChunks(input);
    expect(chunks[0]).toEqual(toChunk(input));
    expect(chunks[0]?.entry).toBeUndefined();
    expect(chunks[0]?.text).toContain(
      '**How do I reset it?**\n\nHold the button.',
    );
    expect(chunks.slice(1).map((c) => c.entry?.blockId)).toEqual([
      'reset',
      'lift',
    ]);
    const [, reset, lift] = chunks;
    expect(reset).toMatchObject({
      moduleId: 'faq',
      lang: 'en',
      title: 'Questions',
      text: '# How do I reset it?\n\nHold the button.',
      conditions: [],
      sources: [{ moduleId: 'faq', lang: 'en' }],
      entry: { blockId: 'reset', question: 'How do I reset it?', within: [] },
    });
    expect(lift?.conditions).toEqual(['model in (l-400)']);
    expect(lift?.entry?.within).toEqual([
      { op: 'in', attr: 'model', values: ['l-400'] },
    ]);
    // Each entry's hashes are its own.
    expect(reset?.sourceHash).not.toBe(chunks[0]?.sourceHash);
    expect(reset?.sourceHash).not.toBe(lift?.sourceHash);
  });

  it('gives no chunk to an entry whose variant block does not hold for the variant', () => {
    expect(
      toChunks({ ...input, variant: { model: 'l-200' } })
        .slice(1)
        .map((c) => c.entry?.blockId),
    ).toEqual(['reset']);
    expect(
      toChunks({ ...input, variant: { model: 'l-400' } })
        .slice(1)
        .map((c) => c.entry?.blockId),
    ).toEqual(['reset', 'lift']);
  });

  it('names the module a cross-reference in a question points at', () => {
    const target = {
      ...module([para('tp', 'T.')]),
      id: 'target',
      meta: { ...m.meta, title: 'Target title' },
    };
    const withXref = module([
      {
        type: 'faq',
        id: 'see',
        question: [t('What is '), { type: 'xref', module: 'target' }, t('?')],
        blocks: [para('see-a', 'A part.')],
      },
    ]);
    const [, entry] = toChunks({
      module: withXref,
      config,
      loadModule: (id) => (id === 'target' ? target : undefined),
    });
    expect(entry?.text).toBe('# What is Target title?\n\nA part.');
    expect(entry?.dependsOn).toEqual(['target']);
  });

  it('changes an entry’s source hash only when its own text changes', () => {
    const edited = module([
      para('intro', 'Other words.'),
      faq('reset', 'How do I reset it?', [para('reset-a', 'Hold the button.')]),
    ]);
    const before = toChunks(input)[1];
    const after = toChunks({ ...input, module: edited })[1];
    expect(after?.sourceHash).toBe(before?.sourceHash);
    expect(after?.contentHash).toBe(before?.contentHash);
  });
});
