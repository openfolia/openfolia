import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.js';

/**
 * The key an account's password attempts count under (#610, `PasswordAttempts`), beside the
 * client's address: its email address in lowercase, whether or not anyone has it, so the
 * lockout behaves the same for an unknown address and a known one.
 */
export const accountKey = (email: string): string =>
  `account:${email.trim().toLowerCase()}`;

/** How many client addresses (and accounts) are tracked at most; the oldest window goes first. */
export const MAX_TRACKED_CLIENTS = 10_000;

interface Window {
  /** When the window started (epoch ms). */
  readonly start: number;
  failures: number;
}

/**
 * Failures per key in fixed windows of `windowMs`, at most `max` per window (0: no limit), in
 * memory and bounded (`MAX_TRACKED_CLIENTS`): `FailedAuthentications`.
 */
export class FailureWindows {
  private readonly windows = new Map<string, Window>();
  now: () => number = Date.now;

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  /** Seconds until `client` may try again; undefined while it may. */
  retryAfter(client: string): number | undefined {
    if (this.max === 0) return undefined;
    const window = this.current(client);
    if (!window || window.failures < this.max) return undefined;
    return Math.max(
      1,
      Math.ceil((window.start + this.windowMs - this.now()) / 1000),
    );
  }

  /**
   * Seconds until every one of `keys` may try again (the longest wait); undefined while all
   * may. A password sign-in asks for its address and its account (#610).
   */
  retryAfterAny(keys: readonly string[]): number | undefined {
    let wait: number | undefined;
    for (const key of keys) {
      const each = this.retryAfter(key);
      if (each !== undefined) wait = Math.max(wait ?? 0, each);
    }
    return wait;
  }

  /** Counts a failed authentication of `client`. */
  fail(client: string): void {
    if (this.max === 0) return;
    const window = this.current(client);
    if (window) {
      window.failures++;
      return;
    }
    if (this.windows.size >= MAX_TRACKED_CLIENTS) this.evict();
    this.windows.set(client, { start: this.now(), failures: 1 });
  }

  /**
   * Takes back one failure of `client` counted before the check (#610): an attempt is counted
   * before its password is checked, so attempts at once cannot all pass the limit, and taken
   * back when it was right.
   */
  forgive(client: string): void {
    const window = this.current(client);
    if (window && window.failures > 0) window.failures--;
  }

  /** The window of `client` still running, if any (an ended one is dropped). */
  private current(client: string): Window | undefined {
    const window = this.windows.get(client);
    if (window && this.now() - window.start >= this.windowMs) {
      this.windows.delete(client);
      return undefined;
    }
    return window;
  }

  /** Drops ended windows; when none has ended, the oldest. */
  private evict(): void {
    const now = this.now();
    for (const [client, window] of this.windows) {
      if (now - window.start >= this.windowMs) this.windows.delete(client);
    }
    if (this.windows.size >= MAX_TRACKED_CLIENTS) {
      const oldest = this.windows.keys().next().value;
      if (oldest !== undefined) this.windows.delete(oldest);
    }
  }
}

/**
 * Failed authentications per client address, in fixed windows
 * (`CCMS_AUTH_FAILURES_MAX` per `CCMS_AUTH_FAILURES_WINDOW_MS`): past the
 * limit, the guard refuses the address (429 `too-many-failed-attempts`)
 * until its window ends, before looking at any token. In memory, per
 * server, bounded (`MAX_TRACKED_CLIENTS`). The address is `clientAddress`:
 * the connection's, unless `CCMS_TRUST_PROXY` names the proxies in front
 * (without it, every client behind a proxy shares the proxy's, so the limit
 * applies to all of them together); an IPv6 address by its /64,
 * never wider, so a lockout cannot reach a neighbour.
 */
@Injectable()
export class FailedAuthentications extends FailureWindows {
  constructor(config: ConfigService<Env, true>) {
    super(
      config.get('CCMS_AUTH_FAILURES_MAX', { infer: true }),
      config.get('CCMS_AUTH_FAILURES_WINDOW_MS', { infer: true }),
    );
  }
}
