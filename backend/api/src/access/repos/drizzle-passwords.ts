import { Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import type { Transaction } from '../../base/core/unit-of-work.js';
import { Database } from '../../database/database.js';
import { drizzleOf } from '../../database/drizzle-unit-of-work.js';
import { type PasswordCredentials, PasswordStore } from '../core/passwords.js';
import {
  type SignInLinkKind,
  SignInLinks,
  type StoredSignInLink,
} from '../core/sign-in-links.js';
import { users } from './access.tables.js';
import { signInLinks, userPasswords } from './passwords.tables.js';

/** `PasswordStore` over the `user_passwords` table. */
@Injectable()
export class DrizzlePasswordStore extends PasswordStore {
  constructor(private readonly database: Database) {
    super();
  }

  async findByEmail(email: string): Promise<PasswordCredentials | undefined> {
    const [row] = await this.database.db
      .select({
        userId: users.id,
        email: users.email,
        deactivatedAt: users.deactivatedAt,
        hash: userPasswords.hash,
      })
      .from(users)
      .innerJoin(userPasswords, eq(userPasswords.userId, users.id))
      .where(sql`lower(${users.email}) = lower(${email})`)
      .limit(1);
    return row && row.email !== null ? { ...row, email: row.email } : undefined;
  }

  async hashOf(userId: string, tx?: Transaction): Promise<string | undefined> {
    const [row] = await (tx ? drizzleOf(tx) : this.database.db)
      .select({ hash: userPasswords.hash })
      .from(userPasswords)
      .where(eq(userPasswords.userId, userId));
    return row?.hash;
  }

  async set(tx: Transaction, userId: string, hash: string): Promise<void> {
    await drizzleOf(tx)
      .insert(userPasswords)
      .values({ userId, hash })
      .onConflictDoUpdate({
        target: userPasswords.userId,
        set: { hash, setAt: sql`now()` },
      });
  }

  async replaceIf(
    tx: Transaction,
    userId: string,
    previous: string,
    next: string,
  ): Promise<boolean> {
    const rows = await drizzleOf(tx)
      .update(userPasswords)
      .set({ hash: next })
      .where(
        and(eq(userPasswords.userId, userId), eq(userPasswords.hash, previous)),
      )
      .returning({ userId: userPasswords.userId });
    return rows.length > 0;
  }
}

const asLink = (row: typeof signInLinks.$inferSelect): StoredSignInLink => ({
  hash: row.tokenHash,
  userId: row.userId,
  kind: row.kind as SignInLinkKind,
  createdAt: row.createdAt,
  expiresAt: row.expiresAt,
});

/** `SignInLinks` over the `sign_in_links` table. */
@Injectable()
export class DrizzleSignInLinks extends SignInLinks {
  constructor(private readonly database: Database) {
    super();
  }

  async replace(
    tx: Transaction,
    link: {
      readonly hash: string;
      readonly userId: string;
      readonly kind: SignInLinkKind;
      readonly expiresAt: Date;
    },
  ): Promise<number> {
    const db = drizzleOf(tx);
    const removed = await db
      .delete(signInLinks)
      .where(eq(signInLinks.userId, link.userId))
      .returning({ hash: signInLinks.tokenHash });
    await db.insert(signInLinks).values({
      tokenHash: link.hash,
      userId: link.userId,
      kind: link.kind,
      expiresAt: link.expiresAt,
    });
    return removed.length;
  }

  async find(hash: string): Promise<StoredSignInLink | undefined> {
    const [row] = await this.database.db
      .select()
      .from(signInLinks)
      .where(eq(signInLinks.tokenHash, hash));
    return row && asLink(row);
  }

  async take(
    tx: Transaction,
    hash: string,
  ): Promise<StoredSignInLink | undefined> {
    const [row] = await drizzleOf(tx)
      .delete(signInLinks)
      .where(eq(signInLinks.tokenHash, hash))
      .returning();
    return row && asLink(row);
  }

  async revokeAll(
    tx: Transaction,
    userId: string,
    kind?: SignInLinkKind,
  ): Promise<number> {
    const removed = await drizzleOf(tx)
      .delete(signInLinks)
      .where(
        and(
          eq(signInLinks.userId, userId),
          kind === undefined ? undefined : eq(signInLinks.kind, kind),
        ),
      )
      .returning({ hash: signInLinks.tokenHash });
    return removed.length;
  }

  async linkOf(
    tx: Transaction,
    userId: string,
  ): Promise<StoredSignInLink | undefined> {
    const [row] = await drizzleOf(tx)
      .select()
      .from(signInLinks)
      .where(eq(signInLinks.userId, userId));
    return row && asLink(row);
  }
}
