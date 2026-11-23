import type { Actor } from '../../src/access/core/actor.js';
import { heldPermissions } from '../../src/access/core/effective-permissions.js';
import type { Transaction } from '../../src/base/core/unit-of-work.js';
import { fakeOf } from './fake-unit-of-work.js';
import {
  type User,
  UserDirectory,
  type UserFilter,
} from '../../src/access/core/user-directory.js';
import {
  paginate,
  type PageRequest,
  type Paginated,
} from '../../src/base/core/paging.js';

/**
 * Users held in memory: the actors it was given, by ID, named by `names`
 * (default: the ID). `fail` makes every call reject, as a database that is
 * down would.
 */
export class FakeUserDirectory extends UserDirectory {
  private readonly actors: Map<string, Actor>;
  /** Users' email addresses, by ID (none unless set). */
  readonly emails = new Map<string, string>();
  /** Users deactivated (`findActor` gives none of them; `findUser` does). */
  readonly deactivated = new Map<string, Date>();
  fail: Error | undefined;

  constructor(
    actors: readonly Actor[] = [],
    private readonly names: Readonly<Record<string, string>> = {},
  ) {
    super();
    this.actors = new Map(actors.map((a) => [a.id, a]));
  }

  /** Adds `actor`, or replaces the user of its ID (a role change); `remove` drops one. */
  put(actor: Actor): void {
    this.actors.set(actor.id, actor);
  }

  remove(userId: string): void {
    this.actors.delete(userId);
  }

  async findActor(
    userId: string,
    tx?: Transaction,
  ): Promise<Actor | undefined> {
    if (tx) fakeOf(tx);
    if (this.fail) throw this.fail;
    return this.deactivated.has(userId) ? undefined : this.actors.get(userId);
  }

  async findUser(userId: string): Promise<User | undefined> {
    if (this.fail) throw this.fail;
    const actor = this.actors.get(userId);
    return actor && this.toUser(actor);
  }

  async listUsers(
    page: PageRequest,
    filter: UserFilter = {},
  ): Promise<Paginated<User>> {
    if (this.fail) throw this.fail;
    const all = [...this.actors.values()]
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .map((actor) => this.toUser(actor))
      .filter(
        (u) =>
          (filter.active === undefined ||
            filter.active === (u.deactivatedAt === null)) &&
          (filter.role === undefined || u.roleIds.includes(filter.role)) &&
          (filter.q === undefined ||
            [u.id, u.name, u.email ?? ''].some((v) =>
              v.toLowerCase().includes(filter.q!.toLowerCase()),
            )),
      );
    return paginate(all, page);
  }

  private toUser(actor: Actor): User {
    return {
      id: actor.id,
      name: this.names[actor.id] ?? actor.id,
      email: this.emails.get(actor.id) ?? null,
      deactivatedAt: this.deactivated.get(actor.id) ?? null,
      roleIds: actor.roles.map((r) => r.id).sort(),
      groupRoleIds: [],
      permissions: heldPermissions(actor.roles),
    };
  }
}
