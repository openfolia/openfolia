import type { Transaction } from '../../src/base/core/unit-of-work.js';
import {
  ScimDirectory,
  type ScimUserLink,
} from '../../src/scim/core/scim-directory.js';
import type {
  ScimGroup,
  ScimUser,
} from '../../src/scim/core/scim-resources.js';
import type { FakeAccessAdmin, FakeState } from './fake-access-admin.js';
import { fakeOf } from './fake-unit-of-work.js';

/** `ScimDirectory` on `FakeAccessAdmin`'s state (its transactions too), as group mappings read it. */
export class FakeScimDirectory extends ScimDirectory {
  private next = 0;

  constructor(private readonly admin: FakeAccessAdmin) {
    super();
  }

  private state(tx?: Transaction): FakeState {
    return tx ? this.admin.in(tx) : this.admin.committed;
  }

  private toUser(state: FakeState, userId: string): ScimUser | undefined {
    const link = state.scimUsers.get(userId);
    const user = state.users.get(userId);
    if (!link || link.unlinked || !user) return undefined;
    return {
      userId,
      userName: link.userName,
      externalId: link.externalId,
      attributes: structuredClone(link.attributes),
      deactivatedAt: user.deactivatedAt,
      createdByScim: link.createdByScim,
      scimDeactivatedAt: link.scimDeactivatedAt,
      createdAt: link.createdAt,
      updatedAt: link.updatedAt,
      groups: [...state.scimGroups]
        .filter(([, g]) => g.members.has(userId))
        .map(([id, g]) => ({ id, displayName: g.displayName }))
        .sort((a, b) => (a.displayName < b.displayName ? -1 : 1)),
    };
  }

  private toGroup(state: FakeState, id: string): ScimGroup | undefined {
    const group = state.scimGroups.get(id);
    if (!group) return undefined;
    return {
      id,
      displayName: group.displayName,
      externalId: group.externalId,
      createdAt: group.createdAt,
      updatedAt: group.updatedAt,
      members: [...group.members].sort().map((userId) => ({
        userId,
        name: state.users.get(userId)?.name ?? userId,
      })),
    };
  }

  async listUsers(): Promise<ScimUser[]> {
    const state = this.state();
    return [...state.scimUsers.keys()]
      .sort()
      .map((id) => this.toUser(state, id)!)
      .filter(Boolean);
  }

  async findUser(
    userId: string,
    tx?: Transaction,
  ): Promise<ScimUser | undefined> {
    return this.toUser(this.state(tx), userId);
  }

  async userNamed(
    tx: Transaction,
    userName: string,
  ): Promise<string | undefined> {
    for (const [id, link] of this.state(tx).scimUsers) {
      if (link.unlinked) continue;
      if (link.userName.toLowerCase() === userName.toLowerCase()) return id;
    }
    return undefined;
  }

  async link(
    tx: Transaction,
    link: ScimUserLink & { readonly createdByScim: boolean },
  ): Promise<void> {
    const state = this.state(tx);
    const former = state.scimUsers.get(link.userId);
    if (former && !former.unlinked) throw new Error('linked already');
    const at = fakeOf(tx).startedAt;
    state.scimUsers.set(link.userId, {
      userName: link.userName,
      externalId: link.externalId,
      attributes: structuredClone(link.attributes),
      createdByScim: former?.createdByScim ?? link.createdByScim,
      scimDeactivatedAt: former?.scimDeactivatedAt ?? null,
      unlinked: false,
      createdAt: former?.createdAt ?? at,
      updatedAt: at,
    });
  }

  async formerLink(tx: Transaction, userId: string) {
    const link = this.state(tx).scimUsers.get(userId);
    return link?.unlinked
      ? {
          createdByScim: link.createdByScim,
          scimDeactivatedAt: link.scimDeactivatedAt,
        }
      : undefined;
  }

  async markDeactivated(
    tx: Transaction,
    userId: string,
    at: Date | null,
  ): Promise<void> {
    const current = this.state(tx).scimUsers.get(userId);
    if (!current) throw new Error('not linked');
    current.scimDeactivatedAt = at;
  }

  async update(tx: Transaction, link: ScimUserLink): Promise<void> {
    const state = this.state(tx);
    const current = state.scimUsers.get(link.userId);
    if (!current) throw new Error('not linked');
    state.scimUsers.set(link.userId, {
      ...current,
      userName: link.userName,
      externalId: link.externalId,
      attributes: structuredClone(link.attributes),
      updatedAt: fakeOf(tx).startedAt,
    });
  }

  async unlink(tx: Transaction, userId: string): Promise<void> {
    const state = this.state(tx);
    const link = state.scimUsers.get(userId);
    if (link) link.unlinked = true;
    for (const group of state.scimGroups.values()) group.members.delete(userId);
  }

  async provisioned(
    tx: Transaction,
    userIds: readonly string[],
  ): Promise<string[]> {
    const state = this.state(tx);
    return userIds.filter((id) => state.scimUsers.get(id)?.unlinked === false);
  }

  async listGroups(): Promise<ScimGroup[]> {
    const state = this.state();
    return [...state.scimGroups.keys()]
      .map((id) => this.toGroup(state, id)!)
      .sort((a, b) => (a.displayName < b.displayName ? -1 : 1));
  }

  async findGroup(
    id: string,
    tx?: Transaction,
  ): Promise<ScimGroup | undefined> {
    return this.toGroup(this.state(tx), id);
  }

  async groupNamed(
    tx: Transaction,
    displayName: string,
  ): Promise<string | undefined> {
    for (const [id, group] of this.state(tx).scimGroups) {
      if (group.displayName === displayName) return id;
    }
    return undefined;
  }

  async insertGroup(
    tx: Transaction,
    group: { displayName: string; externalId: string | null },
  ): Promise<string> {
    const id = `00000000-0000-4000-8000-${String(++this.next).padStart(12, '0')}`;
    const at = fakeOf(tx).startedAt;
    this.state(tx).scimGroups.set(id, {
      displayName: group.displayName,
      externalId: group.externalId,
      members: new Set(),
      createdAt: at,
      updatedAt: at,
    });
    return id;
  }

  async updateGroup(
    tx: Transaction,
    id: string,
    group: { displayName: string; externalId: string | null },
  ): Promise<void> {
    const current = this.state(tx).scimGroups.get(id);
    if (!current) throw new Error('no group');
    current.displayName = group.displayName;
    current.externalId = group.externalId;
    current.updatedAt = fakeOf(tx).startedAt;
  }

  async setMembers(
    tx: Transaction,
    id: string,
    userIds: readonly string[],
  ): Promise<{ added: string[]; removed: string[] }> {
    const group = this.state(tx).scimGroups.get(id);
    if (!group) throw new Error('no group');
    const wanted = new Set(userIds);
    const added = [...wanted].filter((u) => !group.members.has(u)).sort();
    const removed = [...group.members].filter((u) => !wanted.has(u)).sort();
    group.members = wanted;
    return { added, removed };
  }

  async deleteGroup(tx: Transaction, id: string): Promise<string[]> {
    const state = this.state(tx);
    const members = [...(state.scimGroups.get(id)?.members ?? [])].sort();
    state.scimGroups.delete(id);
    return members;
  }
}
