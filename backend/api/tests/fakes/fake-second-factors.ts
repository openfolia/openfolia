import type { SignInEvents } from '../../src/access/core/sign-in-events.js';
import type { AuditLog } from '../../src/audit/core/audit-log.js';
import { FakeAuditLog } from './fake-audit-log.js';
import { FakeSignInEvents } from './fake-sign-in.js';
import type { AccessAdmin } from '../../src/access/core/access-admin.js';
import type { EmailCodes } from '../../src/access/core/email-codes.js';
import {
  MAX_PENDING_SIGN_INS,
  type PendingSignIn,
  PendingSignIns,
} from '../../src/access/core/pending-sign-ins.js';
import {
  DEFAULT_SECOND_FACTOR_RULE,
  type SecondFactor,
  SecondFactorRule,
  type SecondFactorRuleValue,
  SecondFactors,
} from '../../src/access/core/second-factors.js';
import type { SessionPolicy } from '../../src/access/core/session-policy.js';
import { SessionStart } from '../../src/access/core/session-start.js';
import type { SessionStore } from '../../src/access/core/sessions.js';
import type { Transaction } from '../../src/base/core/unit-of-work.js';
import { fakeOf } from './fake-unit-of-work.js';

interface StoredFactor {
  sealedSecret: string;
  begunAt: Date;
  confirmedAt: Date | null;
  lastStep: number | null;
  recovery: ReadonlySet<string>;
}

/** Second factors in memory; a write shows at once and is undone when its transaction fails. */
export class FakeSecondFactors extends SecondFactors {
  readonly factors = new Map<string, StoredFactor>();

  async find(userId: string): Promise<SecondFactor | undefined> {
    const f = this.factors.get(userId);
    return (
      f && {
        userId,
        sealedSecret: f.sealedSecret,
        begunAt: f.begunAt,
        confirmedAt: f.confirmedAt,
        recoveryCodesLeft: f.recovery.size,
      }
    );
  }

  async begin(
    tx: Transaction,
    userId: string,
    sealedSecret: string,
    at: Date,
  ): Promise<boolean> {
    if (this.factors.get(userId)?.confirmedAt) return false;
    this.put(tx, userId, {
      sealedSecret,
      begunAt: at,
      confirmedAt: null,
      lastStep: null,
      recovery: new Set(),
    });
    return true;
  }

  async confirm(
    tx: Transaction,
    userId: string,
    sealedSecret: string,
    at: Date,
    step: number,
    recoveryHashes: readonly string[],
  ): Promise<boolean> {
    const f = this.factors.get(userId);
    if (!f || f.confirmedAt || f.sealedSecret !== sealedSecret) return false;
    this.put(tx, userId, {
      ...f,
      confirmedAt: at,
      lastStep: step,
      recovery: new Set(recoveryHashes),
    });
    return true;
  }

  async useStep(
    tx: Transaction,
    userId: string,
    step: number,
  ): Promise<boolean> {
    const f = this.factors.get(userId);
    if (!f || f.lastStep === null || f.lastStep >= step) return false;
    this.put(tx, userId, { ...f, lastStep: step });
    return true;
  }

  async useRecoveryCode(
    tx: Transaction,
    userId: string,
    hash: string,
  ): Promise<boolean> {
    const f = this.factors.get(userId);
    if (!f?.recovery.has(hash)) return false;
    const recovery = new Set(f.recovery);
    recovery.delete(hash);
    this.put(tx, userId, { ...f, recovery });
    return true;
  }

  async replaceRecoveryCodes(
    tx: Transaction,
    userId: string,
    hashes: readonly string[],
  ): Promise<void> {
    const f = this.factors.get(userId);
    if (f) this.put(tx, userId, { ...f, recovery: new Set(hashes) });
  }

  async remove(tx: Transaction, userId: string): Promise<boolean> {
    const f = this.factors.get(userId);
    if (f) this.put(tx, userId, undefined);
    return f !== undefined && f.confirmedAt !== null;
  }

  private put(
    tx: Transaction,
    userId: string,
    next: StoredFactor | undefined,
  ): void {
    const before = this.factors.get(userId);
    if (next) this.factors.set(userId, next);
    else this.factors.delete(userId);
    fakeOf(tx).onRollback(() => {
      if (before) this.factors.set(userId, before);
      else this.factors.delete(userId);
    });
  }
}

/** Open second steps in memory; a write shows at once and is undone when its transaction fails. */
export class FakePendingSignIns extends PendingSignIns {
  readonly open = new Map<string, PendingSignIn>();

  async create(
    tx: Transaction,
    pending: PendingSignIn,
    now: Date,
  ): Promise<void> {
    const theirs = [...this.open.values()].filter(
      (p) => p.userId === pending.userId,
    );
    const running = theirs.filter((p) => p.expiresAt > now);
    const kept = new Set(running.slice(-(MAX_PENDING_SIGN_INS - 1)));
    this.drop(
      tx,
      theirs.filter((p) => !kept.has(p)),
    );
    this.open.set(pending.hash, pending);
    fakeOf(tx).onRollback(() => this.open.delete(pending.hash));
  }

  async find(hash: string): Promise<PendingSignIn | undefined> {
    return this.open.get(hash);
  }

  async take(tx: Transaction, hash: string, now: Date): Promise<boolean> {
    const found = this.open.get(hash);
    if (!found || found.expiresAt <= now) return false;
    this.drop(tx, [found]);
    return true;
  }

  async revokeAll(tx: Transaction, userId: string): Promise<void> {
    this.drop(
      tx,
      [...this.open.values()].filter((p) => p.userId === userId),
    );
  }

  private drop(tx: Transaction, gone: readonly PendingSignIn[]): void {
    for (const p of gone) this.open.delete(p.hash);
    fakeOf(tx).onRollback(() => {
      for (const p of gone) this.open.set(p.hash, p);
    });
  }
}

/** A second-factor rule a test sets: each person's own choice unless changed. */
export class FakeSecondFactorRule extends SecondFactorRule {
  rule: SecondFactorRuleValue = DEFAULT_SECOND_FACTOR_RULE;

  async read(): Promise<SecondFactorRuleValue> {
    return this.rule;
  }
}

/** `SessionStart` over a test's own stores; without second factors unless they are given. */
export function sessionStart(deps: {
  sessions: SessionStore;
  policy: SessionPolicy;
  admin: AccessAdmin;
  codes: EmailCodes;
  factors?: SecondFactors;
  pending?: PendingSignIns;
  rule?: SecondFactorRule;
  auditLog?: AuditLog;
  events?: SignInEvents;
}): SessionStart {
  return new SessionStart(
    deps.sessions,
    deps.policy,
    deps.factors ?? new FakeSecondFactors(),
    deps.pending ?? new FakePendingSignIns(),
    deps.rule ?? new FakeSecondFactorRule(),
    deps.admin,
    deps.codes,
    deps.auditLog ?? new FakeAuditLog(),
    deps.events ?? new FakeSignInEvents(),
  );
}
