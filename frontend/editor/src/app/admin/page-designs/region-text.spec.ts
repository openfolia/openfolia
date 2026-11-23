import type { Block } from '@openfolia/content-model/core';

import {
  missingTranslations,
  regionGroups,
  regionIn,
  strayRegions,
  withoutRegion,
  withoutTranslation,
  withRegionText,
  type Regions,
} from './region-text';

const para = (id: string, text: string): Block => ({
  type: 'paragraph',
  id,
  content: [{ type: 'text', text }],
});
const en = [para('note', 'Keep this manual.')];
const de = [para('note', 'Bewahren Sie diese Anleitung auf.')];

describe('region text (#393)', () => {
  it('shows the same text in every language, its own in a translated one', () => {
    const shared: Regions = { footer: en };
    expect(regionIn(shared, 'footer', 'en', 'en')).toEqual({
      blocks: en,
      state: 'own',
    });
    expect(regionIn(shared, 'footer', 'de', 'en')).toEqual({
      blocks: en,
      state: 'source',
    });
    const translated: Regions = { footer: { en, de } };
    expect(regionIn(translated, 'footer', 'de', 'en').state).toBe('own');
    expect(regionIn(translated, 'footer', 'fr', 'en')).toEqual({
      blocks: en,
      state: 'source',
    });
    expect(regionIn({}, 'footer', 'en', 'en')).toEqual({
      blocks: [],
      state: 'empty',
    });
    expect(regionIn({ footer: { de } }, 'footer', 'en', 'en').state).toBe(
      'empty',
    );
  });

  it('writes the source text for every language, until a language has its own', () => {
    let regions = withRegionText({}, 'footer', 'en', 'en', en);
    expect(regions).toEqual({ footer: en });
    regions = withRegionText(regions, 'footer', 'de', 'en', de);
    expect(regions).toEqual({ footer: { en, de } });
    const edited = [para('note', 'Keep it.')];
    expect(withRegionText(regions, 'footer', 'en', 'en', edited)).toEqual({
      footer: { en: edited, de },
    });
  });

  it('puts the source text back for a language whose own text goes', () => {
    const regions: Regions = { footer: { en, de } };
    expect(withoutTranslation(regions, 'footer', 'de', 'en')).toEqual({
      footer: en,
    });
    expect(withRegionText(regions, 'footer', 'de', 'en', [])).toEqual({
      footer: en,
    });
    // Nothing of its own to take away: as it was.
    expect(withoutTranslation({ footer: en }, 'footer', 'de', 'en')).toEqual({
      footer: en,
    });
    expect(withoutTranslation(regions, 'footer', 'en', 'en')).toBe(regions);
  });

  it('empties a region, keeping the translations when only the source text goes', () => {
    expect(withRegionText({ footer: en }, 'footer', 'en', 'en', [])).toEqual(
      {},
    );
    expect(
      withRegionText({ footer: { en, de } }, 'footer', 'en', 'en', []),
    ).toEqual({ footer: { de } });
    expect(
      withRegionText({ footer: { de } }, 'footer', 'de', 'en', []),
    ).toEqual({});
    const untouched: Regions = { back: en };
    expect(withRegionText(untouched, 'footer', 'de', 'en', [])).toBe(untouched);
    expect(withoutRegion({ footer: en, back: en }, 'footer')).toEqual({
      back: en,
    });
  });

  it("lists the preset's slots, the ones it lacks, and the missing translations", () => {
    expect(regionGroups('classic')).toEqual({
      titlePage: ['above-title', 'below-fields', 'footer'],
      backPage: ['back', 'back-footer'],
    });
    expect(regionGroups('minimal').titlePage).toEqual(['footer']);
    expect(strayRegions({ band: en, footer: en }, 'classic')).toEqual(['band']);
    const regions: Regions = { footer: { en, de }, back: en, band: en };
    expect(
      missingTranslations(
        regions,
        ['footer', 'back', 'above-title'],
        'de',
        'en',
      ),
    ).toEqual(['back']);
    expect(missingTranslations(regions, ['back'], 'en', 'en')).toEqual([]);
  });
});
