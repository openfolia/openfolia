import { isDeepStrictEqual } from 'node:util';
import { Injectable } from '@nestjs/common';
import { AccessAdmin } from '../../access/core/access-admin.js';
import {
  applyGroupRolesOf,
  keepAnAdmin,
} from '../../access/core/access-changes.js';
import type { Actor } from '../../access/core/actor.js';
import { emailTaken } from '../../access/core/actions/create-user.action.js';
import { GroupMappings } from '../../access/core/group-mappings.js';
import { SessionPolicy } from '../../access/core/session-policy.js';
import {
  userIdBase,
  userIdCandidates,
} from '../../access/core/sign-in-users.js';
import {
  deactivateUserIn,
  reactivateUserIn,
} from '../../access/core/user-deactivation.js';
import { UserIdentities } from '../../access/core/user-identities.js';
import { addressReplaced, WaysIn } from '../../access/core/ways-in.js';
import { AuditLog } from '../../audit/core/audit-log.js';
import { ConflictError, NotFoundError } from '../../base/core/errors.js';
import type { Transaction } from '../../base/core/unit-of-work.js';
import { LockStore } from '../../change-sets/core/lock-store.js';
import type { Permission } from '../../access/core/permissions.js';
import { ScimDirectory, type ScimUserLink } from './scim-directory.js';
import { ScimInvalidValueError } from './scim-errors.js';
import {
  chosenAddress,
  nameOf,
  type ScimGroupInput,
  type ScimUserInput,
} from './scim-resources.js';

/** How many `base-<n>` IDs are tried for a new user before a random suffix. */
const ID_TRIES = 50;

/**
 * The permissions of plain content work. A user holding any other (`admin.*`,
 * `release.publish`, `content.approve`, …, and any permission added later: fail closed) is
 * privileged: a directory never links them, nor changes their address.
 */
const PLAIN: ReadonlySet<string> = new Set<Permission>([
  'content.read',
  'content.read.draft',
  'content.edit',
  'content.review',
]);

/** The provider name the link-by-email setting is asked with (`SessionPolicy.linkByEmail`). */
export const SCIM_PROVIDER = 'scim';

const sameAddress = (a: string | null, b: string | null): boolean =>
  a?.toLowerCase() === b?.toLowerCase();

/** What provisioning records as the way a change came (`data.via`). */
const VIA = { via: 'scim' } as const;

export const userNameTaken = () =>
  new ConflictError(
    'scim-user-name-taken',
    'Another provisioned user has this userName already.',
  );

export const groupNameTaken = () =>
  new ConflictError(
    'scim-group-name-taken',
    'Another provisioned group has this displayName already.',
  );

export const noUser = (id: string) =>
  new NotFoundError(`No provisioned user "${id}".`);

export const noGroup = (id: string) =>
  new NotFoundError(`No provisioned group "${id}".`);

/**
 * The writes of provisioning (#377), inside a transaction begun with `beginScimChange`: users
 * made, linked, changed, deactivated, reactivated and let go; groups made, changed and removed,
 * with the roles their mappings give applied to whoever joined or left. Every change is in the
 * audit log, as the admin screens record it (`user.create`, `user.update`, `user.deactivate`,
 * `role.assign` …), with `data.via` `scim`; and no change leaves no active user holding
 * `admin.roles` (409 `last-admin`).
 */
@Injectable()
export class ScimWrites {
  constructor(
    private readonly admin: AccessAdmin,
    private readonly directory: ScimDirectory,
    private readonly identities: UserIdentities,
    private readonly mappings: GroupMappings,
    private readonly sessionPolicy: SessionPolicy,
    private readonly locks: LockStore,
    private readonly waysIn: WaysIn,
    private readonly auditLog: AuditLog,
  ) {}

  private get deactivation() {
    return {
      admin: this.admin,
      locks: this.locks,
      waysIn: this.waysIn,
      auditLog: this.auditLog,
    };
  }

  /**
   * A user for `input`: an existing one linked by its email address where the link-by-email
   * setting allows it (`CCMS_OIDC_LINK_BY_EMAIL`: `pending`, the default, only a user who has
   * never signed in; `any` any user not provisioned yet; `off` never), never a privileged one
   * (beyond `PLAIN`) nor one deactivated; else a new user, its ID made from `userName`. 409 `scim-user-name-taken`,
   * `email-taken` (the address is another's, and not linked). Answers the user's ID.
   */
  async createUser(
    tx: Transaction,
    actor: Actor,
    input: ScimUserInput,
  ): Promise<string> {
    if (await this.directory.userNamed(tx, input.userName)) {
      throw userNameTaken();
    }
    const email = input.email ?? null;
    const holder =
      email === null
        ? undefined
        : await this.identities.userWithEmail(tx, email);
    let userId: string;
    // Someone it let go (a DELETE) is taken up again, as it knew them.
    const former =
      holder === undefined
        ? undefined
        : await this.directory.formerLink(tx, holder);
    const createdByScim = former?.createdByScim ?? holder === undefined;
    if (holder !== undefined) {
      if (!(await this.linkable(tx, holder, former))) throw emailTaken();
      userId = holder;
      await this.auditLog.record(tx, actor, {
        action: 'user.identity-link',
        subject: { type: 'user', id: userId },
        data: { ...VIA, provider: SCIM_PROVIDER },
      });
    } else {
      userId = await this.insertUser(tx, actor, input, email);
    }
    const link = {
      userId,
      userName: input.userName,
      externalId: input.externalId,
      attributes: input.attributes,
    };
    await this.directory.link(tx, { ...link, createdByScim });
    const active = input.active ?? true;
    await this.writeUser(
      tx,
      actor,
      { ...input, active },
      {
        ...link,
        createdByScim,
        scimDeactivatedAt: former?.scimDeactivatedAt ?? null,
      },
    );
    return userId;
  }

  /**
   * Writes `input` over the provisioned user `before.userId`: its name and email address, its
   * link, and whether it is active (deactivating it ends its sessions, links and code by email
   * and releases its locks at once; its change sets and comments stay). An address that replaces
   * another ends what was mailed to the old one. Nothing changed: nothing written. 409
   * `scim-user-name-taken`, `email-taken`, `scim-address-locked` (`addressLock`), never for a user
   * it leaves inactive: they keep the name or address they have.
   * `active: true` reactivates only a user the directory deactivated itself, never one an admin
   * deactivated (it stays deactivated); left out, they stay as active as they are.
   */
  async writeUser(
    tx: Transaction,
    actor: Actor,
    input: ScimUserInput,
    before: ScimUserLink & {
      readonly createdByScim: boolean;
      readonly scimDeactivatedAt: Date | null;
    },
  ): Promise<void> {
    const { userId } = before;
    const user = await this.admin.findUser(tx, userId);
    if (!user) throw noUser(userId);
    const active = input.active ?? user.deactivatedAt === null;
    // Deprovisioning is never held up: by a name or an address it may not have, it keeps its own.
    const unless = (conflict: ConflictError) => {
      if (active) throw conflict;
    };
    let { userName } = input;
    const other = await this.directory.userNamed(tx, userName);
    if (other !== undefined && other !== userId) {
      unless(userNameTaken());
      userName = before.userName;
    }
    const name = nameOf(input) ?? user.name;
    const attributes = { ...input.attributes };
    const email = await this.addressFor(tx, input, before, user.email, (e) => {
      unless(e);
      // Not kept as the directory's either: given again, it is refused again.
      delete attributes['emails'];
      if (before.attributes['emails'] !== undefined) {
        attributes['emails'] = before.attributes['emails'];
      }
    });
    const changed = [
      ...(name !== user.name ? ['name'] : []),
      ...(email !== user.email ? ['email'] : []),
      ...(userName !== before.userName ? ['userName'] : []),
      ...(input.externalId !== before.externalId ? ['externalId'] : []),
      ...(isDeepStrictEqual(attributes, before.attributes)
        ? []
        : ['attributes']),
    ];
    if (name !== user.name || email !== user.email) {
      await this.admin.updateUser(tx, userId, { name, email });
      if (addressReplaced(user.email, email)) {
        await this.waysIn.endMailed(tx, userId);
      }
    }
    if (changed.length > 0) {
      await this.directory.update(tx, {
        userId,
        userName,
        externalId: input.externalId,
        attributes,
      });
      await this.auditLog.record(tx, actor, {
        action: 'user.update',
        subject: { type: 'user', id: userId },
        data: { ...VIA, changed },
      });
    }
    if (!active && user.deactivatedAt === null) {
      await this.deactivate(tx, actor, userId);
    } else if (
      active &&
      user.deactivatedAt !== null &&
      // Only the directory's own deactivation: an admin's (a later one too) stands.
      before.scimDeactivatedAt?.getTime() === user.deactivatedAt.getTime()
    ) {
      await reactivateUserIn(this.admin, this.auditLog, tx, actor, userId, VIA);
      await this.directory.markDeactivated(tx, userId, null);
    }
  }

  /** Deactivates the provisioned user `userId` (when active) and changes nothing else. */
  async deactivateUser(
    tx: Transaction,
    actor: Actor,
    userId: string,
  ): Promise<void> {
    const user = await this.admin.findUser(tx, userId);
    if (!user) throw noUser(userId);
    if (user.deactivatedAt === null) await this.deactivate(tx, actor, userId);
  }

  /**
   * Lets the provisioned user `userId` go (a DELETE): deactivated (when active), unlinked and out
   * of every group, its roles through groups taken. The user itself stays, with its change sets
   * and comments, as a deactivated user; provisioning its address again takes it up again
   * (`linkable`). Recorded as `user.identity-unlink`.
   */
  async deleteUser(
    tx: Transaction,
    actor: Actor,
    userId: string,
  ): Promise<void> {
    await this.deactivateUser(tx, actor, userId);
    await this.directory.unlink(tx, userId);
    await this.auditLog.record(tx, actor, {
      action: 'user.identity-unlink',
      subject: { type: 'user', id: userId },
      data: { ...VIA, provider: SCIM_PROVIDER },
    });
    await this.reapply(tx, actor, [userId]);
  }

  /** A new group with its members; answers its ID. 409 `scim-group-name-taken`. */
  async createGroup(
    tx: Transaction,
    actor: Actor,
    input: ScimGroupInput,
  ): Promise<string> {
    if (await this.directory.groupNamed(tx, input.displayName)) {
      throw groupNameTaken();
    }
    await this.checkMembers(tx, input.memberIds);
    const id = await this.directory.insertGroup(tx, input);
    const { added } = await this.directory.setMembers(tx, id, input.memberIds);
    await this.auditLog.record(tx, actor, {
      action: 'scim-group.create',
      subject: { type: 'scim-group', id },
      data: { displayName: input.displayName, membersAdded: added },
    });
    await this.reapply(tx, actor, added);
    return id;
  }

  /**
   * Writes `input` over the group `id`: its name (every member's roles through groups follow the
   * new name) and its members (those who joined or left gain or lose what the mappings give).
   * Nothing changed: nothing written. 404, 409 `scim-group-name-taken`.
   */
  async writeGroup(
    tx: Transaction,
    actor: Actor,
    id: string,
    input: ScimGroupInput,
  ): Promise<void> {
    const group = await this.directory.findGroup(id, tx);
    if (!group) throw noGroup(id);
    const other = await this.directory.groupNamed(tx, input.displayName);
    if (other !== undefined && other !== id) throw groupNameTaken();
    await this.checkMembers(tx, input.memberIds);
    const renamed = input.displayName !== group.displayName;
    const changed = [
      ...(renamed ? ['displayName'] : []),
      ...(input.externalId !== group.externalId ? ['externalId'] : []),
    ];
    if (changed.length > 0) await this.directory.updateGroup(tx, id, input);
    const { added, removed } = await this.directory.setMembers(
      tx,
      id,
      input.memberIds,
    );
    if (changed.length === 0 && added.length === 0 && removed.length === 0) {
      return;
    }
    await this.auditLog.record(tx, actor, {
      action: 'scim-group.update',
      subject: { type: 'scim-group', id },
      data: {
        changed,
        ...(renamed && { from: group.displayName, to: input.displayName }),
        membersAdded: added,
        membersRemoved: removed,
      },
    });
    await this.reapply(
      tx,
      actor,
      renamed
        ? [...new Set([...group.members.map((m) => m.userId), ...added])]
        : [...added, ...removed],
    );
  }

  /** Removes the group `id`: its members lose what its mappings gave. 404. */
  async deleteGroup(tx: Transaction, actor: Actor, id: string): Promise<void> {
    const group = await this.directory.findGroup(id, tx);
    if (!group) throw noGroup(id);
    const members = await this.directory.deleteGroup(tx, id);
    await this.auditLog.record(tx, actor, {
      action: 'scim-group.delete',
      subject: { type: 'scim-group', id },
      data: { displayName: group.displayName, membersRemoved: members },
    });
    await this.reapply(tx, actor, members);
  }

  /** Whether a first provisioning may take over the existing user `userId` by its address. */
  private async linkable(
    tx: Transaction,
    userId: string,
    former: { readonly scimDeactivatedAt: Date | null } | undefined,
  ): Promise<boolean> {
    if (await this.directory.findUser(userId, tx)) return false;
    // Never a privileged user: whoever holds the directory's token would hold the account.
    if (await this.privileged(tx, userId)) return false;
    const user = await this.admin.findUser(tx, userId);
    if (!user) return false;
    const mode = this.sessionPolicy.linkByEmail(SCIM_PROVIDER);
    if (mode === 'off') return false;
    if (former) {
      // Someone it let go, signed in since or not, while still deactivated by its DELETE: not
      // once an admin reactivated or deactivated them (they are the editor's then).
      return (
        user.deactivatedAt !== null &&
        user.deactivatedAt.getTime() === former.scimDeactivatedAt?.getTime()
      );
    }
    // Never a deactivated user: linking would let the directory reactivate them.
    if (user.deactivatedAt !== null) return false;
    return (
      mode === 'any' || !(await this.identities.hasAnyIdentity(tx, userId))
    );
  }

  /**
   * The address to keep for the provisioned user `before.userId`, who has `current`: the
   * directory's when it changed it and may (`addressLock`). One it did not change stays as the
   * editor has it, which an admin may have corrected. `unless` gets the conflict otherwise.
   */
  private async addressFor(
    tx: Transaction,
    input: ScimUserInput,
    before: ScimUserLink & { readonly createdByScim: boolean },
    current: string | null,
    unless: (conflict: ConflictError) => void,
  ): Promise<string | null> {
    const { email } = input;
    if (email === undefined) return current;
    if (sameAddress(email, current)) return email;
    const known = chosenAddress(before.attributes);
    if (sameAddress(email, typeof known === 'string' ? known.trim() : null)) {
      return current;
    }
    const locked = await this.addressLock(tx, before);
    if (locked !== undefined) {
      unless(
        new ConflictError(
          'scim-address-locked',
          `${locked}: their email address is changed in the editor, not by a directory.`,
        ),
      );
      return current;
    }
    if (
      email !== null &&
      (await this.admin.emailTaken(tx, email, before.userId))
    ) {
      unless(emailTaken());
      return current;
    }
    return email;
  }

  /**
   * Why a directory does not change the address of the provisioned user; undefined when it does.
   * Whoever holds its token could otherwise move an account to an address of theirs and reset its
   * password. So only of a user it made who has no way in yet (a provider's identity, a password,
   * a code by email: `hasAnyIdentity`), which nothing the directory does takes back, and who holds
   * nothing beyond `PLAIN`. Roles alone would not do: through its groups the directory gives and
   * takes them.
   */
  private async addressLock(
    tx: Transaction,
    { userId, createdByScim }: { userId: string; createdByScim: boolean },
  ): Promise<string | undefined> {
    if (!createdByScim) {
      return 'The directory linked this existing user rather than making it';
    }
    // Held until this commits: someone setting a first password now is waited for, or waits.
    await this.waysIn.holdPerson(tx, userId);
    if (await this.identities.hasAnyIdentity(tx, userId)) {
      return 'The user has signed in';
    }
    if (await this.privileged(tx, userId)) {
      return 'The user holds a permission beyond reading and writing content';
    }
    return undefined;
  }

  /** Whether `userId` holds a permission beyond `PLAIN`. */
  private async privileged(tx: Transaction, userId: string): Promise<boolean> {
    const held = await this.admin.heldPermissions(tx, userId);
    return [...held].some((p) => !PLAIN.has(p));
  }

  /** Deactivates the linked user `userId`, and records that the directory did. */
  private async deactivate(
    tx: Transaction,
    actor: Actor,
    userId: string,
  ): Promise<void> {
    const { deactivatedAt } = await deactivateUserIn(
      this.deactivation,
      tx,
      actor,
      userId,
      VIA,
    );
    await this.directory.markDeactivated(tx, userId, deactivatedAt);
  }

  private async insertUser(
    tx: Transaction,
    actor: Actor,
    input: ScimUserInput,
    email: string | null,
  ): Promise<string> {
    const local = input.userName.includes('@') ? undefined : input.userName;
    const base = userIdBase({
      username: local ?? null,
      email: email ?? input.userName,
    });
    const name = nameOf(input);
    if (name === undefined) {
      throw new ScimInvalidValueError(
        'The user has no name it can be shown by.',
      );
    }
    for (const id of [
      ...userIdCandidates(base, ID_TRIES),
      `${base}-${crypto.randomUUID().slice(0, 8)}`,
    ]) {
      if (await this.admin.insertUser(tx, { id, name, email })) {
        await this.auditLog.record(tx, actor, {
          action: 'user.create',
          subject: { type: 'user', id },
          data: { ...VIA, roleIds: [] },
        });
        return id;
      }
    }
    throw new Error('No free user ID for a new user.');
  }

  /** 400 `scim-invalid-value` for a member that is no provisioned user. */
  private async checkMembers(
    tx: Transaction,
    memberIds: readonly string[],
  ): Promise<void> {
    const known = new Set(await this.directory.provisioned(tx, memberIds));
    const unknown = memberIds.filter((id) => !known.has(id));
    if (unknown.length > 0) {
      throw new ScimInvalidValueError(
        `No provisioned user ${unknown
          .slice(0, 5)
          .map((id) => `"${id}"`)
          .join(
            ', ',
          )}${unknown.length > 5 ? ' …' : ''}: a member is a user provisioned here.`,
      );
    }
  }

  /** Applies the group mappings to `userIds`; 409 `last-admin` when that leaves no admin. */
  private async reapply(
    tx: Transaction,
    actor: Actor,
    userIds: readonly string[],
  ): Promise<void> {
    let tookAdmin = false;
    for (const userId of userIds) {
      if (
        await applyGroupRolesOf(
          this.admin,
          this.mappings,
          this.auditLog,
          tx,
          actor,
          userId,
        )
      ) {
        tookAdmin = true;
      }
    }
    if (tookAdmin) await keepAnAdmin(this.admin, tx);
  }
}
