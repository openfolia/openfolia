import { ConverterReportEntry, ImportSource } from '@openfolia/content-model';
import { z } from 'zod';
import {
  pagedDocument,
  resourceObject,
  singleDocument,
  toOne,
} from '../../base/api/json-api.js';
import {
  IMPORT_STATES,
  ITEM_ACTIONS,
  type ImportView,
} from '../core/import.js';
import { type Importer, optionsJsonSchema } from '../core/importer.js';

const Who = z.object({ kind: z.enum(['user', 'service']), id: z.string() });
const Time = z.iso.datetime({ offset: true });

export const ImporterResource = resourceObject('Importer', {
  attributes: z.object({
    label: z.string().describe('For people choosing one.'),
    description: z.string(),
  }),
  meta: z.object({
    optionsSchema: z
      .record(z.string(), z.unknown())
      .describe(
        'The options it takes (`options` in the upload form), as JSON Schema, for a screen to render.',
      ),
    maxBytes: z
      .number()
      .int()
      .describe(
        'The largest upload it takes, in bytes (`CCMS_IMPORT_MAX_BYTES`), for a screen to state and to check before uploading.',
      ),
  }),
}).meta({ id: 'ImporterResource' });

export const ImporterPageDocument = pagedDocument(ImporterResource).meta({
  id: 'ImporterPageDocument',
});

export function toImporterResource(
  importer: Importer,
  maxBytes: number,
): z.infer<typeof ImporterResource> {
  return {
    type: 'Importer',
    id: importer.id,
    attributes: { label: importer.label, description: importer.description },
    meta: { optionsSchema: optionsJsonSchema(importer), maxBytes },
  };
}

const ReportIssue = z
  .object({
    severity: z.enum(['error', 'warning', 'info']),
    code: z
      .string()
      .describe(
        'Stable: the validator’s codes (`@openfolia/content-model`, "Import format") and the import’s own (`outside-scope`, `exists`, `unused`, `unsupported-image-type`, `unsupported-attachment-type`, `too-large`, `too-many-subjects`, `too-many-files`, `nothing-to-import`).',
      ),
    message: z.string(),
    pointer: z
      .string()
      .optional()
      .describe('Where in `import.json`, as a JSON Pointer.'),
    at: z.string().optional().describe('The block it is about, by ID.'),
  })
  .meta({ id: 'ImportReportIssue' });

const ReportItem = z
  .object({
    kind: z.enum(['module', 'manual', 'asset']),
    id: z
      .string()
      .describe('The module’s or manual’s ID, or the file’s `sha256:<hash>`.'),
    lang: z.string().optional(),
    pointer: z
      .string()
      .describe(
        'Where it is: in `import.json` (`/modules/0`) or the archive (`assets/<hash>`).',
      ),
    sourceId: z
      .string()
      .optional()
      .describe('A module’s `meta.source.id`: its ID in the source system.'),
    action: z
      .enum(ITEM_ACTIONS)
      .describe(
        '`create`, `update` (an existing one, only with `updateExisting`), `skip` (exists already, or a file no written module uses) or `refuse`.',
      ),
    reasons: z
      .array(ReportIssue)
      .describe(
        'Why it is skipped or refused (for `refuse`, its errors). An import applied with `skipRefused` leaves exactly its `refuse` items out, for these reasons.',
      ),
    issues: z.array(ReportIssue).describe('Its other findings.'),
    issueCount: z
      .number()
      .int()
      .describe(
        'Its findings in all; at most 20 reasons and 20 others are listed.',
      ),
    passthrough: z
      .number()
      .int()
      .optional()
      .describe('A module’s `passthrough` blocks: content kept verbatim.'),
    size: z.number().int().optional().describe('A file’s size in bytes.'),
    usedAs: z
      .enum(['image', 'attachment'])
      .optional()
      .describe('How a file is uploaded into the change set.'),
  })
  .meta({ id: 'ImportReportItem' });

const Count = z.number().int();

export const ImportReportSchema = z
  .object({
    valid: z.boolean().describe('The validator found no error.'),
    applicable: z
      .boolean()
      .describe(
        'It can be applied: valid, nothing refused, within one change set’s limits, and something to write.',
      ),
    applicableWithoutRefused: z
      .boolean()
      .describe(
        'It can be applied with `skipRefused` (`POST /imports/:importId/apply`): `applicable`, or the bundle without its refused items, checked again in full, decides every other item exactly as this report does and is applicable itself. False when something else needs a refused item (a manual names a refused module, a module uses a refused file), when the bundle as a whole has an error, or when nothing would be written.',
      ),
    formatVersion: z.number().int().optional(),
    source: ImportSource.optional(),
    issues: z
      .array(ReportIssue)
      .describe('Findings about the bundle as a whole (at most 200).'),
    items: z
      .array(ReportItem)
      .describe('Modules and manuals in document order, then the files.'),
    converterReport: z
      .array(ConverterReportEntry)
      .describe(
        'The converter’s own report of what it could not map, passed through (at most 1,000 entries).',
      ),
    counts: z.object({
      modules: Count,
      manuals: Count,
      assets: Count,
      create: Count,
      update: Count,
      skip: Count,
      refuse: Count,
      passthrough: Count.describe('`passthrough` blocks in all modules.'),
      errors: Count,
      warnings: Count,
      converterReport: Count.describe('Entries in the converter’s report.'),
    }),
  })
  .meta({ id: 'ImportReport' });

const Progress = z
  .object({
    phase: z.enum(['queued', 'change-set', 'assets', 'files', 'done']),
    assets: z.object({ done: Count, total: Count }),
    files: z.object({ done: Count, total: Count }),
    commits: z.array(z.string()).describe('Save points written, oldest first.'),
  })
  .meta({ id: 'ImportProgress' });

export const ImportResource = resourceObject('Import', {
  attributes: z.object({
    importer: z.string().describe('The importer’s ID.'),
    options: z.record(z.string(), z.unknown()),
    updateExisting: z.boolean(),
    baseRef: z
      .string()
      .describe('The branch it was checked against and goes into.'),
    baseCommit: z.string().describe('That branch’s commit when checked.'),
    fileName: z.string().nullable(),
    size: z.number().int().describe('The upload’s size in bytes.'),
    state: z
      .enum(['dry-run', ...IMPORT_STATES])
      .describe(
        '`dry-run` (never stored), `validated` (stored; can be applied until `expiresAt`), `applying` (its job runs), `applied` or `failed`.',
      ),
    createdBy: Who,
    createdAt: Time,
    expiresAt: Time.describe(
      'When a stored import is removed with its upload, unless it is being applied.',
    ),
    startedAt: Time.nullable(),
    finishedAt: Time.nullable(),
  }),
  relationships: z
    .object({ changeSet: toOne('ChangeSet') })
    .optional()
    .describe('The change set it writes into, once its job made it.'),
  meta: z.object({
    dryRun: z.boolean(),
    report: ImportReportSchema,
    progress: Progress,
    failure: z
      .object({ code: z.string(), detail: z.string() })
      .nullable()
      .describe('Why its job failed.'),
  }),
}).meta({ id: 'ImportResource' });

/** `POST /imports/:importId/apply`: no body, or `meta.skipRefused`. */
export const ApplyImportDocument = z
  .strictObject({
    meta: z
      .strictObject({
        skipRefused: z
          .boolean()
          .optional()
          .describe(
            'Leave the items the report refuses out and apply the rest (default false). Only when `meta.report.applicableWithoutRefused` holds; what is left out, and why, is listed in the change set’s description and every commit message.',
          ),
      })
      .optional(),
  })
  .optional()
  .meta({ id: 'ApplyImportDocument' });
export type ApplyImportDocument = z.output<typeof ApplyImportDocument>;

export const ImportDocument = singleDocument(ImportResource).meta({
  id: 'ImportDocument',
});
export type ImportDocument = z.infer<typeof ImportDocument>;

export function toImportResource(
  view: ImportView,
): z.infer<typeof ImportResource> {
  return {
    type: 'Import',
    id: view.id,
    attributes: {
      importer: view.importerId,
      options: view.options,
      updateExisting: view.updateExisting,
      baseRef: view.baseRef,
      baseCommit: view.baseCommit,
      fileName: view.fileName,
      size: view.upload.size,
      state: view.state,
      createdBy: view.createdBy,
      createdAt: view.createdAt.toISOString(),
      expiresAt: view.expiresAt.toISOString(),
      startedAt: view.startedAt?.toISOString() ?? null,
      finishedAt: view.finishedAt?.toISOString() ?? null,
    },
    ...(view.changeSetId !== null && {
      relationships: {
        changeSet: { data: { type: 'ChangeSet', id: view.changeSetId } },
      },
    }),
    meta: {
      dryRun: view.dryRun,
      report: view.report as z.infer<typeof ImportReportSchema>,
      progress: view.progress as z.infer<typeof Progress>,
      failure: view.failure,
    },
  };
}
