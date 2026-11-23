import { Injectable } from '@nestjs/common';
import { and, asc, desc, eq, ne } from 'drizzle-orm';
import type { Transaction } from '../../base/core/unit-of-work.js';
import { Database } from '../../database/database.js';
import { drizzleOf } from '../../database/drizzle-unit-of-work.js';
import { isChangeSetId } from '../core/change-set.js';
import {
  ChangeSetSupersessions,
  type SupersessionLinks,
} from '../core/supersessions.js';
import { changeSets } from './change-sets.tables.js';
import { changeSetSupersessions } from './supersessions.tables.js';

/** `ChangeSetSupersessions` over `change_set_supersessions`. */
@Injectable()
export class DrizzleChangeSetSupersessions extends ChangeSetSupersessions {
  constructor(private readonly database: Database) {
    super();
  }

  async record(
    tx: Transaction,
    link: { readonly changeSetId: string; readonly supersededId: string },
  ): Promise<void> {
    await drizzleOf(tx).insert(changeSetSupersessions).values(link);
  }

  async activeOf(
    supersededId: string,
    tx?: Transaction,
  ): Promise<string | undefined> {
    if (!isChangeSetId(supersededId)) return undefined;
    const db = tx ? drizzleOf(tx) : this.database.db;
    const [row] = await db
      .select({ id: changeSetSupersessions.changeSetId })
      .from(changeSetSupersessions)
      .innerJoin(
        changeSets,
        eq(changeSets.id, changeSetSupersessions.changeSetId),
      )
      .where(
        and(
          eq(changeSetSupersessions.supersededId, supersededId),
          ne(changeSets.state, 'abandoned'),
        ),
      )
      .orderBy(asc(changeSetSupersessions.changeSetId))
      .limit(1);
    return row?.id;
  }

  async linksOf(id: string): Promise<SupersessionLinks> {
    if (!isChangeSetId(id)) return {};
    const db = this.database.db;
    const [[by], [of]] = await Promise.all([
      db
        .select({ id: changeSetSupersessions.changeSetId })
        .from(changeSetSupersessions)
        .where(eq(changeSetSupersessions.supersededId, id))
        // IDs are UUID version 7: the newest last made.
        .orderBy(desc(changeSetSupersessions.changeSetId))
        .limit(1),
      db
        .select({ id: changeSetSupersessions.supersededId })
        .from(changeSetSupersessions)
        .where(eq(changeSetSupersessions.changeSetId, id))
        .limit(1),
    ]);
    return {
      ...(by && { supersededBy: by.id }),
      ...(of && { supersedes: of.id }),
    };
  }
}
