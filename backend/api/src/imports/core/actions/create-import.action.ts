import { Injectable } from '@nestjs/common';
import type { Actor } from '../../../access/core/actor.js';
import { allows, ANYWHERE } from '../../../access/core/allows.js';
import { ActorAction } from '../../../access/core/policy.js';
import {
  ForbiddenError,
  UnavailableError,
  UnprocessableProblems,
} from '../../../base/core/errors.js';
import { UnitOfWork } from '../../../base/core/unit-of-work.js';
import { BUNDLE_IMPORTER } from '../bundle-importer.js';
import {
  IMPORT_TTL_MS,
  type ImportView,
  newImportId,
  NO_PROGRESS,
} from '../import.js';
import { ImportPipeline } from '../import-pipeline.js';
import { ImportUploads } from '../import-uploads.js';
import { type ImportFile, ImporterRegistry } from '../importer.js';

/** What the upload form holds, read only once the actor may import. */
export interface ImportForm {
  readonly file: ImportFile;
  /** Default: the built-in importer (`bundle`). */
  readonly importerId?: string;
  /** The importer's options, checked against its schema; default `{}`. */
  readonly options?: unknown;
  /** Write modules and manuals that exist already (default: skip them). */
  readonly updateExisting: boolean;
  /** Only check: store nothing. */
  readonly dryRun: boolean;
  /** The branch to import into; the server's default branch when left out. */
  readonly baseRef?: string;
}

export interface CreateImportInput {
  readonly actor: Actor;
  /** Reads the form; called only once the actor may import, and while a slot is free. */
  readonly form: () => Promise<ImportForm>;
}

/** How many imports one server checks at once; more are 503 `import-busy`. */
export const MAX_CONCURRENT_IMPORTS = 2;

/** The 403 for an administrator who may not edit content. */
export const IMPORT_NEEDS_EDIT =
  'Importing needs the content.edit permission too, over what is imported.';

/**
 * Checks an upload as an import (`ImportPipeline`): the importer makes the
 * bundle, the validator checks it against the target branch, and each item
 * is decided (create, update, skip, refuse). A dry run answers that report
 * and stores nothing: no blob, no row, no change set, no Git object.
 * Otherwise the upload goes into the blob store and the import, with its
 * report, into `imports` for an hour (`IMPORT_TTL_MS`), so it can be
 * applied (`ApplyImportAction`).
 *
 * Needs `admin.roles` and `content.edit` (in some role; each item is then
 * checked against the scope the way saving it would be).
 */
@Injectable()
export class CreateImportAction extends ActorAction<
  CreateImportInput,
  ImportView
> {
  readonly policy = 'admin.roles';
  private running = 0;

  constructor(
    private readonly registry: ImporterRegistry,
    private readonly pipeline: ImportPipeline,
    private readonly uploads: ImportUploads,
    private readonly unit: UnitOfWork,
  ) {
    super();
  }

  protected async run({ actor, form }: CreateImportInput): Promise<ImportView> {
    if (!allows(actor, 'content.edit', ANYWHERE)) {
      throw new ForbiddenError(IMPORT_NEEDS_EDIT);
    }
    // Checked before the form is read: an import holds its upload and the
    // unpacked files in memory while it is checked.
    if (this.running >= MAX_CONCURRENT_IMPORTS) {
      throw new UnavailableError(
        'import-busy',
        'The server is checking other imports; try again shortly.',
        5,
      );
    }
    this.running++;
    try {
      return await this.check(actor, await form());
    } finally {
      this.running--;
    }
  }

  private async check(actor: Actor, form: ImportForm): Promise<ImportView> {
    const importer = this.registry.get(form.importerId ?? BUNDLE_IMPORTER);
    const parsed = importer.options.safeParse(form.options ?? {});
    if (!parsed.success) {
      throw new UnprocessableProblems(
        'invalid-options',
        `The options are not what the importer "${importer.id}" takes.`,
        parsed.error.issues.map((issue) => ({
          detail: issue.message,
          pointer: `/options${issue.path.map((p) => `/${String(p)}`).join('')}`,
        })),
      );
    }
    const checked = await this.pipeline.check(actor, {
      importer,
      options: parsed.data,
      file: form.file,
      ...(form.baseRef !== undefined && { baseRef: form.baseRef }),
      updateExisting: form.updateExisting,
    });
    const now = new Date();
    const base = {
      id: newImportId(now.getTime()),
      importerId: importer.id,
      options: (parsed.data ?? {}) as Record<string, unknown>,
      updateExisting: form.updateExisting,
      baseRef: checked.baseRef,
      baseCommit: checked.baseCommit,
      createdBy: { kind: actor.kind, id: actor.id },
      fileName: form.file.fileName ?? null,
      report: checked.plan.report,
      changeSetId: null,
      progress: NO_PROGRESS,
      failure: null,
      createdAt: now,
      expiresAt: new Date(now.getTime() + IMPORT_TTL_MS),
      startedAt: null,
      finishedAt: null,
    } as const;
    if (form.dryRun) {
      return {
        ...base,
        dryRun: true,
        state: 'dry-run',
        upload: { size: form.file.bytes.byteLength },
      };
    }
    const stored = await this.uploads.put(form.file.bytes);
    const record = {
      ...base,
      state: 'validated' as const,
      upload: {
        sha256: stored.sha256,
        size: stored.size,
        created: stored.created,
      },
    };
    try {
      await this.unit.run((tx) => this.uploads.insert(tx, record));
    } catch (error) {
      await this.uploads.discard(stored.sha256, stored.created);
      throw error;
    }
    return { ...record, dryRun: false };
  }
}
