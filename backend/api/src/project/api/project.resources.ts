import { ProjectConfig } from '@openfolia/content-model';
import { z } from 'zod';
import {
  pagedDocument,
  resourceObject,
  singleDocument,
} from '../../base/api/json-api.js';
import type { Ref } from '../core/actions/list-refs.action.js';
import {
  usageKey,
  type ConfigValueUsage,
} from '../core/config-usage-counts.js';

export const RefResource = resourceObject('Ref', {
  attributes: z.object({
    kind: z.enum(['branch', 'tag']),
    name: z.string(),
    commit: z.string().describe('The commit it points to (tags are peeled).'),
  }),
  meta: z
    .object({
      withdrawal: z
        .object({
          by: z
            .object({ kind: z.enum(['user', 'service']), id: z.string() })
            .describe('Who withdrew it.'),
          at: z.iso.datetime({ offset: true }).describe('When.'),
          reason: z.string().describe('Why, in their words.'),
        })
        .nullable()
        .describe(
          'Set when the tag is a withdrawn release’s: reads at it keep working, and say so in `X-Ccms-Withdrawn: true`. Null while the release stands, or when the tag is no release’s.',
        ),
    })
    .optional()
    .describe('Tags only.'),
})
  .describe('`id` is `heads/<branch>` or `tags/<tag>`.')
  .meta({ id: 'RefResource' });

export const RefPageDocument = pagedDocument(RefResource).meta({
  id: 'RefPageDocument',
});

export function toRefResource(ref: Ref): z.infer<typeof RefResource> {
  const { kind, name, commit } = ref;
  if (ref.kind === 'branch') {
    return {
      type: 'Ref',
      id: `heads/${name}`,
      attributes: { kind, name, commit },
    };
  }
  const { withdrawal } = ref;
  return {
    type: 'Ref',
    id: `tags/${name}`,
    attributes: { kind, name, commit },
    meta: {
      withdrawal: withdrawal && {
        by: { kind: withdrawal.by.kind, id: withdrawal.by.id },
        at: withdrawal.at.toISOString(),
        reason: withdrawal.reason,
      },
    },
  };
}

export const IirdsMappingIssueSchema = z
  .object({
    code: z
      .enum([
        'unmapped-module-type',
        'unmapped-audience',
        'unmapped-facet',
        'unmapped-variant-attribute',
        'unmapped-lifecycle-phase',
        'unknown-mapping-key',
      ])
      .describe(
        'Stable. `unmapped-*`: a value the configuration defines that the iiRDS mapping names no class for (an iiRDS package leaves that metadata out, with a warning); `unknown-mapping-key`: a key of the mapping naming nothing the configuration defines (ignored).',
      ),
    path: z.string().describe('Where in `iirds`, e.g. `moduleTypes.task`.'),
    message: z.string(),
  })
  .meta({ id: 'IirdsMappingIssue' });

const DitaMappingIssueSchema = z
  .object({
    code: z
      .enum([
        'unknown-module-type',
        'unknown-variant-attribute',
        'unknown-variant-value',
        'unknown-audience',
        'unknown-text-attribute',
        'unknown-safety-symbol',
      ])
      .describe(
        'Stable: the value of the DITA mapping names no module type, variant attribute, variant value, audience level, text attribute or safety symbol of the configuration. A DITA import uses its default there and reports it.',
      ),
    path: z.string().describe('Where in `dita`, e.g. `moduleTypes.task`.'),
    message: z.string(),
  })
  .meta({ id: 'DitaMappingIssue' });

const LanguageDirectionIssueSchema = z
  .object({
    code: z
      .enum(['unknown-direction-language'])
      .describe(
        'Stable: `languages.direction` sets a direction for a language that is neither the source nor a target. It does nothing, and the next save of the configuration leaves it out.',
      ),
    path: z
      .string()
      .describe('Where in the configuration, e.g. `languages.direction.fa`.'),
    message: z.string(),
  })
  .meta({ id: 'LanguageDirectionIssue' });

export const ProjectConfigResource = resourceObject('ProjectConfig', {
  attributes: ProjectConfig,
  meta: z
    .object({
      iirdsIssues: z
        .array(IirdsMappingIssueSchema)
        .optional()
        .describe(
          'The check of the iiRDS mapping (`iirds`, #431) against the rest of the configuration, in the configuration’s order: what it leaves unmapped and keys naming nothing. Never refused, only reported. Bounded by the configuration (at most one per value it defines or key the mapping has). Only with an iiRDS mapping.',
        ),
      ditaIssues: z
        .array(DitaMappingIssueSchema)
        .optional()
        .describe(
          'The check of the DITA mapping (`dita`, #432) against the rest of the configuration, in the mapping’s order: each value naming nothing configured. Never refused, only reported. Bounded by the mapping (at most one per value). Only with a DITA mapping.',
        ),
      directionIssues: z
        .array(LanguageDirectionIssueSchema)
        .optional()
        .describe(
          'Each `languages.direction` entry for a language not configured (#396), sorted by tag. Never refused, only reported. Bounded by `languages.direction`. Only when there is one.',
        ),
    })
    .optional()
    .describe(
      'Only when the configuration holds an iiRDS or a DITA mapping, or a direction for a language not configured.',
    ),
})
  .describe('A singleton: `id` is always `project`.')
  .meta({ id: 'ProjectConfigResource' });

export const ProjectConfigDocument = singleDocument(ProjectConfigResource).meta(
  { id: 'ProjectConfigDocument' },
);

export const ConfigUsageResource = resourceObject('ConfigUsage', {
  attributes: z.object({
    kind: z
      .enum([
        'language',
        'moduleType',
        'audience',
        'facet',
        'facetValue',
        'variantAttribute',
        'variantValue',
        'textAttribute',
        'safetySymbol',
        'calloutStyle',
      ])
      .describe('The part of the configuration the value belongs to.'),
    valueId: z
      .string()
      .describe('The value’s ID (a language tag for a language).'),
    parentId: z
      .string()
      .optional()
      .describe(
        'The facet (`facetValue`) or variant attribute (`variantValue`) the value belongs to.',
      ),
  }),
  meta: z.object({
    modules: z
      .number()
      .int()
      .nonnegative()
      .describe(
        'Modules naming it, counted by ID (every language of a module counts once), as the reader sees them.',
      ),
    manuals: z
      .number()
      .int()
      .nonnegative()
      .describe('Manuals naming it, as the reader sees them.'),
  }),
})
  .describe(
    '`id` is `<kind>/<valueId>`, or `<kind>/<parentId>/<valueId>` for a facet or variant value.',
  )
  .meta({ id: 'ConfigUsageResource' });

export const ConfigUsagePageDocument = pagedDocument(ConfigUsageResource).meta({
  id: 'ConfigUsagePageDocument',
});

export function toConfigUsageResource({
  kind,
  valueId,
  parentId,
  modules,
  manuals,
}: ConfigValueUsage): z.infer<typeof ConfigUsageResource> {
  return {
    type: 'ConfigUsage',
    id: usageKey(kind, valueId, parentId),
    attributes: {
      kind,
      valueId,
      ...(parentId !== undefined && { parentId }),
    },
    meta: { modules, manuals },
  };
}
