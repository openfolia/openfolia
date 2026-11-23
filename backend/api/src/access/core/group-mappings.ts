import { z } from 'zod';
import type { PageRequest, Paginated } from '../../base/core/paging.js';
import type { Transaction } from '../../base/core/unit-of-work.js';

/**
 * A group's name as an identity provider sends it (#37): 1 to 256
 * characters, compared exactly (case included), without U+0000.
 */
export const GroupName = z
  .string()
  .min(1)
  .max(256)
  .refine((name) => !name.includes('\u0000'), 'must not contain U+0000')
  .refine((name) => name.trim() === name, 'no spaces at either end');

/** At most this many groups of one person are kept; more are left out. */
export const MAX_GROUPS = 200;

/**
 * A group's members hold a role (#37): whoever signs in in the group holds
 * the role, from that sign-in on; a person's group memberships are those the
 * provider sent at their last sign-in.
 */
export interface GroupMapping {
  /** A UUID. */
  readonly id: string;
  readonly group: string;
  readonly roleId: string;
  readonly createdAt: Date;
}

/** Which mappings to list; every field optional, missing meaning all. */
export interface GroupMappingFilter {
  readonly group?: string;
  readonly role?: string;
}

/** The roles a user gained and lost through its groups, by ID. */
export interface GroupRoleChange {
  readonly assigned: readonly string[];
  readonly unassigned: readonly string[];
}

/**
 * Port: which groups hold which roles, and the roles users hold through
 * them. A role held through a group is a `role_assignments` row like a
 * direct one (so every check of who holds what sees it); the row says
 * which way it is held, and a direct assignment is never touched by a group
 * change, nor the reverse. Writes run after `AccessAdmin.lock`.
 */
export abstract class GroupMappings {
  /** One page of the mappings, by group, then role. */
  abstract list(
    page: PageRequest,
    filter?: GroupMappingFilter,
  ): Promise<Paginated<GroupMapping>>;

  /** One mapping; undefined when there is none. */
  abstract find(
    id: string,
    tx?: Transaction,
  ): Promise<GroupMapping | undefined>;

  /** Adds a mapping; undefined (nothing written) when the group holds the role already. */
  abstract insert(
    tx: Transaction,
    group: string,
    roleId: string,
  ): Promise<GroupMapping | undefined>;

  /** Removes the mapping `id`; undefined when there was none. */
  abstract delete(
    tx: Transaction,
    id: string,
  ): Promise<GroupMapping | undefined>;

  /** How many mappings give the role `roleId`. */
  abstract countForRole(tx: Transaction, roleId: string): Promise<number>;

  /** The users some identity of whom was last seen in `group`, by ID. */
  abstract usersInGroup(
    tx: Transaction,
    group: string,
  ): Promise<readonly string[]>;

  /**
   * Brings the roles `userId` holds through groups in line with its
   * identities' groups and the mappings: gives the ones it should hold and
   * takes the others (a direct assignment of the same role stays).
   */
  abstract applyGroupRoles(
    tx: Transaction,
    userId: string,
  ): Promise<GroupRoleChange>;
}
