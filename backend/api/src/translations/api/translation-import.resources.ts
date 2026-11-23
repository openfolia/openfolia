import { LanguageTag, ModuleId, PageDesignId } from '@openfolia/content-model';
import type { Request } from 'express';
import { z } from 'zod';
import {
  PageLinks,
  PageMeta,
  resourceObject,
  toOne,
  toPagedDocument,
} from '../../base/api/json-api.js';
import { type PageRequest, paginate } from '../../base/core/paging.js';
import { UnitId } from './translation-status.resources.js';
import { CONFIG_KEY } from '../core/config-translations.js';
import { DESIGN_KEY_PREFIX } from '../core/design-translations.js';
import { MANUAL_KEY_PREFIX } from '../core/manual-translations.js';
import type { MarkedCurrent } from '../core/actions/mark-translation-current.action.js';
import {
  IMPORT_UNIT_STATES,
  type ImportUnitState,
  MAX_REPORT_TEXT_CHARACTERS,
  MAX_UNIT_TEXT_LENGTH,
  reportWith,
  SOURCE_CHANGED_DECISIONS,
  TRANSLATION_IMPORT_STATES,
  type TranslationImport,
} from '../core/translation-import.js';

/**
 * A module's ID, a page design's key (`design.<designId>`, #568), a manual's
 * (`manual.<manualId>`, #656) or the project labels' (`config.project`, #731).
 */
const ModuleOrDesign = z
  .union([
    ModuleId,
    z
      .string()
      .startsWith(DESIGN_KEY_PREFIX)
      .refine(
        (key) =>
          PageDesignId.safeParse(key.slice(DESIGN_KEY_PREFIX.length)).success,
        'design.<page design ID>',
      ),
    z
      .string()
      .startsWith(MANUAL_KEY_PREFIX)
      .refine(
        (key) =>
          ModuleId.safeParse(key.slice(MANUAL_KEY_PREFIX.length)).success,
        'manual.<manual ID>',
      ),
    z.literal(CONFIG_KEY),
  ])
  .describe(
    'A module’s ID; for a page design’s region text (#568), `design.<designId>`; for a manual’s own text (#656), `manual.<manualId>`; for the project labels (#731), `config.project`.',
  );

const Who = z.object({ kind: z.enum(['user', 'service']), id: z.string() });
const Time = z.iso.datetime({ offset: true });

const Counts = z
  .object({
    units: z.int().min(0).describe('Every unit read, in every document.'),
    ok: z.int().min(0),
    sourceChanged: z.int().min(0),
    brokenMarkup: z.int().min(0),
    unknownBlock: z.int().min(0),
    unknownModule: z.int().min(0),
    outsideScope: z.int().min(0),
  })
  .describe('The units per state, over the whole report.')
  .meta({ id: 'TranslationImportCounts' });

export const ImportUnitReportSchema = z
  .object({
    blockId: z.string(),
    state: z
      .enum(IMPORT_UNIT_STATES)
      .describe(
        '`ok`: imported on apply. `source-changed`: the source block changed since it was exported; imported unless its decision is `skip`, and then still `outdated`. `broken-markup`: its target’s inline codes do not match its source (`reason`); refused, alone. `unknown-block`: not a block the job sent in this language (`reason: not-sent`), or one the source has no longer (`removed`). `unknown-module`: no such module you may read. `outside-scope`: a module you read but do not manage translations of in this language (or whose translation you may not see).',
      ),
    reason: z
      .string()
      .optional()
      .describe(
        'Why it is refused, a stable code. `broken-markup`: `missing-segment`, `extra-segment`, `missing-target`, `unsupported-markup`, `unknown-code`, `code-mismatch`, `missing-code`, `extra-code`, `nesting`, `line-break`, `empty`, `invalid-content`, or `source-hash` (its `ccms:sourceHash` is not the one exported). `unknown-block`: `not-sent`, `removed`.',
      ),
    kind: z
      .string()
      .optional()
      .describe(
        'What the unit is: its block’s type (`paragraph`, `section`, `table`, …), `item` for a list item or procedure step, or `callout` for an image callout’s legend (its `blockId` the callout’s ID). Where the job sent the unit (not for `unknown-module`, `outside-scope` or `not-sent`).',
      ),
    detail: z.string().optional().describe('What is wrong, for a person.'),
    texts: z
      .object({
        exported: z
          .string()
          .describe('The source as the job sent it (at its commit).'),
        current: z
          .string()
          .describe('The source on the base now (empty when it has none).'),
        target: z.string().describe('The uploaded translation.'),
        truncated: z
          .boolean()
          .describe(
            `One of them was cut at ${MAX_UNIT_TEXT_LENGTH} characters.`,
          ),
      })
      .optional()
      .describe(
        `\`source-changed\` only: the texts the decision is made on, as plain text (each part of the unit on a line of its own). Left out once the report holds ${MAX_REPORT_TEXT_CHARACTERS} characters of them.`,
      ),
  })
  .meta({ id: 'TranslationImportUnit' });

export const ImportModuleReportSchema = z
  .object({
    lang: LanguageTag,
    moduleId: z
      .string()
      .describe(
        'The `<file id>` of the document: a module’s ID, `design.<designId>` for a page design’s region text (#568), `manual.<manualId>` for a manual’s own text (#656), or `config.project` for the project labels (#731).',
      ),
    designId: z
      .string()
      .optional()
      .describe(
        'For a page design’s region text (#568): the design. Its units are `<slot>.<block>`; `unknown-module` is a design that is not there, `outside-scope` one whose translation into this language you do not manage, or that you may not change (`content.edit` in a role restricting nothing).',
      ),
    manualId: z
      .string()
      .optional()
      .describe(
        'For a manual’s own text (its title and its groups’ titles, #731; its cover images’ alternative text, #656): the manual. Its units are `title`, `group.<hex>`, `coverImage.default` and `coverImage.variant-<hex>`; `unknown-module` is a manual that is not there for you, `outside-scope` one you do not read in this language, whose translation into it you do not manage, or whose manifest you may not change. A translation that is not one line of at most 500 characters is `broken-markup` (`invalid-content`).',
      ),
    config: z
      .literal(true)
      .optional()
      .describe(
        'For the project labels (#731, the labels in `openfolia.yaml`). Its units are `moduleTypes.<id>`, `facets.<id>.<value>`, …; `outside-scope` where you do not manage their translation into this language (`translation.manage` restricted by nothing but languages) or may not change the configuration. A translation that is not one line of at most 500 characters is `broken-markup` (`invalid-content`).',
      ),
    title: z
      .string()
      .optional()
      .describe(
        'The source module’s title on the base (a page design’s name, a manual’s title in the source language, `Project labels`); not for `unknown-module` or `outside-scope`.',
      ),
    units: z.array(ImportUnitReportSchema).describe('In the document’s order.'),
  })
  .meta({ id: 'TranslationImportModule' });

export const TranslationImportResource = resourceObject('TranslationImport', {
  attributes: z.object({
    languages: z
      .array(LanguageTag)
      .describe(
        'The uploaded documents’ target languages, in the job’s order.',
      ),
    baseRef: z
      .string()
      .describe('The branch it was checked against and goes into.'),
    baseCommit: z
      .string()
      .describe('That branch’s commit when it was checked.'),
    state: z
      .enum(TRANSLATION_IMPORT_STATES)
      .describe(
        '`validated`: kept until `expiresAt` to be applied; `applying`: being applied now; `applied`: its change set is made.',
      ),
    createdBy: Who,
    createdAt: Time,
    expiresAt: Time.describe(
      'When it is removed (an applied one an hour after it was applied).',
    ),
  }),
  relationships: z.object({
    job: toOne('TranslationJob').describe(
      'The translation job the documents came from.',
    ),
    changeSet: z
      .object({
        data: z
          .object({ type: z.literal('ChangeSet'), id: z.string() })
          .nullable(),
      })
      .describe('The change set the import went into; null until applied.'),
  }),
  meta: z.object({
    counts: Counts,
    report: z
      .array(ImportModuleReportSchema)
      .describe(
        'One page of the report: per module and target language (the languages in the job’s order, then module IDs), each unit’s state. Paged by `page[number]` and `page[size]` (the document’s `meta.page` and `links`).',
      ),
    commit: z
      .string()
      .nullable()
      .optional()
      .describe(
        'Once applied: the save point’s commit (null when nothing changed).',
      ),
  }),
}).meta({ id: 'TranslationImportResource' });

/** A translation import with one page of its report: the page in `meta.page` and `links`. */
export const TranslationImportDocument = z
  .object({
    data: TranslationImportResource,
    meta: z.object({ page: PageMeta }),
    links: PageLinks,
  })
  .meta({ id: 'TranslationImportDocument' });
export type TranslationImportDocument = z.infer<
  typeof TranslationImportDocument
>;

/**
 * The document of `record`, with the report's `page`: of the units in
 * `state` only, when given (the counts stay the whole report's).
 */
export function toTranslationImportDocument(
  req: Request,
  page: PageRequest,
  record: TranslationImport,
  state?: ImportUnitState,
): TranslationImportDocument {
  const paged = toPagedDocument(
    req,
    page,
    paginate(reportWith(record.modules, state), page),
    (m) => ({
      lang: m.lang,
      moduleId: m.moduleId,
      ...(m.designId !== undefined && { designId: m.designId }),
      ...(m.manualId !== undefined && { manualId: m.manualId }),
      ...(m.config === true && { config: true as const }),
      ...(m.title !== undefined && { title: m.title }),
      units: m.units.map((u) => ({
        ...u,
        ...(u.texts && { texts: { ...u.texts } }),
      })),
    }),
  );
  const { counts } = record;
  return {
    data: {
      type: 'TranslationImport',
      id: record.id,
      attributes: {
        languages: [...record.languages],
        baseRef: record.baseRef,
        baseCommit: record.baseCommit,
        state: record.state,
        createdBy: record.createdBy,
        createdAt: record.createdAt.toISOString(),
        expiresAt: record.expiresAt.toISOString(),
      },
      relationships: {
        job: { data: { type: 'TranslationJob', id: record.jobId } },
        changeSet: {
          data:
            record.changeSetId === undefined
              ? null
              : { type: 'ChangeSet', id: record.changeSetId },
        },
      },
      meta: {
        counts: {
          units: counts.units,
          ok: counts.ok,
          sourceChanged: counts['source-changed'],
          brokenMarkup: counts['broken-markup'],
          unknownBlock: counts['unknown-block'],
          unknownModule: counts['unknown-module'],
          outsideScope: counts['outside-scope'],
        },
        report: paged.data,
        ...(record.commit !== undefined && { commit: record.commit }),
      },
    },
    meta: paged.meta,
    links: paged.links,
  };
}

/** The most decisions one apply takes (one per unit). */
export const MAX_DECISIONS = 50_000;

/** `POST /translations/imports/:importId/apply`: no body, or the decisions. */
export const ApplyTranslationImportDocument = z
  .strictObject({
    meta: z
      .strictObject({
        decisions: z
          .array(
            z.strictObject({
              lang: LanguageTag,
              moduleId: ModuleOrDesign,
              blockId: UnitId,
              decision: z.enum(SOURCE_CHANGED_DECISIONS),
            }),
          )
          .max(MAX_DECISIONS)
          .describe(
            'Per `source-changed` unit: `keep` (import it; it stays `outdated`) or `skip` (leave it out). A unit not named is `keep`; a decision on any other unit changes nothing.',
          ),
      })
      .optional(),
  })
  .optional()
  .meta({ id: 'ApplyTranslationImportDocument' });
export type ApplyTranslationImportDocument = z.output<
  typeof ApplyTranslationImportDocument
>;

/** `POST /translations/mark-current`. */
export const MarkCurrentDocument = z
  .strictObject({
    data: z.strictObject({
      type: z.literal('TranslationMarkCurrent'),
      attributes: z.strictObject({
        changeSetId: z
          .string()
          .min(1)
          .max(100)
          .describe('A draft change set of yours.'),
        moduleId: ModuleId.optional().describe(
          'The source module whose translation is marked current. Exactly one of `moduleId`, `designId`, `manualId` and `config`.',
        ),
        designId: PageDesignId.optional().describe(
          'A page design whose region text in `lang` is marked current (#656).',
        ),
        manualId: ModuleId.optional().describe(
          'A manual whose own text in `lang` (its title, its groups’ titles, its cover images’ alternative text) is marked current (#656, #731).',
        ),
        config: z
          .literal(true)
          .optional()
          .describe(
            'The project labels in `openfolia.yaml` (#731), marked current in `lang`.',
          ),
        lang: LanguageTag.describe('A target language.'),
      }),
    }),
  })
  .refine(
    ({ data: { attributes: a } }) =>
      [a.moduleId, a.designId, a.manualId, a.config].filter(
        (x) => x !== undefined,
      ).length === 1,
    {
      message: 'Exactly one of moduleId, designId, manualId and config.',
      path: ['data', 'attributes'],
    },
  )
  .meta({ id: 'MarkCurrentDocument' });
export type MarkCurrentDocument = z.output<typeof MarkCurrentDocument>;

export const MarkedCurrentResource = resourceObject('TranslationMarkCurrent', {
  attributes: z.object({
    lang: LanguageTag,
    moduleId: z
      .string()
      .describe(
        'The module’s ID; a page design’s key (`design.<designId>`), a manual’s (`manual.<manualId>`) or the project labels’ (`config.project`).',
      ),
    designId: z.string().optional(),
    manualId: z.string().optional(),
    config: z.literal(true).optional(),
    commit: z
      .string()
      .nullable()
      .describe(
        'The save point’s commit; null when the record said so already.',
      ),
    blocks: z
      .int()
      .min(0)
      .describe(
        'The blocks (units) the record now names as translated from their current source.',
      ),
  }),
  relationships: z.object({ changeSet: toOne('ChangeSet') }),
}).meta({ id: 'TranslationMarkCurrentResource' });

export const MarkedCurrentDocument = z
  .object({ data: MarkedCurrentResource })
  .meta({ id: 'TranslationMarkCurrentDocument' });
export type MarkedCurrentDocument = z.infer<typeof MarkedCurrentDocument>;

export function toMarkedCurrentDocument(
  done: MarkedCurrent,
): MarkedCurrentDocument {
  return {
    data: {
      type: 'TranslationMarkCurrent',
      id: `${done.changeSetId}/${done.lang}/${done.moduleId}`,
      attributes: {
        lang: done.lang,
        moduleId: done.moduleId,
        ...(done.designId !== undefined && { designId: done.designId }),
        ...(done.manualId !== undefined && { manualId: done.manualId }),
        ...(done.config === true && { config: true as const }),
        commit: done.commit,
        blocks: done.blocks,
      },
      relationships: {
        changeSet: { data: { type: 'ChangeSet', id: done.changeSetId } },
      },
    },
  };
}
