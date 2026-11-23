import type { TranslatableField } from '@openfolia/content-model';

/**
 * One suggestion of a style review: in the part `field` of the unit
 * `blockId`, replace `range` (UTF-16 code units of the part's plain text,
 * `plainTextOf`; `original` is what it covers) with `replacement`, or
 * only consider `message` when there is none. `rule` says where it came
 * from: `model` for the model-based review. `id` is a hash of what makes
 * it that suggestion.
 */
export interface StyleSuggestion {
  readonly id: string;
  readonly blockId: string;
  readonly field: TranslatableField;
  readonly range: { readonly start: number; readonly end: number };
  readonly original: string;
  readonly message: string;
  readonly replacement: string | null;
  readonly rule: 'model';
}

/** A review's answer: the suggestions for the text it reviewed. Not stored. */
export interface StyleReview {
  readonly changeSetId: string;
  readonly lang: string;
  readonly moduleId: string;
  /** The working copy's version reviewed; 0 for the committed file. */
  readonly version: number;
  /** The commit the reviewed content is based on. */
  readonly baseCommit: string;
  readonly suggestions: readonly StyleSuggestion[];
  /** Proposals that did not fit the module's text (or past the cap), left out. */
  readonly dropped: number;
}
