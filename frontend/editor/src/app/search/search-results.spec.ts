import type { SearchResult } from './palette-search';
import { resultRow } from './search-results';

const result = (
  resourceType: 'Module' | 'Manual' | 'Term',
  resourceId: string,
  lang?: string,
): SearchResult => ({
  type: 'SearchResult',
  id: `${resourceType.toLowerCase()}:${resourceId}`,
  attributes: {
    resourceType,
    resourceId,
    ...(lang === undefined ? {} : { lang }),
    title: 'Charger',
  },
  relationships: {
    resource: { data: { type: resourceType, id: resourceId } },
  },
  meta: {
    matchedOn: 'title',
    excerpt: 'Charger',
    matches: [],
    deprecated: false,
  },
});

describe('resultRow', () => {
  it('opens modules and manuals', () => {
    expect(resultRow(result('Module', 'en/charging', 'en'))?.item).toEqual({
      kind: 'module',
      id: 'charging',
      lang: 'en',
      title: 'Charger',
    });
    expect(resultRow(result('Manual', 'operating'))?.item).toEqual({
      kind: 'manual',
      id: 'operating',
      title: 'Charger',
    });
  });

  it('says whether a module or manual found is deprecated (#266)', () => {
    const found = result('Module', 'en/charging', 'en');
    expect(resultRow(found)?.deprecated).toBe(false);
    expect(
      resultRow({ ...found, meta: { ...found.meta, deprecated: true } })
        ?.deprecated,
    ).toBe(true);
  });

  it('shows a match by meaning as its closest block, like a text match (#54)', () => {
    const found = result('Module', 'en/charging', 'en');
    const row = resultRow({
      ...found,
      attributes: { ...found.attributes, blockId: 'p1' },
      meta: {
        ...found.meta,
        matchedOn: 'meaning',
        excerpt: 'Charge the battery overnight.',
      },
    });
    expect(row).toMatchObject({
      blockId: 'p1',
      detail: 'Charge the battery overnight.',
      detailMatches: [],
      textMatch: true,
    });
  });

  it('leaves terms out: the palette cannot open them yet', () => {
    expect(resultRow(result('Term', 'charger', 'en'))).toBeNull();
  });
});
