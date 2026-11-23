import {
  HIGHLIGHT_START as S,
  HIGHLIGHT_STOP as E,
  highlightRanges,
  MAX_QUERY_TOKENS,
  queryTokens,
  MIN_PREFIX_LENGTH,
  tsQueryText,
} from './search-query.js';
import { textSearchConfig } from './text-search-configs.js';

describe('queryTokens and tsQueryText', () => {
  it('keeps only folded runs of letters and digits, each once, a bounded number', () => {
    expect(queryTokens("Größe O'Brien: a&b | !c :* (x) 42")).toEqual([
      'grosse',
      'o',
      'brien',
      'a',
      'b',
      'c',
      'x',
      '42',
    ]);
    expect(queryTokens("'); drop table x; --")).toEqual(['drop', 'table', 'x']);
    expect(queryTokens('a b c d e f g h i j').length).toBe(MAX_QUERY_TOKENS);
    expect(queryTokens('a a A')).toEqual(['a']);
    expect(queryTokens('́ -- !!')).toEqual([]);
    expect(queryTokens('x'.repeat(200))[0]).toHaveLength(64);
  });

  it('makes every token a required word prefix', () => {
    expect(tsQueryText(['start', '420'])).toBe("'start':* & '420':*");
  });

  it('makes only words of MIN_PREFIX_LENGTH or more prefixes (#539): a one-letter prefix matches nearly everything', () => {
    expect(MIN_PREFIX_LENGTH).toBe(3);
    expect(tsQueryText(['a', 'ab', 'abc', '42', 'äb'])).toBe(
      "'a' & 'ab' & 'abc':* & '42' & 'äb'",
    );
  });
});

describe('highlightRanges', () => {
  it('maps the marked folded text back to the original', () => {
    expect(highlightRanges('Die Straße', `die ${S}strasse${E}`)).toEqual([
      { start: 4, end: 10 },
    ]);
    expect(
      highlightRanges(
        'Pump starts, starts',
        `pump ${S}starts${E}, ${S}starts${E}`,
      ),
    ).toEqual([
      { start: 5, end: 11 },
      { start: 13, end: 19 },
    ]);
  });

  it('marks nothing rather than something wrong', () => {
    // Not the folded text with markers in it.
    expect(highlightRanges('Pump', `pomp ${S}x${E}`)).toEqual([]);
    // Unbalanced markers.
    expect(highlightRanges('Pump', `${S}pump`)).toEqual([]);
    expect(highlightRanges('Pump', `pump${E}`)).toEqual([]);
    // A text holding a marker character itself.
    expect(highlightRanges(`a${S}b`, `${S}a${E}${S}b`)).toEqual([]);
  });
});

describe('textSearchConfig', () => {
  const available = new Set(['simple', 'english', 'german']);
  it('stems by the primary language where the database has it, else not at all', () => {
    expect(textSearchConfig('de-CH', available)).toBe('german');
    expect(textSearchConfig('EN', available)).toBe('english');
    expect(textSearchConfig('fr', available)).toBe('simple');
    expect(textSearchConfig('xx', available)).toBe('simple');
    expect(textSearchConfig('constructor', available)).toBe('simple');
    expect(textSearchConfig(undefined, available)).toBe('simple');
  });
});
