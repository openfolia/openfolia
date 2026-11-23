import {
  Module,
  PageDesign,
  ProjectConfig,
  StrictProjectConfig,
  Term,
} from '@openfolia/content-model';
import { z } from 'zod';
import {
  resourceObject,
  singleDocument,
  toOne,
} from '../../base/api/json-api.js';
import { Issue } from '../../base/api/schemas.js';
import { LockSubject, subjectName } from '../core/lock.js';
import {
  DraftManifest,
  TemplateFileContent,
  type WorkingCopyView,
} from '../core/working-copy.js';

const Editor = z
  .object({ kind: z.enum(['user', 'service']), id: z.string() })
  .describe('Who saved it last.');

const attributes = <T extends z.ZodType>(content: T, describe: string) =>
  z.object({
    subject: LockSubject.describe(
      'The module, manual, configuration, term, page design or template file it is a copy of.',
    ),
    content: content.describe(describe),
    version: z
      .int()
      .min(0)
      .describe(
        'How many times it was saved; 0 when nothing is saved and `content` is the committed file. Send it back with the next save.',
      ),
    baseCommit: z
      .string()
      .describe(
        'The commit the content is based on (for the committed file, the commit it was read at); send it with the next save.',
      ),
    updatedBy: Editor.optional(),
    updatedAt: z.iso
      .datetime({ offset: true })
      .optional()
      .describe('When it was saved last.'),
  });

const meta = z.object({
  saved: z
    .boolean()
    .describe(
      'Whether a working copy is saved; false: `content` is the file committed on the change set’s branch.',
    ),
  issues: z
    .array(Issue)
    .describe(
      'Problems found checking it against the configuration; a draft may have them.',
    ),
});

const resource = <T extends z.ZodType>(content: T, describe: string) =>
  resourceObject('WorkingCopy', {
    attributes: attributes(content, describe),
    relationships: z.object({ changeSet: toOne('ChangeSet') }),
    meta,
  }).describe(
    '`id` is `<changeSetId>/module/<lang>/<moduleId>`, `<changeSetId>/manual/<manualId>`, `<changeSetId>/config`, `<changeSetId>/term/<termId>`, `<changeSetId>/design/<designId>` or `<changeSetId>/template/<templateId>/<path>`.',
  );

export const ModuleWorkingCopyResource = resource(
  Module,
  'The module’s tree (the content model’s `Module`).',
).meta({ id: 'ModuleWorkingCopyResource' });

export const ManualWorkingCopyResource = resource(
  DraftManifest,
  'The manual’s manifest; a draft may have no entries yet. Read from the branch, it names only the modules the reader may see.',
).meta({ id: 'ManualWorkingCopyResource' });

export const ConfigWorkingCopyResource = resource(
  ProjectConfig,
  'The configuration (`openfolia.yaml`) as the content model reads it.',
).meta({ id: 'ConfigWorkingCopyResource' });

export const TermWorkingCopyResource = resource(
  Term,
  'The term (`terms/<termId>.yaml`).',
).meta({ id: 'TermWorkingCopyResource' });

export const PageDesignWorkingCopyResource = resource(
  PageDesign,
  'The page design (`design/<designId>.yaml`, #390), every setting with its default filled in.',
).meta({ id: 'PageDesignWorkingCopyResource' });

export const TemplateFileWorkingCopyResource = resource(
  TemplateFileContent,
  'The template file’s text (#396), as the file holds it.',
).meta({ id: 'TemplateFileWorkingCopyResource' });

export const TemplateFileWorkingCopyDocument = singleDocument(
  TemplateFileWorkingCopyResource,
).meta({ id: 'TemplateFileWorkingCopyDocument' });

export const PageDesignWorkingCopyDocument = singleDocument(
  PageDesignWorkingCopyResource,
).meta({ id: 'PageDesignWorkingCopyDocument' });

export const ConfigWorkingCopyDocument = singleDocument(
  ConfigWorkingCopyResource,
).meta({ id: 'ConfigWorkingCopyDocument' });

export const TermWorkingCopyDocument = singleDocument(
  TermWorkingCopyResource,
).meta({ id: 'TermWorkingCopyDocument' });

export const ModuleWorkingCopyDocument = singleDocument(
  ModuleWorkingCopyResource,
).meta({ id: 'ModuleWorkingCopyDocument' });

export const ManualWorkingCopyDocument = singleDocument(
  ManualWorkingCopyResource,
).meta({ id: 'ManualWorkingCopyDocument' });

export function toWorkingCopyResource(view: WorkingCopyView) {
  return {
    type: 'WorkingCopy' as const,
    id: `${view.changeSetId}/${subjectName(view.subject)}`,
    attributes: {
      subject: view.subject,
      content: view.content,
      version: view.version,
      baseCommit: view.baseCommit,
      ...(view.updatedBy && { updatedBy: view.updatedBy }),
      ...(view.updatedAt && { updatedAt: view.updatedAt.toISOString() }),
    },
    relationships: {
      changeSet: { data: { type: 'ChangeSet' as const, id: view.changeSetId } },
    },
    meta: { saved: view.version > 0, issues: [...view.issues] },
  };
}

const version = z
  .int()
  .min(0)
  .max(2 ** 31 - 1)
  .describe(
    'The version this save is based on: the `version` last read or saved (0 when none is saved yet). Another one is 409 `version-conflict`.',
  );

const baseCommit = z
  .string()
  .regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/, 'a full commit ID')
  .describe(
    'The commit the content is based on: the `baseCommit` last read or saved; for a module or manual not on the branch yet (read is 404), the change set’s `baseCommit`. When the file has changed on the branch since, the save is 409 `stale-working-copy` (`meta.head`: the head to read it at); a save point refuses the same. A newer commit at which the file is unchanged is stored as the base instead.',
  );

const saveDocument = <T extends z.ZodType>(content: T, describe: string) =>
  z.strictObject({
    data: z.strictObject({
      type: z.literal('WorkingCopy'),
      attributes: z.strictObject({ content: content.describe(describe) }),
    }),
    meta: z.strictObject({ version, baseCommit }),
  });

/** `PUT …/modules/{lang}/{moduleId}/working-copy`. */
export const SaveModuleWorkingCopyDocument = saveDocument(
  Module,
  'The module’s tree; its `id` and `meta.lang` must be the path’s.',
).meta({ id: 'SaveModuleWorkingCopyDocument' });
export type SaveModuleWorkingCopyDocument = z.output<
  typeof SaveModuleWorkingCopyDocument
>;

/** `PUT …/manuals/{manualId}/working-copy`. */
export const SaveManualWorkingCopyDocument = saveDocument(
  DraftManifest,
  'The manual’s manifest; its `id` must be the path’s.',
).meta({ id: 'SaveManualWorkingCopyDocument' });
export type SaveManualWorkingCopyDocument = z.output<
  typeof SaveManualWorkingCopyDocument
>;

/** `PUT …/config/working-copy`. */
export const SaveConfigWorkingCopyDocument = saveDocument(
  StrictProjectConfig,
  'The whole configuration, as `GET` reads it; an unknown member at any level is refused (400).',
).meta({ id: 'SaveConfigWorkingCopyDocument' });
export type SaveConfigWorkingCopyDocument = z.output<
  typeof SaveConfigWorkingCopyDocument
>;

/** `PUT …/terms/{termId}/working-copy`. */
export const SaveTermWorkingCopyDocument = saveDocument(
  Term,
  'The term; its `id` must be the path’s.',
).meta({ id: 'SaveTermWorkingCopyDocument' });
export type SaveTermWorkingCopyDocument = z.output<
  typeof SaveTermWorkingCopyDocument
>;

/** `PUT …/page-designs/{designId}/working-copy`. */
export const SavePageDesignWorkingCopyDocument = saveDocument(
  PageDesign,
  'The page design; its `id` must be the path’s. A setting left out takes its default; an unknown member is refused (400).',
).meta({ id: 'SavePageDesignWorkingCopyDocument' });
export type SavePageDesignWorkingCopyDocument = z.output<
  typeof SavePageDesignWorkingCopyDocument
>;

/** `PUT …/page-design-templates/{templateId}/files/working-copy?path=`. */
export const SaveTemplateFileWorkingCopyDocument = saveDocument(
  TemplateFileContent,
  'The template file’s whole text (`schemaVersion` 1), at most 256 KiB as UTF-8, without NUL characters.',
).meta({ id: 'SaveTemplateFileWorkingCopyDocument' });
export type SaveTemplateFileWorkingCopyDocument = z.output<
  typeof SaveTemplateFileWorkingCopyDocument
>;
