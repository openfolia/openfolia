import { Injectable } from '@nestjs/common';
import { AuditLog } from '../../../audit/core/audit-log.js';
import { ConflictError, ForbiddenError } from '../../../base/core/errors.js';
import { UnitOfWork } from '../../../base/core/unit-of-work.js';
import { AccessAdmin } from '../access-admin.js';
import { type Actor, UserEmail } from '../actor.js';
import { beginSession } from '../begin-session.js';
import {
  checkNewPassword,
  PASSWORD_PROVIDER,
  PasswordHasher,
  PasswordSignIn,
  PasswordStore,
} from '../passwords.js';
import { ActorAction, type UnguardedAction } from '../policy.js';
import { SessionPolicy } from '../session-policy.js';
import { SessionStore } from '../sessions.js';
import { WaysIn } from '../ways-in.js';

/** Why a password sign-in gave no session. */
export type PasswordRefusal =
  /** Unknown address, no password, or the wrong one: the same answer for each. */
  | 'invalid-credentials'
  /** The right password, but the user is deactivated. */
  | 'user-deactivated'
  /** The right password, but the session policy refuses password sign-in for them. */
  | 'sign-in-not-allowed';

export type PasswordSignInOutcome =
  | {
      readonly userId: string;
      /** The new session's token, for the cookie; never stored or logged. */
      readonly token: string;
    }
  | { readonly refused: PasswordRefusal };

/**
 * Signs in with an email address and a password (#610), into the same sessions as a provider's
 * sign-in (#37), begun with the provider `password`.
 *
 * An unknown address, a user without a password and a wrong password all answer
 * `invalid-credentials`, and take the same time: an address with no password is checked
 * against a dummy hash (`PasswordHasher.verifyNothing`). Only the right password learns that
 * the user is deactivated (`user-deactivated`) or that the session policy refuses them
 * (`sign-in-not-allowed`). A hash made with older parameters is replaced by one with the
 * current ones (`needsRehash`). The browser's previous session ends. Recorded as
 * `user.sign-in` (`data.method` `password`); the password, its hash and the token never are.
 * Failed attempts are counted by the caller (`FailedAuthentications`, `PasswordAttempts`), which refuses before
 * this runs past the limit. 409 `password-sign-in-off` when it is off.
 */
@Injectable()
export class PasswordSignInAction implements UnguardedAction {
  /** Run before anyone is acting: it is how someone comes to act. */
  readonly policy = 'public';
  now: () => number = Date.now;

  constructor(
    private readonly settings: PasswordSignIn,
    private readonly passwords: PasswordStore,
    private readonly hasher: PasswordHasher,
    private readonly sessions: SessionStore,
    private readonly sessionPolicy: SessionPolicy,
    private readonly auditLog: AuditLog,
    private readonly unit: UnitOfWork,
  ) {}

  async handle(input: {
    readonly email: string;
    readonly password: string;
    /** The session the browser held before, if any: ended. */
    readonly previousToken?: string | undefined;
  }): Promise<PasswordSignInOutcome> {
    if (!this.settings.enabled) {
      throw new ConflictError(
        'password-sign-in-off',
        'Signing in with a password is off on this server.',
      );
    }
    const email = input.email.trim();
    const found = UserEmail.safeParse(email).success
      ? await this.passwords.findByEmail(email)
      : undefined;
    if (!found) {
      await this.hasher.verifyNothing(input.password);
      return { refused: 'invalid-credentials' };
    }
    if (!(await this.hasher.verify(found.hash, input.password))) {
      return { refused: 'invalid-credentials' };
    }
    if (found.deactivatedAt !== null) return { refused: 'user-deactivated' };
    if (
      !(await this.sessionPolicy.maySignIn(found.userId, PASSWORD_PROVIDER))
    ) {
      return { refused: 'sign-in-not-allowed' };
    }
    const rehash = this.hasher.needsRehash(found.hash)
      ? await this.hasher.hash(input.password)
      : undefined;
    const token = await this.unit.run(async (tx) => {
      if (rehash !== undefined) {
        // Only over the hash just checked: a password changed meanwhile stays.
        await this.passwords.replaceIf(tx, found.userId, found.hash, rehash);
      }
      const token = await beginSession(
        { sessions: this.sessions, policy: this.sessionPolicy },
        tx,
        {
          userId: found.userId,
          provider: PASSWORD_PROVIDER,
          previousToken: input.previousToken,
          now: this.now(),
        },
      );
      await this.auditLog.record(
        tx,
        { kind: 'user', id: found.userId, roles: [] },
        {
          action: 'user.sign-in',
          subject: { type: 'user', id: found.userId },
          data: {
            method: 'password',
            provider: PASSWORD_PROVIDER,
            rehashed: rehash !== undefined,
          },
        },
      );
      return token;
    });
    return { userId: found.userId, token };
  }
}

export type ChangePasswordOutcome =
  { readonly sessionsEnded: number } | { readonly refused: 'wrong-password' };

/**
 * Changes the acting person's own password (#610, the account menu's "Change password"):
 * checks the current one first (`wrong-password`, counted by the caller as a failed
 * authentication), then the new one's rules (422 `password-too-short`, `password-too-long`,
 * `password-too-common`). Every other session of theirs ends (the request's own, `sessionHash`,
 * goes on), and an open reset link and an open code by email go too (`WaysIn`). Recorded as
 * `user.password-changed` (`data.sessionsEnded`). 409 `no-password` for someone without one
 * (who signs in with a provider), `password-sign-in-off` when it is off; 403 for a service
 * account.
 */
@Injectable()
export class ChangePasswordAction extends ActorAction<
  {
    actor: Actor;
    currentPassword: string;
    newPassword: string;
    /** The hash of the session the request acts through, if any: it stays. */
    sessionHash?: string | undefined;
  },
  ChangePasswordOutcome
> {
  readonly policy = 'any-actor';

  constructor(
    private readonly settings: PasswordSignIn,
    private readonly passwords: PasswordStore,
    private readonly hasher: PasswordHasher,
    private readonly admin: AccessAdmin,
    private readonly waysIn: WaysIn,
    private readonly auditLog: AuditLog,
    private readonly unit: UnitOfWork,
  ) {
    super();
  }

  protected async run({
    actor,
    currentPassword,
    newPassword,
    sessionHash,
  }: {
    actor: Actor;
    currentPassword: string;
    newPassword: string;
    sessionHash?: string | undefined;
  }): Promise<ChangePasswordOutcome> {
    if (!this.settings.enabled) {
      throw new ConflictError(
        'password-sign-in-off',
        'Signing in with a password is off on this server.',
      );
    }
    if (actor.kind !== 'user') {
      throw new ForbiddenError('Only a person has a password.');
    }
    const stored = await this.passwords.hashOf(actor.id);
    if (stored === undefined) {
      throw new ConflictError(
        'no-password',
        'You have no password here: you sign in with your identity provider.',
      );
    }
    if (!(await this.hasher.verify(stored, currentPassword))) {
      return { refused: 'wrong-password' };
    }
    const user = await this.unit.run((tx) => this.admin.findUser(tx, actor.id));
    checkNewPassword(newPassword, { email: user?.email ?? null });
    const hash = await this.hasher.hash(newPassword);
    return this.unit.run(async (tx): Promise<ChangePasswordOutcome> => {
      // The person before their password (#650), as setting one through a link takes them.
      await this.waysIn.holdPerson(tx, actor.id);
      // Only over the password just checked: one set through a link meanwhile is kept, and
      // the current password given is no longer it.
      if (!(await this.passwords.replaceIf(tx, actor.id, stored, hash))) {
        return { refused: 'wrong-password' };
      }
      await this.passwords.set(tx, actor.id, hash);
      const sessionsEnded = await this.waysIn.endAll(tx, actor.id, sessionHash);
      await this.auditLog.record(tx, actor, {
        action: 'user.password-changed',
        subject: { type: 'user', id: actor.id },
        data: { sessionsEnded },
      });
      return { sessionsEnded };
    });
  }
}
