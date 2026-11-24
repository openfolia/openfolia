import { Injectable } from '@nestjs/common';
import { AuditLog } from '../../../audit/core/audit-log.js';
import {
  ConflictError,
  NotFoundError,
  UnprocessableError,
} from '../../../base/core/errors.js';
import {
  type Transaction,
  UnitOfWork,
} from '../../../base/core/unit-of-work.js';
import { MailOutbox } from '../../../mail/core/mail-outbox.js';
import { AccessAdmin } from '../access-admin.js';
import { beginAccessChange } from '../access-changes.js';
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
import {
  hashSignInLinkToken,
  mintSignInLinkToken,
  RESET_LINK_MS,
  RESET_REQUEST_INTERVAL_MS,
  SIGN_IN_LINK_PATTERN,
  type SignInLinkKind,
  SignInLinks,
  signInLinkUrl,
} from '../sign-in-links.js';
import { UserIdentities } from '../user-identities.js';
import { WaysIn } from '../ways-in.js';
import { Sandbox } from '../../../sandbox/core/sandbox.js';

/** Who records what nobody signed in asked for ("Forgot password"): outside `UserId`'s format. */
export const SIGN_IN_ACTOR: Actor = Object.freeze({
  kind: 'service',
  id: 'service:sign-in',
  roles: Object.freeze([]),
}) as Actor;

function refuseWhenOff(settings: PasswordSignIn): void {
  if (!settings.enabled) {
    throw new ConflictError(
      'password-sign-in-off',
      'Signing in with a password is off on this server.',
    );
  }
}

/** A link just made: shown once (`Cache-Control: no-store`), never stored or logged. */
export interface MadeSignInLink {
  readonly token: string;
  /** `<base>set-password#<token>`; null when the server knows no editor address. */
  readonly url: string | null;
  readonly expiresAt: Date;
  /** Whether it was emailed to the person too. */
  readonly emailed: boolean;
}

/**
 * Makes a one-time link for a person to set their password (#610), for an admin
 * (`admin.roles`): an `invite` (valid `CCMS_INVITE_DAYS`, by default 7 days) or a `reset`
 * (1 hour). Removes the person's earlier link, so a new one revokes it. Answered once, to copy;
 * also emailed to the person's address when email can carry links (`MailOutbox.linksEnabled`),
 * in the transaction that makes it. Recorded as `user.invite` or
 * `user.password-reset-requested` (`data.via` `admin`), with `emailed` and `replaced`: IDs only,
 * never the link or its hash. 404 for no such user; 409 `user-deactivated`,
 * `password-sign-in-off`. Under the access lock, the admin checked again
 * (`beginAccessChange`).
 */
@Injectable()
export class CreateSignInLinkAction extends ActorAction<
  { actor: Actor; userId: string; kind: SignInLinkKind },
  MadeSignInLink
> {
  readonly policy = 'admin.roles';
  now: () => number = Date.now;

  constructor(
    private readonly settings: PasswordSignIn,
    private readonly admin: AccessAdmin,
    private readonly links: SignInLinks,
    private readonly mail: MailOutbox,
    private readonly auditLog: AuditLog,
    private readonly unit: UnitOfWork,
    private readonly sandbox: Sandbox = Sandbox.OFF,
  ) {
    super();
  }

  protected async run({
    actor,
    userId,
    kind,
  }: {
    actor: Actor;
    userId: string;
    kind: SignInLinkKind;
  }): Promise<MadeSignInLink> {
    this.sandbox.refuse('invitations');
    refuseWhenOff(this.settings);
    return this.unit.run(async (tx) => {
      await beginAccessChange(this.admin, tx, actor);
      const user = await this.admin.findUser(tx, userId);
      if (!user) throw new NotFoundError(`No user "${userId}".`);
      if (user.deactivatedAt !== null) {
        throw new ConflictError(
          'user-deactivated',
          'This user is deactivated: reactivate them first.',
        );
      }
      if (user.email === null) {
        // One signs in with the address and the password: without one, a password is useless.
        throw new UnprocessableError(
          'no-email-address',
          'This user has no email address to sign in with: add one first.',
        );
      }
      const made = await makeLink({ links: this.links, mail: this.mail }, tx, {
        userId,
        email: user.email,
        name: user.name,
        kind,
        now: this.now(),
        inviteMs: this.settings.inviteMs,
      });
      await this.auditLog.record(tx, actor, {
        action:
          kind === 'invite' ? 'user.invite' : 'user.password-reset-requested',
        subject: { type: 'user', id: userId },
        data: {
          ...(kind === 'reset' && { via: 'admin' }),
          emailed: made.emailed,
          replaced: made.replaced,
          expiresAt: made.expiresAt.toISOString(),
        },
      });
      return {
        token: made.token,
        url:
          this.settings.linkBase === null
            ? null
            : signInLinkUrl(this.settings.linkBase, made.token),
        expiresAt: made.expiresAt,
        emailed: made.emailed,
      };
    });
  }
}

/** Makes and stores a link (revoking the earlier one), and emails it when email can. */
async function makeLink(
  deps: { readonly links: SignInLinks; readonly mail: MailOutbox },
  tx: Transaction,
  link: {
    readonly userId: string;
    readonly email: string | null;
    readonly name: string;
    readonly kind: SignInLinkKind;
    readonly now: number;
    readonly inviteMs: number;
  },
): Promise<{
  token: string;
  expiresAt: Date;
  emailed: boolean;
  replaced: number;
}> {
  const minted = mintSignInLinkToken();
  const lifetime = link.kind === 'invite' ? link.inviteMs : RESET_LINK_MS;
  const expiresAt = new Date(link.now + lifetime);
  const replaced = await deps.links.replace(tx, {
    hash: minted.hash,
    userId: link.userId,
    kind: link.kind,
    expiresAt,
  });
  let emailed = false;
  if (deps.mail.linksEnabled && link.email !== null) {
    const queued =
      link.kind === 'invite'
        ? await deps.mail.queue(tx, {
            to: { address: link.email, name: link.name },
            template: 'invite',
            params: {
              token: minted.token,
              days: Math.max(1, Math.round(lifetime / 86_400_000)),
            },
          })
        : await deps.mail.queue(tx, {
            to: { address: link.email, name: link.name },
            template: 'password-reset',
            params: { token: minted.token },
          });
    emailed = queued !== null;
  }
  return { token: minted.token, expiresAt, emailed, replaced };
}

/**
 * Withdraws a person's open invite (#610), for an admin (`admin.roles`): the link stops
 * working. Recorded as `user.invite-withdraw`. 404 when the user has none (or does not exist).
 */
@Injectable()
export class WithdrawInviteAction extends ActorAction<
  { actor: Actor; userId: string },
  void
> {
  readonly policy = 'admin.roles';

  constructor(
    private readonly admin: AccessAdmin,
    private readonly links: SignInLinks,
    private readonly auditLog: AuditLog,
    private readonly unit: UnitOfWork,
  ) {
    super();
  }

  protected async run({
    actor,
    userId,
  }: {
    actor: Actor;
    userId: string;
  }): Promise<void> {
    await this.unit.run(async (tx) => {
      await beginAccessChange(this.admin, tx, actor);
      if (!(await this.admin.findUser(tx, userId))) {
        throw new NotFoundError(`No user "${userId}".`);
      }
      if ((await this.links.revokeAll(tx, userId, 'invite')) === 0) {
        throw new NotFoundError(`The user "${userId}" has no open invite.`);
      }
      await this.auditLog.record(tx, actor, {
        action: 'user.invite-withdraw',
        subject: { type: 'user', id: userId },
      });
    });
  }
}

/** Why a link opens nothing. */
export type LinkRefusal =
  /** Malformed, unknown, used, revoked, or its user deactivated. */
  | 'link-invalid'
  /** Past its time. */
  | 'link-expired';

/** What the page a link opens shows. */
export interface OpenedSignInLink {
  readonly kind: SignInLinkKind;
  readonly name: string;
  readonly email: string | null;
  readonly expiresAt: Date;
}

/**
 * What a link is for and whose it is (#610), for the page it opens: anyone holding the link may
 * ask (it is the link's own secret). 256 random bits: nothing to guess, so nothing is counted.
 */
@Injectable()
export class ReadSignInLinkAction implements UnguardedAction {
  readonly policy = 'public';
  now: () => number = Date.now;

  constructor(
    private readonly settings: PasswordSignIn,
    private readonly links: SignInLinks,
    private readonly admin: AccessAdmin,
    private readonly unit: UnitOfWork,
  ) {}

  async handle({
    token,
  }: {
    token: string;
  }): Promise<OpenedSignInLink | { refused: LinkRefusal }> {
    refuseWhenOff(this.settings);
    if (!SIGN_IN_LINK_PATTERN.test(token)) return { refused: 'link-invalid' };
    const link = await this.links.find(hashSignInLinkToken(token));
    if (!link) return { refused: 'link-invalid' };
    if (link.expiresAt.getTime() <= this.now()) {
      return { refused: 'link-expired' };
    }
    const user = await this.unit.run((tx) =>
      this.admin.findUser(tx, link.userId),
    );
    if (!user || user.deactivatedAt !== null) {
      return { refused: 'link-invalid' };
    }
    return {
      kind: link.kind,
      name: user.name,
      email: user.email,
      expiresAt: link.expiresAt,
    };
  }
}

/**
 * Sets a password through a one-time link (#610), an invite or a reset, and signs the person
 * in. The new password's rules are checked before the link is used (422 leaves it working).
 * In one transaction: the link is removed (a second use, or two at once, finds none), the
 * password set, **every session of the person ends** (and every other link and an open code by
 * email, `WaysIn`), a new one starts for this browser, and
 * `user.password-set` (`data.via` the link's kind, `sessionsEnded`) and `user.sign-in`
 * (`data.method` `password`) are recorded.
 */
@Injectable()
export class SetPasswordWithLinkAction implements UnguardedAction {
  readonly policy = 'public';
  now: () => number = Date.now;

  constructor(
    private readonly settings: PasswordSignIn,
    private readonly links: SignInLinks,
    private readonly admin: AccessAdmin,
    private readonly passwords: PasswordStore,
    private readonly hasher: PasswordHasher,
    private readonly sessions: SessionStore,
    private readonly sessionPolicy: SessionPolicy,
    private readonly waysIn: WaysIn,
    private readonly auditLog: AuditLog,
    private readonly unit: UnitOfWork,
  ) {}

  async handle(input: {
    readonly token: string;
    readonly password: string;
    readonly previousToken?: string | undefined;
  }): Promise<
    | { readonly userId: string; readonly token: string }
    | { readonly refused: LinkRefusal | 'sign-in-not-allowed' }
  > {
    refuseWhenOff(this.settings);
    if (!SIGN_IN_LINK_PATTERN.test(input.token)) {
      return { refused: 'link-invalid' };
    }
    const hash = hashSignInLinkToken(input.token);
    const link = await this.links.find(hash);
    if (!link) return { refused: 'link-invalid' };
    if (link.expiresAt.getTime() <= this.now()) {
      return { refused: 'link-expired' };
    }
    const user = await this.unit.run((tx) =>
      this.admin.findUser(tx, link.userId),
    );
    if (!user || user.deactivatedAt !== null) {
      return { refused: 'link-invalid' };
    }
    checkNewPassword(input.password, { email: user.email });
    if (!(await this.sessionPolicy.maySignIn(user.id, PASSWORD_PROVIDER))) {
      return { refused: 'sign-in-not-allowed' };
    }
    const passwordHash = await this.hasher.hash(input.password);
    try {
      return await this.unit.run(async (tx) => {
        // The person before their link (#650), as every change that ends ways in takes them.
        await this.waysIn.holdPerson(tx, link.userId);
        const taken = await this.links.take(tx, hash);
        const current = await this.admin.findUser(tx, link.userId);
        if (
          !taken ||
          taken.userId !== link.userId ||
          taken.expiresAt.getTime() <= this.now() ||
          !current ||
          current.deactivatedAt !== null
        ) {
          throw new LinkGone();
        }
        await this.passwords.set(tx, taken.userId, passwordHash);
        // Every session, link and open code by email (#645), before this browser's session.
        const sessionsEnded = await this.waysIn.endAll(tx, taken.userId);
        const token = await beginSession(
          { sessions: this.sessions, policy: this.sessionPolicy },
          tx,
          {
            userId: taken.userId,
            provider: PASSWORD_PROVIDER,
            previousToken: input.previousToken,
            now: this.now(),
          },
        );
        const self: Actor = { kind: 'user', id: taken.userId, roles: [] };
        await this.auditLog.record(tx, self, {
          action: 'user.password-set',
          subject: { type: 'user', id: taken.userId },
          data: { via: taken.kind, sessionsEnded },
        });
        await this.auditLog.record(tx, self, {
          action: 'user.sign-in',
          subject: { type: 'user', id: taken.userId },
          data: { method: 'password', provider: PASSWORD_PROVIDER },
        });
        return { userId: taken.userId, token };
      });
    } catch (error) {
      if (error instanceof LinkGone) return { refused: 'link-invalid' };
      throw error;
    }
  }
}

/** Thrown inside the transaction to roll it back: the link went meanwhile. */
class LinkGone extends Error {}

/**
 * "Forgot password" (#610): when an active user with a password has the address `email`
 * (ignoring case), makes a reset link (1 hour, revoking their earlier link) and emails it; otherwise does
 * nothing. Answers nothing either way, so it never says whether an account exists; the caller
 * answers at once and runs this after, so the time does not tell either. At most one reset
 * link per person per minute (`RESET_REQUEST_INTERVAL_MS`): more asks send nothing more.
 * Recorded as `user.password-reset-requested` (`data.via` `email`) by `service:sign-in`.
 * Does nothing while email cannot carry links. Never for someone without a password (invited,
 * or signing in with a provider only): an email alone does not give an account a password, an
 * admin's invite does, so an open invite is never replaced from here either.
 */
@Injectable()
export class ForgotPasswordAction implements UnguardedAction {
  readonly policy = 'public';
  now: () => number = Date.now;

  constructor(
    private readonly settings: PasswordSignIn,
    private readonly identities: UserIdentities,
    private readonly admin: AccessAdmin,
    private readonly links: SignInLinks,
    private readonly passwords: PasswordStore,
    private readonly mail: MailOutbox,
    private readonly auditLog: AuditLog,
    private readonly unit: UnitOfWork,
  ) {}

  /** Whether "Forgot password" is offered: password sign-in on, and email carrying links. */
  get offered(): boolean {
    return this.settings.enabled && this.mail.linksEnabled;
  }

  async handle({ email }: { email: string }): Promise<void> {
    if (!this.offered) return;
    const address = email.trim();
    if (!UserEmail.safeParse(address).success) return;
    await this.unit.run(async (tx) => {
      // One at a time: two asks at once make one link, not a clash on the person's one link.
      await this.admin.lock(tx);
      const userId = await this.identities.userWithEmail(tx, address);
      if (userId === undefined) return;
      const user = await this.admin.findUser(tx, userId);
      if (!user || user.deactivatedAt !== null || user.email === null) return;
      if ((await this.passwords.hashOf(userId, tx)) === undefined) return;
      const earlier = await this.links.linkOf(tx, userId);
      if (
        earlier?.kind === 'reset' &&
        this.now() - earlier.createdAt.getTime() < RESET_REQUEST_INTERVAL_MS
      ) {
        return;
      }
      const made = await makeLink({ links: this.links, mail: this.mail }, tx, {
        userId,
        email: user.email,
        name: user.name,
        kind: 'reset',
        now: this.now(),
        inviteMs: this.settings.inviteMs,
      });
      await this.auditLog.record(tx, SIGN_IN_ACTOR, {
        action: 'user.password-reset-requested',
        subject: { type: 'user', id: userId },
        data: {
          via: 'email',
          emailed: made.emailed,
          replaced: made.replaced,
          expiresAt: made.expiresAt.toISOString(),
        },
      });
    });
  }
}
