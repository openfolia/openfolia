import {
  LanguageTag,
  ModuleId,
  ModuleMeta,
  SNIPPET_EXCERPT_LENGTH,
} from '@openfolia/content-model';
import { z } from 'zod';
import { pagedDocument, resourceObject } from '../../base/api/json-api.js';
import type { ModuleSummary } from '../core/actions/list-module-summaries.action.js';

export const ModuleSummaryAttributes = z
  .object({
    moduleId: ModuleId,
    title: ModuleMeta.shape.title.describe(
      'In `filter[lang]` when given, else in the source language (else in the first language there is).',
    ),
    titleLang: LanguageTag.describe('The language of `title`.'),
    moduleType: ModuleMeta.shape.type.describe(
      'One of the configured module types, e.g. `procedure`.',
    ),
    audience: ModuleMeta.shape.audience,
    facets: ModuleMeta.shape.facets,
    keywords: z
      .array(z.string())
      .describe(
        'The keywords of the module in the language of `title` (keywords are per language); empty for none.',
      ),
    languages: z
      .array(LanguageTag)
      .describe(
        'The languages it exists in: the source language first, the others sorted.',
      ),
    variants: z
      .array(z.string())
      .describe(
        'What its variant blocks are conditioned on, sorted: `attribute=value` for an enum value, `attribute>=2.3` (or `<`, `<=`, `>`) for a version.',
      ),
    deprecated: ModuleMeta.shape.deprecated.describe(
      'Its deprecation (#266), with why and what replaces it: its source-language file’s (else, when the reader sees none, that of the language of `title`). Absent when it is not deprecated.',
    ),
  })
  .meta({ id: 'ModuleSummaryAttributes' });

export const ModuleSummaryResource = resourceObject('ModuleSummary', {
  attributes: ModuleSummaryAttributes,
  meta: z.object({
    changed: z
      .boolean()
      .describe(
        'Whether it differs from the released branch (`main`) in any language, or is not there: true for a module a change set added or edited.',
      ),
    text: z
      .string()
      .max(SNIPPET_EXCERPT_LENGTH * 2)
      .describe(
        `The start of its plain text in the language of \`title\`, in document order: at most ${SNIPPET_EXCERPT_LENGTH} characters, white space collapsed, a text attribute as its reference, \`{name}\` (its value depends on the manual). For matching a snippet while writing without reading each module.`,
      ),
    deleted: z
      .object({
        commit: z.string().describe('The commit of its newest deletion.'),
        committedAt: z
          .string()
          .describe(
            'When that commit was committed (ISO 8601, the committer’s offset).',
          ),
      })
      .optional()
      .describe(
        'Set for a deleted module (`filter[status]`, #320): its newest deletion. Its attributes are then those of its last versions, `languages` the languages deleted, and its history (`GET /modules/{lang}/{id}/history`, in one of them) holds the versions to restore.',
      ),
  }),
})
  .describe('`id` is the module ID.')
  .meta({ id: 'ModuleSummaryResource' });

export const ModuleSummaryPageDocument = pagedDocument(
  ModuleSummaryResource,
).meta({ id: 'ModuleSummaryPageDocument' });

export function toModuleSummaryResource(
  summary: ModuleSummary,
): z.infer<typeof ModuleSummaryResource> {
  return {
    type: 'ModuleSummary',
    id: summary.id,
    attributes: {
      moduleId: summary.id,
      title: summary.title,
      titleLang: summary.titleLang,
      moduleType: summary.moduleType,
      ...(summary.audience === undefined ? {} : { audience: summary.audience }),
      facets: summary.facets,
      keywords: summary.keywords,
      languages: summary.languages,
      variants: summary.variants,
      ...(summary.deprecated && { deprecated: summary.deprecated }),
    },
    meta: {
      changed: summary.changed,
      text: summary.text,
      ...(summary.deleted && {
        deleted: {
          commit: summary.deleted.commit,
          committedAt: summary.deleted.committedAt,
        },
      }),
    },
  };
}
