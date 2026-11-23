import { createHash } from 'node:crypto';
import type { Block } from './blocks.js';
import type { Module } from './module.js';
import { sha256Hex } from './sha256.js';
import {
  compareWithRecord,
  parseTranslationRecord,
  printTranslationRecord,
  sourceHash,
  translatableUnits,
  TranslationRecord,
  TranslationRecordParseError,
  translationRecordOf,
} from './translation.js';

const text = (value: string) => [{ type: 'text' as const, text: value }];

const module = (blocks: Block[]): Module => ({
  schemaVersion: 1,
  id: 'sample',
  meta: { title: 'Sample', type: 'concept', lang: 'en', facets: {} },
  blocks,
});

const COMMIT = 'a'.repeat(40);

describe('sha256Hex', () => {
  it('matches the standard digest, also across block boundaries and for non-ASCII text', () => {
    for (const value of [
      '',
      'abc',
      'x'.repeat(55),
      'x'.repeat(56),
      'x'.repeat(64),
      'y'.repeat(1000),
      'Größe ✓ 漢字 🚗',
    ]) {
      expect(sha256Hex(value)).toBe(
        createHash('sha256').update(value, 'utf8').digest('hex'),
      );
    }
  });
});

describe('translatableUnits', () => {
  const everything = module([
    { type: 'paragraph', id: 'intro', content: text('Hello.') },
    {
      type: 'section',
      id: 'setup',
      title: text('Setting up'),
      blocks: [
        {
          type: 'list',
          id: 'parts',
          ordered: false,
          items: [
            {
              id: 'part-a',
              content: text('A part'),
              blocks: [{ type: 'literal', id: 'code', text: 'x = 1' }],
            },
          ],
        },
        {
          type: 'procedure',
          id: 'steps',
          steps: [{ id: 'step-1', content: text('Do it.'), blocks: [] }],
        },
        {
          type: 'table',
          id: 'specs',
          title: text('Specs'),
          columns: [{ width: 1 }],
          header: false,
          rows: [
            {
              cells: [
                {
                  blocks: [
                    { type: 'paragraph', id: 'cell', content: text('10 kg') },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
    {
      type: 'image',
      id: 'photo',
      asset: `sha256:${'0'.repeat(64)}`,
      alt: 'A charger',
      title: text('The charger'),
    },
    {
      type: 'attachment',
      id: 'file',
      asset: `sha256:${'1'.repeat(64)}`,
      name: 'Configuration',
      description: 'For the installer.',
      fileName: 'config.zip',
      mediaType: 'application/zip',
      size: 10,
    },
    {
      type: 'safety',
      id: 'hot',
      severity: 'caution',
      hazard: text('Hot surface'),
      symbols: [],
      blocks: [{ type: 'paragraph', id: 'cool', content: text('Wait.') }],
    },
    {
      type: 'admonition',
      id: 'tip',
      kind: 'tip',
      blocks: [{ type: 'paragraph', id: 'tip-text', content: text('Tip.') }],
    },
    {
      type: 'variant',
      id: 'large-only',
      when: { op: 'in', attr: 'model', values: ['large'] },
      blocks: [{ type: 'paragraph', id: 'large', content: text('Large.') }],
    },
    { type: 'moduleRef', id: 'note', module: 'safety-note' },
    { type: 'passthrough', id: 'raw', format: 'xml', raw: '<x/>' },
    { type: 'pageBreak', id: 'break' },
  ]);

  it('lists every block with text of its own, in document order', () => {
    expect(
      translatableUnits(everything).map((u) => [
        u.blockId,
        u.kind,
        u.parts.map((p) => p.field).join('+'),
      ]),
    ).toEqual([
      ['intro', 'paragraph', 'content'],
      ['setup', 'section', 'title'],
      ['part-a', 'item', 'content'],
      ['step-1', 'item', 'content'],
      ['specs', 'table', 'title'],
      ['cell', 'paragraph', 'content'],
      ['photo', 'image', 'alt+title'],
      ['file', 'attachment', 'name+description'],
      ['hot', 'safety', 'hazard'],
      ['cool', 'paragraph', 'content'],
      ['tip-text', 'paragraph', 'content'],
      ['large', 'paragraph', 'content'],
    ]);
  });

  it('lists each callout legend of an image as a unit of its own, hidden ones too (#548)', () => {
    const units = translatableUnits(
      module([
        {
          type: 'image',
          id: 'photo',
          asset: `sha256:${'0'.repeat(64)}`,
          alt: 'A charger',
          callouts: [
            {
              id: 'switch',
              anchor: { x: 0.8, y: 0.2 },
              legend: [
                { type: 'text', text: 'Power ' },
                { type: 'text', text: 'switch', marks: [{ type: 'strong' }] },
              ],
            },
            {
              id: 'filter',
              anchor: { x: 0.1, y: 0.1 },
              legend: text('Filter'),
              when: { op: 'in', attr: 'model', values: ['large'] },
            },
          ],
        },
        { type: 'paragraph', id: 'after', content: text('After.') },
      ]),
    );
    expect(
      units.map((u) => [u.blockId, u.kind, u.image, u.parts[0]?.field]),
    ).toEqual([
      ['photo', 'image', undefined, 'alt'],
      ['switch', 'callout', 'photo', 'legend'],
      ['filter', 'callout', 'photo', 'legend'],
      ['after', 'paragraph', undefined, 'content'],
    ]);
    expect(units[1]?.parts[0]?.content).toEqual([
      { type: 'text', text: 'Power ' },
      { type: 'text', text: 'switch', marks: [{ type: 'strong' }] },
    ]);
  });

  it('gives plain text fields as one text run', () => {
    const photo = translatableUnits(everything).find(
      (u) => u.blockId === 'photo',
    );
    expect(photo?.parts[0]).toEqual({
      field: 'alt',
      content: text('A charger'),
    });
  });
});

describe('sourceHash', () => {
  const unitOf = (blocks: Block[]) => {
    const [unit] = translatableUnits(module(blocks));
    if (!unit) throw new Error('no unit');
    return unit;
  };

  it('changes with the text, its marks and its inline nodes', () => {
    const plain = sourceHash(
      unitOf([{ type: 'paragraph', id: 'p', content: text('Hi') }]),
    );
    expect(plain).toMatch(/^[0-9a-f]{64}$/);
    expect(
      sourceHash(unitOf([{ type: 'paragraph', id: 'p', content: text('Ho') }])),
    ).not.toBe(plain);
    expect(
      sourceHash(
        unitOf([
          {
            type: 'paragraph',
            id: 'p',
            content: [
              { type: 'text', text: 'Hi', marks: [{ type: 'strong' }] },
            ],
          },
        ]),
      ),
    ).not.toBe(plain);
    expect(
      sourceHash(
        unitOf([
          {
            type: 'paragraph',
            id: 'p',
            content: [...text('Hi'), { type: 'attribute', name: 'product' }],
          },
        ]),
      ),
    ).not.toBe(plain);
  });

  it('ignores the block ID, its type, nested blocks and what normalization removes', () => {
    const plain = sourceHash(
      unitOf([{ type: 'paragraph', id: 'p', content: text('Hi there') }]),
    );
    expect(
      sourceHash(
        unitOf([
          {
            type: 'paragraph',
            id: 'other',
            content: [
              { type: 'text', text: 'Hi', marks: [] },
              { type: 'text', text: ' there' },
            ],
          },
        ]),
      ),
    ).toBe(plain);
    const titled = (blocks: Block[]) =>
      sourceHash(
        unitOf([{ type: 'section', id: 's', title: text('Hi there'), blocks }]),
      );
    expect(titled([])).toBe(
      titled([{ type: 'paragraph', id: 'p', content: text('Nested.') }]),
    );
    // Mark order is canonical.
    const marked = (marks: { type: 'strong' | 'emphasis' }[]) =>
      sourceHash(
        unitOf([
          {
            type: 'paragraph',
            id: 'p',
            content: [{ type: 'text', text: 'x', marks }],
          },
        ]),
      );
    expect(marked([{ type: 'strong' }, { type: 'emphasis' }])).toBe(
      marked([{ type: 'emphasis' }, { type: 'strong' }]),
    );
  });

  it('hashes text alike in composed and decomposed form', () => {
    const word = (value: string) =>
      sourceHash(
        unitOf([{ type: 'paragraph', id: 'p', content: text(value) }]),
      );
    expect(word('Gr\u00fc\u00dfe')).toBe(word('Gru\u0308\u00dfe'));
  });

  it('tells which field a text is in', () => {
    const image = (alt: string, title?: string) =>
      sourceHash(
        unitOf([
          {
            type: 'image',
            id: 'i',
            asset: `sha256:${'0'.repeat(64)}`,
            alt,
            ...(title ? { title: text(title) } : {}),
          },
        ]),
      );
    expect(image('A', 'B')).not.toBe(image('B', 'A'));
  });
});

describe('the translation record', () => {
  const source = module([
    { type: 'paragraph', id: 'intro', content: text('Hello.') },
    { type: 'paragraph', id: 'more', content: text('More.') },
  ]);

  it('prints canonically and parses back', () => {
    const record = translationRecordOf(source, COMMIT);
    const printed = printTranslationRecord(record);
    expect(printed).toBe(
      [
        'schemaVersion: 1',
        `sourceCommit: ${COMMIT}`,
        'blocks:',
        `  intro: ${record.blocks['intro']}`,
        `  more: ${record.blocks['more']}`,
        '',
      ].join('\n'),
    );
    expect(parseTranslationRecord(printed)).toEqual(record);
    // Blocks sorted by ID, whatever order they come in.
    expect(
      printTranslationRecord({
        ...record,
        blocks: {
          more: record.blocks['more'] as string,
          intro: record.blocks['intro'] as string,
        },
      }),
    ).toBe(printed);
  });

  it('refuses what is no record', () => {
    for (const bad of [
      'blocks: [',
      'just text',
      `schemaVersion: 2\nsourceCommit: ${COMMIT}\nblocks: {}\n`,
      `schemaVersion: 1\nsourceCommit: main\nblocks: {}\n`,
      `schemaVersion: 1\nsourceCommit: ${COMMIT}\nblocks:\n  Bad ID: ${'0'.repeat(64)}\n`,
      `schemaVersion: 1\nsourceCommit: ${COMMIT}\nblocks:\n  intro: not-a-hash\n`,
    ]) {
      expect(() => parseTranslationRecord(bad)).toThrow(
        TranslationRecordParseError,
      );
    }
  });

  it('refuses a block named __proto__, which an object cannot hold safely', () => {
    expect(() =>
      parseTranslationRecord(
        `schemaVersion: 1\nsourceCommit: ${COMMIT}\nblocks:\n  __proto__: ${'0'.repeat(64)}\n`,
      ),
    ).toThrow(TranslationRecordParseError);
    const proto = module([
      { type: 'paragraph', id: '__proto__', content: text('Odd.') },
    ]);
    const record = translationRecordOf(proto, COMMIT);
    expect(TranslationRecord.safeParse(record).success).toBe(true);
    expect(compareWithRecord(proto, record)).toEqual([
      { blockId: '__proto__', state: 'outdated' },
    ]);
  });
});

describe('compareWithRecord', () => {
  const source = (more: string) =>
    module([
      { type: 'paragraph', id: 'intro', content: text('Hello.') },
      { type: 'paragraph', id: 'more', content: text(more) },
    ]);

  it('marks exactly the blocks whose text changed since the record', () => {
    const record = translationRecordOf(source('More.'), COMMIT);
    expect(compareWithRecord(source('More.'), record)).toEqual([
      { blockId: 'intro', state: 'up-to-date' },
      { blockId: 'more', state: 'up-to-date' },
    ]);
    expect(compareWithRecord(source('Changed.'), record)).toEqual([
      { blockId: 'intro', state: 'up-to-date' },
      { blockId: 'more', state: 'outdated' },
    ]);
  });

  it('counts a block the record does not name, and every block without a record, as outdated', () => {
    const blocks = Object.fromEntries(
      Object.entries(
        translationRecordOf(source('More.'), COMMIT).blocks,
      ).filter(([id]) => id !== 'more'),
    );
    expect(
      compareWithRecord(source('More.'), {
        schemaVersion: 1,
        sourceCommit: COMMIT,
        blocks,
      }).map((b) => b.state),
    ).toEqual(['up-to-date', 'outdated']);
    expect(
      compareWithRecord(source('More.'), undefined).map((b) => b.state),
    ).toEqual(['outdated', 'outdated']);
  });
});
