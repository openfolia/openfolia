import type { Transaction } from '../../base/core/unit-of-work.js';
import type { JsonObject } from './scim-json.js';
import type { ScimGroup, ScimUser } from './scim-resources.js';

/** What SCIM keeps of a user beside the user itself. */
export interface ScimUserLink {
  readonly userId: string;
  readonly userName: string;
  readonly externalId: string | null;
  readonly attributes: JsonObject;
}

/**
 * Port: the users and groups a directory provisions over SCIM (#377). A provisioned user is a
 * user (`users`, through `AccessAdmin`) with a link holding its `userName`, `externalId` and the
 * attributes the directory sent; a group has a name, which the group mappings give roles by, and
 * members. Writes run after `AccessAdmin.lock`, so provisioning and the admin screens change
 * access one at a time.
 */
export abstract class ScimDirectory {
  /**
   * Every provisioned user, by ID, for a filter to pick from.
   * shortcut: reads them all, for filters evaluated in memory; translate the common filters
   * (`userName eq`, `externalId eq`) to SQL once a directory provisions tens of thousands.
   */
  abstract listUsers(): Promise<ScimUser[]>;

  /** One provisioned user; undefined for none (or a user not provisioned). Inside `tx` when given. */
  abstract findUser(
    userId: string,
    tx?: Transaction,
  ): Promise<ScimUser | undefined>;

  /** The provisioned user whose `userName` is `userName`, ignoring case; undefined for none. */
  abstract userNamed(
    tx: Transaction,
    userName: string,
  ): Promise<string | undefined>;

  /**
   * Links the user `link.userId` (which exists and is not linked) to the directory: one it made
   * (`createdByScim`), or an existing one it took over by email. A link the directory let go is
   * taken up again.
   */
  abstract link(
    tx: Transaction,
    link: ScimUserLink & { readonly createdByScim: boolean },
  ): Promise<void>;

  /**
   * Records that the directory deactivated the linked user `userId` at `at` (its
   * `users.deactivated_at`), or, with null, that it reactivated it.
   */
  abstract markDeactivated(
    tx: Transaction,
    userId: string,
    at: Date | null,
  ): Promise<void>;

  /** Writes what the directory sent over the link of `link.userId` (which is linked). */
  abstract update(tx: Transaction, link: ScimUserLink): Promise<void>;

  /** Lets the linked user `userId` go: no longer provisioned, out of every group (`formerLink`). */
  abstract unlink(tx: Transaction, userId: string): Promise<void>;

  /** What the directory knew of `userId` when it let them go; undefined if it never did. */
  abstract formerLink(
    tx: Transaction,
    userId: string,
  ): Promise<
    | {
        readonly createdByScim: boolean;
        readonly scimDeactivatedAt: Date | null;
      }
    | undefined
  >;

  /** Of `userIds`, those that are provisioned users. */
  abstract provisioned(
    tx: Transaction,
    userIds: readonly string[],
  ): Promise<string[]>;

  /** Every provisioned group, by name; see `listUsers` (the same shortcut). */
  abstract listGroups(): Promise<ScimGroup[]>;

  /** One group; undefined for none. Inside `tx` when given. */
  abstract findGroup(
    id: string,
    tx?: Transaction,
  ): Promise<ScimGroup | undefined>;

  /** The group named `displayName`, exactly; undefined for none. */
  abstract groupNamed(
    tx: Transaction,
    displayName: string,
  ): Promise<string | undefined>;

  /** Adds a group without members; answers its ID. */
  abstract insertGroup(
    tx: Transaction,
    group: { readonly displayName: string; readonly externalId: string | null },
  ): Promise<string>;

  /** Changes the name and `externalId` of the group `id` (which exists). */
  abstract updateGroup(
    tx: Transaction,
    id: string,
    group: { readonly displayName: string; readonly externalId: string | null },
  ): Promise<void>;

  /** Makes `userIds` (provisioned users) the members of the group `id`; answers who joined and who left. */
  abstract setMembers(
    tx: Transaction,
    id: string,
    userIds: readonly string[],
  ): Promise<{
    readonly added: readonly string[];
    readonly removed: readonly string[];
  }>;

  /** Removes the group `id`; answers who were its members. */
  abstract deleteGroup(tx: Transaction, id: string): Promise<readonly string[]>;
}
