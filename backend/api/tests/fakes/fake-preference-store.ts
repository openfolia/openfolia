import type { Transaction } from '../../src/base/core/unit-of-work.js';
import { fakeOf } from './fake-unit-of-work.js';
import type { NotificationSettings } from '../../src/preferences/core/notification-settings.js';
import { PreferenceStore } from '../../src/preferences/core/preference-store.js';
import {
  DEFAULT_PREFERENCES,
  type PreferenceChanges,
  type StoredPreferences,
} from '../../src/preferences/core/preferences.js';

/** `PreferenceStore` in memory; `users` are the IDs a write may store for (all when left out). */
export class FakePreferenceStore extends PreferenceStore {
  readonly rows = new Map<string, StoredPreferences>();
  writes = 0;

  constructor(private readonly users?: ReadonlySet<string>) {
    super();
  }

  async read(userId: string): Promise<StoredPreferences> {
    return (
      this.rows.get(userId) ?? {
        preferences: DEFAULT_PREFERENCES,
        updatedAt: null,
      }
    );
  }

  async write(
    userId: string,
    changes: PreferenceChanges,
    tx?: Transaction,
  ): Promise<StoredPreferences | undefined> {
    if (tx) fakeOf(tx);
    if (this.users && !this.users.has(userId)) return undefined;
    this.writes++;
    const { preferences } = await this.read(userId);
    const { notifications, ...rest } = changes;
    const next: StoredPreferences = {
      preferences: {
        ...preferences,
        ...rest,
        notifications: {
          ...preferences.notifications,
          ...notifications,
          choices: {
            ...preferences.notifications.choices,
            ...notifications?.choices,
          },
        },
      },
      updatedAt: new Date(),
    };
    this.rows.set(userId, next);
    return next;
  }

  async notificationSettings(
    userIds: readonly string[],
  ): Promise<Map<string, NotificationSettings>> {
    const out = new Map<string, NotificationSettings>();
    for (const id of userIds) {
      const row = this.rows.get(id);
      if (row) out.set(id, row.preferences.notifications);
    }
    return out;
  }
}
