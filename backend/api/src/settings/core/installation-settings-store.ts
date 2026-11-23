import type { Transaction } from '../../base/core/unit-of-work.js';
import type {
  InstallationSettings,
  StoredInstallationSettings,
} from './installation-settings.js';

/**
 * Port: where the installation's settings are kept (Postgres,
 * `repos/drizzle-installation-settings-store.ts`; in memory for tests).
 */
export abstract class InstallationSettingsStore {
  /**
   * The settings now; the defaults (version 0) before the first change. In `tx`, read under a
   * shared lock until it ends: a change waits for it.
   */
  abstract read(tx?: Transaction): Promise<StoredInstallationSettings>;

  /**
   * The settings, locked for `tx` until it ends, so changes happen one at a
   * time and none is lost; made (with the defaults) when there are none yet.
   */
  abstract lock(tx: Transaction): Promise<StoredInstallationSettings>;

  /** Writes `settings` as the next version (`tx` holds the lock). */
  abstract write(
    tx: Transaction,
    settings: InstallationSettings,
  ): Promise<StoredInstallationSettings>;
}
