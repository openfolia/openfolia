import { TRANSLATABLE_FIELDS } from '@openfolia/content-model';
import { z } from 'zod';
import { resourceObject, singleDocument } from '../../base/api/json-api.js';
import type { StyleReview } from '../core/style-suggestion.js';

/** No body, or an empty one: nothing to send. */
export const StyleReviewRequestDocument = z
  .strictObject({})
  .optional()
  .meta({ id: 'StyleReviewRequestDocument' });
export type StyleReviewRequestDocument = z.output<
  typeof StyleReviewRequestDocument
>;

export const StyleSuggestion = z
  .object({
    id: z
      .string()
      .describe(
        'A hash of what makes it this suggestion, stable for the same text and answer.',
      ),
    blockId: z
      .string()
      .describe(
        'The block, list item, procedure step or image callout, by its ID.',
      ),
    field: z
      .enum(TRANSLATABLE_FIELDS)
      .describe(
        'Which part of the block: `content` (a paragraph, list item or step), `title`, `alt`, `hazard`, `question` (an FAQ entry’s), `name`, `description`, `legend` (an image callout’s).',
      ),
    range: z
      .object({
        start: z.number().int().min(0),
        end: z.number().int().min(1),
      })
      .describe(
        'What to change: UTF-16 code units of the part’s plain text (`plainTextOf` in `@openfolia/content-model`), `start` inclusive, `end` exclusive; never empty, never touching an inline node (an attribute, a cross-reference, keys, a line break).',
      ),
    original: z.string().describe('The text the range covers.'),
    message: z
      .string()
      .describe(
        'Why, as the model put it (advisory; at most 1,000 characters).',
      ),
    replacement: z
      .string()
      .nullable()
      .describe(
        'The text to put in place of `original` (one line, at most 2,000 characters); null for a remark without a fix.',
      ),
    rule: z
      .literal('model')
      .describe('Where it comes from: `model`, the model-based review.'),
  })
  .meta({ id: 'StyleSuggestion' });

export const StyleReviewResource = resourceObject('StyleReview', {
  attributes: z.object({
    lang: z.string(),
    moduleId: z.string(),
    suggestions: z
      .array(StyleSuggestion)
      .max(200)
      .describe(
        'In document order, at most 200: one answer, not a list resource, since nothing is stored to page through.',
      ),
  }),
  meta: z.object({
    version: z
      .number()
      .int()
      .min(0)
      .describe(
        'The working copy’s version reviewed; 0 when it was the committed file. Ranges refer to that text.',
      ),
    baseCommit: z
      .string()
      .describe('The commit the reviewed content is based on.'),
    dropped: z
      .number()
      .int()
      .min(0)
      .describe(
        'How many of the model’s proposals did not fit the module’s text (or came past the limit) and were left out.',
      ),
  }),
});

export const StyleReviewDocument = singleDocument(StyleReviewResource).meta({
  id: 'StyleReviewDocument',
});

export function toStyleReviewResource(
  review: StyleReview,
): z.infer<typeof StyleReviewResource> {
  return {
    type: 'StyleReview',
    id: `${review.lang}/${review.moduleId}`,
    attributes: {
      lang: review.lang,
      moduleId: review.moduleId,
      suggestions: review.suggestions.map((s) => ({
        ...s,
        range: { ...s.range },
      })),
    },
    meta: {
      version: review.version,
      baseCommit: review.baseCommit,
      dropped: review.dropped,
    },
  };
}

export const StyleReviewStatusResource = resourceObject('StyleReviewStatus', {
  attributes: z.object({
    configured: z
      .boolean()
      .describe(
        'Whether a model endpoint is set up (`CCMS_STYLE_REVIEW_URL` and `CCMS_STYLE_REVIEW_MODEL`): false means a review answers 404 `not-configured`.',
      ),
  }),
})
  .describe('`id` is always `style-review`.')
  .meta({ id: 'StyleReviewStatusResource' });

export const StyleReviewStatusDocument = singleDocument(
  StyleReviewStatusResource,
).meta({ id: 'StyleReviewStatusDocument' });
