import type { TranslatableField } from '@openfolia/content-model';

/** One piece of a unit's text, as the reviewer sees it (`plainTextOf`). */
export interface StyleReviewPart {
  readonly field: TranslatableField;
  readonly text: string;
}

/** One translatable unit of the module (a block's own text), by its block ID. */
export interface StyleReviewUnit {
  readonly blockId: string;
  /** The block's type, or `item` for a list item or procedure step. */
  readonly kind: string;
  readonly parts: readonly StyleReviewPart[];
}

/**
 * Everything a review sends out, and nothing else: the module's
 * translatable text (no metadata, no comments, no other module), its
 * language and the configured style guide.
 */
export interface StyleReviewRequest {
  readonly lang: string;
  readonly units: readonly StyleReviewUnit[];
  /** `styleGuide` in `openfolia.yaml`; undefined when there is none. */
  readonly styleGuide: string | undefined;
}

/**
 * What a reviewer proposes: replace `[start, end)` (UTF-16 code units of
 * the part's `text`) of a unit's part with `replacement` (none: a remark
 * only). Advisory, and untrusted: the action checks every one against the
 * text it sent and drops what does not fit.
 */
export interface ProposedSuggestion {
  readonly blockId: string;
  readonly field: string;
  readonly start: number;
  readonly end: number;
  readonly message: string;
  readonly replacement?: string | undefined;
}

/**
 * Port: a model-based style and consistency review of one module's text.
 * `configured` is false for the default (`NoStyleReviewer`): the feature
 * is off and nothing is ever sent anywhere. An adapter honours `signal`
 * (the action's timeout) and never puts a credential into an error it
 * throws.
 */
export abstract class StyleReviewer {
  abstract readonly configured: boolean;

  abstract review(
    request: StyleReviewRequest,
    signal: AbortSignal,
  ): Promise<readonly ProposedSuggestion[]>;
}

/** The review's limits, from the settings (`CCMS_STYLE_REVIEW_*`). */
export abstract class StyleReviewLimits {
  /** Reviews one actor may ask for per minute, on this server. */
  abstract readonly perMinute: number;
  /** How long one review may take, in ms. */
  abstract readonly timeoutMs: number;
}
