import type { PreferenceChanges, StoredPreferences } from './preferences.js';

/**
 * Port: each person's preferences, by user ID. Every read and write names its user, so no path
 * reads or changes another person's.
 */
export abstract class PreferenceStore {
  /** `userId`'s preferences; the defaults (`updatedAt` null) while none are stored. */
  abstract read(userId: string): Promise<StoredPreferences>;

  /**
   * Applies `changes` to `userId`'s preferences in one statement (stored from the defaults when
   * there were none) and returns the result. Undefined when no such user exists.
   */
  abstract write(
    userId: string,
    changes: PreferenceChanges,
  ): Promise<StoredPreferences | undefined>;
}
