import { Injectable } from '@nestjs/common';
import type { Actor } from '../../../access/core/actor.js';
import { ActorAction } from '../../../access/core/policy.js';
import {
  paginate,
  type PageRequest,
  type Paginated,
} from '../../../base/core/paging.js';
import type { ReadableContent } from '../../../content/core/readable-content.js';
import { TranslationReads } from '../../../translations/core/translation-index.js';
import { TranslationJobs } from '../../../translations/core/translation-jobs.js';
import {
  translationCoverage,
  type CoverageFilter,
  type TranslationCoverage,
} from '../translation-coverage.js';

interface Input {
  actor: Actor;
  snapshot: ReadableContent;
  filter: CoverageFilter;
  /** One page; without it, all of them (the CSV download). */
  page?: PageRequest;
}

/**
 * The translation report (FR-19): per manual and target language, how many
 * of its modules and blocks are up to date, outdated, at a provider or
 * missing, as the actor sees them (`translationCoverage`). Needs
 * `content.read.draft`, on top of reading content.
 */
@Injectable()
export class ReportTranslationsAction extends ActorAction<
  Input,
  Paginated<TranslationCoverage>
> {
  readonly policy = 'content.read.draft';

  constructor(
    private readonly jobs: TranslationJobs,
    private readonly reads: TranslationReads,
  ) {
    super();
  }

  protected async run({
    snapshot,
    filter,
    page,
  }: Input): Promise<Paginated<TranslationCoverage>> {
    const all = await translationCoverage(
      snapshot,
      this.jobs,
      filter,
      this.reads,
    );
    return page ? paginate(all, page) : { items: all, total: all.length };
  }
}
