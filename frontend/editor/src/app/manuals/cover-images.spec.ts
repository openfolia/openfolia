import {
  altIn,
  coverOf,
  issuesFor,
  moveCoverVariant,
  unshownCovers,
  withoutCoverAt,
  withAlt,
  withCover,
  type CoverImages,
  type Issue,
} from './manual-settings';

const A = `sha256:${'a'.repeat(64)}`;
const B = `sha256:${'b'.repeat(64)}`;
const EU = { market: 'eu' };
const US = { market: 'us' };

const covers: CoverImages = {
  default: { asset: A, alt: { en: 'Lifter' } },
  variants: [{ variant: EU, asset: B, alt: 'EU lifter' }],
};

describe('a manual’s cover images (#394)', () => {
  it('reads the manual’s and a variant’s own', () => {
    expect(coverOf(covers, 'manual')).toEqual(covers.default);
    expect(coverOf(covers, { market: 'eu' })).toEqual({
      asset: B,
      alt: 'EU lifter',
    });
    expect(coverOf(covers, US)).toBeUndefined();
    expect(coverOf(undefined, 'manual')).toBeUndefined();
  });

  it('sets, replaces and takes away one, leaving none when nothing is left', () => {
    const withUs = withCover(covers, US, { asset: A, alt: 'US' });
    expect(withUs?.variants.map((v) => v.variant)).toEqual([EU, US]);
    expect(withCover(covers, EU, { asset: A, alt: 'x' })?.variants).toEqual([
      { variant: EU, asset: A, alt: 'x' },
    ]);
    const noManual = withCover(covers, 'manual', undefined);
    expect(noManual).toEqual({ variants: covers.variants });
    expect(withCover(noManual, EU, undefined)).toBeUndefined();
  });

  it('lets a variant’s own follow its new values, or go with it', () => {
    expect(moveCoverVariant(covers, EU, US)?.variants).toEqual([
      { variant: US, asset: B, alt: 'EU lifter' },
    ]);
    expect(moveCoverVariant(covers, EU, undefined)?.variants).toEqual([]);
    expect(moveCoverVariant(covers, US, EU)).toBe(covers);
  });

  it('edits the alternative text per language', () => {
    expect(altIn('One for all', 'de')).toBe('One for all');
    expect(altIn({ en: 'Lifter' }, 'de')).toBe('');
    // One text for all stays one when the source language's changes…
    expect(withAlt('One for all', 'en', ' Front  view ', 'en')).toBe(
      'Front view',
    );
    // …and a target's own leaves the other targets to the source's, never a stale copy.
    expect(withAlt('One for all', 'de', '  Heber ', 'en')).toEqual({
      en: 'One for all',
      de: 'Heber',
    });
    expect(withAlt('One for all', 'de', '', 'en')).toBe('One for all');
    expect(withAlt({ en: 'Lifter', de: 'Heber' }, 'de', '', 'en')).toEqual({
      en: 'Lifter',
    });
    expect(withAlt({ en: 'Lifter' }, 'en', '', 'en')).toBeUndefined();
  });

  it('finds the variants’ own that are never shown, and takes one away', () => {
    const extra: CoverImages = {
      variants: [
        { variant: EU, asset: A, alt: 'a' },
        { variant: { market: 'eu' }, asset: B, alt: 'b' },
        { variant: US, asset: B, alt: 'c' },
      ],
    };
    expect(unshownCovers(extra, [EU])).toEqual([1, 2]);
    expect(withoutCoverAt(extra, 1)?.variants.map((v) => v.alt)).toEqual([
      'a',
      'c',
    ]);
    expect(
      withoutCoverAt({ variants: [extra.variants[0]!] }, 0),
    ).toBeUndefined();
  });

  it('finds the issues about them', () => {
    const issue = (code: string, at?: string): Issue => ({
      severity: 'warning',
      code,
      message: code,
      ...(at === undefined ? {} : { at }),
    });
    const found = issuesFor(
      [
        issue('unknown-cover-variant', 'coverImage.variants.1'),
        issue('unknown-language', 'coverImage.default.alt.xx'),
        issue('unknown-audience'),
      ],
      { kind: 'cover' },
    );
    expect(found.map((i) => i.code)).toEqual([
      'unknown-cover-variant',
      'unknown-language',
    ]);
  });
});
