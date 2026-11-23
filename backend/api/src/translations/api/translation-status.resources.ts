import {
  BlockId,
  ConfigUnitKey,
  DesignUnitKey,
  LanguageTag,
  ManifestUnitKey,
  ModuleId,
  PageDesignId,
} from '@openfolia/content-model';
import { z } from 'zod';
import {
  pagedDocument,
  resourceObject,
  singleDocument,
} from '../../base/api/json-api.js';
import { isConfigKey } from '../core/config-translations.js';
import { designIdOf } from '../core/design-translations.js';
import { manualIdOf } from '../core/manual-translations.js';
import {
  TRANSLATION_STATES,
  TRANSLATION_STATUS_KINDS,
  type TranslationStatus,
} from '../core/translation-status.js';

export const TranslationStateSchema = z
  .enum(TRANSLATION_STATES)
  .describe(
    '`up-to-date`: translated from the source text it has now; `outdated`: the source changed since, or a block was never translated, or the translation has no record; `missing`: no file in that language; `at-provider`: sent to a translation provider and not back yet. A module is `missing` or `outdated` while any block not at a provider is, else `at-provider` while any block is, else `up-to-date`.',
  )
  .meta({ id: 'TranslationState' });

/**
 * A unit's ID: a module's block ID, a page design's unit key (`<slot>.<block>`, #568), a
 * manual's (`title`, `group.…`, `coverImage.…`, #656, #731) or the configuration's
 * (`moduleTypes.<id>`, …, #731).
 */
export const UnitId = z
  .union([BlockId, DesignUnitKey, ManifestUnitKey, ConfigUnitKey])
  .describe(
    'A block (or list item, or callout) ID of a module; for a page design’s region text (#568), `<slot>.<block>`; for a manual’s own text, `title`, `group.<12 hex digits>` (a group’s title, #731), `coverImage.default` or `coverImage.variant-<12 hex digits>` (#656); for the project labels (#731), the label’s list and ID: `moduleTypes.<id>`, `audiences.<id>`, `facets.<id>`, `facets.<id>.<value>`, `variantAttributes.<id>`, `variantAttributes.<id>.<value>`, `textAttributes.<id>`, `safetySymbols.<id>`, `calloutStyles.<id>`.',
  );

const BlockStatusSchema = z
  .object({ blockId: UnitId, state: TranslationStateSchema })
  .meta({ id: 'TranslationBlockStatus' });

const StatusMeta = {
  title: z
    .string()
    .describe(
      'The source module’s title; a page design’s name; a manual’s title (in the source language); `Project labels` for the configuration’s labels.',
    ),
  totalBlocks: z
    .int()
    .min(0)
    .describe('The translatable units (blocks) of the source module.'),
  outdatedBlocks: z
    .int()
    .min(0)
    .describe(
      'The units that need translating: `outdated` or `missing`, and not at a provider.',
    ),
  atProviderBlocks: z.int().min(0),
  sourceCommit: z
    .string()
    .nullable()
    .describe(
      'The source commit the translation was made from (its translation record’s); null without a record.',
    ),
};

const StatusAttributes = z
  .object({
    kind: z
      .enum(TRANSLATION_STATUS_KINDS)
      .describe(
        '`module`: a source module; `design`: a page design’s region text (#568); `manual`: a manual’s own text, its title, its groups’ titles (#731) and its cover images’ alternative text (#656); `config`: the project labels in `openfolia.yaml` (#731: module types, audiences, facets and their values, variant attributes and their values, text attributes, safety symbols, callout styles), no `moduleId`, `designId` or `manualId`.',
      ),
    moduleId: ModuleId.optional().describe('The source module (`module`).'),
    designId: PageDesignId.optional().describe('The page design (`design`).'),
    manualId: ModuleId.optional().describe('The manual (`manual`).'),
    lang: LanguageTag.describe('The target language.'),
    state: TranslationStateSchema,
  })
  .meta({ id: 'TranslationStatusAttributes' });

export const TranslationStatusResource = resourceObject('TranslationStatus', {
  attributes: StatusAttributes,
  meta: z.object(StatusMeta),
})
  .describe(
    '`id` is `<lang>/<moduleId>`: the source module in one target language; `<lang>/designs/<designId>` for a page design’s region text; `<lang>/manuals/<manualId>` for a manual’s own text; `<lang>/config/project` for the project labels.',
  )
  .meta({ id: 'TranslationStatusResource' });

export const TranslationStatusDetailResource = resourceObject(
  'TranslationStatus',
  {
    attributes: StatusAttributes,
    meta: z.object({
      ...StatusMeta,
      blocks: z
        .array(BlockStatusSchema)
        .describe('Every unit of the source module, in document order.'),
    }),
  },
).meta({ id: 'TranslationStatusDetailResource' });

export const TranslationStatusPageDocument = pagedDocument(
  TranslationStatusResource,
).meta({ id: 'TranslationStatusPageDocument' });

export const TranslationStatusDocument = singleDocument(
  TranslationStatusDetailResource,
).meta({ id: 'TranslationStatusDocument' });

export function toTranslationStatusResource(
  status: TranslationStatus,
): z.infer<typeof TranslationStatusResource> {
  const designId =
    status.kind === 'design' ? designIdOf(status.moduleId) : undefined;
  const manualId =
    status.kind === 'manual' ? manualIdOf(status.moduleId) : undefined;
  const config = status.kind === 'config' && isConfigKey(status.moduleId);
  return {
    type: 'TranslationStatus',
    id: config
      ? `${status.lang}/config/project`
      : designId !== undefined
        ? `${status.lang}/designs/${designId}`
        : manualId !== undefined
          ? `${status.lang}/manuals/${manualId}`
          : `${status.lang}/${status.moduleId}`,
    attributes: {
      kind: status.kind,
      ...(config
        ? {}
        : designId !== undefined
          ? { designId }
          : manualId !== undefined
            ? { manualId }
            : { moduleId: status.moduleId }),
      lang: status.lang,
      state: status.state,
    },
    meta: {
      title: status.title,
      totalBlocks: status.blocks.length,
      outdatedBlocks: status.outdatedBlocks,
      atProviderBlocks: status.atProviderBlocks,
      sourceCommit: status.sourceCommit,
    },
  };
}

export function toTranslationStatusDetailResource(
  status: TranslationStatus,
): z.infer<typeof TranslationStatusDetailResource> {
  const resource = toTranslationStatusResource(status);
  return {
    ...resource,
    meta: {
      ...resource.meta,
      blocks: status.blocks.map(({ blockId, state }) => ({ blockId, state })),
    },
  };
}
