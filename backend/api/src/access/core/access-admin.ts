import { z } from 'zod';
import type { PageRequest, Paginated } from '../../base/core/paging.js';
import type { Transaction } from '../../base/core/unit-of-work.js';
import { Role } from './actor.js';
import type { User } from './user-directory.js';

/** What a role is for, shown to the people assigning it: 1 to 500 characters. */
export const RoleDescription = z.string().trim().min(1).max(500);

/** A role as administered: the model's `Role` with its description. */
export const RoleDefinition = Role.extend({
  description: RoleDescription.nullable(),
});
export type RoleDefinition = z.infer<typeof RoleDefinition>;

/** A role as listed: its definition and how many users and service accounts hold it. */
export interface StoredRole extends RoleDefinition {
  /** Users and service accounts holding it, deactivated ones included. */
  readonly holders: number;
}

/** A user to create. */
export interface NewUser {
  readonly id: string;
  readonly name: string;
  readonly email: string | null;
}

/**
 * Port: changing roles, users and who holds which role (the `admin.roles`
 * screens). Every change runs inside a transaction that first calls
 * `lock`, so changes to access are made one at a time: what one checks
 * (e.g. that an admin remains) cannot be undone meanwhile by another.
 */
export abstract class AccessAdmin {
  /**
   * Serializes access changes: held until `tx` ends, and every other
   * transaction calling it waits for that. Reads after it in `tx` see what
   * the transactions before it committed.
   */
  abstract lock(tx: Transaction): Promise<void>;

  /** One page of the roles, by name (then ID). */
  abstract listRoles(page: PageRequest): Promise<Paginated<StoredRole>>;

  /** One role; undefined when there is none. Inside `tx` when given. */
  abstract findRole(
    roleId: string,
    tx?: Transaction,
  ): Promise<StoredRole | undefined>;

  /** Of `roleIds`, those that name no role, read inside `tx`. */
  abstract missingRoles(
    tx: Transaction,
    roleIds: readonly string[],
  ): Promise<string[]>;

  /** Adds `role`; false (and nothing written) when its ID is taken. */
  abstract insertRole(tx: Transaction, role: RoleDefinition): Promise<boolean>;

  /** Writes `role` over the stored one of its ID (which exists). */
  abstract updateRole(tx: Transaction, role: RoleDefinition): Promise<void>;

  /** Removes the role `roleId`, which no user holds. */
  abstract deleteRole(tx: Transaction, roleId: string): Promise<void>;

  /** One user, read inside `tx`; undefined when there is none. */
  abstract findUser(tx: Transaction, userId: string): Promise<User | undefined>;

  /**
   * Whether a user other than `exceptUserId` has `email`, ignoring case,
   * read inside `tx`.
   */
  abstract emailTaken(
    tx: Transaction,
    email: string,
    exceptUserId?: string,
  ): Promise<boolean>;

  /** Adds `user`, active and without roles; false (nothing written) when its ID is taken. */
  abstract insertUser(tx: Transaction, user: NewUser): Promise<boolean>;

  /** Changes the name and email of the user `userId` (which exists). */
  abstract updateUser(
    tx: Transaction,
    userId: string,
    changes: { readonly name: string; readonly email: string | null },
  ): Promise<void>;

  /**
   * Gives the user `userId` the role `roleId` directly; false when it held
   * it directly already (one it held only through a group, #37, is now held
   * directly too).
   */
  abstract assign(
    tx: Transaction,
    userId: string,
    roleId: string,
  ): Promise<boolean>;

  /**
   * Takes the direct assignment of the role `roleId` from the user `userId`;
   * false when it held none. A role it holds through a group too stays held
   * that way (#37).
   */
  abstract unassign(
    tx: Transaction,
    userId: string,
    roleId: string,
  ): Promise<boolean>;

  /**
   * Deactivates the user `userId` (at the transaction's time) or, with
   * `false`, reactivates it; returns when it was deactivated (null: active).
   */
  abstract setDeactivated(
    tx: Transaction,
    userId: string,
    deactivated: boolean,
  ): Promise<Date | null>;

  /**
   * The permissions the user `userId` holds through its roles (in any
   * scope), read inside `tx`; empty for no such user.
   */
  abstract heldPermissions(
    tx: Transaction,
    userId: string,
  ): Promise<ReadonlySet<string>>;

  /**
   * How many active users hold a role with `admin.roles`, read inside `tx`
   * (after `lock`, so no other access change runs meanwhile).
   */
  abstract countActiveAdmins(tx: Transaction): Promise<number>;

  /**
   * When single sign-on is required (#378) and the account named break-glass holds `admin.roles`
   * directly no more: ends its password sessions, open second steps and links, so they do not come
   * back with the role. Does nothing otherwise.
   */
  abstract endLostBreakGlass(tx: Transaction): Promise<void>;

  /** How many service accounts hold the role `roleId`, read inside `tx`. */
  abstract serviceAccountHolders(
    tx: Transaction,
    roleId: string,
  ): Promise<number>;
}
