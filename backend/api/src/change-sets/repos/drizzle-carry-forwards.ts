import { Injectable } from '@nestjs/common';
import { and, asc, eq, ne } from 'drizzle-orm';
import type { Transaction } from '../../base/core/unit-of-work.js';
import { Database } from '../../database/database.js';
import { drizzleOf } from '../../database/drizzle-unit-of-work.js';
import { CarryForwards } from '../core/carry-forwards.js';
import { isChangeSetId } from '../core/change-set.js';
import { changeSetCarryForwards } from './carry-forwards.tables.js';
import { changeSets } from './change-sets.tables.js';

/** `CarryForwards` over `change_set_carry_forwards`. */
@Injectable()
export class DrizzleCarryForwards extends CarryForwards {
  constructor(private readonly database: Database) {
    super();
  }

  async record(
    tx: Transaction,
    link: { readonly changeSetId: string; readonly sourceId: string },
  ): Promise<void> {
    await drizzleOf(tx).insert(changeSetCarryForwards).values(link);
  }

  async activeOf(
    sourceId: string,
    tx?: Transaction,
  ): Promise<string | undefined> {
    if (!isChangeSetId(sourceId)) return undefined;
    const db = tx ? drizzleOf(tx) : this.database.db;
    const [row] = await db
      .select({ id: changeSetCarryForwards.changeSetId })
      .from(changeSetCarryForwards)
      .innerJoin(
        changeSets,
        eq(changeSets.id, changeSetCarryForwards.changeSetId),
      )
      .where(
        and(
          eq(changeSetCarryForwards.sourceId, sourceId),
          ne(changeSets.state, 'abandoned'),
        ),
      )
      .orderBy(asc(changeSetCarryForwards.changeSetId))
      .limit(1);
    return row?.id;
  }

  async sourceOf(changeSetId: string): Promise<string | undefined> {
    if (!isChangeSetId(changeSetId)) return undefined;
    const [row] = await this.database.db
      .select({ id: changeSetCarryForwards.sourceId })
      .from(changeSetCarryForwards)
      .where(eq(changeSetCarryForwards.changeSetId, changeSetId))
      .limit(1);
    return row?.id;
  }
}
