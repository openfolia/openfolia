import {
  DEFAULT_RELEASE_TAG,
  isReleasePart,
  isReleaseTagPattern,
  releaseTagName,
} from './release-tags.js';

describe('release tag names', () => {
  it('fill the pattern with the product and the revision', () => {
    expect(releaseTagName(DEFAULT_RELEASE_TAG, 'x-200', '1.2.0')).toBe(
      'release/x-200/1.2.0',
    );
    expect(releaseTagName('{revision}/of/{product}', 'p', 'r_1')).toBe(
      'r_1/of/p',
    );
  });

  it('refuse values that are no single safe ref component', () => {
    for (const value of [
      '',
      'a/b',
      '..',
      'a..b',
      '.a',
      '-a',
      'a.',
      'a.lock',
      'a b',
      'a:b',
      'a~1',
      'a^',
      'a@{0}',
      'x'.repeat(101),
      '{revision}',
    ]) {
      expect([value, isReleasePart(value)]).toEqual([value, false]);
      expect(releaseTagName(DEFAULT_RELEASE_TAG, value, '1')).toBeUndefined();
      expect(releaseTagName(DEFAULT_RELEASE_TAG, 'p', value)).toBeUndefined();
    }
  });

  it('take only a pattern with both placeholders, once each, as whole components', () => {
    expect(isReleaseTagPattern(DEFAULT_RELEASE_TAG)).toBe(true);
    for (const pattern of [
      '{product}',
      'r/{product}/{product}/{revision}',
      'r/{product}-{revision}',
      'r//{product}/{revision}',
      'r/{product}/{revision}/',
      'r/{product}/{revision}/x.lock',
    ]) {
      expect([pattern, isReleaseTagPattern(pattern)]).toEqual([pattern, false]);
    }
    expect(isReleaseTagPattern('refs/{product}/{revision}')).toBe(false);
    expect(releaseTagName('{product}/{revision}', 'refs', '1')).toBeUndefined();
    expect(releaseTagName('{product}/{revision}', 'Refs', '1')).toBeUndefined();
    expect(() => releaseTagName('{product}', 'p', 'r')).toThrow(
      'invalid release tag pattern',
    );
  });
});
