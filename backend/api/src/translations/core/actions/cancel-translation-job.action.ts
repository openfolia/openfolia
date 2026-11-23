import { Injectable } from '@nestjs/common';
import type { Actor } from '../../../access/core/actor.js';
import { ActorAction } from '../../../access/core/policy.js';
import { AuditLog } from '../../../audit/core/audit-log.js';
import { ConflictError } from '../../../base/core/errors.js';
import { UnitOfWork } from '../../../base/core/unit-of-work.js';
import type { TranslationJob } from '../translation-job.js';
import { TranslationJobs } from '../translation-jobs.js';
import { visibleJob } from './read-translation-jobs.action.js';

/**
 * Cancels a translation job that is `sent`: its units stop being
 * `at-provider`, so the next export sends them again. Recorded with a
 * `translation-job.cancel` audit event in the same transaction. A job
 * returned or cancelled already is 409 `job-not-open`; one the actor may
 * not see (`visibleJob`) is 404. Needs `translation.manage`.
 */
@Injectable()
export class CancelTranslationJobAction extends ActorAction<
  { readonly actor: Actor; readonly id: string },
  TranslationJob
> {
  readonly policy = 'translation.manage';

  constructor(
    private readonly jobs: TranslationJobs,
    private readonly auditLog: AuditLog,
    private readonly unit: UnitOfWork,
  ) {
    super();
  }

  protected async run({
    actor,
    id,
  }: {
    readonly actor: Actor;
    readonly id: string;
  }): Promise<TranslationJob> {
    const job = await visibleJob(this.jobs, actor, id);
    await this.unit.run(async (tx) => {
      if (!(await this.jobs.cancel(tx, job.id))) {
        throw new ConflictError(
          'job-not-open',
          `The translation job "${job.id}" is ${job.state === 'sent' ? 'no longer sent' : job.state} and cannot be cancelled.`,
          // Cancelled or returned meanwhile: its state now is not known here.
          job.state === 'sent' ? undefined : { state: job.state },
        );
      }
      await this.auditLog.record(tx, actor, {
        action: 'translation-job.cancel',
        subject: { type: 'translation-job', id: job.id },
        data: { languages: [...job.languages], ...job.counts },
      });
    });
    return { ...job, state: 'cancelled' };
  }
}
