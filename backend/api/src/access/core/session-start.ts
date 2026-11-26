import { Injectable } from '@nestjs/common';
import { AuditLog } from '../../audit/core/audit-log.js';
import type { Transaction } from '../../base/core/unit-of-work.js';
import { AccessAdmin } from './access-admin.js';
import { beginSession, type HeldBefore } from './begin-session.js';
import { EmailCodes } from './email-codes.js';
import {
  hashPendingSignIn,
  mintPendingSignIn,
  PENDING_SIGN_IN_MS,
  PendingSignIns,
  type SecondStep,
} from './pending-sign-ins.js';
import {
  coveredBySecondFactor,
  SecondFactorRule,
  SecondFactors,
} from './second-factors.js';
import { SessionPolicy } from './session-policy.js';
import { hashSessionToken, SessionStore } from './sessions.js';
import { recordBreakGlassUse, SignInEvents } from './sign-in-events.js';
import { SignInNotAllowedError } from './sign-in-rules.js';
import { PASSWORD_PROVIDER } from './passwords.js';

/** What a right first factor gave: a session, or the second step to take first. */
export type StartedSignIn =
  | {
      /** The new session's token, for the cookie; never stored or logged. */
      readonly token: string;
    }
  | {
      readonly secondStep: SecondStep;
      /** The open second step's token, for its own cookie; never stored or logged. */
      readonly pendingToken: string;
    };

/** What a browser brought to a sign-in, as its cookies hold it. */
export interface BrowserTokens {
  /** The session it held before, if any: ended. */
  readonly previousToken?: string | undefined;
  /** The second step it had open, if any (#611): ended. */
  readonly openStepToken?: string | undefined;
}

export function heldBefore(browser: BrowserTokens): HeldBefore {
  return {
    ...(browser.previousToken !== undefined && {
      sessionHash: hashSessionToken(browser.previousToken),
    }),
    ...(browser.openStepToken !== undefined && {
      stepHash: hashPendingSignIn(browser.openStepToken),
    }),
  };
}

/**
 * The one way a sign-in that ends here (a password, a one-time link, a code by email) starts a
 * session (#611): with a second factor on, or required and not set up yet, it opens the second
 * step instead, and no session exists until that is done (`finish`). A new way in calls `begin`,
 * never `beginSession` itself (`tests/session-start.spec.ts` holds that). A provider's sign-in
 * (`CompleteSignInAction`) is the provider's to secure and starts its session with `finish`.
 *
 * Both refuse a way in the session policy does not allow (#378, `SignInNotAllowedError`). With
 * single sign-on required a session begun with a password is the break-glass account's: each is
 * recorded as `user.break-glass-sign-in` and told to the administrators (`SignInEvents`).
 */
@Injectable()
export class SessionStart {
  constructor(
    private readonly sessions: SessionStore,
    private readonly policy: SessionPolicy,
    private readonly factors: SecondFactors,
    private readonly pending: PendingSignIns,
    private readonly rule: SecondFactorRule,
    private readonly admin: AccessAdmin,
    private readonly codes: EmailCodes,
    private readonly auditLog: AuditLog,
    private readonly events: SignInEvents,
  ) {}

  async begin(
    tx: Transaction,
    signIn: {
      readonly userId: string;
      readonly provider: string;
      readonly held: HeldBefore;
      readonly now: number;
      /** How an email code was given (`code`, `link`), kept for the audit log. */
      readonly via?: string;
    },
  ): Promise<StartedSignIn> {
    // Held until this commits: turning the second factor on at the same moment either finds and
    // ends the session this starts, or is seen here.
    await this.codes.holdToEnd(tx, signIn.userId);
    const step = await this.stepOf(tx, signIn.userId, signIn.provider);
    if (step === null) return { token: await this.finish(tx, signIn) };
    if (!(await this.policy.maySignIn(signIn.userId, signIn.provider, tx))) {
      throw new SignInNotAllowedError();
    }
    if (signIn.held.stepHash !== undefined) {
      await this.pending.take(tx, signIn.held.stepHash, new Date(signIn.now));
    }
    const minted = mintPendingSignIn();
    await this.pending.create(
      tx,
      {
        hash: minted.hash,
        userId: signIn.userId,
        step,
        provider: signIn.provider,
        via: signIn.via ?? null,
        expiresAt: new Date(signIn.now + PENDING_SIGN_IN_MS),
      },
      new Date(signIn.now),
    );
    return { secondStep: step, pendingToken: minted.token };
  }

  /** Starts the session, the second step taken (or none needed): `beginSession`. */
  async finish(
    tx: Transaction,
    signIn: {
      readonly userId: string;
      readonly provider: string;
      readonly held: HeldBefore;
      readonly now: number;
    },
  ): Promise<string> {
    const token = await beginSession(
      { sessions: this.sessions, policy: this.policy, pending: this.pending },
      tx,
      signIn,
    );
    if (
      signIn.provider === PASSWORD_PROVIDER &&
      (await this.policy.requiresSingleSignOn(tx))
    ) {
      await recordBreakGlassUse(this.auditLog, this.events, tx, signIn.userId);
    }
    return token;
  }

  /** Whether the installation requires a second factor of the person. */
  async required(tx: Transaction, userId: string): Promise<boolean> {
    const rule = await this.rule.read(tx);
    if (rule === 'optional') return false;
    if (rule === 'everyone') return true;
    return (await this.admin.heldPermissions(tx, userId)).has('admin.roles');
  }

  /** The second step a sign-in of the person takes; null for none. */
  private async stepOf(
    tx: Transaction,
    userId: string,
    provider: string,
  ): Promise<SecondStep | null> {
    if (!coveredBySecondFactor(provider)) return null;
    const factor = await this.factors.find(userId, tx);
    if (factor && factor.confirmedAt !== null) return 'verify';
    return (await this.required(tx, userId)) ? 'set-up' : null;
  }
}
