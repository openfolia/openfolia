import { Injectable } from '@nestjs/common';
import type { Actor } from '../../../access/core/actor.js';
import { ActorAction } from '../../../access/core/policy.js';
import {
  paginate,
  type PageRequest,
  type Paginated,
} from '../../../base/core/paging.js';
import type { ReadableContent } from '../../../content/core/readable-content.js';
import { ReadableModuleIndex } from '../../../modules/core/readable-module-index.js';
import {
  moduleUsageReport,
  type ModuleUsageRow,
  type UsageFilter,
  type UsageSort,
} from '../module-usage-report.js';

interface Input {
  actor: Actor;
  snapshot: ReadableContent;
  filter: UsageFilter;
  sort?: readonly UsageSort[] | undefined;
  /** One page; without it, all of them (the CSV download). */
  page?: PageRequest;
}

/**
 * The module usage report (FR-19): every module the actor may see, with
 * the manuals and modules using it, from the module index as the actor
 * sees it; `filter.unused` finds the modules no manual includes. Needs
 * `content.read.draft`, on top of reading content.
 */
@Injectable()
export class ReportModuleUsageAction extends ActorAction<
  Input,
  Paginated<ModuleUsageRow>
> {
  readonly policy = 'content.read.draft';

  constructor(private readonly index: ReadableModuleIndex) {
    super();
  }

  protected async run({
    snapshot,
    filter,
    sort,
    page,
  }: Input): Promise<Paginated<ModuleUsageRow>> {
    const [index, config] = await Promise.all([
      this.index.of(snapshot),
      snapshot.config(),
    ]);
    const all = moduleUsageReport(
      index,
      config.languages.source,
      [config.languages.source, ...config.languages.targets],
      filter,
      sort,
    );
    return page ? paginate(all, page) : { items: all, total: all.length };
  }
}
