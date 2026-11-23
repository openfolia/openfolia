import {
  AsciidocParseError,
  parseCondition,
  localizedText,
  type Condition,
  type VariantAttribute,
} from '@openfolia/content-model';
import { z } from 'zod';
import {
  pagedDocument,
  resourceObject,
  toOne,
} from '../../base/api/json-api.js';
import { VariantSummary } from '../../manuals/api/manual.resources.js';
import type { VariantUse } from '../core/actions/list-variant-uses.action.js';
import type { VariantBuild } from '../core/actions/match-variants.action.js';

/** A configured label as stored (#731): one text for every language, or one per language. */
const Label = localizedText(z.string()).describe(
  'As configured: one text for every language, or one per language tag (the source language’s among them; a language without its own takes it).',
);

const VariantValue = z
  .object({
    id: z.string(),
    label: Label,
    archived: z
      .literal(true)
      .optional()
      .describe(
        'Archived: still valid where content uses it, but no longer offered for new content (a picker hides it). Left out for a value that is not archived.',
      ),
  })
  .meta({ id: 'VariantValue' });

export const VariantAttributeResource = resourceObject('VariantAttribute', {
  attributes: z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('enum'),
      label: Label,
      values: z
        .array(VariantValue)
        .describe('The values a variant may take, in the configured order.'),
    }),
    z.object({
      kind: z
        .literal('version')
        .describe('A dotted version, compared numerically (`2.10 > 2.9`).'),
      label: Label,
    }),
  ]),
})
  .describe(
    '`id` is the attribute’s ID, as conditions name it (`model in (large)`).',
  )
  .meta({ id: 'VariantAttributeResource' });

export const VariantAttributePageDocument = pagedDocument(
  VariantAttributeResource,
).meta({ id: 'VariantAttributePageDocument' });

export function toVariantAttributeResource(
  attribute: VariantAttribute,
): z.infer<typeof VariantAttributeResource> {
  return {
    type: 'VariantAttribute',
    id: attribute.id,
    attributes:
      attribute.kind === 'enum'
        ? {
            kind: 'enum',
            label: attribute.label,
            values: attribute.values.map(({ id, label, archived }) => ({
              id,
              label,
              ...(archived && { archived: true as const }),
            })),
          }
        : { kind: 'version', label: attribute.label },
  };
}

export const VariantBuildResource = resourceObject('VariantBuild', {
  attributes: z.object({
    values: VariantSummary.shape.values,
  }),
  relationships: z.object({ manual: toOne('Manual') }),
  meta: z.object({
    slug: VariantSummary.shape.slug,
    label: VariantSummary.shape.label,
    manualTitle: z.string(),
  }),
})
  .describe(
    'A manual in one of the variant combinations its manifest lists. `id` is `<manual ID>/<variant slug>`.',
  )
  .meta({ id: 'VariantBuildResource' });

export const VariantBuildPageDocument = pagedDocument(
  VariantBuildResource,
).meta({ id: 'VariantBuildPageDocument' });

export function toVariantBuildResource(
  build: VariantBuild,
): z.infer<typeof VariantBuildResource> {
  return {
    type: 'VariantBuild',
    id: `${build.manualId}/${build.variant.slug}`,
    attributes: { values: build.variant.values },
    relationships: { manual: { data: { type: 'Manual', id: build.manualId } } },
    meta: {
      slug: build.variant.slug,
      label: build.variant.label,
      manualTitle: build.manualTitle,
    },
  };
}

/** Longer conditions are refused before they are parsed. */
export const MAX_CONDITION_LENGTH = 1000;

/**
 * `?when=`: a condition in the text form a variant block's `when="…"` takes
 * in AsciiDoc (`model in (large) && software >= 2.3`), parsed by the
 * content model's parser; its message is the error's `detail`.
 */
export const ConditionText = z
  .string({ error: 'Give a condition, e.g. `model in (large)`.' })
  .max(MAX_CONDITION_LENGTH, `At most ${MAX_CONDITION_LENGTH} characters.`)
  .transform((text, ctx): Condition => {
    try {
      return parseCondition(text);
    } catch (error) {
      if (!(error instanceof AsciidocParseError)) throw error;
      ctx.addIssue({ code: 'custom', message: error.message });
      return z.NEVER;
    }
  });

export const VariantUseResource = resourceObject('VariantUse', {
  attributes: z.discriminatedUnion('kind', [
    z.object({
      kind: z
        .literal('manual')
        .describe(
          'A manual: its variant combinations, or a condition of an entry or a text attribute, name it.',
        ),
      manualId: z.string(),
      title: z.string(),
    }),
    z.object({
      kind: z
        .literal('module')
        .describe('A module: a variant block names it, in `languages`.'),
      moduleId: z.string(),
      title: z
        .string()
        .describe(
          'The title of its source-language file, else of its first file.',
        ),
      languages: z
        .array(z.string())
        .describe('The languages whose files name it, in code-unit order.'),
    }),
  ]),
})
  .describe(
    'A manual or module naming a variant attribute or value. `id` is `manual/<manual ID>` or `module/<module ID>`.',
  )
  .meta({ id: 'VariantUseResource' });

export const VariantUsePageDocument = pagedDocument(VariantUseResource).meta({
  id: 'VariantUsePageDocument',
});

export function toVariantUseResource(
  use: VariantUse,
): z.infer<typeof VariantUseResource> {
  return {
    type: 'VariantUse',
    id: `${use.kind}/${use.id}`,
    attributes:
      use.kind === 'manual'
        ? { kind: 'manual', manualId: use.id, title: use.title }
        : {
            kind: 'module',
            moduleId: use.id,
            title: use.title,
            languages: [...use.languages],
          },
  };
}
