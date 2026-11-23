import { LanguageTag, ModuleId, PageDesignId } from '@openfolia/content-model';
import { z } from 'zod';
import {
  pagedDocument,
  resourceObject,
  singleDocument,
} from '../../base/api/json-api.js';
import {
  type ExportSubject,
  TRANSLATION_JOB_STATES,
  type TranslationJob,
} from '../core/translation-job.js';

/** A folder of the content browser: `<type>` or `<type>/<facet value>`. */
export const Folder = z
  .string()
  .max(200)
  .regex(/^[^/]+(?:\/[^/]+)?$/, '`<type>` or `<type>/<facet value>`');

/** The most modules one export may name. */
export const MAX_SUBJECT_MODULES = 500;

/** The most page designs one export may name. */
export const MAX_SUBJECT_DESIGNS = 100;

/** The most manuals one export of their own text (#656) may name. */
export const MAX_SUBJECT_MANUALS = 100;

/** The most target languages one export may name. */
export const MAX_EXPORT_LANGUAGES = 100;

const unique = <T>(items: readonly T[]) => new Set(items).size === items.length;

export const ExportSubjectSchema = z
  .discriminatedUnion('type', [
    z.strictObject({ type: z.literal('manual'), manualId: ModuleId }),
    z.strictObject({
      type: z.literal('modules'),
      moduleIds: z
        .array(ModuleId)
        .min(1)
        .max(MAX_SUBJECT_MODULES)
        .refine(unique, 'each module once'),
    }),
    z.strictObject({ type: z.literal('folder'), folder: Folder }),
    z.strictObject({
      type: z.literal('designs'),
      designIds: z
        .array(PageDesignId)
        .min(1)
        .max(MAX_SUBJECT_DESIGNS)
        .refine(unique, 'each design once'),
    }),
    z.strictObject({
      type: z.literal('manuals'),
      manualIds: z
        .array(ModuleId)
        .min(1)
        .max(MAX_SUBJECT_MANUALS)
        .refine(unique, 'each manual once'),
    }),
    z.strictObject({ type: z.literal('config') }),
  ])
  .describe(
    'What to export, in the source language: `manual` (the modules a manual includes, also through module references, each once), `modules` (a list of module IDs) `folder` (a folder of the content browser: `<type>`, or `<type>/<value>` of the first configured facet) `designs` (page designs’ region text, #568; a `manual` takes the manual’s design too) `manuals` (manuals’ own text: their titles, their groups’ titles, #731, and their cover images’ alternative text, #656; a `manual` takes it too) or `config` (the project labels in `openfolia.yaml`, #731; a `manual` takes them too, as its title page shows them). Modules the exporter may not see, and modules or designs that do not exist, are left out.',
  )
  .meta({ id: 'TranslationExportSubject' });

const Counts = {
  modules: z
    .int()
    .min(0)
    .describe('Distinct modules (and page designs, #568) with a unit.'),
  units: z
    .int()
    .min(0)
    .describe('Units sent: one per block and target language.'),
  words: z
    .int()
    .min(0)
    .describe('Their words in the source language, roughly as counted.'),
};

const Who = z.object({ kind: z.enum(['user', 'service']), id: z.string() });

/** A day, `YYYY-MM-DD`, that is a real date. */
const Day = z.iso.date();

export const TranslationJobAttributes = z
  .object({
    languages: z
      .array(LanguageTag)
      .describe('The target languages, in the configured order.'),
    subject: ExportSubjectSchema,
    ref: z.string().describe('The ref exported, as asked for.'),
    commit: z
      .string()
      .describe(
        'The commit `ref` resolved to: the files are always made from it.',
      ),
    state: z
      .enum(TRANSLATION_JOB_STATES)
      .describe(
        '`sent`: at the provider (its units are `at-provider` in the translation status); `returned`: read back by the import; `cancelled`.',
      ),
    dueDate: Day.nullable().describe(
      'The day the translation is due; null for none.',
    ),
    createdBy: Who.describe('Who exported it.'),
    createdAt: z.iso.datetime({ offset: true }),
  })
  .meta({ id: 'TranslationJobAttributes' });

export const TranslationJobMeta = z
  .object({
    ...Counts,
    languages: z
      .array(z.object({ lang: LanguageTag, ...Counts }))
      .describe('The counts per target language, in `languages`’ order.'),
    dryRun: z
      .boolean()
      .optional()
      .describe('True on a dry run’s answer: nothing was recorded.'),
  })
  .meta({ id: 'TranslationJobMeta' });

export const TranslationJobResource = resourceObject('TranslationJob', {
  attributes: TranslationJobAttributes,
  meta: TranslationJobMeta,
}).meta({ id: 'TranslationJobResource' });

export const TranslationJobDocument = singleDocument(
  TranslationJobResource,
).meta({ id: 'TranslationJobDocument' });

export const TranslationJobPageDocument = pagedDocument(
  TranslationJobResource,
).meta({ id: 'TranslationJobPageDocument' });

export function toTranslationJobResource(
  job: TranslationJob,
  options: { readonly dryRun?: boolean } = {},
): z.infer<typeof TranslationJobResource> {
  return {
    type: 'TranslationJob',
    id: job.id,
    attributes: {
      languages: [...job.languages],
      subject: subjectOf(job.subject),
      ref: job.ref,
      commit: job.commit,
      state: job.state,
      dueDate: job.dueDate,
      createdBy: job.createdBy,
      createdAt: job.createdAt.toISOString(),
    },
    meta: {
      ...job.counts,
      languages: job.perLanguage.map((counts) => ({ ...counts })),
      ...(options.dryRun && { dryRun: true }),
    },
  };
}

function subjectOf(
  subject: ExportSubject,
): z.infer<typeof ExportSubjectSchema> {
  return subject.type === 'modules'
    ? { type: 'modules', moduleIds: [...subject.moduleIds] }
    : subject.type === 'designs'
      ? { type: 'designs', designIds: [...subject.designIds] }
      : subject.type === 'manuals'
        ? { type: 'manuals', manualIds: [...subject.manualIds] }
        : subject;
}

/** `POST /translations/exports`. */
export const CreateTranslationExportDocument = z
  .strictObject({
    data: z.strictObject({
      type: z.literal('TranslationJob'),
      attributes: z.strictObject({
        languages: z
          .array(LanguageTag)
          .min(1)
          .max(MAX_EXPORT_LANGUAGES)
          .refine(unique, 'each language once')
          .describe(
            'The target languages: each a configured target language you manage translations into (`translation.manage` in a role whose scope covers it).',
          ),
        subject: ExportSubjectSchema,
        ref: z
          .string()
          .min(1)
          .max(256)
          .optional()
          .describe('The branch, tag or commit to export; default `main`.'),
        dueDate: Day.nullable()
          .optional()
          .describe('The day the translation is due (`YYYY-MM-DD`).'),
      }),
    }),
    meta: z
      .strictObject({
        dryRun: z
          .boolean()
          .optional()
          .describe(
            'Work out what would be sent and answer it, recording nothing.',
          ),
      })
      .optional(),
  })
  .meta({ id: 'CreateTranslationExportDocument' });
export type CreateTranslationExportDocument = z.output<
  typeof CreateTranslationExportDocument
>;
