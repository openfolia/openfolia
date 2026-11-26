import type { Transaction } from '../../base/core/unit-of-work.js';
import type { PendingSignIns } from './pending-sign-ins.js';
import type { SessionPolicy } from './session-policy.js';
import { mintSessionToken, type SessionStore } from './sessions.js';
import { SignInNotAllowedError } from './sign-in-rules.js';

/** What the browser held before a sign-in, by hash: ended with it, so a sign-in adds to nothing. */
export interface HeldBefore {
  readonly sessionHash?: string | undefined;
  /** A second step left open (#611). */
  readonly stepHash?: string | undefined;
}

/**
 * Starts a session for `userId` begun with `provider`, in `tx`. The one place a session starts,
 * whichever way in (`tests/session-start.spec.ts`), and so the one place that asks whether this
 * one may (#378): `SignInNotAllowedError` when the session policy refuses it, read in this
 * transaction, so a change of the rule waits for it or is seen. The browser's previous session and
 * the second step it had open end; the user's ended sessions are cleared
 * (`SessionStore.create`). Answers the new token, for the cookie only.
 */
export async function beginSession(
  deps: {
    readonly sessions: SessionStore;
    readonly policy: SessionPolicy;
    readonly pending: PendingSignIns;
  },
  tx: Transaction,
  session: {
    readonly userId: string;
    readonly provider: string;
    readonly held: HeldBefore;
    readonly now: number;
  },
): Promise<string> {
  if (!(await deps.policy.maySignIn(session.userId, session.provider, tx))) {
    throw new SignInNotAllowedError();
  }
  if (session.held.stepHash !== undefined) {
    await deps.pending.take(tx, session.held.stepHash, new Date(session.now));
  }
  if (session.held.sessionHash !== undefined) {
    await deps.sessions.revoke(session.held.sessionHash, tx);
  }
  const limits = await deps.policy.limits(session.userId, session.provider, tx);
  const minted = mintSessionToken();
  await deps.sessions.create(tx, {
    hash: minted.hash,
    userId: session.userId,
    provider: session.provider,
    endedBefore: new Date(session.now - limits.maxMs),
  });
  return minted.token;
}
