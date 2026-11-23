import { Injectable } from '@nestjs/common';
import type { Actor } from '../../../access/core/actor.js';
import { ActorAction } from '../../../access/core/policy.js';
import { ConflictError } from '../../../base/core/errors.js';
import {
  type ExchangePackage,
  TranslationExchange,
} from '../translation-exchange.js';
import type { TranslationJob } from '../translation-job.js';
import { TranslationJobs } from '../translation-jobs.js';
import { visibleJob } from './read-translation-jobs.action.js';
import { TranslationJobFileAction } from './translation-job-file.action.js';

export interface TranslationJobPackageInput {
  readonly actor: Actor;
  readonly id: string;
}

/**
 * A translation job as a package for a translation management system (#140, `GET
 * /translations/exports/:jobId/package`): the job's XLIFF documents, every language's, exactly
 * as its file gives them (`TranslationJobFileAction`: made again from the job's commit and units
 * as the actor may read them now, 404 for a job they do not see or when nothing of it is left),
 * wrapped by the exchange (`TranslationExchange`, a COTI level 1 package). A cancelled job is 409
 * `job-not-open`: its blocks may have been sent again since, and its package would be refused on
 * its way back. Needs `translation.manage`, and `content.read`.
 */
@Injectable()
export class TranslationJobPackageAction extends ActorAction<
  TranslationJobPackageInput,
  { readonly job: TranslationJob; readonly package: ExchangePackage }
> {
  readonly policy = 'translation.manage';

  constructor(
    private readonly jobs: TranslationJobs,
    private readonly jobFile: TranslationJobFileAction,
    private readonly exchange: TranslationExchange,
  ) {
    super();
  }

  protected async run({ actor, id }: TranslationJobPackageInput): Promise<{
    job: TranslationJob;
    package: ExchangePackage;
  }> {
    // The state first (as the actor may see the job: 404 otherwise), before any file is made.
    const seen = await visibleJob(this.jobs, actor, id);
    if (seen.state === 'cancelled') {
      throw new ConflictError(
        'job-not-open',
        `The translation job "${seen.id}" was cancelled; export its blocks again instead.`,
        { state: seen.state },
      );
    }
    const { job, files } = await this.jobFile.handle({ actor, id });
    return { job, package: this.exchange.pack(job, files, new Date()) };
  }
}
