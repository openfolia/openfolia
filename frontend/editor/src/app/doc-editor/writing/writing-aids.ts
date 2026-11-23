import type { WritingRules } from '@openfolia/content-model/core';

import type { TermHints } from './term-hints';

/**
 * What the page hands the block editor for the writing aids (#247): the writing checks compiled
 * for the document's language (`compileWritingRules`), and its terms for suggestions, links'
 * definitions and the picker. Either may be null (not read yet, or could not be read: then
 * nothing is checked or offered).
 */
export interface WritingAids {
  readonly rules: WritingRules | null;
  readonly terms: TermHints | null;
}

/** A term chosen in the term picker: which, and the text to insert (its preferred variant). */
export interface TermChoice {
  readonly termId: string;
  readonly text: string;
}
