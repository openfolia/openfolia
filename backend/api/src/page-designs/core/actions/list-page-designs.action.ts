import { Injectable } from '@nestjs/common';
import {
  validatePageDesign,
  type PageDesign,
  type PageDesignIssue,
} from '@openfolia/content-model';
import type { Actor } from '../../../access/core/actor.js';
import { ActorAction } from '../../../access/core/policy.js';
import {
  paginate,
  type PageRequest,
  type Paginated,
} from '../../../base/core/paging.js';
import type { ReadableContent } from '../../../content/core/readable-content.js';

/** A page design with the problems found checking it, or a file that is no design. */
export type PageDesignEntry =
  | { id: string; design: PageDesign; issues: PageDesignIssue[] }
  | { id: string; error: string };

/**
 * One page of the page designs at the snapshot's commit (`design/<id>.yaml`,
 * #390), by ID, each with the problems found checking it against the
 * configuration (`validatePageDesign`; its assets are checked by
 * `GetPageDesignAction`, one design at a time). A file in `design/` that is
 * no design is listed too (with why), so it does not hide. Designs carry no
 * audience: every reader of the commit reads them.
 */
@Injectable()
export class ListPageDesignsAction extends ActorAction<
  { actor: Actor; snapshot: ReadableContent; page: PageRequest },
  Paginated<PageDesignEntry>
> {
  readonly policy = 'content.read';

  protected async run({
    snapshot,
    page,
  }: {
    snapshot: ReadableContent;
    page: PageRequest;
  }): Promise<Paginated<PageDesignEntry>> {
    const [listed, config] = await Promise.all([
      snapshot.pageDesigns(),
      snapshot.config(),
    ]);
    const entries = listed.map((entry): PageDesignEntry =>
      'error' in entry
        ? entry
        : {
            id: entry.id,
            design: entry.design,
            issues: validatePageDesign(entry.design, config),
          },
    );
    return paginate(entries, page);
  }
}
