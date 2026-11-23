import {
  AccessAdmin,
  type NewUser,
  type RoleDefinition,
  type StoredRole,
} from '../../src/access/core/access-admin.js';
import { heldPermissions } from '../../src/access/core/effective-permissions.js';
import type { GroupMapping } from '../../src/access/core/group-mappings.js';
import type { User } from '../../src/access/core/user-directory.js';
import {
  paginate,
  type PageRequest,
  type Paginated,
} from '../../src/base/core/paging.js';
import type { Transaction } from '../../src/base/core/unit-of-work.js';
import { type FakeTransaction, fakeOf } from './fake-unit-of-work.js';

interface FakeUser {
  name: string;
  email: string | null;
  deactivatedAt: Date | null;
  /** Assigned directly. */
  roleIds: Set<string>;
  /** Held through groups (#37). */
  groupRoleIds: Set<string>;
}

/** A user's identity at a provider (#37), by `issuer\u0000subject`. */
export interface FakeIdentity {
  issuer: string;
  subject: string;
  userId: string;
  groups: string[];
}

export interface FakeState {
  roles: Map<string, RoleDefinition>;
  users: Map<string, FakeUser>;
  identities: Map<string, FakeIdentity>;
  mappings: Map<string, GroupMapping>;
}

const clone = (state: FakeState): FakeState => ({
  roles: new Map(state.roles),
  users: new Map(
    [...state.users].map(([id, u]) => [
      id,
      {
        ...u,
        roleIds: new Set(u.roleIds),
        groupRoleIds: new Set(u.groupRoleIds),
      },
    ]),
  ),
  identities: new Map(
    [...state.identities].map(([k, i]) => [k, { ...i, groups: [...i.groups] }]),
  ),
  mappings: new Map(state.mappings),
});

const heldRoles = (u: FakeUser) => new Set([...u.roleIds, ...u.groupRoleIds]);

/**
 * Roles and users in memory, with `FakeUnitOfWork`: a transaction works on
 * its own copy (it reads its own writes), which replaces the committed state
 * when it commits, as a rolled-back one leaves nothing behind. `locked`
 * counts the transactions that took the access lock.
 */
export class FakeAccessAdmin extends AccessAdmin {
  private state: FakeState = {
    roles: new Map(),
    users: new Map(),
    identities: new Map(),
    mappings: new Map(),
  };
  private readonly open = new WeakMap<FakeTransaction, FakeState>();
  locked = 0;
  /** Service accounts holding each role, as `serviceAccountHolders` reads it. */
  readonly serviceAccountRoles = new Map<string, number>();

  /** Adds a committed role (holders are counted from the users). */
  putRole(role: RoleDefinition): void {
    this.state.roles.set(role.id, role);
  }

  /** Adds a committed user holding `roleIds`. */
  putUser(
    user: NewUser & { roleIds?: string[]; deactivatedAt?: Date | null },
  ): void {
    this.state.users.set(user.id, {
      name: user.name,
      email: user.email,
      deactivatedAt: user.deactivatedAt ?? null,
      roleIds: new Set(user.roleIds ?? []),
      groupRoleIds: new Set(),
    });
  }

  /** The committed state (sign-in's fakes share it, #37). */
  get committed(): FakeState {
    return this.state;
  }

  /** The committed user, as `findUser` reads it. */
  user(userId: string): User | undefined {
    return toUser(this.state, userId);
  }

  /** The committed role. */
  role(roleId: string): StoredRole | undefined {
    return toStored(this.state, roleId);
  }

  /** The state `tx` works on (sign-in's fakes share it, #37). */
  in(tx: Transaction): FakeState {
    const transaction = fakeOf(tx);
    let state = this.open.get(transaction);
    if (!state) {
      const copy = clone(this.state);
      state = copy;
      this.open.set(transaction, copy);
      transaction.onCommit(() => {
        this.state = copy;
      });
    }
    return state;
  }

  async lock(tx: Transaction): Promise<void> {
    this.in(tx);
    this.locked++;
  }

  async listRoles(page: PageRequest): Promise<Paginated<StoredRole>> {
    const all = [...this.state.roles.values()]
      .sort((a, b) =>
        a.name === b.name ? (a.id < b.id ? -1 : 1) : a.name < b.name ? -1 : 1,
      )
      .map((r) => toStored(this.state, r.id)!);
    return paginate(all, page);
  }

  async findRole(
    roleId: string,
    tx?: Transaction,
  ): Promise<StoredRole | undefined> {
    return toStored(tx ? this.in(tx) : this.state, roleId);
  }

  async missingRoles(
    tx: Transaction,
    roleIds: readonly string[],
  ): Promise<string[]> {
    const { roles } = this.in(tx);
    return roleIds.filter((id) => !roles.has(id));
  }

  async insertRole(tx: Transaction, role: RoleDefinition): Promise<boolean> {
    const { roles } = this.in(tx);
    if (roles.has(role.id)) return false;
    roles.set(role.id, role);
    return true;
  }

  async updateRole(tx: Transaction, role: RoleDefinition): Promise<void> {
    this.in(tx).roles.set(role.id, role);
  }

  async deleteRole(tx: Transaction, roleId: string): Promise<void> {
    this.in(tx).roles.delete(roleId);
  }

  async findUser(tx: Transaction, userId: string): Promise<User | undefined> {
    return toUser(this.in(tx), userId);
  }

  async emailTaken(
    tx: Transaction,
    email: string,
    exceptUserId?: string,
  ): Promise<boolean> {
    return [...this.in(tx).users].some(
      ([id, u]) =>
        id !== exceptUserId && u.email?.toLowerCase() === email.toLowerCase(),
    );
  }

  async insertUser(tx: Transaction, user: NewUser): Promise<boolean> {
    const { users } = this.in(tx);
    if (users.has(user.id)) return false;
    users.set(user.id, {
      name: user.name,
      email: user.email,
      deactivatedAt: null,
      roleIds: new Set(),
      groupRoleIds: new Set(),
    });
    return true;
  }

  async updateUser(
    tx: Transaction,
    userId: string,
    changes: { readonly name: string; readonly email: string | null },
  ): Promise<void> {
    const user = this.in(tx).users.get(userId);
    if (user) Object.assign(user, changes);
  }

  async assign(
    tx: Transaction,
    userId: string,
    roleId: string,
  ): Promise<boolean> {
    const user = this.in(tx).users.get(userId);
    if (!user || user.roleIds.has(roleId)) return false;
    user.roleIds.add(roleId);
    return true;
  }

  async unassign(
    tx: Transaction,
    userId: string,
    roleId: string,
  ): Promise<boolean> {
    return this.in(tx).users.get(userId)?.roleIds.delete(roleId) ?? false;
  }

  async setDeactivated(
    tx: Transaction,
    userId: string,
    deactivated: boolean,
  ): Promise<Date | null> {
    const user = this.in(tx).users.get(userId);
    if (!user) return null;
    user.deactivatedAt = deactivated ? fakeOf(tx).startedAt : null;
    return user.deactivatedAt;
  }

  async heldPermissions(
    tx: Transaction,
    userId: string,
  ): Promise<ReadonlySet<string>> {
    const state = this.in(tx);
    const user = state.users.get(userId);
    return new Set(
      [...(user ? heldRoles(user) : [])].flatMap(
        (id) => state.roles.get(id)?.permissions ?? [],
      ),
    );
  }

  async serviceAccountHolders(
    tx: Transaction,
    roleId: string,
  ): Promise<number> {
    this.in(tx);
    return this.serviceAccountRoles.get(roleId) ?? 0;
  }

  async countActiveAdmins(tx: Transaction): Promise<number> {
    const state = this.in(tx);
    return [...state.users.values()].filter(
      (u) =>
        u.deactivatedAt === null &&
        [...heldRoles(u)].some((id) =>
          state.roles.get(id)?.permissions.includes('admin.roles'),
        ),
    ).length;
  }
}

function toUser(state: FakeState, userId: string): User | undefined {
  const user = state.users.get(userId);
  return (
    user && {
      id: userId,
      name: user.name,
      email: user.email,
      deactivatedAt: user.deactivatedAt,
      roleIds: [...heldRoles(user)].sort(),
      groupRoleIds: [...user.groupRoleIds]
        .filter((id) => !user.roleIds.has(id))
        .sort(),
      permissions: heldPermissions(
        [...heldRoles(user)].flatMap((id) => {
          const role = state.roles.get(id);
          return role ? [role] : [];
        }),
      ),
    }
  );
}

function toStored(state: FakeState, roleId: string): StoredRole | undefined {
  const role = state.roles.get(roleId);
  if (!role) return undefined;
  const holders = [...state.users.values()].filter((u) =>
    heldRoles(u).has(roleId),
  ).length;
  return { ...role, holders };
}
