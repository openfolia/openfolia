import { createHash } from 'node:crypto';
import {
  EMAIL_CODE_MAX_FAILURES,
  type EmailCodeHolder,
  EmailCodeHasher,
  EmailCodes,
  EmailCodeSignIn,
  type StoredEmailCode,
} from '../../src/access/core/email-codes.js';
import {
  type PasswordAttempt,
  PasswordAttempts,
} from '../../src/access/core/password-attempts.js';
import type { Transaction } from '../../src/base/core/unit-of-work.js';
import type { FakeAccessAdmin } from './fake-access-admin.js';
import { fakeOf } from './fake-unit-of-work.js';

/** Codes by email's settings, set by the test (on, 10 minutes, a link base). */
export class FakeEmailCodeSignIn extends EmailCodeSignIn {
  enabled = true;
  lifetimeMs = 10 * 60_000;
  linkBase: string | null = 'https://docs.example.com/';
}

/** A keyed hash without the key's origin: SHA-256 of a fixed key, the user and the code. */
export class FakeEmailCodeHasher extends EmailCodeHasher {
  available = true;
  hashed = 0;

  hash(userId: string, code: string): string {
    if (!this.available) throw new Error('No key.');
    this.hashed++;
    return createHash('sha256')
      .update(`fake-key\n${userId}\n${code}`)
      .digest('hex');
  }
}

/** Codes in memory, one per user, over `FakeAccessAdmin`'s users; writes apply on commit. */
export class FakeEmailCodes extends EmailCodes {
  readonly codes = new Map<string, StoredEmailCode>();
  readonly failures = new Map<string, number>();
  now: () => number = Date.now;
  lookups = 0;

  constructor(private readonly admin: FakeAccessAdmin) {
    super();
  }

  /** The users held so far (`hold`, `holdToEnd`); the fake runs one transaction at a time. */
  readonly held: string[] = [];

  async hold(_tx: Transaction, userId: string): Promise<void> {
    this.held.push(userId);
  }

  async holdToEnd(_tx: Transaction, userId: string): Promise<void> {
    this.held.push(userId);
  }

  async replace(
    tx: Transaction,
    code: {
      userId: string;
      codeHash: string;
      linkHash: string;
      sentTo: string;
      expiresAt: Date;
    },
  ): Promise<boolean> {
    // Only while the address is still theirs (#646), as the store checks it.
    if (
      !this.mailedToTheirs(code) ||
      this.admin.committed.users.get(code.userId)?.deactivatedAt != null
    ) {
      return false;
    }
    fakeOf(tx).onCommit(() => {
      this.codes.set(code.userId, { ...code, createdAt: new Date(this.now()) });
      this.failures.set(code.userId, 0);
    });
    return true;
  }

  /** Claims that returned a code: the comparisons the store let happen. */
  granted = 0;

  async claim(email: string, now: Date): Promise<EmailCodeHolder | undefined> {
    this.lookups++;
    const id = this.userWith(email);
    const code = id === undefined ? undefined : this.codes.get(id);
    const user =
      id === undefined ? undefined : this.admin.committed.users.get(id);
    const tries = id === undefined ? 0 : (this.failures.get(id) ?? 0);
    if (
      !code ||
      !user ||
      !this.mailedToTheirs(code) ||
      code.expiresAt.getTime() <= now.getTime() ||
      tries >= EMAIL_CODE_MAX_FAILURES
    ) {
      return undefined;
    }
    // Counted at once, before any await: like the store's one statement.
    this.failures.set(code.userId, tries + 1);
    this.granted++;
    return {
      userId: code.userId,
      codeHash: code.codeHash,
      expiresAt: code.expiresAt,
      tries: tries + 1,
      deactivatedAt: user.deactivatedAt,
    };
  }

  async findByLink(linkHash: string): Promise<StoredEmailCode | undefined> {
    return [...this.codes.values()].find(
      (c) => c.linkHash === linkHash && this.mailedToTheirs(c),
    );
  }

  async take(
    tx: Transaction,
    userId: string,
    which: { readonly codeHash: string } | { readonly linkHash: string },
    now: Date,
  ): Promise<boolean> {
    const code = this.codes.get(userId);
    if (
      !code ||
      !this.mailedToTheirs(code) ||
      code.expiresAt.getTime() <= now.getTime() ||
      (this.failures.get(userId) ?? 0) > EMAIL_CODE_MAX_FAILURES ||
      ('codeHash' in which
        ? code.codeHash !== which.codeHash
        : code.linkHash !== which.linkHash)
    ) {
      return false;
    }
    fakeOf(tx).onCommit(() => this.codes.delete(userId));
    return true;
  }

  async dropSpent(userId: string): Promise<void> {
    if ((this.failures.get(userId) ?? 0) >= EMAIL_CODE_MAX_FAILURES) {
      this.codes.delete(userId);
    }
  }

  async revokeByEmail(email: string): Promise<void> {
    const id = this.userWith(email);
    if (id !== undefined) this.codes.delete(id);
  }

  async revokeAll(tx: Transaction, userId: string): Promise<boolean> {
    if (!this.codes.has(userId)) return false;
    fakeOf(tx).onCommit(() => this.codes.delete(userId));
    return true;
  }

  /** Whether the address `code` went to is still its user's (committed), ignoring case. */
  private mailedToTheirs(code: {
    readonly userId: string;
    readonly sentTo: string;
  }): boolean {
    const email = this.admin.committed.users.get(code.userId)?.email;
    return email?.toLowerCase() === code.sentTo.toLowerCase();
  }

  private userWith(email: string): string | undefined {
    for (const [id, user] of this.admin.committed.users) {
      if (user.email?.toLowerCase() === email.toLowerCase()) return id;
    }
    return undefined;
  }
}

/** The lockout per key in memory, at most `max` per window (no window: it never ends here). */
export class FakePasswordAttempts extends PasswordAttempts {
  readonly counts = new Map<string, number>();
  retryAfter = 60;

  constructor(public max = 3) {
    super();
  }

  async reserve(
    key: string,
  ): Promise<
    { attempt: PasswordAttempt; remaining: number } | { retryAfter: number }
  > {
    const count = this.counts.get(key) ?? 0;
    if (count >= this.max) return { retryAfter: this.retryAfter };
    this.counts.set(key, count + 1);
    return {
      attempt: { keyHash: key, windowStart: new Date(0) },
      remaining: this.max - count - 1,
    };
  }

  async forgive(attempt: PasswordAttempt): Promise<void> {
    const count = this.counts.get(attempt.keyHash) ?? 0;
    this.counts.set(attempt.keyHash, Math.max(0, count - 1));
  }
}
