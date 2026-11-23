import { Injectable } from '@nestjs/common';
import type { Actor } from '../../../access/core/actor.js';
import { ActorAction } from '../../../access/core/policy.js';
import {
  type PageRequest,
  type Paginated,
  paginate,
} from '../../../base/core/paging.js';
import { UnitOfWork } from '../../../base/core/unit-of-work.js';
import { ChangeSetStore } from '../change-set-store.js';
import {
  RefreshConflictStore,
  type ReportedConflict,
} from '../refresh-conflicts.js';
import { authorsChangeSet } from '../working-copy-rules.js';
import { AUTHOR_UPDATES } from './refresh-change-set.action.js';

/**
 * One page of the conflicts the change set's last updates from its base
 * reported (#437), in subject-key order, each with whether it was saved
 * since: the editor's list of what is resolved. By its author only (403
 * for a draft reader, 404 for anyone else, as for updating it). Cleared
 * once an update goes through.
 */
@Injectable()
export class ListRefreshConflictsAction extends ActorAction<
  { actor: Actor; id: string; page: PageRequest },
  Paginated<ReportedConflict>
> {
  readonly policy = 'content.edit';

  constructor(
    private readonly changeSets: ChangeSetStore,
    private readonly reported: RefreshConflictStore,
    private readonly unit: UnitOfWork,
  ) {
    super();
  }

  protected async run({
    actor,
    id,
    page,
  }: {
    actor: Actor;
    id: string;
    page: PageRequest;
  }): Promise<Paginated<ReportedConflict>> {
    const changeSet = await authorsChangeSet(
      this.changeSets,
      actor,
      id,
      AUTHOR_UPDATES,
    );
    const all = await this.unit.run((tx) => this.reported.of(tx, changeSet.id));
    return paginate(all, page);
  }
}
