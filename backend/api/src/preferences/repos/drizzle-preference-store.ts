import { Injectable } from '@nestjs/common';
import { eq, inArray, sql } from 'drizzle-orm';
import type { Transaction } from '../../base/core/unit-of-work.js';
import { Database } from '../../database/database.js';
import { drizzleOf } from '../../database/drizzle-unit-of-work.js';
import { ChosenKind } from '../../notifications/core/notification.js';
import {
  DeliveryChoice,
  DigestHour,
  isTimeZone,
  NotificationLanguage,
  type NotificationSettings,
} from '../core/notification-settings.js';
import { PreferenceStore } from '../core/preference-store.js';
import {
  DEFAULT_PREFERENCES,
  type PreferenceChanges,
  type StoredPreferences,
} from '../core/preferences.js';
import { userPreferences } from './preferences.tables.js';

type Row = typeof userPreferences.$inferSelect;

/** The stored choices, each checked: a kind or a choice this server does not know is left out. */
function choicesOf(
  stored: Record<string, string>,
): NotificationSettings['choices'] {
  const out: Partial<Record<ChosenKind, DeliveryChoice>> = {};
  for (const [kind, choice] of Object.entries(stored ?? {})) {
    const k = ChosenKind.safeParse(kind);
    const c = DeliveryChoice.safeParse(choice);
    if (k.success && c.success) out[k.data] = c.data;
  }
  return out;
}

const notificationsOf = (row: Row): NotificationSettings => ({
  choices: choicesOf(row.notificationChoices),
  emailPaused: row.emailPaused,
  allOff: row.notificationsOff,
  digestHour: DigestHour.safeParse(row.digestHour).success
    ? row.digestHour
    : null,
  timeZone:
    row.timeZone !== null && isTimeZone(row.timeZone) ? row.timeZone : null,
  language: NotificationLanguage.safeParse(row.language).success
    ? (row.language as NotificationSettings['language'])
    : null,
});

const toStored = (row: Row): StoredPreferences => ({
  preferences: {
    showTips: row.showTips,
    dismissedTips: row.dismissedTips,
    tourDone: row.tourDone,
    notifications: notificationsOf(row),
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
    tx?: Transaction,
  ): Promise<StoredPreferences | undefined> {
    const n = changes.notifications;
    const values = {
      ...(changes.showTips !== undefined && { showTips: changes.showTips }),
      ...(changes.dismissedTips !== undefined && {
        dismissedTips: [...changes.dismissedTips],
      }),
      ...(changes.tourDone !== undefined && { tourDone: changes.tourDone }),
      ...(n?.choices !== undefined && {
        notificationChoices: { ...n.choices } as Record<string, string>,
      }),
      ...(n?.emailPaused !== undefined && { emailPaused: n.emailPaused }),
      ...(n?.allOff !== undefined && { notificationsOff: n.allOff }),
      ...(n?.digestHour !== undefined && { digestHour: n.digestHour }),
      ...(n?.timeZone !== undefined && { timeZone: n.timeZone }),
      ...(n?.language !== undefined && { language: n.language }),
    };
    // On a stored row the choices merge into what is there, kind by kind.
    const set = {
      ...values,
      ...(n?.choices !== undefined && {
        notificationChoices: sql`${userPreferences.notificationChoices} || ${JSON.stringify(n.choices)}::jsonb`,
      }),
    };
    try {
      // One statement: two changes at once (two tabs) each apply whole, never half.
      const [row] = await (tx ? drizzleOf(tx) : this.database.db)
        .insert(userPreferences)
        .values({ userId, ...values })
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

  async notificationSettings(
    userIds: readonly string[],
  ): Promise<Map<string, NotificationSettings>> {
    const out = new Map<string, NotificationSettings>();
    const ids = [...new Set(userIds)];
    for (let at = 0; at < ids.length; at += 1_000) {
      const rows = await this.database.db
        .select()
        .from(userPreferences)
        .where(inArray(userPreferences.userId, ids.slice(at, at + 1_000)));
      for (const row of rows) out.set(row.userId, notificationsOf(row));
    }
    return out;
  }
}
