import { foldText } from '@openfolia/content-model/core';

// Matching what is typed against the snippets: a paragraph whose first words are the start of a
// snippet's text (folded as search folds it: case, diacritics, `ß`, white space aside) is offered
// the rest of that snippet. Framework-free: the suggestion plugin and its tests use it.

/** A snippet as the suggestions know it: from `GET /module-summaries?filter[snippet]=true`. */
export interface SnippetSuggestion {
  /** The snippet module's ID. */
  readonly id: string;
  readonly title: string;
  /** The start of its plain text in the document's language (`meta.text`, 200 characters). */
  readonly text: string;
}

/** A match: the snippet, and the rest of its text after what was typed (as the snippet has it). */
export interface SnippetMatch {
  readonly snippet: SnippetSuggestion;
  readonly rest: string;
}

/** How many words must be typed before a snippet is suggested. */
export const MIN_MATCH_WORDS = 2;
/** How many characters (folded, without white space at the start) must be typed. */
export const MIN_MATCH_LENGTH = 6;

/**
 * The first snippet (in the order given) whose text starts with `typed`, once `typed` holds at
 * least `MIN_MATCH_WORDS` words and `MIN_MATCH_LENGTH` characters; null when none does. A
 * snippet typed out in full still matches (its rest is empty): accepting it makes it a
 * reference.
 */
export function matchSnippet(
  typed: string,
  snippets: readonly SnippetSuggestion[],
): SnippetMatch | null {
  const folded = foldText(typed).trimStart();
  if (folded.length < MIN_MATCH_LENGTH) return null;
  if (folded.trim().split(' ').length < MIN_MATCH_WORDS) return null;
  for (const snippet of snippets) {
    const rest = restAfter(snippet.text, folded);
    if (rest !== null) return { snippet, rest };
  }
  return null;
}

/**
 * The part of `text` after a start that folds to `folded`, or null when `text` does not start
 * so. Character by character, so the rest is cut where the snippet's own characters end (an
 * `ä` typed as `a` still matches, and the rest keeps the snippet's spelling).
 */
export function restAfter(text: string, folded: string): string | null {
  const whole = foldText(text);
  // A space typed at the end matches the space in the text, or its end.
  if (!whole.startsWith(folded) && !`${whole} `.startsWith(folded)) return null;
  let length = 0;
  let at = 0;
  const chars = Array.from(text);
  let previousSpace = false;
  while (at < chars.length && length < folded.length) {
    const char = chars[at] as string;
    const space = /\s/u.test(char);
    // Runs of white space fold to one space.
    if (!(space && previousSpace)) length += foldText(char).length;
    previousSpace = space;
    at += 1;
  }
  return chars.slice(at).join('');
}
