import { Injectable } from '@nestjs/common';
import { asc, eq, inArray, lt, sql } from 'drizzle-orm';
import {
  SealedSecretSource,
  type SealedValue,
} from '../../base/core/secret-sealer.js';
import type { Transaction } from '../../base/core/unit-of-work.js';
import { Database } from '../../database/database.js';
import { drizzleOf } from '../../database/drizzle-unit-of-work.js';
import { isMailLanguage, type MailLanguage } from '../core/mail.js';
import {
  mailParamsContext,
  MailStore,
  type StoredMail,
} from '../core/mail-ports.js';
import { mailMessages } from './mail.tables.js';

type Row = typeof mailMessages.$inferSelect;

function toStored(row: Row): StoredMail {
  if (!isMailLanguage(row.language)) {
    throw new Error(`Email ${row.id} has an unknown language.`);
  }
  return {
    id: row.id,
    toAddress: row.toAddress,
    toName: row.toName,
    template: row.template,
    language: row.language as MailLanguage,
    paramsSealed: row.paramsSealed,
    attempts: row.attempts,
    lastError: row.lastError,
    createdAt: row.createdAt,
  };
}

/** `MailStore` on Postgres (`mail_messages`). */
@Injectable()
export class DrizzleMailStore extends MailStore {
  constructor(private readonly database: Database) {
    super();
  }

  async add(
    tx: Transaction,
    mail: Omit<StoredMail, 'attempts' | 'lastError' | 'createdAt'>,
  ): Promise<void> {
    await drizzleOf(tx).insert(mailMessages).values({
      id: mail.id,
      toAddress: mail.toAddress,
      toName: mail.toName,
      template: mail.template,
      language: mail.language,
      paramsSealed: mail.paramsSealed,
    });
  }

  async find(id: string): Promise<StoredMail | undefined> {
    const [row] = await this.database.db
      .select()
      .from(mailMessages)
      .where(eq(mailMessages.id, id));
    return row ? toStored(row) : undefined;
  }

  async recordFailure(id: string, error: string): Promise<boolean> {
    const rows = await this.database.db
      .update(mailMessages)
      .set({
        attempts: sql`${mailMessages.attempts} + 1`,
        lastError: error.slice(0, 32),
      })
      .where(eq(mailMessages.id, id))
      .returning({ id: mailMessages.id });
    return rows.length > 0;
  }

  async remove(tx: Transaction, id: string): Promise<boolean> {
    const rows = await drizzleOf(tx)
      .delete(mailMessages)
      .where(eq(mailMessages.id, id))
      .returning({ id: mailMessages.id });
    return rows.length > 0;
  }

  async removeStale(before: Date, limit: number): Promise<number> {
    const db = this.database.db;
    const stale = db
      .select({ id: mailMessages.id })
      .from(mailMessages)
      .where(lt(mailMessages.createdAt, before))
      .orderBy(asc(mailMessages.createdAt))
      .limit(limit);
    const rows = await db
      .delete(mailMessages)
      .where(inArray(mailMessages.id, stale))
      .returning({ id: mailMessages.id });
    return rows.length;
  }
}

/**
 * The queued emails' sealed params, for the instance key's check and rotation
 * (`SealedSecretSource`, #470).
 */
export class MailSealedSecretSource extends SealedSecretSource {
  readonly name = 'queued email params';

  async sample(tx: Transaction, limit: number): Promise<SealedValue[]> {
    const rows = await drizzleOf(tx)
      .select({ id: mailMessages.id, sealed: mailMessages.paramsSealed })
      .from(mailMessages)
      .orderBy(asc(mailMessages.id))
      .limit(limit);
    return rows.map((row) => ({
      sealed: row.sealed,
      context: mailParamsContext(row.id),
    }));
  }

  async reseal(
    tx: Transaction,
    reseal: (value: SealedValue) => string | undefined,
  ): Promise<number> {
    const db = drizzleOf(tx);
    const rows = await db
      .select({ id: mailMessages.id, sealed: mailMessages.paramsSealed })
      .from(mailMessages)
      .orderBy(asc(mailMessages.id))
      .for('update');
    let count = 0;
    for (const row of rows) {
      const sealed = reseal({
        sealed: row.sealed,
        context: mailParamsContext(row.id),
      });
      if (sealed === undefined) continue;
      await db
        .update(mailMessages)
        .set({ paramsSealed: sealed })
        .where(eq(mailMessages.id, row.id));
      count++;
    }
    return count;
  }
}
