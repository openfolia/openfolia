import { readFileSync } from 'node:fs';
import { PageDesign, type PageDesignInput } from './page-design.js';
import {
  compareDesignWithRecord,
  designSourceHashes,
  designUnits,
  hasDesignTranslation,
  markDesignCurrent,
} from './page-design-translation.js';
import { parsePageDesign, printPageDesign } from './page-design-yaml.js';

const fixture = readFileSync(
  new URL('../fixtures/page-design.yaml', import.meta.url),
  'utf8',
);
const sample = () => parsePageDesign(fixture, { id: 'product-line' });

const design = (extra: Partial<PageDesignInput> = {}): PageDesign =>
  PageDesign.parse({
    schemaVersion: 1,
    id: 'plain',
    name: 'Plain',
    preset: 'classic',
    colours: { primary: '#1f4e79', accent: '#2563eb', text: '#1f2328' },
    ...extra,
  });

const para = (id: string, text: string) => ({
  type: 'paragraph' as const,
  id,
  content: [{ type: 'text' as const, text }],
});

describe('designUnits', () => {
  it('lists the source text of every region, in the preset’s slot order, keyed by slot and block', () => {
    const units = designUnits(sample(), 'en');
    expect(units.map((u) => u.blockId)).toEqual([
      'above-title.intro',
      'footer.doc-number',
      'back.imprint',
      'back.us-note',
    ]);
    expect(units[0]).toMatchObject({
      slot: 'above-title',
      block: 'intro',
      kind: 'paragraph',
    });
    // The placeholder is part of the text: a translation keeps it.
    expect(units[0]?.parts[0]?.content).toContainEqual({
      type: 'placeholder',
      key: 'product',
    });
  });

  it('has no units for a region with only other languages’ text', () => {
    const d = design({ regions: { back: { de: [para('a', 'Hallo')] } } });
    expect(designUnits(d, 'en')).toEqual([]);
  });

  it('hashes only the text, so a reprint changes nothing', () => {
    const hashes = designSourceHashes(sample(), 'en');
    const again = designSourceHashes(
      parsePageDesign(printPageDesign(sample()), { id: 'product-line' }),
      'en',
    );
    expect([...again]).toEqual([...hashes]);
  });
});

describe('compareDesignWithRecord', () => {
  const source = [para('imprint', 'Made by us')];

  it('is missing without text of the language, up to date with a record, outdated once the source changes', () => {
    const plain = design({ regions: { back: source } });
    expect(compareDesignWithRecord(plain, 'de', 'en')).toEqual([
      { blockId: 'back.imprint', state: 'missing' },
    ]);
    expect(hasDesignTranslation(plain, 'de', 'en')).toBe(false);

    const hash = designSourceHashes(plain, 'en').get('back.imprint') as string;
    const translated = design({
      regions: { back: { en: source, de: [para('imprint', 'Von uns')] } },
      translations: {
        de: { sourceCommit: 'a'.repeat(40), blocks: { 'back.imprint': hash } },
      },
    });
    expect(hasDesignTranslation(translated, 'de', 'en')).toBe(true);
    expect(compareDesignWithRecord(translated, 'de', 'en')).toEqual([
      { blockId: 'back.imprint', state: 'up-to-date' },
    ]);

    const edited = design({
      ...translated,
      regions: {
        back: {
          en: [para('imprint', 'Made by us, now')],
          de: [para('imprint', 'Von uns')],
        },
      },
    });
    expect(compareDesignWithRecord(edited, 'de', 'en')).toEqual([
      { blockId: 'back.imprint', state: 'outdated' },
    ]);
  });

  it('is outdated without a record, and where the translation lacks the block', () => {
    const d = design({
      regions: {
        back: {
          en: [para('imprint', 'Made by us'), para('extra', 'More')],
          de: [para('imprint', 'Von uns')],
        },
      },
    });
    expect(compareDesignWithRecord(d, 'de', 'en')).toEqual([
      { blockId: 'back.imprint', state: 'outdated' },
      { blockId: 'back.extra', state: 'outdated' },
    ]);
  });
});

describe('markDesignCurrent', () => {
  it('takes the current hash for every block the translation has, its text unchanged', () => {
    const d = design({
      regions: {
        back: {
          en: [para('imprint', 'Made by us'), para('extra', 'More')],
          de: [para('imprint', 'Von uns')],
        },
        footer: [para('note', 'Same for all')],
      },
    });
    const marked = markDesignCurrent(d, 'de', 'en', 'b'.repeat(40));
    expect(marked.units).toBe(1);
    expect(marked.design.regions).toEqual(d.regions);
    expect(compareDesignWithRecord(marked.design, 'de', 'en')).toEqual([
      { blockId: 'footer.note', state: 'missing' },
      { blockId: 'back.imprint', state: 'up-to-date' },
      { blockId: 'back.extra', state: 'outdated' },
    ]);
  });
});

describe('the translation record in the file', () => {
  it('round-trips, languages and units sorted', () => {
    const d = design({
      regions: {
        back: {
          en: [para('imprint', 'Made by us')],
          de: [para('imprint', 'Von uns')],
        },
      },
      translations: {
        fr: { sourceCommit: 'b'.repeat(40), blocks: {} },
        de: {
          sourceCommit: 'a'.repeat(40),
          blocks: { 'back.z': 'c'.repeat(64), 'back.imprint': 'd'.repeat(64) },
        },
      },
    });
    const printed = printPageDesign(d);
    expect(printed).toContain(
      [
        'translations:',
        '  de:',
        `    sourceCommit: ${'a'.repeat(40)}`,
        '    blocks:',
        `      back.imprint: ${'d'.repeat(64)}`,
        `      back.z: ${'c'.repeat(64)}`,
        '  fr:',
      ].join('\n'),
    );
    const read = parsePageDesign(printed, { id: 'plain' });
    expect(read.translations).toEqual(d.translations);
    expect(printPageDesign(read)).toBe(printed);
  });

  it('refuses a unit key that is no slot and block, and a language that is no tag', () => {
    const bad = (translations: unknown) =>
      PageDesign.safeParse({ ...design(), translations }).success;
    expect(
      bad({
        de: { sourceCommit: 'a'.repeat(40), blocks: { back: 'c'.repeat(64) } },
      }),
    ).toBe(false);
    expect(bad({ DE: { sourceCommit: 'a'.repeat(40), blocks: {} } })).toBe(
      false,
    );
    expect(bad({ de: { sourceCommit: 'nope', blocks: {} } })).toBe(false);
  });
});
