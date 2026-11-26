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

/**
 * How many answers of one network may be in turn at once, the one checked and those waiting for
 * it, at most (#965); the next is refused.
 */
export const NETWORK_QUEUE = 8;
/**
 * How many of those one address may have, the one checked and two waiting (a few answers at once
 * are within its own limit, `CCMS_AUTH_FAILURES_MAX`): it cannot fill the queue alone, so its
 * neighbours keep places.
 */
export const ADDRESS_IN_TURN = 3;
/**
 * How long one answer may hold its turn, whatever it waits for (the check, the database, the
 * identity provider's metadata): past it the turn ends, so a call that never returns cannot hold a
 * network for good.
 */
export const TURN_LIMIT_MS = 60_000;
/** How many networks a log line was written for within one window, at most. */
const MAX_LOGGED = 1_000;

/**
 * The SAML answers of one network (IPv4 /24, IPv6 /48; `networkAddress`) are checked one at a
 * time (#965): answers are checked in a few workers shared by every client (#951) and served in
 * turn, so a network with several in them, from one address or many, would hold every worker and
 * the others wait behind it. With one, another network's answer always finds a worker free of it
 * (there are two). A normal answer takes a few milliseconds, so the people of a network wait for
 * each other for about that; no one is refused for it. At most `NETWORK_QUEUE` wait their turn,
 * and past it an answer is not checked (`provider-unavailable`), logged once per network and
 * window. Nothing is counted over time: no lockout. In memory, bounded by the answers waiting.
 */
@Injectable()
export class NetworkAnswers {
  now: () => number = Date.now;
  private readonly turns = new Map<
    string,
    { tail: Promise<void>; count: number; clients: Map<string, number> }
  >();
  private readonly logged = new Map<string, number>();
  private readonly windowMs: number;

  constructor(config: ConfigService<Env, true>) {
    this.windowMs = config.get('CCMS_AUTH_FAILURES_WINDOW_MS', { infer: true });
  }

  /**
   * Waits for the turn of `network` for an answer of `client`, then gives the way to end it (call
   * it once, when the answer is done); none when `NETWORK_QUEUE` answers of the network, or
   * `ADDRESS_IN_TURN` of the address, are in turn already.
   */
  async enter(
    network: string,
    client: string,
  ): Promise<(() => void) | undefined> {
    const turn = this.turns.get(network) ?? {
      tail: Promise.resolve(),
      count: 0,
      clients: new Map<string, number>(),
    };
    const mine = turn.clients.get(client) ?? 0;
    if (turn.count >= NETWORK_QUEUE || mine >= ADDRESS_IN_TURN) {
      return undefined;
    }
    turn.count++;
    turn.clients.set(client, mine + 1);
    this.turns.set(network, turn);
    const before = turn.tail;
    let end!: () => void;
    turn.tail = new Promise<void>((resolve) => (end = resolve));
    await before;
    let ended = false;
    const release = () => {
      if (ended) return;
      ended = true;
      clearTimeout(watchdog);
      end();
      const left = (turn.clients.get(client) ?? 1) - 1;
      if (left > 0) turn.clients.set(client, left);
      else turn.clients.delete(client);
      if (--turn.count === 0 && this.turns.get(network) === turn) {
        this.turns.delete(network);
      }
    };
    const watchdog = setTimeout(release, TURN_LIMIT_MS);
    watchdog.unref();
    return release;
  }

  /** Whether to log a refusal of `network` now: the first of each window, not each answer. */
  firstRefusal(network: string): boolean {
    const now = this.now();
    const at = this.logged.get(network);
    if (at !== undefined && now - at < this.windowMs) return false;
    if (this.logged.size >= MAX_LOGGED) {
      for (const [key, when] of this.logged) {
        if (now - when >= this.windowMs) this.logged.delete(key);
      }
      // shortcut: past 1,000 networks refused in one window, the oldest goes and each new one is logged, so the lines are as many as networks refused (a network needs 3 addresses to be refused); upgrade to a cap of lines per window if that matters.
      if (this.logged.size >= MAX_LOGGED) {
        this.logged.delete(this.logged.keys().next().value as string);
      }
    }
    this.logged.set(network, now);
    return true;
  }
}
