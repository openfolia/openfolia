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
  ): Promise<StoredPreferences | undefined> {
    if (this.users && !this.users.has(userId)) return undefined;
    this.writes++;
    const { preferences } = await this.read(userId);
    const next: StoredPreferences = {
      preferences: { ...preferences, ...changes },
      updatedAt: new Date(),
    };
    this.rows.set(userId, next);
    return next;
  }
}
