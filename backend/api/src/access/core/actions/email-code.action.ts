import { timingSafeEqual } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { AuditLog } from '../../../audit/core/audit-log.js';
import { ConflictError } from '../../../base/core/errors.js';
import {
  type Transaction,
  UnitOfWork,
} from '../../../base/core/unit-of-work.js';
import { MailOutbox } from '../../../mail/core/mail-outbox.js';
import { AccessAdmin } from '../access-admin.js';
import { type Actor, UserEmail } from '../actor.js';
import {
  EMAIL_CODE_MAX_FAILURES,
  EMAIL_CODE_LINK_PATTERN,
  EMAIL_CODE_PROVIDER,
  EmailCodeHasher,
  EmailCodes,
  EmailCodeSignIn,
  hashEmailCodeLink,
  mintEmailCode,
  readEmailCode,
} from '../email-codes.js';
import {
  type PasswordAttempt,
  PasswordAttempts,
} from '../password-attempts.js';
import type { UnguardedAction } from '../policy.js';
import { SessionPolicy } from '../session-policy.js';
import {
  type BrowserTokens,
  heldBefore,
  SessionStart,
  type StartedSignIn,
} from '../session-start.js';
import { refuseWhenSingleSignOn } from '../single-sign-on.js';
import { SignInLinks } from '../sign-in-links.js';
import { UserIdentities } from '../user-identities.js';
import { SIGN_IN_ACTOR } from './sign-in-links.action.js';

/**
 * The budgets of codes by email in `PasswordAttempts` (#634), each its own key, apart from a
 * password's `sign-in:` and `reset:`: requests for a code and wrong codes never block each other,
 * a password sign-in or a reset. Keyed by the address in lowercase whether or not anyone has it,
 * so the lockout behaves the same for an unknown address and a known one.
 */
export const codeRequestKey = (email: string): string =>
  `code-request:account:${email.trim().toLowerCase()}`;
export const codeAttemptKey = (email: string): string =>
  `code-attempt:account:${email.trim().toLowerCase()}`;

/** Compared against when nobody has the address: the same work as for a real code. */
const NO_CODE_HASH = '0'.repeat(64);
const NO_USER = 'nobody';

/** Whether codes by email are offered now: on in the settings, email going out, a key to hash with. */
function offeredBy(deps: {
  readonly settings: EmailCodeSignIn;
  readonly mail: MailOutbox;
  readonly hasher: EmailCodeHasher;
}): boolean {
  return deps.settings.enabled && deps.mail.enabled && deps.hasher.available;
}

function refuseWhenOff(offered: boolean): void {
  if (!offered) {
    throw new ConflictError(
      'email-code-sign-in-off',
      'Signing in with a code by email is off on this server.',
    );
  }
}

/** Takes back a counted attempt; best effort, never the answer: a failure leaves one count too many. */
async function forgive(
  attempts: PasswordAttempts,
  attempt: PasswordAttempt,
): Promise<void> {
  await attempts.forgive(attempt).catch(() => undefined);
}

/**
 * "Email me a code" (#634): counts the request toward the address's `code-request:` budget
 * (`CCMS_PASSWORD_FAILURES_*`; past it, `retryAfter`, whether or not anyone has the address),
 * then answers at once with the work still `sending`, so neither the answer nor its time says
 * whether an account exists. The work: when an active user has the address (ignoring case),
 * makes a six-digit code and a link, valid `CCMS_EMAIL_CODE_MINUTES` (10), replacing their
 * earlier code, and emails both in the transaction that stores them (in `language`, the sign-in
 * page's, else the installation's). The code is bound to the address it goes to (#646): it works
 * only while that is still the person's. Anyone with an address may: with a password or without
 * one, invited or not (an open invite stays). Recorded as `user.email-code-requested` by
 * `service:sign-in`: IDs only, never the code or the link. 409 `email-code-sign-in-off` while it
 * is not offered.
 */
@Injectable()
export class RequestEmailCodeAction implements UnguardedAction {
  readonly policy = 'public';
  now: () => number = Date.now;

  constructor(
    private readonly settings: EmailCodeSignIn,
    private readonly hasher: EmailCodeHasher,
    private readonly codes: EmailCodes,
    private readonly attempts: PasswordAttempts,
    private readonly identities: UserIdentities,
    private readonly admin: AccessAdmin,
    private readonly mail: MailOutbox,
    private readonly auditLog: AuditLog,
    private readonly unit: UnitOfWork,
    private readonly sessionPolicy: SessionPolicy,
  ) {}

  /** Whether "Email me a code" is offered: on in the settings, and email going out. */
  get offered(): boolean {
    return offeredBy({
      settings: this.settings,
      mail: this.mail,
      hasher: this.hasher,
    });
  }

  async handle(input: {
    readonly email: string;
    readonly language?: string | undefined;
  }): Promise<
    { readonly retryAfter: number } | { readonly sending: Promise<void> }
  > {
    refuseWhenOff(this.offered);
    await refuseWhenSingleSignOn(this.sessionPolicy);
    const address = input.email.trim();
    const counted = await this.attempts.reserve(codeRequestKey(address));
    if ('retryAfter' in counted) return { retryAfter: counted.retryAfter };
    return { sending: this.send(address, input.language) };
  }

  private async send(
    address: string,
    language: string | undefined,
  ): Promise<void> {
    if (!UserEmail.safeParse(address).success) return;
    await this.unit.run(async (tx) => {
      const userId = await this.identities.userWithEmail(tx, address);
      if (userId === undefined) return;
      // Held before they are read (#650): a password set or changed, or a deactivation, either
      // waits for this code and ends it, or is waited for and seen.
      await this.codes.hold(tx, userId);
      const user = await this.admin.findUser(tx, userId);
      if (!user || user.deactivatedAt !== null || user.email === null) return;
      // Still the address asked for: one changed since the lookup ended what was mailed there.
      if (user.email.toLowerCase() !== address.toLowerCase()) return;
      const minted = mintEmailCode();
      const expiresAt = new Date(this.now() + this.settings.lifetimeMs);
      // Bound to the address it is mailed to (#646): nothing is stored, or mailed, when that
      // stopped being theirs since it was read.
      const stored = await this.codes.replace(tx, {
        userId,
        codeHash: this.hasher.hash(userId, minted.code),
        linkHash: minted.linkHash,
        sentTo: user.email,
        expiresAt,
      });
      if (!stored) return;
      const queued = await this.mail.queue(tx, {
        to: { address: user.email, name: user.name },
        template: 'email-code',
        params: {
          code: minted.code,
          token: minted.linkToken,
          minutes: Math.round(this.settings.lifetimeMs / 60_000),
        },
        language: language ?? null,
      });
      await this.auditLog.record(tx, SIGN_IN_ACTOR, {
        action: 'user.email-code-requested',
        subject: { type: 'user', id: userId },
        data: {
          emailed: queued !== null,
          expiresAt: expiresAt.toISOString(),
        },
      });
    });
  }
}

/** Why a code gave no session. */
export type EmailCodeRefusal =
  /** Unknown address, no code, a wrong one, a used one or one past its time: the same answer. */
  | 'invalid-code'
  /** The right code, but the user is deactivated. */
  | 'user-deactivated'
  /** The right code, but the session policy refuses this way of signing in for them. */
  | 'sign-in-not-allowed';

export type EmailCodeSignInOutcome =
  | ({ readonly userId: string } & StartedSignIn)
  | { readonly refused: EmailCodeRefusal }
  /** Past the address's `code-attempt:` budget (the try that used it up revoked the code): try again in this many seconds. */
  | { readonly retryAfter: number };

/** Thrown inside the transaction to roll it back: the code went meanwhile. */
class CodeGone extends Error {}

/**
 * Signs in with an email address and the code emailed to it (#634), into the same sessions as a
 * password or a provider (#37, #610), begun with the provider `email-code`. Each try counts
 * toward the address's `code-attempt:` budget first, in the same step as the limit's test, apart
 * from every other budget; a right code is taken back. **Once the budget is used up, the code is
 * revoked**, as it is after `EMAIL_CODE_MAX_FAILURES` (5) wrong codes whatever the budget: a
 * new one must be asked for, and tried once the window lets it. An unknown address,
 * an address without a code, a wrong code and an expired one all answer `invalid-code`, after
 * the same work (one lookup, one HMAC, a constant-time comparison). Only the right code learns
 * that the user is deactivated or that the session policy refuses them. The code is removed in
 * the transaction that starts the session, so it works once (and so does its link); the
 * browser's previous session ends. Recorded as `user.sign-in` (`data.method` `email-code`,
 * `via` `code`); the code and the token never are.
 */
@Injectable()
export class SignInWithEmailCodeAction implements UnguardedAction {
  readonly policy = 'public';
  now: () => number = Date.now;

  constructor(
    private readonly settings: EmailCodeSignIn,
    private readonly hasher: EmailCodeHasher,
    private readonly codes: EmailCodes,
    private readonly attempts: PasswordAttempts,
    private readonly mail: MailOutbox,
    private readonly start: SessionStart,
    private readonly sessionPolicy: SessionPolicy,
    private readonly auditLog: AuditLog,
    private readonly unit: UnitOfWork,
    private readonly identities: UserIdentities,
    private readonly links: SignInLinks,
  ) {}

  async handle(
    input: {
      readonly email: string;
      readonly code: string;
    } & BrowserTokens,
  ): Promise<EmailCodeSignInOutcome> {
    refuseWhenOff(
      offeredBy({
        settings: this.settings,
        mail: this.mail,
        hasher: this.hasher,
      }),
    );
    await refuseWhenSingleSignOn(this.sessionPolicy);
    const address = input.email.trim();
    const counted = await this.attempts.reserve(codeAttemptKey(address));
    // Locked: nothing is compared, so a code asked for meanwhile stays for when the window
    // ends (the try that used the budget up revoked the one before it).
    if ('retryAfter' in counted) return { retryAfter: counted.retryAfter };
    let outcome: Exclude<EmailCodeSignInOutcome, { retryAfter: number }>;
    try {
      outcome = await this.check(address, input.code, input);
    } catch (error) {
      await forgive(this.attempts, counted.attempt);
      throw error;
    }
    if ('refused' in outcome && outcome.refused === 'invalid-code') {
      // The last try the window allowed: the code goes with it.
      if (counted.remaining <= 0) await this.revoke(address);
    } else {
      await forgive(this.attempts, counted.attempt);
    }
    return outcome;
  }

  private async check(
    address: string,
    typed: string,
    browser: BrowserTokens,
  ): Promise<Exclude<EmailCodeSignInOutcome, { retryAfter: number }>> {
    const code = readEmailCode(typed);
    const now = this.now();
    // The try is counted against the code before it is compared (at most five, at once or not).
    const found = UserEmail.safeParse(address).success
      ? await this.codes.claim(address, new Date(now))
      : undefined;
    // The same work whether or not there is a code to compare with.
    const expected = Buffer.from(found?.codeHash ?? NO_CODE_HASH, 'hex');
    const actual = Buffer.from(
      this.hasher.hash(found?.userId ?? NO_USER, code ?? '000000'),
      'hex',
    );
    const same =
      expected.length === actual.length && timingSafeEqual(expected, actual);
    if (!found || code === null || !same || found.expiresAt.getTime() <= now) {
      // Its last try spent: the code goes.
      if (found && found.tries >= EMAIL_CODE_MAX_FAILURES) {
        await this.codes.dropSpent(found.userId);
      }
      return { refused: 'invalid-code' };
    }
    if (found.deactivatedAt !== null) return { refused: 'user-deactivated' };
    if (
      !(await this.sessionPolicy.maySignIn(found.userId, EMAIL_CODE_PROVIDER))
    ) {
      return { refused: 'sign-in-not-allowed' };
    }
    try {
      const started = await this.unit.run(async (tx) => {
        // The person before their code and their invite (#660), as every change that ends ways
        // in takes them: a password set through the invite at the same moment waits, or is
        // waited for, and never holds the invite while this holds the code.
        await this.codes.holdToEnd(tx, found.userId);
        if (
          !(await this.codes.take(
            tx,
            found.userId,
            { codeHash: found.codeHash },
            new Date(now),
          ))
        ) {
          throw new CodeGone();
        }
        return startSession(
          this.sessionDeps(),
          tx,
          found.userId,
          browser,
          now,
          'code',
        );
      });
      return { userId: found.userId, ...started };
    } catch (error) {
      if (error instanceof CodeGone) return { refused: 'invalid-code' };
      throw error;
    }
  }

  private sessionDeps() {
    return {
      start: this.start,
      auditLog: this.auditLog,
      identities: this.identities,
      links: this.links,
    };
  }

  private async revoke(address: string): Promise<void> {
    if (UserEmail.safeParse(address).success) {
      await this.codes.revokeByEmail(address);
    }
  }
}

/** Why a code's link gives no session. */
export type EmailLinkRefusal =
  /** Malformed, unknown, used, replaced by a newer code, revoked, or its user deactivated. */
  | 'link-invalid'
  /** Past its time. */
  | 'link-expired'
  /** The session policy refuses this way of signing in for them. */
  | 'sign-in-not-allowed';

/**
 * Signs in with the link in a code's email (#634): `<editor>/sign-in-code#<token>`, the page
 * posting the token. 256 random bits, so nothing is counted. Using it uses the code too (one row
 * holds both), in the transaction that starts the session. Recorded as `user.sign-in`
 * (`data.method` `email-code`, `via` `link`).
 */
@Injectable()
export class SignInWithEmailLinkAction implements UnguardedAction {
  readonly policy = 'public';
  now: () => number = Date.now;

  constructor(
    private readonly settings: EmailCodeSignIn,
    private readonly hasher: EmailCodeHasher,
    private readonly codes: EmailCodes,
    private readonly mail: MailOutbox,
    private readonly admin: AccessAdmin,
    private readonly start: SessionStart,
    private readonly sessionPolicy: SessionPolicy,
    private readonly auditLog: AuditLog,
    private readonly unit: UnitOfWork,
    private readonly identities: UserIdentities,
    private readonly links: SignInLinks,
  ) {}

  async handle(
    input: { readonly token: string } & BrowserTokens,
  ): Promise<
    | ({ readonly userId: string } & StartedSignIn)
    | { readonly refused: EmailLinkRefusal }
  > {
    refuseWhenOff(
      offeredBy({
        settings: this.settings,
        mail: this.mail,
        hasher: this.hasher,
      }),
    );
    await refuseWhenSingleSignOn(this.sessionPolicy);
    if (!EMAIL_CODE_LINK_PATTERN.test(input.token)) {
      return { refused: 'link-invalid' };
    }
    const linkHash = hashEmailCodeLink(input.token);
    const found = await this.codes.findByLink(linkHash);
    if (!found) return { refused: 'link-invalid' };
    const now = this.now();
    if (found.expiresAt.getTime() <= now) return { refused: 'link-expired' };
    const user = await this.unit.run((tx) =>
      this.admin.findUser(tx, found.userId),
    );
    if (!user || user.deactivatedAt !== null) {
      return { refused: 'link-invalid' };
    }
    if (
      !(await this.sessionPolicy.maySignIn(found.userId, EMAIL_CODE_PROVIDER))
    ) {
      return { refused: 'sign-in-not-allowed' };
    }
    try {
      const started = await this.unit.run(async (tx) => {
        // The person before reading them, their code and their invite (#660), as above.
        await this.codes.holdToEnd(tx, found.userId);
        const current = await this.admin.findUser(tx, found.userId);
        if (
          !current ||
          current.deactivatedAt !== null ||
          !(await this.codes.take(
            tx,
            found.userId,
            { linkHash },
            new Date(now),
          ))
        ) {
          throw new CodeGone();
        }
        return startSession(
          this.sessionDeps(),
          tx,
          found.userId,
          input,
          now,
          'link',
        );
      });
      return { userId: found.userId, ...started };
    } catch (error) {
      if (error instanceof CodeGone) return { refused: 'link-invalid' };
      throw error;
    }
  }

  private sessionDeps() {
    return {
      start: this.start,
      auditLog: this.auditLog,
      identities: this.identities,
      links: this.links,
    };
  }
}

/**
 * Starts the session of a sign-in by email code, in `tx`, and records it; or its second step
 * (#611), which records it once taken.
 */
async function startSession(
  deps: {
    readonly start: SessionStart;
    readonly auditLog: AuditLog;
    readonly identities: UserIdentities;
    readonly links: SignInLinks;
  },
  tx: Transaction,
  userId: string,
  browser: BrowserTokens,
  now: number,
  via: 'code' | 'link',
): Promise<StartedSignIn> {
  const started = await deps.start.begin(tx, {
    userId,
    provider: EMAIL_CODE_PROVIDER,
    held: heldBefore(browser),
    now,
    via,
  });
  // A way in of their own from now on: `pending` OIDC linking by email never takes them.
  await deps.identities.recordCodeSignIn(tx, userId);
  const self: Actor = { kind: 'user', id: userId, roles: [] };
  // Their open invite (the first admin's link logged at start-up, #373, or an admin's) closes:
  // they have a way in, and a link that sets a password stays usable by whoever else holds it.
  if ((await deps.links.revokeAll(tx, userId, 'invite')) > 0) {
    await deps.auditLog.record(tx, self, {
      action: 'user.invite-withdraw',
      subject: { type: 'user', id: userId },
      data: { via: 'sign-in', provider: EMAIL_CODE_PROVIDER },
    });
  }
  if ('token' in started) {
    await deps.auditLog.record(tx, self, {
      action: 'user.sign-in',
      subject: { type: 'user', id: userId },
      data: { method: 'email-code', provider: EMAIL_CODE_PROVIDER, via },
    });
  }
  return started;
}
