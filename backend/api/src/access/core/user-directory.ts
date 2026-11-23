import type { PageRequest, Paginated } from '../../base/core/paging.js';
import type { Transaction } from '../../base/core/unit-of-work.js';
import type { Actor } from './actor.js';
import type { Permission } from './permissions.js';

/**
 * A user as listed: its name, email, whether it may act, the IDs of its
 * roles and the permissions they hold.
 */
export interface User {
  readonly id: string;
  readonly name: string;
  /** Null for a user stored without one (e.g. seeded). */
  readonly email: string | null;
  /** When it was deactivated; null while it may act. */
  readonly deactivatedAt: Date | null;
  /** Every role it holds, directly or through its groups; sorted by ID. */
  readonly roleIds: readonly string[];
  /**
   * Of `roleIds`, those it holds only through its identity provider's
   * groups (#37), not assigned directly: they follow the group mappings, and
   * taking them from the user directly changes nothing. Sorted by ID.
   */
  readonly groupRoleIds: readonly string[];
  /**
   * The permissions some role of the user holds, in any scope, in
   * `PERMISSIONS` order (`heldPermissions`): derived from the roles, for a
   * client telling what a person may do (a contributor's label in review).
   */
  readonly permissions: readonly Permission[];
  /**
   * How the person signs in (#610): with a password, a provider, both, or invited (an open
   * invite's end) and not yet signed in. Left out where it is not read.
   */
  readonly signIn?: UserSignIn;
}

/** How a user signs in (#610). */
export interface UserSignIn {
  readonly password: boolean;
  /** Has signed in with an identity provider at least once. */
  readonly provider: boolean;
  /** When an open invite link ends; null for none. */
  readonly inviteExpiresAt: Date | null;
}

/** Which users to list; every field optional, missing meaning all. */
export interface UserFilter {
  /** Only holders of this role. */
  readonly role?: string;
  /** Only active (`true`) or only deactivated (`false`) users. */
  readonly active?: boolean;
  /** Only users whose ID, name or email contains this text, ignoring case. */
  readonly q?: string;
}

/** Port: the users and the roles assigned to them. */
export abstract class UserDirectory {
  /**
   * The user as an actor, with every role assigned to it; undefined when
   * there is no such user, or it is deactivated (a deactivated user acts as
   * nobody, and an approval it gave no longer holds). Rejects when a role's
   * stored data is not valid (an unknown permission, a malformed scope):
   * never a partial actor. Inside `tx` when given (read in that
   * transaction: e.g. approvals checked against their approvers' roles
   * while a change set is held).
   */
  abstract findActor(
    userId: string,
    tx?: Transaction,
  ): Promise<Actor | undefined>;

  /** One user, deactivated or not; undefined when there is no such user. */
  abstract findUser(userId: string): Promise<User | undefined>;

  /** One page of the users matching `filter`, by ID. */
  abstract listUsers(
    page: PageRequest,
    filter?: UserFilter,
  ): Promise<Paginated<User>>;
}
