import { Injectable } from '@nestjs/common';
import type { Actor } from '../../../access/core/actor.js';
import { allows, ANYWHERE } from '../../../access/core/allows.js';
import { ActorAction } from '../../../access/core/policy.js';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnprocessableError,
} from '../../../base/core/errors.js';
import { UnitOfWork } from '../../../base/core/unit-of-work.js';
import { JobQueue } from '../../../jobs/core/job-queue.js';
import { type ImportRecord, isImportId, NO_PROGRESS } from '../import.js';
import { APPLY_IMPORT } from '../import-job.js';
import { ImportStore } from '../import-store.js';
import { IMPORT_NEEDS_EDIT } from './create-import.action.js';
import { importedBy } from './get-import.action.js';
import { Sandbox } from '../../../sandbox/core/sandbox.js';

/**
 * Starts applying a stored import: `validated` → `applying`, and its job
 * (`import.apply`) queued in the same transaction, so it exists exactly
 * when the import says it is applying. Only the one who uploaded it, only
 * before it expired, and only when its report is applicable (valid,
 * nothing refused). The job (`RunImportAction`) checks it all again
 * against the target as it is then and writes it through the change-set
 * actions, as its uploader.
 */
@Injectable()
export class ApplyImportAction extends ActorAction<
  {
    readonly actor: Actor;
    readonly id: string;
    /** Leave the refused items out and apply the rest (#758). */
    readonly skipRefused?: boolean;
  },
  ImportRecord
> {
  readonly policy = 'admin.roles';

  constructor(
    private readonly store: ImportStore,
    private readonly jobs: JobQueue,
    private readonly unit: UnitOfWork,
    private readonly sandbox: Sandbox = Sandbox.OFF,
  ) {
    super();
  }

  protected async run({
    actor,
    id,
    skipRefused = false,
  }: {
    actor: Actor;
    id: string;
    skipRefused?: boolean;
  }) {
    this.sandbox.refuse('imports');
    if (!allows(actor, 'content.edit', ANYWHERE)) {
      throw new ForbiddenError(IMPORT_NEEDS_EDIT);
    }
    if (!isImportId(id)) throw new NotFoundError(`No import "${id}".`);
    return this.unit.run(async (tx) => {
      const record = await this.store.lock(tx, id);
      if (!record || !importedBy(record, actor)) {
        throw new NotFoundError(`No import "${id}".`);
      }
      if (record.state !== 'validated') {
        throw new ConflictError(
          'invalid-state',
          `The import is ${record.state}; only a validated one is applied.`,
          { state: record.state },
        );
      }
      const now = new Date();
      if (record.expiresAt <= now) {
        throw new ConflictError(
          'import-expired',
          'The import was uploaded more than an hour ago; upload it again.',
        );
      }
      const { report } = record;
      if (!report.applicable) {
        if (!skipRefused) {
          throw new UnprocessableError(
            'import-not-applicable',
            report.applicableWithoutRefused === true
              ? 'The import’s report refuses something; apply it with skipRefused to leave the refused items out, or fix the bundle and upload it again.'
              : 'The import’s report refuses something, or has nothing to write; fix the bundle and upload it again.',
            { skipRefused: report.applicableWithoutRefused === true },
          );
        }
        if (report.applicableWithoutRefused !== true) {
          throw new UnprocessableError(
            'import-not-applicable',
            'The rest of the import does not stand without its refused items (something else names them, the bundle itself has an error, or nothing is left to write); fix the bundle and upload it again.',
            { skipRefused: false },
          );
        }
      }
      const change = {
        state: 'applying' as const,
        startedAt: now,
        progress: NO_PROGRESS,
      };
      await this.store.update(tx, id, change);
      await this.jobs.enqueue(APPLY_IMPORT, { importId: id }, { key: id, tx });
      return { ...record, ...change };
    });
  }
}
