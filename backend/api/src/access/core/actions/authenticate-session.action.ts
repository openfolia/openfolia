import { Injectable } from '@nestjs/common';
import type { Actor } from '../actor.js';
import type { UnguardedAction } from '../policy.js';
import { SessionPolicy } from '../session-policy.js';
import {
  hashSessionToken,
  SESSION_TOKEN_PATTERN,
  SessionStore,
} from '../sessions.js';
import { UserDirectory } from '../user-directory.js';

/** A session's request records its time at most this often. */
const TOUCH_EVERY_MS = 60_000;

/** Why a session token does not authenticate. */
export type SessionRefusal =
  /** Malformed, unknown, or signed out: nothing more is said. */
  | 'invalid-session'
  /** Past its idle time or its longest lifetime: sign in again. */
  | 'session-expired'
  /** Its user is deactivated. */
  | 'user-deactivated';

export type SessionAuthentication =
  | {
      readonly actor: Actor;
      /** The provider the session began with, and when it ends unless used again. */
      readonly session: { readonly provider: string; readonly expiresAt: Date };
    }
  | { readonly refused: SessionRefusal };

/**
 * Authenticates a person's session (#37) on every request that carries
 * one: looks it up by the token's hash, checks the session policy's limits
 * (asked now, so a changed policy applies at once) and resolves its user
 * with the roles they hold now, so a role change applies from the next
 * request, and so does a deactivation or a sign-out. Nothing is cached. A
 * session past a limit is ended. A failing store rejects (a 5xx), never a
 * refusal. Records the request's time, at most once a minute; not a
 * `background` one's (#378: what an open tab asks by itself), so a session
 * nobody uses reaches its idle time.
 */
@Injectable()
export class AuthenticateSessionAction implements UnguardedAction {
  /** Run by the guard to find the actor, before there is one to check. */
  readonly policy = 'internal';
  now: () => number = Date.now;

  constructor(
    private readonly sessions: SessionStore,
    private readonly policyOfSessions: SessionPolicy,
    private readonly users: UserDirectory,
  ) {}

  async handle({
    token,
    background = false,
  }: {
    token: string;
    background?: boolean;
  }): Promise<SessionAuthentication> {
    if (!SESSION_TOKEN_PATTERN.test(token)) {
      return { refused: 'invalid-session' };
    }
    const hash = hashSessionToken(token);
    const session = await this.sessions.find(hash);
    if (!session || session.revokedAt !== null) {
      return { refused: 'invalid-session' };
    }
    const now = this.now();
    const limits = await this.policyOfSessions.limits(
      session.userId,
      session.provider,
    );
    const endsAt = Math.min(
      session.createdAt.getTime() + limits.maxMs,
      session.lastSeenAt.getTime() + limits.idleMs,
    );
    // Not `now >= endsAt`: limits that are no number would never end it.
    if (!(now < endsAt)) {
      await this.sessions.revoke(hash);
      return { refused: 'session-expired' };
    }
    const actor = await this.users.findActor(session.userId);
    if (!actor) {
      // No actor: deactivated (said, as for `X-Ccms-User`), or gone.
      const user = await this.users.findUser(session.userId);
      return user?.deactivatedAt
        ? { refused: 'user-deactivated' }
        : { refused: 'invalid-session' };
    }
    if (background) {
      return {
        actor,
        session: { provider: session.provider, expiresAt: new Date(endsAt) },
      };
    }
    if (now - session.lastSeenAt.getTime() >= TOUCH_EVERY_MS) {
      await this.sessions.touch(hash, new Date(now));
    }
    return {
      actor,
      session: {
        provider: session.provider,
        expiresAt: new Date(
          Math.min(
            session.createdAt.getTime() + limits.maxMs,
            now + limits.idleMs,
          ),
        ),
      },
    };
  }
}
