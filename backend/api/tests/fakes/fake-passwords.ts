import {
  normalizePassword,
  type PasswordCredentials,
  PasswordHasher,
  PasswordSignIn,
  PasswordStore,
} from '../../src/access/core/passwords.js';
import {
  type SignInLinkKind,
  SignInLinks,
  type StoredSignInLink,
} from '../../src/access/core/sign-in-links.js';
import type { Transaction } from '../../src/base/core/unit-of-work.js';
import type { FakeAccessAdmin } from './fake-access-admin.js';
import { fakeOf } from './fake-unit-of-work.js';

/**
 * A hasher without the cost: `fake$<version>$<password>`, so a test reads what was set.
 * `version` stands for the parameters: a hash of another version `needsRehash`. Counts its
 * checks, so a test sees an unknown address checked like a known one.
 */
export class FakePasswordHasher extends PasswordHasher {
  version = 1;
  verified = 0;
  nothings = 0;

  async hash(password: string): Promise<string> {
    return `fake$${this.version}$${normalizePassword(password)}`;
  }

  async verify(stored: string, password: string): Promise<boolean> {
    this.verified++;
    const match = /^fake\$(\d+)\$(.*)$/s.exec(stored);
    return match !== null && match[2] === normalizePassword(password);
  }

  needsRehash(stored: string): boolean {
    return !stored.startsWith(`fake$${this.version}$`);
  }

  async verifyNothing(): Promise<void> {
    this.nothings++;
  }
}

/** Password sign-in's settings, set by the test (on, a week's invites, a link base). */
export class FakePasswordSignIn extends PasswordSignIn {
  enabled = true;
  inviteMs = 7 * 24 * 60 * 60 * 1000;
  linkBase: string | null = 'https://docs.example.com/';
}

/** Hashes on `FakeAccessAdmin`'s users; writes in a transaction apply when it commits. */
export class FakePasswordStore extends PasswordStore {
  readonly hashes = new Map<string, string>();

  constructor(private readonly admin: FakeAccessAdmin) {
    super();
  }

  async findByEmail(email: string): Promise<PasswordCredentials | undefined> {
    for (const [id, user] of this.admin.committed.users) {
      if (user.email?.toLowerCase() !== email.toLowerCase()) continue;
      const hash = this.hashes.get(id);
      return hash === undefined
        ? undefined
        : {
            userId: id,
            email: user.email,
            hash,
            deactivatedAt: user.deactivatedAt,
          };
    }
    return undefined;
  }

  async hashOf(userId: string): Promise<string | undefined> {
    return this.hashes.get(userId);
  }

  async set(tx: Transaction, userId: string, hash: string): Promise<void> {
    fakeOf(tx).onCommit(() => this.hashes.set(userId, hash));
  }

  async replaceIf(
    tx: Transaction,
    userId: string,
    previous: string,
    next: string,
  ): Promise<boolean> {
    if (this.hashes.get(userId) !== previous) return false;
    fakeOf(tx).onCommit(() => {
      if (this.hashes.get(userId) === previous) this.hashes.set(userId, next);
    });
    return true;
  }
}

/** Links in memory, one per user; writes in a transaction apply when it commits. */
export class FakeSignInLinks extends SignInLinks {
  readonly links = new Map<string, StoredSignInLink>();
  now: () => number = Date.now;

  async replace(
    tx: Transaction,
    link: {
      hash: string;
      userId: string;
      kind: SignInLinkKind;
      expiresAt: Date;
    },
  ): Promise<number> {
    const earlier = [...this.links.values()].filter(
      (l) => l.userId === link.userId,
    );
    fakeOf(tx).onCommit(() => {
      for (const l of earlier) this.links.delete(l.hash);
      this.links.set(link.hash, { ...link, createdAt: new Date(this.now()) });
    });
    return earlier.length;
  }

  async find(hash: string): Promise<StoredSignInLink | undefined> {
    return this.links.get(hash);
  }

  async take(
    tx: Transaction,
    hash: string,
  ): Promise<StoredSignInLink | undefined> {
    const link = this.links.get(hash);
    if (link) fakeOf(tx).onCommit(() => this.links.delete(hash));
    return link;
  }

  async revokeAll(
    tx: Transaction,
    userId: string,
    kind?: SignInLinkKind,
  ): Promise<number> {
    const these = [...this.links.values()].filter(
      (l) => l.userId === userId && (kind === undefined || l.kind === kind),
    );
    fakeOf(tx).onCommit(() => {
      for (const l of these) this.links.delete(l.hash);
    });
    return these.length;
  }

  async linkOf(
    _tx: Transaction,
    userId: string,
  ): Promise<StoredSignInLink | undefined> {
    return [...this.links.values()].find((l) => l.userId === userId);
  }
}
