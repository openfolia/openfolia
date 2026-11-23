import { Injectable } from '@nestjs/common';
import { Database } from '../../database/database.js';
import { PlanningTurns } from '../core/planning-turns.js';

/** The first key of the advisory lock a product's planning holds (the second: the product's hash). */
export const PLANNING_LOCK = 527;

/**
 * `PlanningTurns` with a Postgres session advisory lock per product
 * (`Database.withSessionLock`): on a connection of its own, held while the release is planned.
 */
@Injectable()
export class DatabasePlanningTurns extends PlanningTurns {
  constructor(private readonly database: Database) {
    super();
  }

  take<T>(
    product: string,
    work: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    return this.database.withSessionLock(PLANNING_LOCK, product, work, signal);
  }
}
