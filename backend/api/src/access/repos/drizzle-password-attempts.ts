import { createHmac, randomBytes } from 'node:crypto';
import {
  Injectable,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, eq, inArray, lte, sql } from 'drizzle-orm';
import type { Env } from '../../config/env.js';
import { Database } from '../../database/database.js';
import { InstanceSecretKey } from '../../secrets/core/instance-secret-key.js';
import {
  type PasswordAttempt,
  PasswordAttempts,
} from '../core/password-attempts.js';
import { passwordAttempts, passwordAttemptsKey } from './passwords.tables.js';

/** How many ended windows one statement deletes. */
const PRUNE_BATCH = 5_000;

/** The attempt counted when there is no limit (`CCMS_PASSWORD_FAILURES_MAX=0`): nothing. */
const UNCOUNTED: PasswordAttempt = { keyHash: '', windowStart: new Date(0) };

/** What the HMAC key is derived for from the instance secret key (HKDF `info`). */
// Compatibility: keeps the working name from before the product was named OpenFolia: a key derivation's
// context, so attempts already stored keep matching.
export const PASSWORD_ATTEMPTS_KEY_INFO = 'ccms password-attempts v1';

/**
 * `PasswordAttempts` over the `password_attempts` table (#610): one row per key, nothing
 * evicted before its window ends, so no flood of other keys can reset an account's count. The
 * key is stored as an HMAC, so the table holds no address, and a known address and an unknown
 * one are kept and expire alike. The HMAC key is derived from the instance secret key (HKDF,
 * `PASSWORD_ATTEMPTS_KEY_INFO`), else made once at random and kept in `password_attempts_key`:
 * the same on every server and after a restart, so counts are shared and survive (rotating the
 * secret key starts them afresh). Ended windows are deleted every `windowMs` (at least each
 * minute).
 */
@Injectable()
export class DrizzlePasswordAttempts
  extends PasswordAttempts
  implements OnModuleInit, OnModuleDestroy
{
  private readonly max: number;
  private readonly windowMs: number;
  private hmacKey: Promise<Buffer> | undefined;
  private pruning: NodeJS.Timeout | undefined;
  now: () => number = Date.now;

  constructor(
    private readonly database: Database,
    config: ConfigService<Env, true>,
    private readonly secretKey: InstanceSecretKey,
  ) {
    super();
    this.max = config.get('CCMS_PASSWORD_FAILURES_MAX', { infer: true });
    this.windowMs = config.get('CCMS_PASSWORD_FAILURES_WINDOW_MS', {
      infer: true,
    });
  }

  onModuleInit(): void {
    if (this.max === 0) return;
    this.pruning = setInterval(
      () => void this.prune().catch(() => undefined),
      Math.max(this.windowMs, 60_000),
    );
    this.pruning.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.pruning);
  }

  async reserve(
    key: string,
  ): Promise<
    { attempt: PasswordAttempt; remaining: number } | { retryAfter: number }
  > {
    if (this.max === 0) return { attempt: UNCOUNTED, remaining: Infinity };
    const keyHash = await this.hashOf(key);
    const now = new Date(this.now());
    const ended = new Date(now.getTime() - this.windowMs);
    const t = passwordAttempts;
    // The limit's test and the count in one statement: attempts at once each see the others.
    const [row] = await this.database.db
      .insert(t)
      .values({ keyHash, failures: 1, windowStart: now })
      .onConflictDoUpdate({
        target: t.keyHash,
        set: {
          failures: sql`case when ${t.windowStart} <= ${ended} then 1 else ${t.failures} + 1 end`,
          windowStart: sql`case when ${t.windowStart} <= ${ended} then ${now} else ${t.windowStart} end`,
        },
        setWhere: sql`${t.windowStart} <= ${ended} or ${t.failures} < ${this.max}`,
      })
      .returning({ windowStart: t.windowStart, failures: t.failures });
    if (row) {
      return {
        attempt: { keyHash, windowStart: row.windowStart },
        remaining: Math.max(0, this.max - row.failures),
      };
    }
    const [held] = await this.database.db
      .select({ windowStart: t.windowStart })
      .from(t)
      .where(eq(t.keyHash, keyHash));
    const endsAt =
      (held?.windowStart.getTime() ?? now.getTime()) + this.windowMs;
    return {
      retryAfter: Math.max(1, Math.ceil((endsAt - now.getTime()) / 1000)),
    };
  }

  async forgive(attempt: PasswordAttempt): Promise<void> {
    if (attempt === UNCOUNTED) return;
    const t = passwordAttempts;
    await this.database.db
      .update(t)
      .set({ failures: sql`greatest(${t.failures} - 1, 0)` })
      .where(
        and(
          eq(t.keyHash, attempt.keyHash),
          eq(t.windowStart, attempt.windowStart),
        ),
      );
  }

  /** Deletes the rows whose window has ended, in batches; how many. */
  async prune(): Promise<number> {
    const ended = new Date(this.now() - this.windowMs);
    const t = passwordAttempts;
    let deleted = 0;
    for (;;) {
      const batch = this.database.db
        .select({ keyHash: t.keyHash })
        .from(t)
        .where(lte(t.windowStart, ended))
        .limit(PRUNE_BATCH);
      const rows = await this.database.db
        .delete(t)
        // The window again: one restarted meanwhile is kept.
        .where(and(lte(t.windowStart, ended), inArray(t.keyHash, batch)))
        .returning({ keyHash: t.keyHash });
      deleted += rows.length;
      if (rows.length < PRUNE_BATCH) return deleted;
    }
  }

  private async hashOf(key: string): Promise<string> {
    this.hmacKey ??= this.loadKey().catch((error: unknown) => {
      this.hmacKey = undefined;
      throw error;
    });
    return createHmac('sha256', await this.hmacKey)
      .update(key)
      .digest('hex');
  }

  private async loadKey(): Promise<Buffer> {
    const derived = this.secretKey.derive(PASSWORD_ATTEMPTS_KEY_INFO);
    if (derived) return derived;
    const db = this.database.db;
    await db
      .insert(passwordAttemptsKey)
      .values({ id: 1, key: randomBytes(32).toString('hex') })
      .onConflictDoNothing();
    const [row] = await db
      .select({ key: passwordAttemptsKey.key })
      .from(passwordAttemptsKey)
      .where(eq(passwordAttemptsKey.id, 1));
    if (!row) throw new Error('The password lockout has no key.');
    return Buffer.from(row.key, 'hex');
  }
}
