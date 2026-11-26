import { Injectable } from '@nestjs/common';
import { and, inArray, isNotNull } from 'drizzle-orm';
import { Database } from '../../database/database.js';
import { DeactivatedUsers } from '../core/deactivated-users.js';
import { users } from './access.tables.js';

/** `DeactivatedUsers` over the `users` table. */
@Injectable()
export class DrizzleDeactivatedUsers extends DeactivatedUsers {
  constructor(private readonly database: Database) {
    super();
  }

  async among(userIds: readonly string[]): Promise<ReadonlySet<string>> {
    if (userIds.length === 0) return new Set();
    const rows = await this.database.db
      .select({ id: users.id })
      .from(users)
      .where(
        and(inArray(users.id, [...userIds]), isNotNull(users.deactivatedAt)),
      );
    return new Set(rows.map((row) => row.id));
  }
}
