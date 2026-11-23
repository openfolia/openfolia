import type { Role } from '../../src/access/core/actor.js';
import {
  type NewServiceAccount,
  type NewServiceToken,
  type ServiceAccount,
  type ServiceAccountFilter,
  ServiceAccountStore,
  type ServiceToken,
  type TokenCredential,
} from '../../src/access/core/service-accounts.js';
import {
  paginate,
  type PageRequest,
  type Paginated,
} from '../../src/base/core/paging.js';
import type { Transaction } from '../../src/base/core/unit-of-work.js';
import { type FakeTransaction, fakeOf } from './fake-unit-of-work.js';

interface FakeAccount {
  name: string;
  description: string | null;
  deactivatedAt: Date | null;
  createdAt: Date;
  roleIds: Set<string>;
}

type FakeToken = { -readonly [K in keyof ServiceToken]: ServiceToken[K] } & {
  secretHash: string;
};

interface State {
  accounts: Map<string, FakeAccount>;
  tokens: Map<string, FakeToken>;
}

const clone = (state: State): State => ({
  accounts: new Map(
    [...state.accounts].map(([id, a]) => [
      id,
      { ...a, roleIds: new Set(a.roleIds) },
    ]),
  ),
  tokens: new Map([...state.tokens].map(([id, t]) => [id, { ...t }])),
});

/**
 * Service accounts and tokens in memory, with `FakeUnitOfWork` (a
 * transaction works on its own copy, committed on success). `roles`
 * resolves role IDs for `credential`; `touched` records `touch` calls;
 * `fail` makes `credential` reject, as a database that is down would.
 */
export class FakeServiceAccountStore extends ServiceAccountStore {
  private state: State = { accounts: new Map(), tokens: new Map() };
  private readonly open = new WeakMap<FakeTransaction, State>();
  readonly roles = new Map<string, Role>();
  readonly touched: { tokenId: string; at: Date }[] = [];
  fail: Error | undefined;

  /** Adds a committed account. */
  putAccount(
    account: NewServiceAccount & {
      roleIds?: string[];
      deactivatedAt?: Date | null;
    },
  ): void {
    this.state.accounts.set(account.id, {
      name: account.name,
      description: account.description,
      deactivatedAt: account.deactivatedAt ?? null,
      createdAt: new Date(),
      roleIds: new Set(account.roleIds ?? []),
    });
  }

  /** The committed token of `tokenId`, hash included. */
  token(tokenId: string): FakeToken | undefined {
    return this.state.tokens.get(tokenId);
  }

  /** Changes a committed token (e.g. its expiry). */
  patchToken(tokenId: string, changes: Partial<FakeToken>): void {
    const token = this.state.tokens.get(tokenId);
    if (token) Object.assign(token, changes);
  }

  /** How many committed accounts hold `roleId`. */
  holdersOf(roleId: string): number {
    return [...this.state.accounts.values()].filter((a) =>
      a.roleIds.has(roleId),
    ).length;
  }

  private in(tx: Transaction): State {
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

  async list(
    page: PageRequest,
    filter: ServiceAccountFilter = {},
  ): Promise<Paginated<ServiceAccount>> {
    const q = filter.q?.toLowerCase();
    const all = [...this.state.accounts.keys()]
      .sort()
      .map((id) => toAccount(this.state, id)!)
      .filter(
        (a) =>
          (filter.role === undefined || a.roleIds.includes(filter.role)) &&
          (filter.active === undefined ||
            (a.deactivatedAt === null) === filter.active) &&
          (q === undefined ||
            a.id.includes(q) ||
            a.name.toLowerCase().includes(q)),
      );
    return paginate(all, page);
  }

  async find(
    id: string,
    tx?: Transaction,
  ): Promise<ServiceAccount | undefined> {
    return toAccount(tx ? this.in(tx) : this.state, id);
  }

  async insert(tx: Transaction, account: NewServiceAccount): Promise<boolean> {
    const { accounts } = this.in(tx);
    if (accounts.has(account.id)) return false;
    accounts.set(account.id, {
      name: account.name,
      description: account.description,
      deactivatedAt: null,
      createdAt: fakeOf(tx).startedAt,
      roleIds: new Set(),
    });
    return true;
  }

  async update(
    tx: Transaction,
    id: string,
    changes: { readonly name: string; readonly description: string | null },
  ): Promise<void> {
    const account = this.in(tx).accounts.get(id);
    if (account) Object.assign(account, changes);
  }

  async assign(tx: Transaction, id: string, roleId: string): Promise<boolean> {
    const account = this.in(tx).accounts.get(id);
    if (!account || account.roleIds.has(roleId)) return false;
    account.roleIds.add(roleId);
    return true;
  }

  async unassign(
    tx: Transaction,
    id: string,
    roleId: string,
  ): Promise<boolean> {
    return this.in(tx).accounts.get(id)?.roleIds.delete(roleId) ?? false;
  }

  async setDeactivated(
    tx: Transaction,
    id: string,
    deactivated: boolean,
  ): Promise<Date | null> {
    const account = this.in(tx).accounts.get(id);
    if (!account) return null;
    account.deactivatedAt = deactivated ? fakeOf(tx).startedAt : null;
    return account.deactivatedAt;
  }

  async listTokens(
    id: string,
    page: PageRequest,
  ): Promise<Paginated<ServiceToken>> {
    const all = [...this.state.tokens.values()]
      .filter((t) => t.serviceAccountId === id)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map(withoutHash);
    return paginate(all, page);
  }

  async findToken(
    tx: Transaction,
    id: string,
    tokenId: string,
  ): Promise<ServiceToken | undefined> {
    const token = this.in(tx).tokens.get(tokenId);
    return token?.serviceAccountId === id ? withoutHash(token) : undefined;
  }

  async countActiveTokens(tx: Transaction, id: string): Promise<number> {
    const now = fakeOf(tx).startedAt.getTime();
    return [...this.in(tx).tokens.values()].filter(
      (t) =>
        t.serviceAccountId === id &&
        t.revokedAt === null &&
        t.expiresAt.getTime() > now,
    ).length;
  }

  async insertToken(
    tx: Transaction,
    token: NewServiceToken,
  ): Promise<ServiceToken | undefined> {
    const { tokens } = this.in(tx);
    if (tokens.has(token.id)) return undefined;
    const stored: FakeToken = {
      ...token,
      createdAt: fakeOf(tx).startedAt,
      lastUsedAt: null,
      revokedAt: null,
    };
    tokens.set(token.id, stored);
    return withoutHash(stored);
  }

  async revokeToken(tx: Transaction, tokenId: string): Promise<Date> {
    const token = this.in(tx).tokens.get(tokenId);
    if (!token) throw new Error(`No token "${tokenId}" to revoke.`);
    token.revokedAt = fakeOf(tx).startedAt;
    return token.revokedAt;
  }

  async credential(tokenId: string): Promise<TokenCredential | undefined> {
    if (this.fail) throw this.fail;
    const token = this.state.tokens.get(tokenId);
    const account = token && this.state.accounts.get(token.serviceAccountId);
    if (!token || !account) return undefined;
    return {
      token: { ...token },
      account: {
        id: token.serviceAccountId,
        deactivatedAt: account.deactivatedAt,
      },
      roles: [...account.roleIds].sort().flatMap((id) => {
        const role = this.roles.get(id);
        return role ? [role] : [];
      }),
    };
  }

  async touch(tokenId: string, at: Date): Promise<void> {
    this.touched.push({ tokenId, at });
    const token = this.state.tokens.get(tokenId);
    if (token) token.lastUsedAt = at;
  }
}

function withoutHash({ secretHash: _, ...token }: FakeToken): ServiceToken {
  return token;
}

function toAccount(state: State, id: string): ServiceAccount | undefined {
  const account = state.accounts.get(id);
  return (
    account && {
      id,
      name: account.name,
      description: account.description,
      deactivatedAt: account.deactivatedAt,
      createdAt: account.createdAt,
      roleIds: [...account.roleIds].sort(),
    }
  );
}
