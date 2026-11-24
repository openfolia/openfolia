// The sandboxes the launcher started, the session cookie each is bound to, and the limits: how
// many at once, how many per address at once and in 24 hours, how long each lives. Kept in
// memory: a restart of the launcher removes every sandbox (`reset`), so no sandbox outlives the
// record of who may reach it.
import { createHash, randomBytes } from 'node:crypto';
import type { Logger } from './log.js';
import {
  RuntimeFullError,
  type SandboxLang,
  type SandboxRuntime,
} from './runtime.js';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

export interface SandboxLimits {
  readonly maxSandboxes: number;
  readonly perAddress: number;
  readonly perAddressDaily: number;
  readonly idleMinutes: number;
  readonly maxMinutes: number;
  readonly startTimeoutSeconds: number;
}

export interface Session {
  readonly id: string;
  readonly url: string;
  readonly lang: SandboxLang;
  readonly addressKey: string;
  readonly startedAt: number;
  lastActive: number;
}

export type StartResult =
  | {
      readonly kind: 'started';
      readonly token: string;
      readonly session: Session;
    }
  | { readonly kind: 'full' }
  | { readonly kind: 'one-at-a-time' }
  | { readonly kind: 'daily-limit'; readonly retryAt: number }
  | { readonly kind: 'failed'; readonly reference: string };

/** The cookie's value is a random token; only its hash is kept, so a memory dump holds no cookie. */
export function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export class Sandboxes {
  private readonly sessions = new Map<string, Session>();
  /** Starts under way, per address and in all: they count against every limit. */
  private readonly starting = new Map<string, number>();
  private startingTotal = 0;
  /** When each address started its sandboxes in the last 24 hours. */
  private readonly daily = new Map<string, number[]>();
  /** Sandboxes being removed: they still take room until the runtime has removed them. */
  private removing = 0;

  constructor(
    private readonly runtime: SandboxRuntime,
    private readonly limits: SandboxLimits,
    private readonly log: Logger,
    private readonly now: () => number = Date.now,
  ) {}

  /** How many are free now, of how many. */
  status(): { capacity: number; free: number } {
    const used = this.sessions.size + this.startingTotal + this.removing;
    return {
      capacity: this.limits.maxSandboxes,
      free: Math.max(0, this.limits.maxSandboxes - used),
    };
  }

  /** The live session a cookie names; undefined when none, or when it has ended (it is removed). */
  find(token: string | undefined): Session | undefined {
    if (!token) return undefined;
    const session = this.sessions.get(tokenHash(token));
    if (!session) return undefined;
    if (this.endsAt(session) <= this.now()) {
      void this.end(tokenHash(token), session, 'expired');
      return undefined;
    }
    return session;
  }

  /** Ends a sandbox at once (it stopped answering): the next request gets the start page. */
  async drop(session: Session, reason: string): Promise<void> {
    for (const [hash, s] of this.sessions)
      if (s === session) await this.end(hash, s, reason);
  }

  /** A request reached the sandbox: its idle end moves on. */
  touch(session: Session): void {
    session.lastActive = this.now();
  }

  /** The idle end, at most the start plus the maximum. */
  endsAt(session: Session): number {
    return Math.min(
      session.lastActive + this.limits.idleMinutes * MINUTE,
      session.startedAt + this.limits.maxMinutes * MINUTE,
    );
  }

  /**
   * Starts a sandbox for `addressKey`: the keyed hash of the visitor's address, never the address
   * itself (kept for the daily limit, 24 hours at most; never logged).
   */
  async start(addressKey: string, lang: SandboxLang): Promise<StartResult> {
    const now = this.now();
    if (this.status().free === 0) {
      this.log.info('refused', { reason: 'full' });
      return { kind: 'full' };
    }
    const mine =
      [...this.sessions.values()].filter((s) => s.addressKey === addressKey)
        .length + (this.starting.get(addressKey) ?? 0);
    if (mine >= this.limits.perAddress) {
      this.log.info('refused', { reason: 'one-at-a-time' });
      return { kind: 'one-at-a-time' };
    }
    // One array per address, pruned in place: concurrent starts and the sweep share it.
    const recent = this.daily.get(addressKey) ?? [];
    for (let i = recent.length - 1; i >= 0; i--)
      if ((recent[i] ?? 0) <= now - DAY) recent.splice(i, 1);
    if (recent.length >= this.limits.perAddressDaily) {
      this.log.info('refused', { reason: 'daily-limit' });
      return { kind: 'daily-limit', retryAt: (recent[0] ?? now) + DAY };
    }

    // Reserved before the runtime is asked, so concurrent starts cannot pass the limits together.
    recent.push(now);
    this.daily.set(addressKey, recent);
    this.starting.set(addressKey, (this.starting.get(addressKey) ?? 0) + 1);
    this.startingTotal += 1;
    const release = () => {
      const left = (this.starting.get(addressKey) ?? 1) - 1;
      if (left > 0) this.starting.set(addressKey, left);
      else this.starting.delete(addressKey);
      this.startingTotal -= 1;
    };
    const unreserve = () => {
      const index = recent.lastIndexOf(now);
      if (index >= 0) recent.splice(index, 1);
      if (recent.length === 0 && this.daily.get(addressKey) === recent)
        this.daily.delete(addressKey);
    };

    const began = this.now();
    try {
      const started = await this.runtime.start(
        lang,
        AbortSignal.timeout(this.limits.startTimeoutSeconds * 1000),
      );
      const token = randomBytes(32).toString('base64url');
      const session: Session = {
        id: started.id,
        url: started.url,
        lang,
        addressKey,
        startedAt: this.now(),
        lastActive: this.now(),
      };
      this.sessions.set(tokenHash(token), session);
      this.log.info('started', {
        sandbox: session.id,
        lang,
        ms: this.now() - began,
      });
      return { kind: 'started', token, session };
    } catch (error) {
      // A start that failed does not count towards the visitor's daily starts.
      unreserve();
      if (error instanceof RuntimeFullError) {
        this.log.info('refused', { reason: 'full' });
        return { kind: 'full' };
      }
      const reference = randomBytes(4).toString('hex');
      this.log.error('start-failed', {
        reference,
        error: describe(error),
      });
      return { kind: 'failed', reference };
    } finally {
      release();
    }
  }

  /** Removes every sandbox past its time, and every one the runtime has that the launcher doesn't know. */
  async sweep(): Promise<void> {
    const now = this.now();
    for (const [hash, session] of this.sessions)
      if (this.endsAt(session) <= now) await this.end(hash, session, 'expired');
    // In place: a start under way holds the same array, and takes its time back off it if it fails.
    for (const [key, times] of this.daily) {
      for (let i = times.length - 1; i >= 0; i--)
        if ((times[i] ?? 0) <= now - DAY) times.splice(i, 1);
      if (times.length === 0 && !this.starting.has(key)) this.daily.delete(key);
    }
    // A start under way has a sandbox the runtime lists before the launcher records it.
    if (this.startingTotal > 0) return;
    let ids: string[];
    try {
      ids = await this.runtime.list();
    } catch (error) {
      this.log.error('sweep-failed', { error: describe(error) });
      return;
    }
    if (this.startingTotal > 0) return;
    const known = new Set([...this.sessions.values()].map((s) => s.id));
    for (const id of ids)
      if (!known.has(id)) await this.removeQuietly(id, 'unknown');
  }

  /** At the launcher's start: removes every sandbox the runtime has (none of them has a cookie any more). */
  async reset(): Promise<void> {
    for (const id of await this.runtime.list())
      await this.removeQuietly(id, 'unknown');
  }

  /** At the launcher's end: removes every sandbox. */
  async removeAll(): Promise<void> {
    for (const [hash, session] of [...this.sessions])
      await this.end(hash, session, 'shutdown');
  }

  private async end(
    hash: string,
    session: Session,
    reason: string,
  ): Promise<void> {
    if (!this.sessions.delete(hash)) return;
    await this.removeQuietly(
      session.id,
      reason,
      this.now() - session.startedAt,
    );
  }

  private async removeQuietly(
    id: string,
    reason: string,
    ms?: number,
  ): Promise<void> {
    this.removing += 1;
    try {
      await this.runtime.remove(id);
      this.log.info('stopped', {
        sandbox: id,
        reason,
        ...(ms === undefined ? {} : { minutes: Math.round(ms / MINUTE) }),
      });
    } catch (error) {
      // The next sweep finds it in the runtime's list and tries again.
      this.log.error('stop-failed', {
        sandbox: id,
        reason,
        error: describe(error),
      });
    } finally {
      this.removing -= 1;
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
