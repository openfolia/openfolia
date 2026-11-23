import { createHmac } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { and, eq, gt, gte, isNull, lt, lte, sql } from 'drizzle-orm';
import type { Transaction } from '../../base/core/unit-of-work.js';
import { Database } from '../../database/database.js';
import { drizzleOf } from '../../database/drizzle-unit-of-work.js';
import { InstanceSecretKey } from '../../secrets/core/instance-secret-key.js';
import {
  EMAIL_CODE_MAX_FAILURES,
  type EmailCodeHolder,
  EmailCodeHasher,
  EmailCodes,
  type StoredEmailCode,
} from '../core/email-codes.js';
import { users } from './access.tables.js';
import { emailSignInCodes } from './email-codes.tables.js';

/** What the HMAC key of codes is derived for from the instance secret key (HKDF `info`). */
// Compatibility: keeps the working name from before the product was named OpenFolia: a key derivation's
// context, so codes and attempts already stored keep matching.
export const EMAIL_CODE_KEY_INFO = 'ccms email-codes v1';

/**
 * `EmailCodeHasher` (#634): HMAC-SHA256 of `<userId>\n<code>` under a key derived (HKDF) from
 * the instance secret key, which email needs as well (it seals what a queued email holds): the
 * same on every server and after a restart. Rotating the secret key leaves open codes unusable,
 * for ten minutes at most.
 */
@Injectable()
export class DrizzleEmailCodeHasher extends EmailCodeHasher {
  private key: Buffer | undefined;

  constructor(private readonly secretKey: InstanceSecretKey) {
    super();
  }

  get available(): boolean {
    return this.keyOrUndefined() !== undefined;
  }

  hash(userId: string, code: string): string {
    const key = this.keyOrUndefined();
    if (!key) throw new Error('There is no secret key to hash a code with.');
    return createHmac('sha256', key).update(`${userId}\n${code}`).digest('hex');
  }

  private keyOrUndefined(): Buffer | undefined {
    // Opened as the server starts, before any request: kept once there.
    this.key ??= this.secretKey.derive(EMAIL_CODE_KEY_INFO);
    return this.key;
  }
}

const asCode = (
  row: typeof emailSignInCodes.$inferSelect,
): StoredEmailCode => ({
  userId: row.userId,
  codeHash: row.codeHash,
  linkHash: row.linkHash,
  sentTo: row.sentTo,
  createdAt: row.createdAt,
  expiresAt: row.expiresAt,
});

/** The code's person still has the address it was mailed to (#646), ignoring case. */
const stillTheirs = sql`exists (select 1 from ${users} where ${users.id} = ${emailSignInCodes.userId} and lower(${users.email}) = lower(${emailSignInCodes.sentTo}))`;

/** `EmailCodes` over the `email_sign_in_codes` table. */
@Injectable()
export class DrizzleEmailCodes extends EmailCodes {
  constructor(private readonly database: Database) {
    super();
  }

  async hold(tx: Transaction, userId: string): Promise<void> {
    // A share lock: requests at once don't wait for each other, only for a change of the row
    // (`revokeAll`'s lock, an `UPDATE` of the address or the deactivation).
    await drizzleOf(tx)
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, userId))
      .for('share');
  }

  async holdToEnd(tx: Transaction, userId: string): Promise<void> {
    // As an `UPDATE` of the row would take it: waits for a request holding it (`hold`) to store
    // its code, which `revokeAll` then removes, and makes one that comes after wait until this
    // commits. `no key update`, not `update`: a sign-in's new session (a foreign key to the
    // row) is not held up, so this row adds no deadlock with a sign-in by the code.
    await drizzleOf(tx)
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, userId))
      .for('no key update');
  }

  async replace(
    tx: Transaction,
    code: {
      readonly userId: string;
      readonly codeHash: string;
      readonly linkHash: string;
      readonly sentTo: string;
      readonly expiresAt: Date;
    },
  ): Promise<boolean> {
    const t = emailSignInCodes;
    const db = drizzleOf(tx);
    // The person, while the address is still theirs, held until this commits: a change of their
    // row in progress (a new address) is waited for and then seen, and one that comes after
    // waits for this code to be stored, so its `WaysIn.endMailed` ends it.
    const [holder] = await db
      .select({ id: users.id })
      .from(users)
      .where(
        and(
          eq(users.id, code.userId),
          sql`lower(${users.email}) = lower(${code.sentTo})`,
          isNull(users.deactivatedAt),
        ),
      )
      .for('share');
    if (!holder) return false;
    // One statement: two requests at once leave one code, the later one.
    await db
      .insert(t)
      .values(code)
      .onConflictDoUpdate({
        target: t.userId,
        set: {
          codeHash: code.codeHash,
          linkHash: code.linkHash,
          sentTo: code.sentTo,
          expiresAt: code.expiresAt,
          createdAt: sql`now()`,
          failures: 0,
        },
      });
    return true;
  }

  async claim(email: string, now: Date): Promise<EmailCodeHolder | undefined> {
    const t = emailSignInCodes;
    // One statement: the row lock makes requests at once take turns, and each re-reads
    // `failures` after the one before it, so no more than the cap ever get the hash.
    const [row] = await this.database.db
      .update(t)
      .set({ failures: sql`${t.failures} + 1` })
      .from(users)
      .where(
        and(
          eq(users.id, t.userId),
          sql`lower(${users.email}) = lower(${email})`,
          sql`lower(${users.email}) = lower(${t.sentTo})`,
          gt(t.expiresAt, now),
          lt(t.failures, EMAIL_CODE_MAX_FAILURES),
        ),
      )
      .returning({
        userId: t.userId,
        codeHash: t.codeHash,
        expiresAt: t.expiresAt,
        tries: t.failures,
        deactivatedAt: users.deactivatedAt,
      });
    return row;
  }

  async findByLink(linkHash: string): Promise<StoredEmailCode | undefined> {
    const [row] = await this.database.db
      .select()
      .from(emailSignInCodes)
      .where(and(eq(emailSignInCodes.linkHash, linkHash), stillTheirs));
    return row && asCode(row);
  }

  async take(
    tx: Transaction,
    userId: string,
    which: { readonly codeHash: string } | { readonly linkHash: string },
    now: Date,
  ): Promise<boolean> {
    const t = emailSignInCodes;
    const rows = await drizzleOf(tx)
      .delete(t)
      .where(
        and(
          eq(t.userId, userId),
          'codeHash' in which
            ? eq(t.codeHash, which.codeHash)
            : eq(t.linkHash, which.linkHash),
          gt(t.expiresAt, now),
          // The claimed try that found the code is counted already.
          lte(t.failures, EMAIL_CODE_MAX_FAILURES),
          stillTheirs,
        ),
      )
      .returning({ userId: t.userId });
    return rows.length > 0;
  }

  async dropSpent(userId: string): Promise<void> {
    const t = emailSignInCodes;
    await this.database.db
      .delete(t)
      .where(
        and(eq(t.userId, userId), gte(t.failures, EMAIL_CODE_MAX_FAILURES)),
      );
  }

  async revokeByEmail(email: string): Promise<void> {
    const t = emailSignInCodes;
    await this.database.db
      .delete(t)
      .where(
        sql`${t.userId} in (select ${users.id} from ${users} where lower(${users.email}) = lower(${email}))`,
      );
  }

  async revokeAll(tx: Transaction, userId: string): Promise<boolean> {
    const t = emailSignInCodes;
    const db = drizzleOf(tx);
    await this.holdToEnd(tx, userId);
    const rows = await db
      .delete(t)
      .where(eq(t.userId, userId))
      .returning({ userId: t.userId });
    return rows.length > 0;
  }
}
