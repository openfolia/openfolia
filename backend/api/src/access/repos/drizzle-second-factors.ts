import { Injectable } from '@nestjs/common';
import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  isNotNull,
  isNull,
  lt,
  lte,
  notInArray,
} from 'drizzle-orm';
import {
  type SealedValue,
  SealedSecretSource,
} from '../../base/core/secret-sealer.js';
import type { Transaction } from '../../base/core/unit-of-work.js';
import { Database } from '../../database/database.js';
import { drizzleOf } from '../../database/drizzle-unit-of-work.js';
import {
  MAX_PENDING_SIGN_INS,
  type PendingSignIn,
  PendingSignIns,
  type SecondStep,
} from '../core/pending-sign-ins.js';
import {
  type SecondFactor,
  secondFactorContext,
  SecondFactors,
} from '../core/second-factors.js';
import {
  pendingSignIns,
  secondFactorRecoveryCodes,
  secondFactors,
} from './second-factors.tables.js';

/** `SecondFactors` over `second_factors` and `second_factor_recovery_codes` (#611). */
@Injectable()
export class DrizzleSecondFactors extends SecondFactors {
  constructor(private readonly database: Database) {
    super();
  }

  async find(
    userId: string,
    tx?: Transaction,
  ): Promise<SecondFactor | undefined> {
    const db = tx ? drizzleOf(tx) : this.database.db;
    const t = secondFactors;
    const codes = secondFactorRecoveryCodes;
    const [row] = await db
      .select({
        userId: t.userId,
        sealedSecret: t.sealedSecret,
        begunAt: t.begunAt,
        confirmedAt: t.confirmedAt,
      })
      .from(t)
      .where(eq(t.userId, userId));
    if (!row) return undefined;
    const [left] = await db
      .select({ codes: count() })
      .from(codes)
      .where(eq(codes.userId, userId));
    return { ...row, recoveryCodesLeft: left?.codes ?? 0 };
  }

  async begin(
    tx: Transaction,
    userId: string,
    sealedSecret: string,
    at: Date,
  ): Promise<boolean> {
    const t = secondFactors;
    const rows = await drizzleOf(tx)
      .insert(t)
      .values({ userId, sealedSecret, begunAt: at })
      .onConflictDoUpdate({
        target: t.userId,
        set: { sealedSecret, begunAt: at },
        setWhere: isNull(t.confirmedAt),
      })
      .returning({ userId: t.userId });
    return rows.length > 0;
  }

  async confirm(
    tx: Transaction,
    userId: string,
    sealedSecret: string,
    at: Date,
    step: number,
    recoveryHashes: readonly string[],
  ): Promise<boolean> {
    const t = secondFactors;
    const rows = await drizzleOf(tx)
      .update(t)
      .set({ confirmedAt: at, lastStep: step })
      .where(
        and(
          eq(t.userId, userId),
          eq(t.sealedSecret, sealedSecret),
          isNull(t.confirmedAt),
        ),
      )
      .returning({ userId: t.userId });
    if (rows.length === 0) return false;
    await this.replaceRecoveryCodes(tx, userId, recoveryHashes);
    return true;
  }

  async useStep(
    tx: Transaction,
    userId: string,
    step: number,
  ): Promise<boolean> {
    const t = secondFactors;
    const rows = await drizzleOf(tx)
      .update(t)
      .set({ lastStep: step })
      .where(
        and(
          eq(t.userId, userId),
          isNotNull(t.confirmedAt),
          lt(t.lastStep, step),
        ),
      )
      .returning({ userId: t.userId });
    return rows.length > 0;
  }

  async useRecoveryCode(
    tx: Transaction,
    userId: string,
    hash: string,
  ): Promise<boolean> {
    const t = secondFactorRecoveryCodes;
    const rows = await drizzleOf(tx)
      .delete(t)
      .where(and(eq(t.userId, userId), eq(t.codeHash, hash)))
      .returning({ userId: t.userId });
    return rows.length > 0;
  }

  async replaceRecoveryCodes(
    tx: Transaction,
    userId: string,
    hashes: readonly string[],
  ): Promise<void> {
    const t = secondFactorRecoveryCodes;
    const db = drizzleOf(tx);
    await db.delete(t).where(eq(t.userId, userId));
    await db.insert(t).values(hashes.map((codeHash) => ({ userId, codeHash })));
  }

  async remove(tx: Transaction, userId: string): Promise<boolean> {
    const t = secondFactors;
    const rows = await drizzleOf(tx)
      .delete(t)
      .where(eq(t.userId, userId))
      .returning({ confirmedAt: t.confirmedAt });
    return rows.some((row) => row.confirmedAt !== null);
  }
}

/** `PendingSignIns` over `pending_sign_ins` (#611). */
@Injectable()
export class DrizzlePendingSignIns extends PendingSignIns {
  constructor(private readonly database: Database) {
    super();
  }

  async create(
    tx: Transaction,
    pending: PendingSignIn,
    now: Date,
  ): Promise<void> {
    const t = pendingSignIns;
    const db = drizzleOf(tx);
    await db
      .delete(t)
      .where(and(eq(t.userId, pending.userId), lte(t.expiresAt, now)));
    const { hash, ...values } = pending;
    const kept = db
      .select({ tokenHash: t.tokenHash })
      .from(t)
      .where(eq(t.userId, pending.userId))
      .orderBy(desc(t.createdAt), asc(t.tokenHash))
      .limit(MAX_PENDING_SIGN_INS - 1);
    await db
      .delete(t)
      .where(and(eq(t.userId, pending.userId), notInArray(t.tokenHash, kept)));
    await db.insert(t).values({ ...values, tokenHash: hash, createdAt: now });
  }

  async find(
    hash: string,
    tx?: Transaction,
  ): Promise<PendingSignIn | undefined> {
    const t = pendingSignIns;
    const [row] = await (tx ? drizzleOf(tx) : this.database.db)
      .select({
        hash: t.tokenHash,
        userId: t.userId,
        step: t.step,
        provider: t.provider,
        via: t.via,
        expiresAt: t.expiresAt,
      })
      .from(t)
      .where(eq(t.tokenHash, hash));
    return row && { ...row, step: row.step as SecondStep };
  }

  async take(tx: Transaction, hash: string, now: Date): Promise<boolean> {
    const t = pendingSignIns;
    const rows = await drizzleOf(tx)
      .delete(t)
      .where(and(eq(t.tokenHash, hash), gt(t.expiresAt, now)))
      .returning({ userId: t.userId });
    return rows.length > 0;
  }

  async revokeAll(tx: Transaction, userId: string): Promise<void> {
    const t = pendingSignIns;
    await drizzleOf(tx).delete(t).where(eq(t.userId, userId));
  }
}

/** The second factors' sealed secrets, for the instance key's check and rotation (#470). */
export class SecondFactorSealedSecretSource extends SealedSecretSource {
  readonly name = 'two-factor secrets';

  async sample(tx: Transaction, limit: number): Promise<SealedValue[]> {
    const t = secondFactors;
    const rows = await drizzleOf(tx)
      .select({ userId: t.userId, sealed: t.sealedSecret })
      .from(t)
      .orderBy(asc(t.userId))
      .limit(limit);
    return rows.map((row) => ({
      sealed: row.sealed,
      context: secondFactorContext(row.userId),
    }));
  }

  async reseal(
    tx: Transaction,
    reseal: (value: SealedValue) => string | undefined,
  ): Promise<number> {
    const db = drizzleOf(tx);
    const t = secondFactors;
    const rows = await db
      .select({ userId: t.userId, sealed: t.sealedSecret })
      .from(t)
      .orderBy(asc(t.userId))
      .for('update');
    let resealed = 0;
    for (const row of rows) {
      const sealed = reseal({
        sealed: row.sealed,
        context: secondFactorContext(row.userId),
      });
      if (sealed === undefined) continue;
      await db
        .update(t)
        .set({ sealedSecret: sealed })
        .where(eq(t.userId, row.userId));
      resealed++;
    }
    return resealed;
  }
}
