import { Injectable } from '@nestjs/common';
import { AuditLog } from '../../../audit/core/audit-log.js';
import {
  ConflictError,
  NotFoundError,
  UnprocessableError,
} from '../../../base/core/errors.js';
import type { PageRequest, Paginated } from '../../../base/core/paging.js';
import {
  BOUNDED,
  runContended,
  UnitOfWork,
} from '../../../base/core/unit-of-work.js';
import { AccessAdmin } from '../access-admin.js';
import { beginAccessChange } from '../access-changes.js';
import type { Actor } from '../actor.js';
import { ActorAction } from '../policy.js';
import {
  noServiceAccount,
  serviceAccountIn,
} from '../service-account-changes.js';
import {
  DEFAULT_TOKEN_LIFETIME_MS,
  MAX_ACTIVE_TOKENS,
  MAX_TOKEN_LIFETIME_MS,
  ServiceAccountStore,
  type ServiceToken,
} from '../service-accounts.js';
import {
  mintServiceToken,
  SERVICE_TOKEN_ID_PATTERN,
} from '../service-token.js';

/** One page of a service account's tokens, newest first: never a token or its hash. Needs `admin.roles`. */
@Injectable()
export class ListServiceTokensAction extends ActorAction<
  { actor: Actor; serviceAccountId: string; page: PageRequest },
  Paginated<ServiceToken>
> {
  readonly policy = 'admin.roles';

  constructor(private readonly store: ServiceAccountStore) {
    super();
  }

  protected async run({
    serviceAccountId,
    page,
  }: {
    serviceAccountId: string;
    page: PageRequest;
  }): Promise<Paginated<ServiceToken>> {
    if (!(await this.store.find(serviceAccountId))) {
      throw noServiceAccount(serviceAccountId);
    }
    return this.store.listTokens(serviceAccountId, page);
  }
}

export interface IssueServiceTokenInput {
  readonly actor: Actor;
  readonly serviceAccountId: string;
  /** What it is for. */
  readonly name: string;
  /** When it stops working; default 90 days from now, at most 366. */
  readonly expiresAt?: Date;
}

/** A token just issued: as listed, and the token itself, shown this once. */
export interface IssuedServiceToken {
  readonly token: ServiceToken;
  /** The bearer token. Never stored, logged or audited; it cannot be shown again. */
  readonly secret: string;
}

/**
 * Issues a token for a service account. The token is made from the CSPRNG
 * and answered once; only its hash is stored. It expires (by default in
 * 90 days, at most 366). 404 `not-found`; 409
 * `service-account-deactivated`; 409 `too-many-tokens` beyond
 * `MAX_ACTIVE_TOKENS` tokens neither revoked nor expired; 422
 * `invalid-expiry` for an expiry not in the future or too far ahead.
 * Recorded as `service-token.issue` (the token's ID and expiry, never the
 * token). Needs `admin.roles`, held by a user.
 */
@Injectable()
export class IssueServiceTokenAction extends ActorAction<
  IssueServiceTokenInput,
  IssuedServiceToken
> {
  readonly policy = 'admin.roles';
  now: () => number = Date.now;
  /** Makes the token; the CSPRNG's in the server. */
  mint = mintServiceToken;

  constructor(
    private readonly admin: AccessAdmin,
    private readonly store: ServiceAccountStore,
    private readonly auditLog: AuditLog,
    private readonly unit: UnitOfWork,
  ) {
    super();
  }

  protected run({
    actor,
    serviceAccountId: id,
    name,
    expiresAt,
  }: IssueServiceTokenInput): Promise<IssuedServiceToken> {
    return runContended(
      this.unit,
      async (tx) => {
        await beginAccessChange(this.admin, tx, actor);
        const account = await serviceAccountIn(this.store, tx, id);
        if (account.deactivatedAt !== null) {
          throw new ConflictError(
            'service-account-deactivated',
            `The service account "${id}" is deactivated; reactivate it first.`,
          );
        }
        // After the transaction began, so its creation time is before this.
        const now = this.now();
        const expires = expiresAt ?? new Date(now + DEFAULT_TOKEN_LIFETIME_MS);
        if (
          expires.getTime() <= now ||
          expires.getTime() > now + MAX_TOKEN_LIFETIME_MS
        ) {
          throw new UnprocessableError(
            'invalid-expiry',
            'A token must expire in the future, and within 366 days.',
          );
        }
        if ((await this.store.countActiveTokens(tx, id)) >= MAX_ACTIVE_TOKENS) {
          throw new ConflictError(
            'too-many-tokens',
            `A service account holds at most ${MAX_ACTIVE_TOKENS} tokens that are neither revoked nor expired; revoke one first.`,
          );
        }
        // An ID taken (64 random bits: practically never) is drawn again.
        for (let attempt = 0; attempt < 3; attempt++) {
          const minted = this.mint();
          const token = await this.store.insertToken(tx, {
            id: minted.id,
            serviceAccountId: id,
            name,
            secretHash: minted.secretHash,
            expiresAt: expires,
          });
          if (!token) continue;
          await this.auditLog.record(tx, actor, {
            action: 'service-token.issue',
            subject: { type: 'service-account', id },
            data: { tokenId: token.id, expiresAt: expires.toISOString() },
          });
          return { token, secret: minted.token };
        }
        throw new Error('No free token ID after 3 attempts.');
      },
      BOUNDED,
    );
  }
}

export interface RevokeServiceTokenInput {
  readonly actor: Actor;
  readonly serviceAccountId: string;
  readonly tokenId: string;
}

/**
 * Revokes a token: from the next request on it is refused (401
 * `token-revoked`). It stays listed, with when it was revoked. 404
 * `not-found` (no such account, or no such token of it); 409
 * `already-revoked`. Recorded as `service-token.revoke`. Needs
 * `admin.roles`, held by a user.
 */
@Injectable()
export class RevokeServiceTokenAction extends ActorAction<
  RevokeServiceTokenInput,
  ServiceToken
> {
  readonly policy = 'admin.roles';

  constructor(
    private readonly admin: AccessAdmin,
    private readonly store: ServiceAccountStore,
    private readonly auditLog: AuditLog,
    private readonly unit: UnitOfWork,
  ) {
    super();
  }

  protected run({
    actor,
    serviceAccountId: id,
    tokenId,
  }: RevokeServiceTokenInput): Promise<ServiceToken> {
    return runContended(
      this.unit,
      async (tx) => {
        await beginAccessChange(this.admin, tx, actor);
        await serviceAccountIn(this.store, tx, id);
        const wellFormed = SERVICE_TOKEN_ID_PATTERN.test(tokenId);
        const token = wellFormed
          ? await this.store.findToken(tx, id, tokenId)
          : undefined;
        if (!token) {
          // Only an ID is repeated: never what may be a whole token pasted in.
          throw new NotFoundError(
            wellFormed
              ? `The service account "${id}" has no token "${tokenId}".`
              : `The service account "${id}" has no such token (an ID is 16 hex digits).`,
          );
        }
        if (token.revokedAt !== null) {
          throw new ConflictError(
            'already-revoked',
            `The token "${tokenId}" is revoked already.`,
          );
        }
        const revokedAt = await this.store.revokeToken(tx, tokenId);
        await this.auditLog.record(tx, actor, {
          action: 'service-token.revoke',
          subject: { type: 'service-account', id },
          data: { tokenId },
        });
        return { ...token, revokedAt };
      },
      BOUNDED,
    );
  }
}
