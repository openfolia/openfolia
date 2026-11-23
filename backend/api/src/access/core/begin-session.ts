import type { Transaction } from '../../base/core/unit-of-work.js';
import type { SessionPolicy } from './session-policy.js';
import {
  hashSessionToken,
  mintSessionToken,
  type SessionStore,
} from './sessions.js';

/**
 * Starts a session for `userId` begun with `provider`, in `tx`: the browser's previous session
 * (its token, if any) ends, so a sign-in never adds to it; the user's ended sessions are
 * cleared (`SessionStore.create`). Answers the new token, for the cookie only.
 */
export async function beginSession(
  deps: { readonly sessions: SessionStore; readonly policy: SessionPolicy },
  tx: Transaction,
  session: {
    readonly userId: string;
    readonly provider: string;
    readonly previousToken: string | undefined;
    readonly now: number;
  },
): Promise<string> {
  if (session.previousToken !== undefined) {
    await deps.sessions.revoke(hashSessionToken(session.previousToken), tx);
  }
  const limits = deps.policy.limits(session.userId, session.provider);
  const minted = mintSessionToken();
  await deps.sessions.create(tx, {
    hash: minted.hash,
    userId: session.userId,
    provider: session.provider,
    endedBefore: new Date(session.now - limits.maxMs),
  });
  return minted.token;
}
