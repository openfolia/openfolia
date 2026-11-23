import { Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { Database } from '../../database/database.js';
import { PreferenceStore } from '../core/preference-store.js';
import {
  DEFAULT_PREFERENCES,
  type PreferenceChanges,
  type StoredPreferences,
} from '../core/preferences.js';
import { userPreferences } from './preferences.tables.js';

type Row = typeof userPreferences.$inferSelect;

const toStored = (row: Row): StoredPreferences => ({
  preferences: {
    showTips: row.showTips,
    dismissedTips: row.dismissedTips,
    tourDone: row.tourDone,
  },
  updatedAt: row.updatedAt,
});

/** Postgres's "insert or update violates foreign key constraint". */
const isForeignKeyViolation = (error: unknown): boolean => {
  for (let e: unknown = error; e instanceof Error; e = e.cause) {
    if ((e as { code?: unknown }).code === '23503') return true;
  }
  return false;
};

/** `PreferenceStore` over `user_preferences`; every query names its user. */
@Injectable()
export class DrizzlePreferenceStore extends PreferenceStore {
  constructor(private readonly database: Database) {
    super();
  }

  async read(userId: string): Promise<StoredPreferences> {
    const [row] = await this.database.db
      .select()
      .from(userPreferences)
      .where(eq(userPreferences.userId, userId));
    return row
      ? toStored(row)
      : { preferences: DEFAULT_PREFERENCES, updatedAt: null };
  }

  async write(
    userId: string,
    changes: PreferenceChanges,
  ): Promise<StoredPreferences | undefined> {
    const set = {
      ...(changes.showTips !== undefined && { showTips: changes.showTips }),
      ...(changes.dismissedTips !== undefined && {
        dismissedTips: [...changes.dismissedTips],
      }),
      ...(changes.tourDone !== undefined && { tourDone: changes.tourDone }),
    };
    try {
      // One statement: two changes at once (two tabs) each apply whole, never half.
      const [row] = await this.database.db
        .insert(userPreferences)
        .values({ userId, ...set })
        .onConflictDoUpdate({
          target: userPreferences.userId,
          set: { ...set, updatedAt: sql`now()` },
        })
        .returning();
      return row ? toStored(row) : undefined;
    } catch (error) {
      if (isForeignKeyViolation(error)) return undefined;
      throw error;
    }
  }
}
