import { Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import type { Transaction } from '../../base/core/unit-of-work.js';
import type { SelfApproval } from '../../change-sets/core/self-approval.js';
import { Database } from '../../database/database.js';
import { drizzleOf } from '../../database/drizzle-unit-of-work.js';
import {
  DEFAULT_INSTALLATION_SETTINGS,
  type InstallationSettings,
  type StoredInstallationSettings,
} from '../core/installation-settings.js';
import { InstallationSettingsStore } from '../core/installation-settings-store.js';
import { installationSettings } from './installation-settings.tables.js';

const ROW = 1;
const byRow = eq(installationSettings.id, ROW);

type Row = typeof installationSettings.$inferSelect;

const toStored = (row: Row | undefined): StoredInstallationSettings =>
  row
    ? {
        settings: { selfApproval: row.selfApproval as SelfApproval },
        version: row.version,
        updatedAt: row.updatedAt,
      }
    : {
        settings: DEFAULT_INSTALLATION_SETTINGS,
        version: 0,
        updatedAt: null,
      };

/** `InstallationSettingsStore` over `installation_settings` (one row). */
@Injectable()
export class DrizzleInstallationSettingsStore extends InstallationSettingsStore {
  constructor(private readonly database: Database) {
    super();
  }

  async read(tx?: Transaction): Promise<StoredInstallationSettings> {
    if (!tx) {
      const [row] = await this.database.db
        .select()
        .from(installationSettings)
        .where(byRow);
      return toStored(row);
    }
    // Shared in a transaction (an approval reading the rule): a change of the settings
    // (`lock`, `FOR UPDATE`) waits for it, and it for the change, so the audit log never shows a
    // self-approval recorded after the rule that forbids it.
    const [row] = await drizzleOf(tx)
      .select()
      .from(installationSettings)
      .where(byRow)
      .for('share');
    return toStored(row);
  }

  async lock(tx: Transaction): Promise<StoredInstallationSettings> {
    const db = drizzleOf(tx);
    await db
      .insert(installationSettings)
      .values({ id: ROW, version: 0 })
      .onConflictDoNothing();
    const [row] = await db
      .select()
      .from(installationSettings)
      .where(byRow)
      .for('update');
    return toStored(row);
  }

  async write(
    tx: Transaction,
    next: InstallationSettings,
  ): Promise<StoredInstallationSettings> {
    const [row] = await drizzleOf(tx)
      .update(installationSettings)
      .set({
        selfApproval: next.selfApproval,
        version: sql`${installationSettings.version} + 1`,
        updatedAt: sql`now()`,
      })
      .where(byRow)
      .returning();
    if (!row) throw new Error('The installation settings row is missing.');
    return toStored(row);
  }
}
