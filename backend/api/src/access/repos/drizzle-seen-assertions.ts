import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { lte, sql } from 'drizzle-orm';
import { Database } from '../../database/database.js';
import { SeenAssertions } from '../core/seen-assertions.js';
import { samlSeenAssertions } from './saml.tables.js';

/**
 * `SeenAssertions` over `saml_seen_assertions` (#376): the record and its test in one
 * statement (an insert that, on a key already there, takes it over only once its time has
 * passed), so two copies of one assertion at once are one accepted, one refused, on any server.
 */
@Injectable()
export class DrizzleSeenAssertions extends SeenAssertions {
  now: () => number = Date.now;

  constructor(private readonly database: Database) {
    super();
  }

  async recordOnce(key: string, until: Date): Promise<boolean> {
    const t = samlSeenAssertions;
    const now = new Date(this.now());
    const keyHash = createHash('sha256').update(key).digest('hex');
    // Those past their time go first: as many as sign-ins left since the last one.
    await this.database.db.delete(t).where(lte(t.expiresAt, now));
    const rows = await this.database.db
      .insert(t)
      .values({ keyHash, expiresAt: until })
      .onConflictDoUpdate({
        target: t.keyHash,
        set: { expiresAt: until },
        setWhere: sql`${t.expiresAt} <= ${now}`,
      })
      .returning({ keyHash: t.keyHash });
    return rows.length > 0;
  }
}
