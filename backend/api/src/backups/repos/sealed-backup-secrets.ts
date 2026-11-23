import { asc, eq, isNotNull } from 'drizzle-orm';
import {
  SealedSecretSource,
  type SealedValue,
} from '../../base/core/secret-sealer.js';
import type { Transaction } from '../../base/core/unit-of-work.js';
import { drizzleOf } from '../../database/drizzle-unit-of-work.js';
import {
  backupIdentityContext,
  S3_SECRET_CONTEXT,
} from '../core/backup-settings.js';
import { backupKeys, backupSettings } from './backups.tables.js';

/** The S3 location's secret access key (#529), for the instance key's check and rotation. */
export class BackupS3SealedSecretSource extends SealedSecretSource {
  readonly name = 'backup S3 secret';

  async sample(tx: Transaction, limit: number): Promise<SealedValue[]> {
    const rows = await drizzleOf(tx)
      .select({ sealed: backupSettings.s3SecretSealed })
      .from(backupSettings)
      .where(isNotNull(backupSettings.s3SecretSealed))
      .limit(limit);
    return rows.map((r) => ({ sealed: r.sealed!, context: S3_SECRET_CONTEXT }));
  }

  async reseal(
    tx: Transaction,
    reseal: (value: SealedValue) => string | undefined,
  ): Promise<number> {
    const db = drizzleOf(tx);
    const rows = await db
      .select({ id: backupSettings.id, sealed: backupSettings.s3SecretSealed })
      .from(backupSettings)
      .where(isNotNull(backupSettings.s3SecretSealed))
      .for('update');
    let count = 0;
    for (const row of rows) {
      const next = reseal({ sealed: row.sealed!, context: S3_SECRET_CONTEXT });
      if (next === undefined) continue;
      await db
        .update(backupSettings)
        .set({ s3SecretSealed: next })
        .where(eq(backupSettings.id, row.id));
      count++;
    }
    return count;
  }
}

/**
 * The backup key's identity, kept sealed while backups are verified by
 * decrypting (#529), for the instance key's check and rotation.
 */
export class BackupIdentitySealedSecretSource extends SealedSecretSource {
  readonly name = 'backup key identity';

  async sample(tx: Transaction, limit: number): Promise<SealedValue[]> {
    const rows = await drizzleOf(tx)
      .select({ id: backupKeys.id, sealed: backupKeys.identitySealed })
      .from(backupKeys)
      .where(isNotNull(backupKeys.identitySealed))
      .orderBy(asc(backupKeys.id))
      .limit(limit);
    return rows.map((r) => ({
      sealed: r.sealed!,
      context: backupIdentityContext(r.id),
    }));
  }

  async reseal(
    tx: Transaction,
    reseal: (value: SealedValue) => string | undefined,
  ): Promise<number> {
    const db = drizzleOf(tx);
    const rows = await db
      .select({ id: backupKeys.id, sealed: backupKeys.identitySealed })
      .from(backupKeys)
      .where(isNotNull(backupKeys.identitySealed))
      .orderBy(asc(backupKeys.id))
      .for('update');
    let count = 0;
    for (const row of rows) {
      const next = reseal({
        sealed: row.sealed!,
        context: backupIdentityContext(row.id),
      });
      if (next === undefined) continue;
      await db
        .update(backupKeys)
        .set({ identitySealed: next })
        .where(eq(backupKeys.id, row.id));
      count++;
    }
    return count;
  }
}
