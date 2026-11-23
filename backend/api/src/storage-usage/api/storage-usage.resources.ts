import { z } from 'zod';
import {
  pagedDocument,
  resourceObject,
  singleDocument,
} from '../../base/api/json-api.js';
import type { StorageReport } from '../core/actions/get-storage-usage.action.js';
import { WARN_AT } from '../core/storage-quota.js';
import type { CategoryUsage, StoredFile } from '../core/storage-usage.js';

const Bytes = z.number().int().min(0);

const Category = z
  .object({
    bytes: Bytes.describe('The bytes it holds.'),
    files: z
      .number()
      .int()
      .min(0)
      .describe('The files it holds, each stored once.'),
  })
  .meta({ id: 'StorageCategory' });

export const StorageUsageResource = resourceObject('StorageUsage', {
  attributes: z.object({
    media: Category.describe(
      'Uploaded images and attachments in the blob store (renditions and import bundles are not counted). Counts towards the limit.',
    ),
    archivedPdfs: Category.describe(
      'The release outputs archived in the blob store (the render cache is not counted). Counts towards the limit.',
    ),
    gitContent: z
      .object({ bytes: Bytes.nullable() })
      .describe(
        'The content repository on disk, as of the last recount; for information, never counted towards the limit. Null when not known.',
      ),
    database: z
      .object({ bytes: Bytes.nullable() })
      .describe(
        'The database, as of the last recount; for information, never counted towards the limit. Null when not known.',
      ),
    limitBytes: z
      .number()
      .int()
      .positive()
      .nullable()
      .describe(
        'The storage limit (`CCMS_STORAGE_LIMIT_BYTES`) of media and archived PDFs together; null: none.',
      ),
    recountedAt: z.iso
      .datetime({ offset: true })
      .nullable()
      .describe(
        'When the totals were last counted afresh; between recounts they move with every upload and delete. Null: not yet.',
      ),
  }),
  meta: z.object({
    usedBytes: Bytes.describe(
      'What counts towards the limit: media and archived PDFs.',
    ),
    usedShare: z
      .number()
      .min(0)
      .nullable()
      .describe(
        '`usedBytes` as a share of the limit (1 is full); null without a limit.',
      ),
    level: z
      .enum(['unlimited', 'ok', 'warning', 'reached'])
      .describe(
        `\`unlimited\` without a limit; \`warning\` from ${WARN_AT * 100} % of it on; \`reached\` at the limit, where uploads are refused (409 \`storage-limit-reached\`).`,
      ),
    warnAt: z
      .number()
      .describe('The share of the limit from which `level` is `warning`.'),
  }),
})
  .describe('`id` is always `instance`.')
  .meta({ id: 'StorageUsageResource' });

export const StorageUsageDocument = singleDocument(StorageUsageResource).meta({
  id: 'StorageUsageDocument',
});

export const StoredFileResource = resourceObject('StoredFile', {
  attributes: z.object({
    reference: z
      .string()
      .regex(/^sha256:[0-9a-f]{64}$/)
      .describe('`sha256:<hash>`, as a module refers to it.'),
    size: Bytes.describe('Its length in bytes.'),
    contentType: z.string().describe('The first upload’s type.'),
    fileName: z
      .string()
      .nullable()
      .describe('The first upload’s file name that has one; null for none.'),
    lastUploadedAt: z.iso
      .datetime({ offset: true })
      .describe('The latest upload of it, into any change set.'),
  }),
})
  .describe('`id` is the file’s SHA-256.')
  .meta({ id: 'StoredFileResource' });

export const StoredFilePageDocument = pagedDocument(StoredFileResource).meta({
  id: 'StoredFilePageDocument',
});

const category = ({ bytes, files }: CategoryUsage) => ({ bytes, files });

export function toStorageUsageDocument(
  report: StorageReport,
): z.infer<typeof StorageUsageDocument> {
  const { totals, limit, used, level } = report;
  return {
    data: {
      type: 'StorageUsage',
      id: 'instance',
      attributes: {
        media: category(totals.media),
        archivedPdfs: category(totals.pdfs),
        gitContent: { bytes: totals.gitBytes },
        database: { bytes: totals.databaseBytes },
        limitBytes: limit,
        recountedAt: totals.recountedAt?.toISOString() ?? null,
      },
      meta: {
        usedBytes: used,
        usedShare: limit === null ? null : used / limit,
        level,
        warnAt: WARN_AT,
      },
    },
  };
}

export function toStoredFileResource(
  file: StoredFile,
): z.infer<typeof StoredFileResource> {
  return {
    type: 'StoredFile',
    id: file.sha256,
    attributes: {
      reference: `sha256:${file.sha256}`,
      size: file.size,
      contentType: file.contentType,
      fileName: file.fileName ?? null,
      lastUploadedAt: file.lastUploadedAt.toISOString(),
    },
  };
}
