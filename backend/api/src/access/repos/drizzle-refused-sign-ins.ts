import { Injectable } from '@nestjs/common';
import {
  and,
  eq,
  inArray,
  isNull,
  lte,
  ne,
  not,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import type { Transaction } from '../../base/core/unit-of-work.js';
import { drizzleOf } from '../../database/drizzle-unit-of-work.js';
import { PASSWORD_PROVIDER } from '../core/passwords.js';
import { type EndedSignIns, RefusedSignIns } from '../core/refused-sign-ins.js';
import type { SessionLimits } from '../core/session-policy.js';
import type { AllowedSignIns } from '../core/sign-in-rules.js';
import { users } from './access.tables.js';
import { emailSignInCodes } from './email-codes.tables.js';
import { signInLinks } from './passwords.tables.js';
import { pendingSignIns } from './second-factors.tables.js';
import { sessions } from './sign-in.tables.js';

/** `RefusedSignIns` over the tables of what a sign-in leaves behind. */
@Injectable()
export class DrizzleRefusedSignIns extends RefusedSignIns {
  async end(
    tx: Transaction,
    {
      allowed,
      limits,
      now,
    }: {
      readonly allowed: AllowedSignIns;
      readonly limits: SessionLimits | null;
      readonly now: Date;
    },
  ): Promise<EndedSignIns> {
    const db = drizzleOf(tx);
    const count = (rows: readonly unknown[]) => rows.length;
    const ended = { links: 0, emailCodes: 0, secondSteps: 0 };
    let refused: SQL | undefined;
    if (allowed !== 'all') {
      const holder = allowed.breakGlassUserId;
      const begunOtherwise = (provider: AnyPgColumn, userId: AnyPgColumn) =>
        not(
          or(
            inArray(provider, [...allowed.providers]),
            holder === null
              ? sql`false`
              : and(eq(provider, PASSWORD_PROVIDER), eq(userId, holder)),
          ) ?? sql`false`,
        );
      ended.links = count(
        await db
          .delete(signInLinks)
          .where(
            holder === null ? undefined : not(eq(signInLinks.userId, holder)),
          )
          .returning({ hash: signInLinks.tokenHash }),
      );
      ended.emailCodes = count(
        await db
          .delete(emailSignInCodes)
          .returning({ userId: emailSignInCodes.userId }),
      );
      ended.secondSteps = count(
        await db
          .delete(pendingSignIns)
          .where(begunOtherwise(pendingSignIns.provider, pendingSignIns.userId))
          .returning({ hash: pendingSignIns.tokenHash }),
      );
      refused = begunOtherwise(sessions.provider, sessions.userId);
    }
    const past =
      limits === null
        ? undefined
        : or(
            lte(sessions.createdAt, new Date(now.getTime() - limits.maxMs)),
            lte(sessions.lastSeenAt, new Date(now.getTime() - limits.idleMs)),
          );
    const which = or(refused, past);
    const revoked =
      which === undefined
        ? []
        : await db
            .update(sessions)
            .set({ revokedAt: sql`now()` })
            .where(and(isNull(sessions.revokedAt), which))
            .returning({ hash: sessions.tokenHash });
    return { ...ended, sessions: count(revoked) };
  }

  async hold(tx: Transaction, userId: string): Promise<void> {
    await drizzleOf(tx)
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, userId))
      .for('no key update');
  }

  async endPasswordsOf(
    tx: Transaction,
    userId: string,
    keepSessionHash?: string,
  ): Promise<EndedSignIns> {
    const db = drizzleOf(tx);
    const links = await db
      .delete(signInLinks)
      .where(eq(signInLinks.userId, userId))
      .returning({ hash: signInLinks.tokenHash });
    const steps = await db
      .delete(pendingSignIns)
      .where(
        and(
          eq(pendingSignIns.userId, userId),
          eq(pendingSignIns.provider, PASSWORD_PROVIDER),
        ),
      )
      .returning({ hash: pendingSignIns.tokenHash });
    const revoked = await db
      .update(sessions)
      .set({ revokedAt: sql`now()` })
      .where(
        and(
          eq(sessions.userId, userId),
          eq(sessions.provider, PASSWORD_PROVIDER),
          isNull(sessions.revokedAt),
          keepSessionHash === undefined
            ? undefined
            : ne(sessions.tokenHash, keepSessionHash),
        ),
      )
      .returning({ hash: sessions.tokenHash });
    return {
      links: links.length,
      emailCodes: 0,
      secondSteps: steps.length,
      sessions: revoked.length,
    };
  }
}
