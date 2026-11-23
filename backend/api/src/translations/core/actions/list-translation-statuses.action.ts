import { Injectable } from '@nestjs/common';
import type { Actor } from '../../../access/core/actor.js';
import { ActorAction } from '../../../access/core/policy.js';
import type { PageRequest, Paginated } from '../../../base/core/paging.js';
import type { ReadableContent } from '../../../content/core/readable-content.js';
import {
  authorizeTranslationStatus,
  type TranslationStatusFilter,
} from '../statuses.js';
import {
  listTranslationStatuses,
  TranslationReads,
  type StatusPaging,
} from '../translation-index.js';
import { TranslationJobs } from '../translation-jobs.js';
import type { TranslationStatus } from '../translation-status.js';

interface Input {
  actor: Actor;
  snapshot: ReadableContent;
  filter: TranslationStatusFilter;
  page: PageRequest;
  /** What `page` counts: statuses (the default), or the matrix's rows (#689). */
  by?: StatusPaging;
}

/**
 * One page of the module × language translation status: one per source
 * module and target language the actor would see a translation in,
 * filtered before paging, from the module index (`listTranslationStatuses`). Needs
 * `translation.manage` or `content.read.draft` on top of reading content.
 */
@Injectable()
export class ListTranslationStatusesAction extends ActorAction<
  Input,
  Paginated<TranslationStatus>
> {
  readonly policy = 'content.read';

  constructor(
    private readonly jobs: TranslationJobs,
    private readonly reads: TranslationReads,
  ) {
    super();
  }

  protected async run({
    actor,
    snapshot,
    filter,
    page,
    by,
  }: Input): Promise<Paginated<TranslationStatus>> {
    authorizeTranslationStatus(actor);
    return listTranslationStatuses(
      snapshot,
      this.jobs,
      filter,
      page,
      this.reads,
      by,
    );
  }
}
