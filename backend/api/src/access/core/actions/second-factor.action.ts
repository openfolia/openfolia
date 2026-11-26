import { Injectable } from '@nestjs/common';
import { AuditLog } from '../../../audit/core/audit-log.js';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from '../../../base/core/errors.js';
import {
  BOUNDED,
  runContended,
  type Transaction,
  UnitOfWork,
} from '../../../base/core/unit-of-work.js';
import { AccessAdmin } from '../access-admin.js';
import { beginAccessChange } from '../access-changes.js';
import type { Actor } from '../actor.js';
import { PasswordHasher, PasswordSignIn, PasswordStore } from '../passwords.js';
import { ActorAction } from '../policy.js';
import { SecondFactorCodes, type SetUpBegun } from '../second-factor-codes.js';
import { coveredBySecondFactor, SecondFactors } from '../second-factors.js';
import { SessionStart } from '../session-start.js';
import { WaysIn } from '../ways-in.js';

/** The acting person and how their session began (undefined: none, a token). */
interface OwnInput {
  readonly actor: Actor;
  readonly provider: string | undefined;
}

/** Who proves again that they are the person: their password, or a current code of their app. */
export interface Proof {
  readonly password?: string | undefined;
  /** A code of the app, or a recovery code. */
  readonly code?: string | undefined;
}

export type ProofRefused = {
  readonly refused: 'wrong-password' | 'wrong-code';
};

/** Thrown inside the transaction to roll it back; answered as a refusal. */
class Refused extends Error {
  constructor(readonly reason: ProofRefused['refused']) {
    super(reason);
  }
}

/**
 * Only for a person whose session began here (a password, a code by email): 403 for a service
 * account, 409 `second-factor-not-applicable` for a provider's session, the shared token or demo
 * mode.
 */
function ownFactor({ actor, provider }: OwnInput): void {
  if (actor.kind !== 'user') {
    throw new ForbiddenError('Only a person signs in with a second factor.');
  }
  if (!coveredBySecondFactor(provider)) {
    throw new ConflictError(
      'second-factor-not-applicable',
      'Two-factor sign-in is for people who sign in here with a password or a code by email; a single sign-on provider has its own.',
    );
  }
}

/**
 * The password a person proves themselves with (#611): none while password sign-in is off, as
 * one that signs nobody in (and cannot be reset) neither proves nor is asked for.
 */
@Injectable()
export class OwnPassword {
  constructor(
    private readonly settings: PasswordSignIn,
    private readonly passwords: PasswordStore,
    private readonly hasher: PasswordHasher,
  ) {}

  /** Its hash, read in `tx` when given; undefined for none. */
  async hashOf(userId: string, tx?: Transaction): Promise<string | undefined> {
    return this.settings.enabled
      ? this.passwords.hashOf(userId, tx)
      : undefined;
  }

  verify(hash: string, password: string): Promise<boolean> {
    return this.hasher.verify(hash, password);
  }
}

/** A person's second factor, as they see it themselves. */
export interface OwnSecondFactor {
  readonly on: boolean;
  readonly since: Date | null;
  readonly recoveryCodesLeft: number;
  /** The installation requires it of them. */
  readonly required: boolean;
  /** It can be set up: there is a secret key. */
  readonly available: boolean;
  /** They have a password to prove themselves with. */
  readonly hasPassword: boolean;
}

/** The acting person's own second factor (#611): never its secret or a code. */
@Injectable()
export class GetSecondFactorAction extends ActorAction<
  OwnInput,
  OwnSecondFactor
> {
  readonly policy = 'any-actor';

  constructor(
    private readonly factors: SecondFactors,
    private readonly codes: SecondFactorCodes,
    private readonly password: OwnPassword,
    private readonly start: SessionStart,
    private readonly unit: UnitOfWork,
  ) {
    super();
  }

  protected run(input: OwnInput): Promise<OwnSecondFactor> {
    ownFactor(input);
    const userId = input.actor.id;
    return this.unit.run(async (tx) => {
      const factor = await this.factors.find(userId, tx);
      const since = factor?.confirmedAt ?? null;
      return {
        on: since !== null,
        since,
        recoveryCodesLeft: since === null ? 0 : factor!.recoveryCodesLeft,
        required: await this.start.required(tx, userId),
        available: this.codes.available,
        hasPassword: (await this.password.hashOf(userId, tx)) !== undefined,
      };
    });
  }
}

/**
 * Begins setting up the acting person's second factor (#611): asks for the password again when
 * they have one, so a session left open cannot lock its person out with a stranger's app.
 * Answers the secret, once. 409 `second-factor-on`, `second-factor-unavailable`.
 */
@Injectable()
export class BeginSetUpAction extends ActorAction<
  OwnInput & { readonly password?: string | undefined },
  SetUpBegun | ProofRefused
> {
  readonly policy = 'any-actor';
  now: () => number = Date.now;

  constructor(
    private readonly codes: SecondFactorCodes,
    private readonly password: OwnPassword,
    private readonly admin: AccessAdmin,
    private readonly waysIn: WaysIn,
    private readonly unit: UnitOfWork,
  ) {
    super();
  }

  protected async run(
    input: OwnInput & { readonly password?: string | undefined },
  ): Promise<SetUpBegun | ProofRefused> {
    ownFactor(input);
    const userId = input.actor.id;
    const hash = await this.password.hashOf(userId);
    if (
      hash !== undefined &&
      !(
        input.password !== undefined &&
        (await this.password.verify(hash, input.password))
      )
    ) {
      return { refused: 'wrong-password' };
    }
    return this.unit.run(async (tx) => {
      await this.waysIn.holdPerson(tx, userId);
      // Changed (or first set) while it was checked: the one given is no longer it.
      if ((await this.password.hashOf(userId, tx)) !== hash) {
        return { refused: 'wrong-password' } as const;
      }
      const user = await this.admin.findUser(tx, userId);
      if (!user) throw new NotFoundError(`No user "${userId}".`);
      return this.codes.begin(tx, user, this.now());
    }, BOUNDED);
  }
}

/**
 * Turns on the acting person's second factor with a code of the app just set up (#611). Their
 * other sessions, begun without it, end; the request's own (`sessionHash`) goes on. Answers the
 * recovery codes, once. Recorded as `user.second-factor-on`.
 */
@Injectable()
export class ConfirmSetUpAction extends ActorAction<
  OwnInput & {
    readonly code: string;
    readonly sessionHash?: string | undefined;
  },
  | {
      readonly recoveryCodes: readonly string[];
      readonly sessionsEnded: number;
    }
  | ProofRefused
> {
  readonly policy = 'any-actor';
  now: () => number = Date.now;

  constructor(
    private readonly codes: SecondFactorCodes,
    private readonly waysIn: WaysIn,
    private readonly unit: UnitOfWork,
  ) {
    super();
  }

  protected async run(
    input: OwnInput & {
      readonly code: string;
      readonly sessionHash?: string | undefined;
    },
  ) {
    ownFactor(input);
    const confirmed = await this.unit.run(async (tx) => {
      await this.waysIn.holdPerson(tx, input.actor.id);
      return this.codes.confirm(
        tx,
        input.actor,
        input.code,
        this.now(),
        input.sessionHash,
      );
    }, BOUNDED);
    return confirmed ?? ({ refused: 'wrong-code' } as const);
  }
}

/** Runs a change of the person's own factor, once they proved again who they are. */
@Injectable()
export class ProvenChange {
  now: () => number = Date.now;

  constructor(
    private readonly factors: SecondFactors,
    private readonly codes: SecondFactorCodes,
    private readonly password: OwnPassword,
    private readonly waysIn: WaysIn,
    private readonly unit: UnitOfWork,
  ) {}

  /**
   * `work` in one transaction with the proof: a code is used up by it. 409 `second-factor-off`
   * when there is none on.
   */
  async run<T>(
    input: OwnInput & Proof,
    work: (tx: Transaction) => Promise<T>,
  ): Promise<T | ProofRefused> {
    ownFactor(input);
    const userId = input.actor.id;
    const byPassword = input.password !== undefined;
    let hash: string | undefined;
    if (input.password !== undefined) {
      hash = await this.password.hashOf(userId);
      if (
        hash === undefined ||
        !(await this.password.verify(hash, input.password))
      ) {
        return { refused: 'wrong-password' };
      }
    }
    try {
      return await this.unit.run(async (tx) => {
        await this.waysIn.holdPerson(tx, userId);
        if (byPassword && (await this.password.hashOf(userId, tx)) !== hash) {
          throw new Refused('wrong-password');
        }
        const factor = await this.factors.find(userId, tx);
        if (!factor || factor.confirmedAt === null) {
          throw new ConflictError(
            'second-factor-off',
            'Two-factor sign-in is off.',
          );
        }
        if (
          !byPassword &&
          (await this.codes.use(tx, userId, input.code ?? '', this.now())) ===
            undefined
        ) {
          throw new Refused('wrong-code');
        }
        return work(tx);
      }, BOUNDED);
    } catch (error) {
      if (error instanceof Refused) return { refused: error.reason };
      throw error;
    }
  }
}

/**
 * New recovery codes for the acting person (#611), the earlier ones gone: takes the password or
 * a current code again. Recorded as `user.second-factor-recovery-codes`, never a code.
 */
@Injectable()
export class NewRecoveryCodesAction extends ActorAction<
  OwnInput & Proof,
  { readonly recoveryCodes: readonly string[] } | ProofRefused
> {
  readonly policy = 'any-actor';

  constructor(
    private readonly change: ProvenChange,
    private readonly codes: SecondFactorCodes,
    private readonly auditLog: AuditLog,
  ) {
    super();
  }

  protected run(input: OwnInput & Proof) {
    return this.change.run(input, async (tx) => {
      const recoveryCodes = await this.codes.newRecoveryCodes(
        tx,
        input.actor.id,
      );
      await this.auditLog.record(tx, input.actor, {
        action: 'user.second-factor-recovery-codes',
        subject: { type: 'user', id: input.actor.id },
      });
      return { recoveryCodes };
    });
  }
}

/**
 * Turns off the acting person's second factor (#611): takes the password or a current code
 * again. Where the installation requires one, they set up a new one at their next sign-in.
 * Recorded as `user.second-factor-off`.
 */
@Injectable()
export class TurnOffSecondFactorAction extends ActorAction<
  OwnInput & Proof,
  { readonly off: true } | ProofRefused
> {
  readonly policy = 'any-actor';

  constructor(
    private readonly change: ProvenChange,
    private readonly factors: SecondFactors,
    private readonly waysIn: WaysIn,
    private readonly auditLog: AuditLog,
  ) {
    super();
  }

  protected run(input: OwnInput & Proof) {
    return this.change.run(input, async (tx) => {
      await this.factors.remove(tx, input.actor.id);
      await this.waysIn.endOpenSteps(tx, input.actor.id);
      await this.auditLog.record(tx, input.actor, {
        action: 'user.second-factor-off',
        subject: { type: 'user', id: input.actor.id },
      });
      return { off: true } as const;
    });
  }
}

/**
 * Removes another person's second factor, for an admin (`admin.roles`), when they lost their
 * phone and their recovery codes (#611): they sign in without it, and set up a new one at once
 * where the installation requires it. Never one's own (409 `second-factor-own`): that takes the
 * password or a code, in the account menu. 404 for no such user or none on. Recorded as
 * `user.second-factor-reset`.
 */
@Injectable()
export class ResetSecondFactorAction extends ActorAction<
  { readonly actor: Actor; readonly userId: string },
  void
> {
  readonly policy = 'admin.roles';

  constructor(
    private readonly admin: AccessAdmin,
    private readonly factors: SecondFactors,
    private readonly waysIn: WaysIn,
    private readonly auditLog: AuditLog,
    private readonly unit: UnitOfWork,
  ) {
    super();
  }

  protected run({
    actor,
    userId,
  }: {
    readonly actor: Actor;
    readonly userId: string;
  }): Promise<void> {
    if (actor.kind === 'user' && actor.id === userId) {
      throw new ConflictError(
        'second-factor-own',
        'Turn off your own second factor in the account menu, with your password or a code.',
      );
    }
    return runContended(
      this.unit,
      async (tx) => {
        await beginAccessChange(this.admin, tx, actor);
        if (!(await this.admin.findUser(tx, userId))) {
          throw new NotFoundError(`No user "${userId}".`);
        }
        await this.waysIn.holdPerson(tx, userId);
        if (!(await this.factors.remove(tx, userId))) {
          throw new NotFoundError(
            `The user "${userId}" has no second factor on.`,
          );
        }
        await this.waysIn.endOpenSteps(tx, userId);
        await this.auditLog.record(tx, actor, {
          action: 'user.second-factor-reset',
          subject: { type: 'user', id: userId },
        });
      },
      BOUNDED,
    );
  }
}
