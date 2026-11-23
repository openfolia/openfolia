import { eq, sql } from 'drizzle-orm';
import type { Transaction } from '../../base/core/unit-of-work.js';
import { drizzleOf } from '../../database/drizzle-unit-of-work.js';
import { SecretKeyCheck } from '../core/secret-key-ports.js';
import { secretKeyCheck } from './secrets.tables.js';

/** `SecretKeyCheck` in `secret_key_check`, with a transaction-scoped advisory lock. */
export class DrizzleSecretKeyCheck extends SecretKeyCheck {
  async lock(tx: Transaction): Promise<void> {
    await drizzleOf(tx).execute(
      // Compatibility: keeps the working name from before the product was named OpenFolia: servers of
      // the version before and after an upgrade take the same lock.
      sql`select pg_advisory_xact_lock(hashtext('ccms:secret-key'))`,
    );
  }

  async read(tx: Transaction): Promise<string | undefined> {
    const [row] = await drizzleOf(tx)
      .select({ sealed: secretKeyCheck.sealed })
      .from(secretKeyCheck)
      .where(eq(secretKeyCheck.id, 1));
    return row?.sealed;
  }

  async write(tx: Transaction, sealed: string): Promise<void> {
    await drizzleOf(tx).insert(secretKeyCheck).values({ id: 1, sealed });
  }

  async replace(tx: Transaction, sealed: string): Promise<void> {
    await drizzleOf(tx)
      .update(secretKeyCheck)
      .set({ sealed })
      .where(eq(secretKeyCheck.id, 1));
  }
}
