import { countsAsAudience, matchesClassification } from './module-filter.js';

const LEVELS = ['public', 'partner', 'internal'];

describe('countsAsAudience (#699)', () => {
  it('matches a module’s own level, and only it', () => {
    expect(countsAsAudience('partner', 'partner', LEVELS)).toBe(true);
    expect(countsAsAudience('partner', 'public', LEVELS)).toBe(false);
    expect(countsAsAudience('partner', 'internal', LEVELS)).toBe(false);
  });

  it('counts a module naming no audience as the last, most restricted level', () => {
    expect(countsAsAudience(undefined, 'internal', LEVELS)).toBe(true);
    expect(countsAsAudience(undefined, 'public', LEVELS)).toBe(false);
    expect(countsAsAudience(undefined, 'partner', LEVELS)).toBe(false);
  });

  it('places an audience the configuration does not list at no level', () => {
    for (const level of LEVELS) {
      expect(countsAsAudience('retired', level, LEVELS)).toBe(false);
    }
    // Not even when asked for by name: a level not configured matches nothing.
    expect(countsAsAudience('retired', 'retired', LEVELS)).toBe(false);
    expect(countsAsAudience(undefined, 'retired', LEVELS)).toBe(false);
  });

  it('matches nothing without configured levels', () => {
    expect(countsAsAudience(undefined, 'internal', [])).toBe(false);
    expect(countsAsAudience('internal', 'internal', [])).toBe(false);
  });
});

describe('matchesClassification', () => {
  const meta = (audience?: string) => ({
    type: 'concept',
    facets: {},
    ...(audience !== undefined && { audience }),
  });

  it('filters by the level a module counts as, with the other parts', () => {
    expect(
      matchesClassification(meta(), { audience: 'internal' }, LEVELS),
    ).toBe(true);
    expect(
      matchesClassification(
        meta(),
        { audience: 'internal', type: 'procedure' },
        LEVELS,
      ),
    ).toBe(false);
    expect(matchesClassification(meta(), { audience: 'public' }, LEVELS)).toBe(
      false,
    );
    // Without an audience filter, any audience passes, an unknown one too.
    expect(matchesClassification(meta('retired'), {}, LEVELS)).toBe(true);
  });
});
