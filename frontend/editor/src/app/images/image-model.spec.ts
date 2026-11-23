import {
  assetHash,
  presetOf,
  searchQuery,
  tileLabel,
  typeName,
  widthOf,
  type AssetItem,
} from './image-model';

const HASH = 'a'.repeat(64);

const item = (meta: Partial<AssetItem['meta']>): AssetItem => ({
  type: 'Asset',
  id: HASH,
  attributes: {
    reference: `sha256:${HASH}`,
    fileName: null,
    contentType: 'image/png',
    size: 10,
    width: 4,
    height: 3,
    font: null,
  },
  meta: {
    usedIn: [],
    usedInCount: 0,
    usedInManuals: [],
    languages: [],
    usedAs: [],
    uploaded: false,
    missing: false,
    ...meta,
  },
});

describe('image model', () => {
  it('reads the hash of an asset reference, and nothing else', () => {
    expect(assetHash(`sha256:${HASH}`)).toBe(HASH);
    expect(assetHash(HASH)).toBeNull();
    expect(assetHash(`sha256:${HASH.toUpperCase()}`)).toBeNull();
    expect(assetHash('sha256:../../etc')).toBeNull();
  });

  it('maps widths to presets and back; another width is no preset', () => {
    expect(presetOf(10)).toBe('icon');
    expect(presetOf(50)).toBe('50');
    expect(presetOf(100)).toBe('full');
    expect(presetOf(40)).toBe('');
    expect(presetOf(null)).toBe('');
    expect(widthOf('75')).toBe(75);
    expect(widthOf('full')).toBe(100);
  });

  it("names a tile by a module showing it, in the module's language first", () => {
    const shown = item({
      usedIn: [
        { moduleId: 'charging', lang: 'de', title: 'Laden' },
        { moduleId: 'charging', lang: 'en', title: 'Charging' },
      ],
      usedInCount: 2,
      languages: [],
    });
    expect(tileLabel(shown, 'en')).toEqual({
      kind: 'module',
      title: 'Charging',
      more: 1,
    });
    expect(tileLabel(shown, 'fr')).toEqual({
      kind: 'module',
      title: 'Laden',
      more: 1,
    });
    expect(tileLabel(item({ uploaded: true }))).toEqual({ kind: 'uploaded' });
    expect(tileLabel(item({}))).toEqual({
      kind: 'unused',
      hash: HASH.slice(0, 12),
    });
  });

  it('names media types shortly', () => {
    expect(typeName('image/png')).toBe('PNG');
    expect(typeName('image/svg+xml')).toBe('SVG');
    expect(typeName(null)).toBeNull();
  });

  it('trims and caps the search', () => {
    expect(searchQuery('  pump  ')).toBe('pump');
    expect(searchQuery('x'.repeat(250))).toHaveLength(200);
    expect(searchQuery('   ')).toBe('');
  });
});
