import { MAX_QUERY_WORDS, type MatchRange } from '../core/content-search.js';
import { fold, foldText } from './search-entries.js';

/** The most words of a query the Postgres search matches on (each a run of letters or digits). */
export const MAX_QUERY_TOKENS = MAX_QUERY_WORDS;

/** The longest token looked for; a longer run of letters is cut (no word is that long). */
const MAX_TOKEN_LENGTH = 64;

/**
 * The words of a query as the Postgres search looks for them: folded (lower
 * case, no diacritics, `ß` as `ss`) like the indexed text, split into runs
 * of letters and digits, each once, at most `MAX_QUERY_TOKENS`. Only
 * letters and digits are left, so no token can carry `tsquery` syntax
 * (quotes, `&`, `|`, `!`, `:`, parentheses) or anything else.
 */
export function queryTokens(query: string): string[] {
  const tokens = foldText(query).match(/[\p{L}\p{N}]+/gu) ?? [];
  return [...new Set(tokens.map((t) => t.slice(0, MAX_TOKEN_LENGTH)))].slice(
    0,
    MAX_QUERY_TOKENS,
  );
}

/**
 * Tokens shorter than this are whole words in the full text, never
 * prefixes (#539): `'a':*` matches nearly every part, a slow shape for
 * nothing; the word list still finds them anywhere in a word.
 */
export const MIN_PREFIX_LENGTH = 3;

/**
 * The `to_tsquery` text for `tokens`: every token of `MIN_PREFIX_LENGTH`
 * or more as a word prefix (`'start':*`), a shorter one as a whole word,
 * all of them required. Passed as a parameter, never into the SQL; the
 * configuration's stemmer then reduces each word (`starting` to `start`),
 * so any word form of the language matches.
 */
export function tsQueryText(tokens: readonly string[]): string {
  // Only letters and digits (`queryTokens`): nothing to escape.
  return tokens
    .map((token) =>
      [...token].length >= MIN_PREFIX_LENGTH ? `'${token}':*` : `'${token}'`,
    )
    .join(' & ');
}

/** What `ts_headline` puts around a match: control characters no folded text holds (`highlightRanges` checks). */
export const HIGHLIGHT_START = '\u0002';
export const HIGHLIGHT_STOP = '\u0003';

/** `ts_headline`'s options: the whole text, the markers above. */
export const HEADLINE_OPTIONS = `HighlightAll=true, StartSel=${HIGHLIGHT_START}, StopSel=${HIGHLIGHT_STOP}`;

/**
 * Where `ts_headline` marked matches in `original`'s folded text, as
 * ranges of `original` (UTF-16, in order, not overlapping). None when the
 * marked text is not exactly the folded text with markers in it (a text
 * holding a marker character itself), so a wrong offset is never returned.
 */
export function highlightRanges(
  original: string,
  headline: string,
): MatchRange[] {
  const folded = fold(original);
  if (
    folded.text.includes(HIGHLIGHT_START) ||
    folded.text.includes(HIGHLIGHT_STOP)
  ) {
    return [];
  }
  const ranges: MatchRange[] = [];
  let plain = '';
  let open: number | undefined;
  for (const character of headline) {
    if (character === HIGHLIGHT_START) {
      if (open !== undefined) return [];
      open = plain.length;
    } else if (character === HIGHLIGHT_STOP) {
      if (open === undefined) return [];
      if (plain.length > open) {
        const start = folded.from[open];
        const end = folded.to[plain.length - 1];
        if (start === undefined || end === undefined) return [];
        const last = ranges[ranges.length - 1];
        if (last && start <= last.end) last.end = Math.max(last.end, end);
        else ranges.push({ start, end });
      }
      open = undefined;
    } else {
      plain += character;
    }
  }
  return open === undefined && plain === folded.text ? ranges : [];
}
