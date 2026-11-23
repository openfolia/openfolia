import { Injectable } from '@nestjs/common';
import type { Actor } from '../actor.js';
import type { UnguardedAction } from '../policy.js';
import {
  serviceAccountActor,
  ServiceAccountStore,
} from '../service-accounts.js';
import {
  hashServiceToken,
  serviceTokenId,
  serviceTokenMatches,
} from '../service-token.js';

/** Why a service token does not authenticate. */
export type TokenRefusal =
  /** Malformed, unknown, or the secret does not match: nothing more is said. */
  | 'invalid-token'
  /** The caller holds the right secret, but the token was revoked. */
  | 'token-revoked'
  /** The caller holds the right secret, but the token has expired. */
  | 'token-expired'
  /** The caller holds a valid token, but its service account is deactivated. */
  | 'service-account-deactivated';

export type TokenAuthentication =
  { readonly actor: Actor } | { readonly refused: TokenRefusal };

/** Compared against when no token is found, so the answer takes as long. */
const NO_HASH = hashServiceToken('');

/**
 * Authenticates a service account's token (`ccms_sat_…`) on every request
 * that carries one: looks it up by its ID, compares the hash in constant
 * time, then checks it is neither revoked nor expired and its account is
 * active. Nothing is cached, so a revocation or deactivation applies to the
 * very next request. Revoked and expired are told apart only to a caller
 * who proved it holds the secret; anything else is `invalid-token`. A
 * failing store rejects (a 5xx), never a refusal. Records the last use, at
 * most once a minute.
 */
@Injectable()
export class AuthenticateServiceTokenAction implements UnguardedAction {
  /** Run by the guard to find the actor, before there is one to check. */
  readonly policy = 'internal';
  now: () => number = Date.now;

  constructor(private readonly store: ServiceAccountStore) {}

  async handle({ token }: { token: string }): Promise<TokenAuthentication> {
    const id = serviceTokenId(token);
    const credential =
      id === undefined ? undefined : await this.store.credential(id);
    const matches = serviceTokenMatches(
      token,
      credential?.token.secretHash ?? NO_HASH,
    );
    if (!id || !credential || !matches) return { refused: 'invalid-token' };
    const now = this.now();
    if (credential.token.revokedAt !== null)
      return { refused: 'token-revoked' };
    if (credential.token.expiresAt.getTime() <= now) {
      return { refused: 'token-expired' };
    }
    if (credential.account.deactivatedAt !== null) {
      return { refused: 'service-account-deactivated' };
    }
    const lastUsed = credential.token.lastUsedAt?.getTime();
    if (lastUsed === undefined || now - lastUsed >= 60_000) {
      await this.store.touch(id, new Date(now));
    }
    return {
      actor: serviceAccountActor(credential.account.id, credential.roles),
    };
  }
}
