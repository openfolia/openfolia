import { z } from 'zod';
import type { PageRequest, Paginated } from '../../base/core/paging.js';
import type { Transaction } from '../../base/core/unit-of-work.js';
import type { Actor, Role } from './actor.js';
import { UserId, UserName } from './actor.js';

/**
 * A service account's ID: `UserId`'s format (e.g. "portal-build"). As an
 * actor it is `{ kind: 'service', id }`; every comparison of actors checks
 * the kind too, so a service account never stands in for a user of the
 * same ID.
 */
export const ServiceAccountId = UserId;

/** Its name as shown: 1 to 200 characters, trimmed. */
export const ServiceAccountName = UserName;

/** What it is for: 1 to 500 characters, trimmed. */
export const ServiceAccountDescription = z.string().trim().min(1).max(500);

/** What a token is for, e.g. "portal build, production": 1 to 100 characters, trimmed. */
export const ServiceTokenName = z.string().trim().min(1).max(100);

/** How long a token is valid by default (90 days), and at most (366 days). */
export const DEFAULT_TOKEN_LIFETIME_MS = 90 * 24 * 60 * 60 * 1000;
export const MAX_TOKEN_LIFETIME_MS = 366 * 24 * 60 * 60 * 1000;

/** How many tokens a service account may hold that are neither revoked nor expired. */
export const MAX_ACTIVE_TOKENS = 10;

/** A service account as listed. */
export interface ServiceAccount {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  /** When it was deactivated; null while its tokens may act. */
  readonly deactivatedAt: Date | null;
  readonly createdAt: Date;
  /** Sorted by ID. */
  readonly roleIds: readonly string[];
}

/** A service account to create. */
export interface NewServiceAccount {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
}

/** Which service accounts to list; every field optional, missing meaning all. */
export interface ServiceAccountFilter {
  /** Only holders of this role. */
  readonly role?: string;
  /** Only active (`true`) or only deactivated (`false`) ones. */
  readonly active?: boolean;
  /** Only those whose ID or name contains this text, ignoring case. */
  readonly q?: string;
}

/** A token as listed: never the token, never its hash. */
export interface ServiceToken {
  readonly id: string;
  readonly serviceAccountId: string;
  readonly name: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  /** Kept to the minute; null when never used. */
  readonly lastUsedAt: Date | null;
  readonly revokedAt: Date | null;
}

/** A token to store: its hash, never the token. */
export interface NewServiceToken {
  readonly id: string;
  readonly serviceAccountId: string;
  readonly name: string;
  readonly secretHash: string;
  readonly expiresAt: Date;
}

/**
 * What authenticating a token needs, read together: the token's stored
 * hash and state, its account's, and the account's roles.
 */
export interface TokenCredential {
  readonly token: ServiceToken & { readonly secretHash: string };
  readonly account: {
    readonly id: string;
    readonly deactivatedAt: Date | null;
  };
  /** The account's roles, by ID. */
  readonly roles: readonly Role[];
}

/** The actor a service account acts as. */
export const serviceAccountActor = (
  id: string,
  roles: readonly Role[],
): Actor => ({ kind: 'service', id, roles });

/**
 * Port: service accounts, the roles they hold and their tokens. Writes
 * take a transaction (inside `AccessAdmin.lock`, like every access
 * change); `credential` and `touch` serve authentication, outside one.
 */
export abstract class ServiceAccountStore {
  /** One page of the service accounts matching `filter`, by ID. */
  abstract list(
    page: PageRequest,
    filter?: ServiceAccountFilter,
  ): Promise<Paginated<ServiceAccount>>;

  /** One service account; undefined when there is none. Inside `tx` when given. */
  abstract find(
    id: string,
    tx?: Transaction,
  ): Promise<ServiceAccount | undefined>;

  /** Adds `account`, active and without roles; false (nothing written) when its ID is taken. */
  abstract insert(
    tx: Transaction,
    account: NewServiceAccount,
  ): Promise<boolean>;

  /** Changes the name and description of the service account `id` (which exists). */
  abstract update(
    tx: Transaction,
    id: string,
    changes: { readonly name: string; readonly description: string | null },
  ): Promise<void>;

  /** Gives the service account `id` the role `roleId`; false when it held it already. */
  abstract assign(
    tx: Transaction,
    id: string,
    roleId: string,
  ): Promise<boolean>;

  /** Takes the role `roleId` from the service account `id`; false when it did not hold it. */
  abstract unassign(
    tx: Transaction,
    id: string,
    roleId: string,
  ): Promise<boolean>;

  /**
   * Deactivates the service account `id` (at the transaction's time) or,
   * with `false`, reactivates it; returns when it was deactivated (null: active).
   */
  abstract setDeactivated(
    tx: Transaction,
    id: string,
    deactivated: boolean,
  ): Promise<Date | null>;

  /** One page of the tokens of the service account `id`, newest first. */
  abstract listTokens(
    id: string,
    page: PageRequest,
  ): Promise<Paginated<ServiceToken>>;

  /** The token `tokenId` of the service account `id`, read inside `tx`; undefined when it has none of that ID. */
  abstract findToken(
    tx: Transaction,
    id: string,
    tokenId: string,
  ): Promise<ServiceToken | undefined>;

  /** How many of its tokens are neither revoked nor expired (at `tx`'s time). */
  abstract countActiveTokens(tx: Transaction, id: string): Promise<number>;

  /**
   * Stores `token` (created at `tx`'s time) and answers it as listed;
   * undefined (nothing written) when its ID is taken.
   */
  abstract insertToken(
    tx: Transaction,
    token: NewServiceToken,
  ): Promise<ServiceToken | undefined>;

  /** Revokes the token `tokenId` (at `tx`'s time); returns when. */
  abstract revokeToken(tx: Transaction, tokenId: string): Promise<Date>;

  /**
   * The token `tokenId` with its account and the account's roles, read in
   * one statement; undefined when there is no such token. Rejects when a
   * role's stored data is invalid (never a partial actor) or the database
   * fails (never a refusal on a guess).
   */
  abstract credential(tokenId: string): Promise<TokenCredential | undefined>;

  /**
   * Records that the token `tokenId` was used at `at`, when its stored last
   * use is older than a minute (so a busy client does not write on every
   * request).
   */
  abstract touch(tokenId: string, at: Date): Promise<void>;
}
