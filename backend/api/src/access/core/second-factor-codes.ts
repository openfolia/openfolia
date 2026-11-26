import { Injectable, Logger } from '@nestjs/common';
import { AuditLog } from '../../audit/core/audit-log.js';
import { ConflictError } from '../../base/core/errors.js';
import { SecretSealer } from '../../base/core/secret-sealer.js';
import type { Transaction } from '../../base/core/unit-of-work.js';
import type { Actor } from './actor.js';
import {
  hashRecoveryCode,
  mintRecoveryCodes,
  readSecondFactorCode,
  SECOND_FACTOR_SET_UP_MS,
  secondFactorContext,
  SecondFactors,
} from './second-factors.js';
import { matchingStep, mintTotpSecret } from './totp.js';
import { WaysIn } from './ways-in.js';

/** A set-up begun: the secret, given to the person now and never again. */
export interface SetUpBegun {
  /** Whose it is, as the authenticator app lists it. */
  readonly account: string;
  readonly secret: string;
}

/**
 * What the account menu and the sign-in's second step share of a second factor (#611): setting
 * one up, using a code of it, making recovery codes. The callers hold the person first
 * (`WaysIn.holdPerson`) and count tries before (`PasswordAttempts`).
 */
@Injectable()
export class SecondFactorCodes {
  private readonly log = new Logger('SecondFactor');
  /** Whose unreadable secret was logged: once each, until the next start. */
  private readonly unreadable = new Set<string>();

  constructor(
    private readonly factors: SecondFactors,
    private readonly sealer: SecretSealer,
    private readonly waysIn: WaysIn,
    private readonly auditLog: AuditLog,
  ) {}

  /** Whether one can be set up: there is a secret key to seal it with. */
  get available(): boolean {
    return this.sealer.available;
  }

  /**
   * Begins a set-up: a new secret, stored sealed and unconfirmed. 409 `second-factor-on` with one
   * on already, `second-factor-unavailable` without a secret key.
   */
  async begin(
    tx: Transaction,
    person: { readonly id: string; readonly email: string | null },
    now: number,
  ): Promise<SetUpBegun> {
    this.refuseWithoutKey();
    const secret = mintTotpSecret();
    const begun = await this.factors.begin(
      tx,
      person.id,
      this.sealer.seal(secret, secondFactorContext(person.id)),
      new Date(now),
    );
    if (!begun) throw alreadyOn();
    return { account: person.email ?? person.id, secret };
  }

  /**
   * Turns on the set-up begun, with a code of it: the factor counts from now, and the person's
   * other sessions (begun without it) and open second steps end. Answers the recovery codes,
   * once. Recorded as `user.second-factor-on`. Undefined for a code that is not right; 409
   * `second-factor-on`, `second-factor-not-begun` (none, or begun too long ago).
   */
  async confirm(
    tx: Transaction,
    self: Actor,
    typed: string,
    now: number,
    keepSessionHash?: string,
  ): Promise<
    | {
        readonly recoveryCodes: readonly string[];
        readonly sessionsEnded: number;
      }
    | undefined
  > {
    const factor = await this.factors.find(self.id, tx);
    if (factor && factor.confirmedAt !== null) throw alreadyOn();
    if (!factor || factor.begunAt.getTime() + SECOND_FACTOR_SET_UP_MS <= now) {
      throw new ConflictError(
        'second-factor-not-begun',
        'No set-up is open: begin it again.',
      );
    }
    const read = readSecondFactorCode(typed);
    const step =
      read?.kind === 'totp'
        ? matchingStep(this.open(factor.sealedSecret, self.id), read.code, now)
        : undefined;
    if (step === undefined) return undefined;
    const recoveryCodes = mintRecoveryCodes();
    const confirmed = await this.factors.confirm(
      tx,
      self.id,
      factor.sealedSecret,
      new Date(now),
      step,
      recoveryCodes.map((code) => hashRecoveryCode(self.id, code)),
    );
    if (!confirmed) return undefined;
    const sessionsEnded = await this.waysIn.endWithoutSecondFactor(
      tx,
      self.id,
      keepSessionHash,
    );
    await this.auditLog.record(tx, self, {
      action: 'user.second-factor-on',
      subject: { type: 'user', id: self.id },
      data: { sessionsEnded },
    });
    return { recoveryCodes, sessionsEnded };
  }

  /**
   * Uses up what was typed: a code of the person's app (accepted once, within the fixed window)
   * or one of their recovery codes. Undefined: not right, used before, or no factor on.
   */
  async use(
    tx: Transaction,
    userId: string,
    typed: string,
    now: number,
  ): Promise<'totp' | 'recovery-code' | undefined> {
    const factor = await this.factors.find(userId, tx);
    if (!factor || factor.confirmedAt === null) return undefined;
    const read = readSecondFactorCode(typed);
    if (read?.kind === 'totp') {
      const step = matchingStep(
        this.open(factor.sealedSecret, userId),
        read.code,
        now,
      );
      if (step === undefined) return undefined;
      return (await this.factors.useStep(tx, userId, step))
        ? 'totp'
        : undefined;
    }
    if (read?.kind === 'recovery-code') {
      const hash = hashRecoveryCode(userId, read.code);
      return (await this.factors.useRecoveryCode(tx, userId, hash))
        ? 'recovery-code'
        : undefined;
    }
    return undefined;
  }

  /** New recovery codes in place of every earlier one; shown once. */
  async newRecoveryCodes(
    tx: Transaction,
    userId: string,
  ): Promise<readonly string[]> {
    const codes = mintRecoveryCodes();
    await this.factors.replaceRecoveryCodes(
      tx,
      userId,
      codes.map((code) => hashRecoveryCode(userId, code)),
    );
    return codes;
  }

  /**
   * The secret, opened: refused without the key, or when it cannot be opened (damaged), so a
   * sign-in that needs it never goes on.
   */
  private open(sealed: string, userId: string): string {
    this.refuseWithoutKey();
    try {
      return this.sealer.open(sealed, secondFactorContext(userId));
    } catch {
      // IDs only: neither the sealed value nor the error, which might hold some of it.
      if (!this.unreadable.has(userId)) {
        this.unreadable.add(userId);
        this.log.error(
          `The second factor of user "${userId}" cannot be opened with the instance secret key: their codes are refused until it is reset.`,
        );
      }
      throw new ConflictError(
        'second-factor-unavailable',
        'The stored secret cannot be opened; use a recovery code, or ask an administrator to reset two-factor sign-in.',
      );
    }
  }

  private refuseWithoutKey(): void {
    if (this.available) return;
    throw new ConflictError(
      'second-factor-unavailable',
      'Two-factor sign-in needs the instance secret key, which this server has none of.',
    );
  }
}

function alreadyOn(): ConflictError {
  return new ConflictError(
    'second-factor-on',
    'Two-factor sign-in is on already.',
  );
}
