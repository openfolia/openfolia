import type { Transaction } from '../../base/core/unit-of-work.js';
import type { NotificationSettings } from './notification-settings.js';
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
   * there were none) and returns the result; notification `choices` merge kind by kind. Undefined
   * when no such user exists. Inside `tx` when given (with what records the change).
   */
  abstract write(
    userId: string,
    changes: PreferenceChanges,
    tx?: Transaction,
  ): Promise<StoredPreferences | undefined>;

  /**
   * The notification settings of each of `userIds` that stored any (#884), in one read: the
   * fan-out's and the email sender's. Those not in the map have the defaults.
   */
  abstract notificationSettings(
    userIds: readonly string[],
  ): Promise<Map<string, NotificationSettings>>;
}
