import {
  type EndedSignIns,
  RefusedSignIns,
} from '../../src/access/core/refused-sign-ins.js';
import { SignInEvents } from '../../src/access/core/sign-in-events.js';
import {
  DEFAULT_SIGN_IN_RULE,
  type SignInRule,
  SignInRules,
  SignInSetup,
} from '../../src/access/core/sign-in-rules.js';
import {
  type GroupMapping,
  type GroupMappingFilter,
  GroupMappings,
  type GroupRoleChange,
} from '../../src/access/core/group-mappings.js';
import {
  type BegunSignIn,
  type ExternalIdentity,
  IdentityProvider,
  type PendingSignIn,
  SignInFailedError,
} from '../../src/access/core/identity-provider.js';
import {
  type LinkByEmail,
  type SessionLimits,
  SessionPolicy,
} from '../../src/access/core/session-policy.js';
import {
  SessionStore,
  type StoredSession,
} from '../../src/access/core/sessions.js';
import { GLOBAL_PERMISSIONS } from '../../src/access/core/permissions.js';
import { UserIdentities } from '../../src/access/core/user-identities.js';
import {
  paginate,
  type PageRequest,
  type Paginated,
} from '../../src/base/core/paging.js';
import type { Transaction } from '../../src/base/core/unit-of-work.js';
import type { FakeAccessAdmin, FakeState } from './fake-access-admin.js';
import { fakeOf } from './fake-unit-of-work.js';

const key = (issuer: string, subject: string) => `${issuer}\u0000${subject}`;

/** `UserIdentities` on `FakeAccessAdmin`'s state (its transactions too). */
export class FakeUserIdentities extends UserIdentities {
  constructor(private readonly admin: FakeAccessAdmin) {
    super();
  }

  async userOf(
    tx: Transaction,
    issuer: string,
    subject: string,
  ): Promise<string | undefined> {
    return this.admin.in(tx).identities.get(key(issuer, subject))?.userId;
  }

  /** The users with a password (#610), as `user_passwords` holds them. */
  readonly withPassword = new Set<string>();

  /** The users who signed in with a code by email (#634). */
  readonly byCode = new Set<string>();

  async recordCodeSignIn(tx: Transaction, userId: string): Promise<void> {
    fakeOf(tx).onCommit(() => this.byCode.add(userId));
  }

  async hasAnyIdentity(tx: Transaction, userId: string): Promise<boolean> {
    return (
      this.withPassword.has(userId) ||
      this.byCode.has(userId) ||
      [...this.admin.in(tx).identities.values()].some(
        (i) => i.userId === userId,
      )
    );
  }

  async hasIdentityAt(
    tx: Transaction,
    userId: string,
    issuer: string,
  ): Promise<boolean> {
    return [...this.admin.in(tx).identities.values()].some(
      (i) => i.userId === userId && i.issuer === issuer,
    );
  }

  async userWithEmail(
    tx: Transaction,
    email: string,
  ): Promise<string | undefined> {
    for (const [id, u] of this.admin.in(tx).users) {
      if (u.email?.toLowerCase() === email.toLowerCase()) return id;
    }
    return undefined;
  }

  async link(
    tx: Transaction,
    identity: {
      issuer: string;
      subject: string;
      userId: string;
      groups: readonly string[];
    },
  ): Promise<void> {
    const state = this.admin.in(tx);
    const k = key(identity.issuer, identity.subject);
    if (state.identities.has(k)) throw new Error('identity linked already');
    state.identities.set(k, { ...identity, groups: [...identity.groups] });
  }

  async recordSignIn(
    tx: Transaction,
    issuer: string,
    subject: string,
    groups: readonly string[],
  ): Promise<void> {
    const identity = this.admin.in(tx).identities.get(key(issuer, subject));
    if (identity) identity.groups = [...groups];
  }
}

function apply(state: FakeState, userId: string): GroupRoleChange {
  const user = state.users.get(userId);
  if (!user) return { assigned: [], unassigned: [] };
  const groups = new Set(
    [...state.identities.values()]
      .filter((i) => i.userId === userId)
      .flatMap((i) => i.groups),
  );
  // And its SCIM groups (#377), by name, for roles holding no global permission.
  const scimGroups = new Set(
    [...state.scimGroups.values()]
      .filter((g) => g.members.has(userId))
      .map((g) => g.displayName),
  );
  const global = (roleId: string) =>
    (state.roles.get(roleId)?.permissions ?? []).some((p) =>
      GLOBAL_PERMISSIONS.has(p),
    );
  const want = new Set(
    [...state.mappings.values()]
      .filter(
        (m) =>
          groups.has(m.group) || (scimGroups.has(m.group) && !global(m.roleId)),
      )
      .map((m) => m.roleId),
  );
  const assigned = [...want].filter((id) => !user.groupRoleIds.has(id)).sort();
  const unassigned = [...user.groupRoleIds]
    .filter((id) => !want.has(id))
    .sort();
  user.groupRoleIds = want;
  return { assigned, unassigned };
}

/** `GroupMappings` on `FakeAccessAdmin`'s state (its transactions too). */
export class FakeGroupMappings extends GroupMappings {
  private next = 0;

  constructor(private readonly admin: FakeAccessAdmin) {
    super();
  }

  async list(
    page: PageRequest,
    filter: GroupMappingFilter = {},
  ): Promise<Paginated<GroupMapping>> {
    const all = [...this.admin.committed.mappings.values()]
      .filter(
        (m) =>
          (filter.group === undefined || m.group === filter.group) &&
          (filter.role === undefined || m.roleId === filter.role),
      )
      .sort((a, b) =>
        a.group === b.group
          ? a.roleId < b.roleId
            ? -1
            : 1
          : a.group < b.group
            ? -1
            : 1,
      );
    return paginate(all, page);
  }

  async find(id: string, tx?: Transaction): Promise<GroupMapping | undefined> {
    return (tx ? this.admin.in(tx) : this.admin.committed).mappings.get(id);
  }

  async insert(
    tx: Transaction,
    group: string,
    roleId: string,
  ): Promise<GroupMapping | undefined> {
    const { mappings } = this.admin.in(tx);
    if (
      [...mappings.values()].some(
        (m) => m.group === group && m.roleId === roleId,
      )
    ) {
      return undefined;
    }
    const id = `00000000-0000-4000-8000-${String(++this.next).padStart(12, '0')}`;
    const mapping = { id, group, roleId, createdAt: fakeOf(tx).startedAt };
    mappings.set(id, mapping);
    return mapping;
  }

  async delete(tx: Transaction, id: string): Promise<GroupMapping | undefined> {
    const { mappings } = this.admin.in(tx);
    const mapping = mappings.get(id);
    mappings.delete(id);
    return mapping;
  }

  async countForRole(tx: Transaction, roleId: string): Promise<number> {
    return [...this.admin.in(tx).mappings.values()].filter(
      (m) => m.roleId === roleId,
    ).length;
  }

  async groupsForRole(
    tx: Transaction,
    roleId: string,
  ): Promise<readonly string[]> {
    return [...this.admin.in(tx).mappings.values()]
      .filter((m) => m.roleId === roleId)
      .map((m) => m.group)
      .sort();
  }

  async usersInGroup(
    tx: Transaction,
    group: string,
  ): Promise<readonly string[]> {
    const state = this.admin.in(tx);
    return [
      ...new Set([
        ...[...state.identities.values()]
          .filter((i) => i.groups.includes(group))
          .map((i) => i.userId),
        ...[...state.scimGroups.values()]
          .filter((g) => g.displayName === group)
          .flatMap((g) => [...g.members]),
      ]),
    ].sort();
  }

  async applyGroupRoles(
    tx: Transaction,
    userId: string,
  ): Promise<GroupRoleChange> {
    return apply(this.admin.in(tx), userId);
  }
}

/** Sessions in memory; writes in a transaction apply when it commits. */
export class FakeSessionStore extends SessionStore {
  readonly sessions = new Map<string, StoredSession>();
  now: () => number = Date.now;

  async find(hash: string): Promise<StoredSession | undefined> {
    return this.sessions.get(hash);
  }

  async create(
    tx: Transaction,
    session: {
      hash: string;
      userId: string;
      provider: string;
      endedBefore: Date;
    },
  ): Promise<void> {
    fakeOf(tx).onCommit(() => {
      for (const [hash, s] of this.sessions) {
        if (
          s.userId === session.userId &&
          (s.revokedAt !== null || s.createdAt < session.endedBefore)
        ) {
          this.sessions.delete(hash);
        }
      }
      const at = new Date(this.now());
      this.sessions.set(session.hash, {
        hash: session.hash,
        userId: session.userId,
        provider: session.provider,
        createdAt: at,
        lastSeenAt: at,
        revokedAt: null,
      });
    });
  }

  async touch(hash: string, at: Date): Promise<void> {
    const s = this.sessions.get(hash);
    if (s && s.revokedAt === null)
      this.sessions.set(hash, { ...s, lastSeenAt: at });
  }

  async revoke(hash: string, tx?: Transaction): Promise<boolean> {
    const s = this.sessions.get(hash);
    if (!s || s.revokedAt !== null) return false;
    const end = () =>
      this.sessions.set(hash, { ...s, revokedAt: new Date(this.now()) });
    if (tx) fakeOf(tx).onCommit(end);
    else end();
    return true;
  }

  async revokeAllOf(
    tx: Transaction,
    userId: string,
    exceptHash?: string,
  ): Promise<number> {
    const running = [...this.sessions.values()].filter(
      (s) =>
        s.userId === userId && s.revokedAt === null && s.hash !== exceptHash,
    );
    fakeOf(tx).onCommit(() => {
      for (const s of running) {
        this.sessions.set(s.hash, { ...s, revokedAt: new Date(this.now()) });
      }
    });
    return running.length;
  }
}

/** A session policy with fixed limits, refusing whom `refuse` names. */
export class FakeSessionPolicy extends SessionPolicy {
  refuse = new Set<string>();
  /** Single sign-on is required (#378): `refuse` says of whom. */
  required = false;
  linking: LinkByEmail = 'pending';

  constructor(
    public fixed: SessionLimits = { idleMs: 3_600_000, maxMs: 86_400_000 },
  ) {
    super();
  }

  async limits(): Promise<SessionLimits> {
    return this.fixed;
  }

  async maySignIn(userId: string): Promise<boolean> {
    return !this.refuse.has(userId);
  }

  async requiresSingleSignOn(): Promise<boolean> {
    return this.required;
  }

  linkByEmail(): LinkByEmail {
    return this.linking;
  }
}

/** `SignInEvents` in memory: who used the break-glass account. */
export class FakeSignInEvents extends SignInEvents {
  readonly used: string[] = [];

  async breakGlassUsed(_tx: Transaction, userId: string): Promise<void> {
    this.used.push(userId);
  }
}

/** The rule about signing in (#378), as a test sets it. */
export class FakeSignInRules extends SignInRules {
  rule: SignInRule = DEFAULT_SIGN_IN_RULE;
  /** Why a user could not be the break-glass account; anyone not named could. */
  readonly problems = new Map<
    string,
    Awaited<ReturnType<SignInRules['breakGlassProblem']>>
  >();

  async read(): Promise<SignInRule> {
    return this.rule;
  }

  readFor(): Promise<SignInRule> {
    return this.read();
  }

  async breakGlassProblem(userId: string) {
    return this.problems.get(userId) ?? null;
  }
}

/** A server set up with one provider and the default session limits. */
export class FakeSignInSetup extends SignInSetup {
  sessionIdleMinutes = 480;
  sessionMaxHours = 168;
  offered: readonly string[] = ['oidc'];
}

/** `RefusedSignIns` that only records what it was asked to end. */
export class FakeRefusedSignIns extends RefusedSignIns {
  readonly asked: Parameters<RefusedSignIns['end']>[1][] = [];
  next: EndedSignIns = { sessions: 0, secondSteps: 0, links: 0, emailCodes: 0 };
  /** Thrown from the call with this index on. */
  failFrom = Number.POSITIVE_INFINITY;

  async end(
    _tx: Transaction,
    refused: Parameters<RefusedSignIns['end']>[1],
  ): Promise<EndedSignIns> {
    if (this.asked.length >= this.failFrom) throw new Error('interrupted');
    this.asked.push(refused);
    return this.next;
  }

  /** Whose password ways in were ended, and the session kept. */
  readonly passwordsOf: (readonly [string, string | undefined])[] = [];

  async hold(): Promise<void> {
    // One transaction at a time here.
  }

  async endPasswordsOf(_tx: Transaction, userId: string, keep?: string) {
    this.passwordsOf.push([userId, keep]);
    return { sessions: 0, secondSteps: 0, links: 0, emailCodes: 0 };
  }
}

/**
 * An identity provider answering whatever `next` holds: `complete` checks
 * the pending state against the callback's `state`, as a real one does.
 */
export class FakeIdentityProvider extends IdentityProvider {
  readonly id = 'oidc';
  readonly displayName = 'Test provider';
  next: ExternalIdentity | SignInFailedError = {
    issuer: 'https://idp.example.org',
    subject: 'sub-1',
    email: 'pat@example.org',
    emailVerified: true,
    name: 'Pat Example',
    username: 'pat',
    groups: [],
  };
  signOut: string | undefined = 'https://idp.example.org/logout';

  async begin(): Promise<BegunSignIn> {
    return {
      authorizationUrl: 'https://idp.example.org/authorize?state=s1',
      pending: { state: 's1' },
    };
  }

  async complete(
    callback: URLSearchParams,
    pending: PendingSignIn,
  ): Promise<ExternalIdentity> {
    if (callback.get('state') !== pending['state']) {
      throw new SignInFailedError('sign-in-failed', 'state mismatch');
    }
    if (this.next instanceof SignInFailedError) throw this.next;
    return this.next;
  }

  async signOutUrl(returnTo: string): Promise<string | undefined> {
    return (
      this.signOut &&
      `${this.signOut}?post_logout_redirect_uri=${encodeURIComponent(returnTo)}`
    );
  }
}
