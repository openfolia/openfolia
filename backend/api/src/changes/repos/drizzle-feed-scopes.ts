import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { Database } from '../../database/database.js';
import { FeedScopes } from '../core/feed-scopes.js';
import { changeFeedScopes } from './change-feed.tables.js';

/** `FeedScopes` over `change_feed_scopes`. */
@Injectable()
export class DrizzleFeedScopes extends FeedScopes {
  constructor(private readonly database: Database) {
    super();
  }

  async save(digest: string, scopes: readonly string[]): Promise<void> {
    await this.database.db
      .insert(changeFeedScopes)
      .values({ digest, scopes: [...scopes] })
      .onConflictDoNothing({ target: changeFeedScopes.digest });
  }

  async find(digest: string): Promise<readonly string[] | undefined> {
    const [row] = await this.database.db
      .select({ scopes: changeFeedScopes.scopes })
      .from(changeFeedScopes)
      .where(eq(changeFeedScopes.digest, digest));
    const scopes = row?.scopes;
    return Array.isArray(scopes) && scopes.every((s) => typeof s === 'string')
      ? (scopes as string[])
      : undefined;
  }
}
