import { Manifest, type ManifestInput } from './manifest.js';
import {
  compareManifestWithRecord,
  hasManifestTranslation,
  manifestSourceHashes,
  markManifestCurrent,
  mergeManifestTranslation,
} from './manifest-translation.js';
import { coverUnitKey, groupUnitKey, manifestUnits } from './manifest-units.js';
import { parseManifest, printManifest } from './manifest-yaml.js';
import { ImportDocument } from './import/format.js';

const ASSET = 'sha256:' + 'a'.repeat(64);
const COMMIT = 'c'.repeat(40);

const manifest = (extra: Partial<ManifestInput> = {}): Manifest =>
  Manifest.parse({
    schemaVersion: 1,
    id: 'operating',
    title: 'Operating manual',
    variants: [{ model: 'l-200' }, { model: 'l-400' }],
    entries: [{ module: 'battery-charging' }],
    ...extra,
  });

const withCovers = (extra: Partial<ManifestInput> = {}) =>
  manifest({
    coverImage: {
      default: { asset: ASSET, alt: 'The vehicle' },
      variants: [
        { variant: { model: 'l-400' }, asset: ASSET, alt: { en: 'The L-400' } },
        // A second entry for the same variant is never shown.
        { variant: { model: 'l-400' }, asset: ASSET, alt: 'Shadowed' },
        {
          variant: { model: 'l-200' },
          asset: ASSET,
          alt: { de: 'Nur Deutsch' },
        },
      ],
    },
    ...extra,
  });

describe('coverUnitKey', () => {
  it('keys the manual’s own image and each variant’s, whatever the attributes’ order', () => {
    expect(coverUnitKey()).toBe('coverImage.default');
    const key = coverUnitKey({ model: 'l-400', market: 'eu' });
    expect(key).toMatch(/^coverImage\.variant-[0-9a-f]{12}$/);
    expect(coverUnitKey({ market: 'eu', model: 'l-400' })).toBe(key);
    expect(coverUnitKey({ market: 'us', model: 'l-400' })).not.toBe(key);
  });
});

describe('manifestUnits', () => {
  it('lists the source text of each cover image, the manual’s first, each variant once', () => {
    const units = manifestUnits(withCovers(), 'en');
    expect(units.map((u) => u.blockId)).toEqual([
      'title',
      'coverImage.default',
      coverUnitKey({ model: 'l-400' }),
    ]);
    expect(units[2]).toMatchObject({
      kind: 'image',
      variant: { model: 'l-400' },
      parts: [{ field: 'alt', content: [{ type: 'text', text: 'The L-400' }] }],
    });
  });

  it('has the title alone without cover images or groups', () => {
    expect(manifestUnits(manifest(), 'en')).toEqual([
      {
        blockId: 'title',
        kind: 'section',
        parts: [
          {
            field: 'title',
            content: [{ type: 'text', text: 'Operating manual' }],
          },
        ],
      },
    ]);
  });
});

/** The states of the cover images' units, the title's left out. */
const covers = (states: ReturnType<typeof compareManifestWithRecord>) =>
  states.filter((s) => s.blockId !== 'title');

describe('compareManifestWithRecord', () => {
  it('is missing without a text of its own, outdated without a record, then up to date', () => {
    const m = withCovers();
    expect(covers(compareManifestWithRecord(m, 'de', 'en'))).toEqual([
      { blockId: 'coverImage.default', state: 'missing' },
      { blockId: coverUnitKey({ model: 'l-400' }), state: 'missing' },
    ]);
    expect(hasManifestTranslation(m, 'de', 'en')).toBe(true);
    expect(hasManifestTranslation(m, 'fr', 'en')).toBe(false);

    const hash = manifestSourceHashes(m, 'en').get('coverImage.default') ?? '';
    const merged = mergeManifestTranslation(
      m,
      'de',
      'en',
      COMMIT,
      new Map([['coverImage.default', { text: 'Das Fahrzeug', hash }]]),
    );
    expect(merged.coverImage?.default?.alt).toEqual({
      en: 'The vehicle',
      de: 'Das Fahrzeug',
    });
    expect(merged.translations).toEqual({
      de: { sourceCommit: COMMIT, blocks: { 'coverImage.default': hash } },
    });
    expect(covers(compareManifestWithRecord(merged, 'de', 'en'))[0]).toEqual({
      blockId: 'coverImage.default',
      state: 'up-to-date',
    });

    // The source changes: outdated, its text kept.
    const changed = Manifest.parse({
      ...merged,
      coverImage: {
        ...merged.coverImage,
        default: {
          asset: ASSET,
          alt: { en: 'The new vehicle', de: 'Das Fahrzeug' },
        },
      },
    });
    expect(
      covers(compareManifestWithRecord(changed, 'de', 'en'))[0]?.state,
    ).toBe('outdated');
    // Marked current: up to date again, the text unchanged.
    const marked = markManifestCurrent(changed, 'de', 'en', COMMIT);
    expect(marked.units).toBe(1);
    expect(marked.manifest.coverImage).toEqual(changed.coverImage);
    expect(
      covers(compareManifestWithRecord(marked.manifest, 'de', 'en')),
    ).toEqual([
      { blockId: 'coverImage.default', state: 'up-to-date' },
      { blockId: coverUnitKey({ model: 'l-400' }), state: 'missing' },
    ]);
  });

  it('leaves a unit the manifest no longer has out of the merge', () => {
    const m = withCovers();
    const merged = mergeManifestTranslation(
      m,
      'de',
      'en',
      COMMIT,
      new Map([
        [coverUnitKey({ model: 'l-900' }), { text: 'X', hash: 'f'.repeat(64) }],
      ]),
    );
    expect(merged).toBe(m);
  });

  it('puts a variant’s text into its first entry only', () => {
    const m = withCovers();
    const key = coverUnitKey({ model: 'l-400' });
    const merged = mergeManifestTranslation(
      m,
      'de',
      'en',
      COMMIT,
      new Map([[key, { text: 'Der L-400', hash: 'f'.repeat(64) }]]),
    );
    expect(merged.coverImage?.variants.map((v) => v.alt)).toEqual([
      { en: 'The L-400', de: 'Der L-400' },
      'Shadowed',
      { de: 'Nur Deutsch' },
    ]);
  });
});

describe('the record kept to the manifest', () => {
  it('drops units of cover images the manifest no longer has', () => {
    const m = withCovers({
      translations: {
        de: {
          sourceCommit: COMMIT,
          blocks: { [coverUnitKey({ model: 'gone' })]: 'e'.repeat(64) },
        },
      },
    });
    const hash = manifestSourceHashes(m, 'en').get('coverImage.default') ?? '';
    const merged = mergeManifestTranslation(
      m,
      'de',
      'en',
      COMMIT,
      new Map([['coverImage.default', { text: 'Das Fahrzeug', hash }]]),
    );
    expect(merged.translations?.['de']?.blocks).toEqual({
      'coverImage.default': hash,
    });
    expect(
      markManifestCurrent(merged, 'de', 'en', COMMIT).manifest.translations?.[
        'de'
      ]?.blocks,
    ).toEqual({ 'coverImage.default': hash });
  });

  it('never puts a variant’s text into a later entry when its first has no source text', () => {
    const m = manifest({
      coverImage: {
        variants: [
          { variant: { model: 'l-400' }, asset: ASSET, alt: { de: 'Nur' } },
          { variant: { model: 'l-400' }, asset: ASSET, alt: 'Shadowed' },
        ],
      },
    });
    const merged = mergeManifestTranslation(
      m,
      'de',
      'en',
      COMMIT,
      new Map([
        [coverUnitKey({ model: 'l-400' }), { text: 'X', hash: 'f'.repeat(64) }],
      ]),
    );
    expect(merged).toBe(m);
  });
});

describe('the record in YAML', () => {
  it('prints and reads back, sorted', () => {
    const m = withCovers({
      translations: {
        fr: {
          sourceCommit: COMMIT,
          blocks: { 'coverImage.default': 'e'.repeat(64) },
        },
        de: {
          sourceCommit: COMMIT,
          blocks: { 'coverImage.default': 'f'.repeat(64) },
        },
      },
    });
    const text = printManifest(m);
    expect(text.indexOf('translations:')).toBeLessThan(
      text.indexOf('\nvariants:'),
    );
    expect(text.indexOf('de:')).toBeLessThan(text.indexOf('fr:'));
    expect(parseManifest(text, { id: 'operating' })).toEqual(m);
  });

  it('refuses a unit key that is no cover image', () => {
    expect(() =>
      manifest({
        translations: {
          de: { sourceCommit: COMMIT, blocks: { 'title.x': 'e'.repeat(64) } },
        },
      }),
    ).toThrow();
  });

  it('is not part of the import format', () => {
    const doc = {
      formatVersion: 1,
      modules: [],
      manuals: [
        {
          ...withCovers(),
          translations: {
            de: { sourceCommit: COMMIT, blocks: {} },
          },
        },
      ],
    };
    expect(ImportDocument.safeParse(doc).success).toBe(false);
  });
});

describe('the title and the groups’ titles (#731)', () => {
  const grouped = (extra: Partial<ManifestInput> = {}) =>
    manifest({
      title: { en: 'Operating manual', de: 'Betriebsanleitung' },
      entries: [
        {
          title: 'Maintenance',
          entries: [
            { module: 'battery-charging' },
            {
              title: { en: 'Daily', fr: 'Quotidien' },
              entries: [{ module: 'a' }],
            },
          ],
        },
        // The same title again, under a condition: the same unit.
        {
          title: 'Maintenance',
          when: { op: 'in', attr: 'model', values: ['l-400'] },
          entries: [{ module: 'b' }],
        },
        // No source-language title: no unit.
        { title: { de: 'Nur Deutsch' }, entries: [{ module: 'c' }] },
      ],
      ...extra,
    });

  it('lists the title, then each group title once, in document order', () => {
    const units = manifestUnits(grouped(), 'en');
    expect(units.map((u) => u.blockId)).toEqual([
      'title',
      groupUnitKey('Maintenance'),
      groupUnitKey('Daily'),
    ]);
    expect(units[1]?.blockId).toMatch(/^group\.[0-9a-f]{12}$/);
    expect(units[1]?.parts).toEqual([
      { field: 'title', content: [{ type: 'text', text: 'Maintenance' }] },
    ]);
  });

  it('is missing, outdated or up to date like a cover image', () => {
    const m = grouped();
    expect(compareManifestWithRecord(m, 'de', 'en')).toEqual([
      { blockId: 'title', state: 'outdated' },
      { blockId: groupUnitKey('Maintenance'), state: 'missing' },
      { blockId: groupUnitKey('Daily'), state: 'missing' },
    ]);
    expect(compareManifestWithRecord(m, 'fr', 'en')[2]).toEqual({
      blockId: groupUnitKey('Daily'),
      state: 'outdated',
    });
    expect(hasManifestTranslation(m, 'fr', 'en')).toBe(true);
    const marked = markManifestCurrent(m, 'de', 'en', COMMIT);
    expect(marked.units).toBe(1);
    expect(compareManifestWithRecord(marked.manifest, 'de', 'en')[0]).toEqual({
      blockId: 'title',
      state: 'up-to-date',
    });
  });

  it('merges a group’s title into every group of that title, and the title', () => {
    const m = grouped();
    const key = groupUnitKey('Maintenance');
    const hashes = manifestSourceHashes(m, 'en');
    const merged = mergeManifestTranslation(
      m,
      'fr',
      'en',
      COMMIT,
      new Map([
        [key, { text: 'Entretien', hash: hashes.get(key) ?? '' }],
        ['title', { text: 'Manuel', hash: hashes.get('title') ?? '' }],
      ]),
    );
    expect(merged.title).toEqual({
      en: 'Operating manual',
      de: 'Betriebsanleitung',
      fr: 'Manuel',
    });
    const titles = merged.entries.map((e) => ('entries' in e ? e.title : null));
    expect(titles).toEqual([
      { en: 'Maintenance', fr: 'Entretien' },
      { en: 'Maintenance', fr: 'Entretien' },
      { de: 'Nur Deutsch' },
    ]);
    expect(merged.translations?.['fr']?.blocks).toEqual({
      title: hashes.get('title'),
      [key]: hashes.get(key),
    });
    expect(
      compareManifestWithRecord(merged, 'fr', 'en').map((s) => s.state),
    ).toEqual(['up-to-date', 'up-to-date', 'outdated']);
  });

  it('prints one text as it was written, and a title per language sorted', () => {
    const single = manifest();
    const text = printManifest(single);
    expect(text).toContain('title: Operating manual\n');
    expect(parseManifest(text, { id: 'operating' })).toEqual(single);

    const m = Manifest.parse({
      ...grouped(),
      title: { de: 'Betriebsanleitung', en: 'Operating manual' },
    });
    const printed = printManifest(m);
    expect(printed).toContain(
      'title:\n  de: Betriebsanleitung\n  en: Operating manual\n',
    );
    expect(printed).toContain(
      'title:\n          en: Daily\n          fr: Quotidien',
    );
    const back = parseManifest(printed, { id: 'operating' });
    expect(back).toEqual(m);
    expect(printManifest(back)).toBe(printed);
  });

  it('takes a group-title unit key in the record, not any other', () => {
    expect(() =>
      manifest({
        translations: {
          de: {
            sourceCommit: COMMIT,
            blocks: {
              title: 'e'.repeat(64),
              [groupUnitKey('Maintenance')]: 'e'.repeat(64),
            },
          },
        },
      }),
    ).not.toThrow();
    expect(() =>
      manifest({
        translations: {
          de: { sourceCommit: COMMIT, blocks: { 'group.xyz': 'e'.repeat(64) } },
        },
      }),
    ).toThrow();
  });
});
