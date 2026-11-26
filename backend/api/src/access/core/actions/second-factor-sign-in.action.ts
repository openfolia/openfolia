import { Injectable } from '@nestjs/common';
import { AuditLog } from '../../../audit/core/audit-log.js';
import {
  BOUNDED,
  type Transaction,
  UnitOfWork,
} from '../../../base/core/unit-of-work.js';
import { AccessAdmin } from '../access-admin.js';
import type { Actor } from '../actor.js';
import {
  hashPendingSignIn,
  PENDING_SIGN_IN_PATTERN,
  type PendingSignIn,
  PendingSignIns,
  type SecondStep,
} from '../pending-sign-ins.js';
import type { UnguardedAction } from '../policy.js';
import { SecondFactorCodes, type SetUpBegun } from '../second-factor-codes.js';
import { SessionPolicy } from '../session-policy.js';
import { heldBefore, SessionStart } from '../session-start.js';
import type { User } from '../user-directory.js';
import { WaysIn } from '../ways-in.js';

/** Why an open second step gave nothing. */
export type SecondStepRefusal =
  /** None open in this browser: never begun, run out, used, or ended by a change of the account. */
  | 'second-step-expired'
  /** Not the app's code of now, or used before; not a recovery code (any more). */
  | 'wrong-code'
  /** Deactivated since the first factor. */
  | 'user-deactivated'
  /** The session policy refuses this way of signing in for them. */
  | 'sign-in-not-allowed';

export type SecondStepRefused = { readonly refused: SecondStepRefusal };

/** Thrown inside the transaction to roll it back; answered as a refusal. */
class Refusal extends Error {
  constructor(readonly reason: SecondStepRefusal) {
    super(reason);
  }
}

/**
 * The sign-in whose second step is open in this browser (#611), checked and finished in one
 * transaction: the token is the browser's cookie, its person is held, active and still allowed
 * in, and the step is used up with the session it starts. A refusal leaves it as it was.
 */
@Injectable()
export class SecondSteps {
  constructor(
    private readonly pending: PendingSignIns,
    private readonly admin: AccessAdmin,
    private readonly sessionPolicy: SessionPolicy,
    private readonly waysIn: WaysIn,
    private readonly start: SessionStart,
    private readonly auditLog: AuditLog,
    private readonly unit: UnitOfWork,
  ) {}

  /** Runs `work` on the open step of `token` (`step` only, when given), or says why not. */
  async run<T>(
    input: {
      readonly token: string | undefined;
      readonly now: number;
      readonly step?: SecondStep;
    },
    work: (
      tx: Transaction,
      open: PendingSignIn,
      user: User,
    ) => Promise<T | 'wrong-code'>,
  ): Promise<T | SecondStepRefused> {
    const { token, now } = input;
    if (token === undefined || !PENDING_SIGN_IN_PATTERN.test(token)) {
      return { refused: 'second-step-expired' };
    }
    const hash = hashPendingSignIn(token);
    try {
      return await this.unit.run(async (tx) => {
        const found = await this.pending.find(hash, tx);
        if (!found) throw new Refusal('second-step-expired');
        // The person before what is theirs, as every change of their ways in takes them; then
        // the step again: one ended meanwhile is gone.
        await this.waysIn.holdPerson(tx, found.userId);
        const open = await this.pending.find(hash, tx);
        if (
          !open ||
          open.expiresAt.getTime() <= now ||
          (input.step !== undefined && open.step !== input.step)
        ) {
          throw new Refusal('second-step-expired');
        }
        const user = await this.admin.findUser(tx, open.userId);
        if (!user) throw new Refusal('second-step-expired');
        if (user.deactivatedAt !== null) throw new Refusal('user-deactivated');
        if (!(await this.sessionPolicy.maySignIn(user.id, open.provider, tx))) {
          throw new Refusal('sign-in-not-allowed');
        }
        const done = await work(tx, open, user);
        if (done === 'wrong-code') throw new Refusal('wrong-code');
        return done;
      }, BOUNDED);
    } catch (error) {
      if (error instanceof Refusal) return { refused: error.reason };
      throw error;
    }
  }

  /** Uses up the step: a second use, or two at once, finds none. */
  async take(tx: Transaction, open: PendingSignIn, now: number): Promise<void> {
    if (!(await this.pending.take(tx, open.hash, new Date(now)))) {
      throw new Refusal('second-step-expired');
    }
  }

  /** Starts the session, the step taken, and records the sign-in: never a code or a token. */
  async finish(
    tx: Transaction,
    open: PendingSignIn,
    secondFactor: 'totp' | 'recovery-code' | 'set-up',
    previousToken: string | undefined,
    now: number,
  ): Promise<string> {
    const token = await this.start.finish(tx, {
      userId: open.userId,
      provider: open.provider,
      // The step itself is used up (`take`).
      held: heldBefore({ previousToken }),
      now,
    });
    const self: Actor = { kind: 'user', id: open.userId, roles: [] };
    await this.auditLog.record(tx, self, {
      action: 'user.sign-in',
      subject: { type: 'user', id: open.userId },
      data: {
        method: open.provider,
        provider: open.provider,
        ...(open.via !== null && { via: open.via }),
        secondFactor,
      },
    });
    return token;
  }
}

/** What the open second step of this browser is (#611), for the page that takes it. */
@Injectable()
export class ReadSecondStepAction implements UnguardedAction {
  readonly policy = 'public';
  now: () => number = Date.now;

  constructor(private readonly steps: SecondSteps) {}

  handle(input: { readonly token: string | undefined }): Promise<
    | {
        readonly userId: string;
        readonly step: SecondStep;
        readonly email: string | null;
        readonly expiresAt: Date;
      }
    | SecondStepRefused
  > {
    return this.steps.run(
      { token: input.token, now: this.now() },
      async (_tx, open, user) => ({
        userId: open.userId,
        step: open.step,
        email: user.email,
        expiresAt: open.expiresAt,
      }),
    );
  }
}

/**
 * Takes the second step with a code of the person's app, or one of their recovery codes (#611),
 * and starts the session. A code counts once; a wrong one leaves the step open, for as many
 * tries as the lockout allows (the caller counts them, per person, before this). Recorded as
 * `user.sign-in` (`data.secondFactor` `totp` or `recovery-code`).
 */
@Injectable()
export class VerifySecondStepAction implements UnguardedAction {
  readonly policy = 'public';
  now: () => number = Date.now;

  constructor(
    private readonly steps: SecondSteps,
    private readonly codes: SecondFactorCodes,
  ) {}

  handle(input: {
    readonly token: string | undefined;
    readonly code: string;
    /** The session the browser held before, if any: ended. */
    readonly previousToken?: string | undefined;
  }): Promise<
    { readonly userId: string; readonly token: string } | SecondStepRefused
  > {
    const now = this.now();
    return this.steps.run(
      { token: input.token, now, step: 'verify' },
      async (tx, open) => {
        const used = await this.codes.use(tx, open.userId, input.code, now);
        if (used === undefined) return 'wrong-code';
        await this.steps.take(tx, open, now);
        return {
          userId: open.userId,
          token: await this.steps.finish(
            tx,
            open,
            used,
            input.previousToken,
            now,
          ),
        };
      },
    );
  }
}

/** Begins the set-up a required second factor asks for, before any session (#611). */
@Injectable()
export class BeginRequiredSetUpAction implements UnguardedAction {
  readonly policy = 'public';
  now: () => number = Date.now;

  constructor(
    private readonly steps: SecondSteps,
    private readonly codes: SecondFactorCodes,
  ) {}

  handle(input: {
    readonly token: string | undefined;
  }): Promise<SetUpBegun | SecondStepRefused> {
    const now = this.now();
    return this.steps.run(
      { token: input.token, now, step: 'set-up' },
      (tx, _open, user) => this.codes.begin(tx, user, now),
    );
  }
}

/**
 * Confirms the set-up a required second factor asks for (#611): turns it on, ends the person's
 * sessions (none had a second factor) and starts this one. Answers the recovery codes, once.
 */
@Injectable()
export class ConfirmRequiredSetUpAction implements UnguardedAction {
  readonly policy = 'public';
  now: () => number = Date.now;

  constructor(
    private readonly steps: SecondSteps,
    private readonly codes: SecondFactorCodes,
  ) {}

  handle(input: {
    readonly token: string | undefined;
    readonly code: string;
    readonly previousToken?: string | undefined;
  }): Promise<
    | {
        readonly userId: string;
        readonly token: string;
        readonly recoveryCodes: readonly string[];
      }
    | SecondStepRefused
  > {
    const now = this.now();
    return this.steps.run(
      { token: input.token, now, step: 'set-up' },
      async (tx, open) => {
        // Before the others end with the factor turned on; back again with a wrong code.
        await this.steps.take(tx, open, now);
        const self: Actor = { kind: 'user', id: open.userId, roles: [] };
        const confirmed = await this.codes.confirm(tx, self, input.code, now);
        if (!confirmed) return 'wrong-code';
        return {
          userId: open.userId,
          token: await this.steps.finish(
            tx,
            open,
            'set-up',
            input.previousToken,
            now,
          ),
          recoveryCodes: confirmed.recoveryCodes,
        };
      },
    );
  }
}
