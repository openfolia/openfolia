import { Injectable } from '@nestjs/common';
import type { Actor } from '../../../access/core/actor.js';
import { ActorAction } from '../../../access/core/policy.js';
import { NotFoundError } from '../../../base/core/errors.js';
import type { PageRequest, Paginated } from '../../../base/core/paging.js';
import { jobReaders } from '../exports.js';
import type { TranslationJob } from '../translation-job.js';
import { seesJob, TranslationJobs } from '../translation-jobs.js';

/**
 * The job `id`, when `actor` may see it (`seesJob`); any other is not
 * found, exactly like one that does not exist.
 */
export async function visibleJob(
  jobs: TranslationJobs,
  actor: Actor,
  id: string,
): Promise<TranslationJob> {
  const job = await jobs.find(id);
  if (!job || !seesJob(jobReaders(actor), job)) {
    throw new NotFoundError(`No translation job "${id}".`);
  }
  return job;
}

/**
 * One page of the translation jobs the actor may see (`seesJob`), newest
 * first. Needs `translation.manage`.
 */
@Injectable()
export class ListTranslationJobsAction extends ActorAction<
  { readonly actor: Actor; readonly page: PageRequest },
  Paginated<TranslationJob>
> {
  readonly policy = 'translation.manage';

  constructor(private readonly jobs: TranslationJobs) {
    super();
  }

  protected run({
    actor,
    page,
  }: {
    readonly actor: Actor;
    readonly page: PageRequest;
  }): Promise<Paginated<TranslationJob>> {
    return this.jobs.list(jobReaders(actor), page);
  }
}

/** One translation job (`visibleJob`). Needs `translation.manage`. */
@Injectable()
export class GetTranslationJobAction extends ActorAction<
  { readonly actor: Actor; readonly id: string },
  TranslationJob
> {
  readonly policy = 'translation.manage';

  constructor(private readonly jobs: TranslationJobs) {
    super();
  }

  protected run({
    actor,
    id,
  }: {
    readonly actor: Actor;
    readonly id: string;
  }): Promise<TranslationJob> {
    return visibleJob(this.jobs, actor, id);
  }
}
