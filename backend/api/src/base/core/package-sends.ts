import { Readable } from 'node:stream';
import type { Actor } from '../../access/core/actor.js';
import { TooManyRequestsError } from './errors.js';

/**
 * How many files of one kind of package (iiRDS, DITA) are sent at once,
 * server-wide; past it 429 `rate-limited`. A plan too large to keep is held
 * by each download until it ends, so this bounds what slow downloads hold.
 */
export const PACKAGE_SENDS_AT_ONCE = 4;

/** The most of those turns one reader may hold: one is always left for someone else. */
export const MAX_PACKAGE_SENDS_PER_ACTOR = PACKAGE_SENDS_AT_ONCE - 1;

/** `CCMS_PACKAGE_SEND_IDLE_TIMEOUT_MS`'s default: a minute without a byte read. */
export const DEFAULT_SEND_IDLE_TIMEOUT_MS = 60_000;
/** `CCMS_PACKAGE_SEND_TIMEOUT_MS`'s default: half an hour. */
export const DEFAULT_SEND_TIMEOUT_MS = 30 * 60_000;
/** `CCMS_PACKAGE_SENDS_PER_ACTOR`'s default: one at a time. */
export const DEFAULT_SENDS_PER_ACTOR = 1;
/** `CCMS_PACKAGE_SEND_MIN_BYTES_PER_SECOND`'s default: 16 KiB a second on average. */
export const DEFAULT_SEND_MIN_BYTES_PER_SECOND = 16 * 1024;

/** The most bytes handed on at once, so the timers follow what the client reads, not whole entries. */
const SLICE_BYTES = 64 * 1024;

/** How long a reader past a bound is told to wait, in seconds (`Retry-After`). */
const RETRY_AFTER_SECONDS = 10;

/** How package files are sent (`CCMS_PACKAGE_SEND_*`). */
export abstract class PackageSendSettings {
  /** A send no byte of which is read for this long ends (and frees its turn). */
  abstract readonly idleTimeoutMs: number;
  /** A send still going after this long ends. */
  abstract readonly sendTimeoutMs: number;
  /** How many of the `PACKAGE_SENDS_AT_ONCE` turns one reader may hold (at most `MAX_PACKAGE_SENDS_PER_ACTOR`). */
  abstract readonly perActor: number;
  /** A send read more slowly than this on average (bytes a second), past its first idle timeout, ends. */
  abstract readonly minBytesPerSecond: number;
}

/** A send ended by a timeout: the connection is cut, never a short file passed off as whole. */
export class PackageSendTimeout extends Error {
  constructor(
    readonly reason: 'idle' | 'total' | 'slow',
    what: string,
  ) {
    super(
      reason === 'idle'
        ? `The ${what} was not read for too long.`
        : reason === 'slow'
          ? `The ${what} was read too slowly.`
          : `The ${what} took too long to send.`,
    );
    this.name = 'PackageSendTimeout';
  }
}

/**
 * The package files of one kind being sent: at most
 * `PACKAGE_SENDS_AT_ONCE`, at most `perActor` of them one reader's, each
 * ended once it stalls (`idleTimeoutMs` without a chunk read), is read too
 * slowly (`minBytesPerSecond`) or runs too long (`sendTimeoutMs`), which
 * frees its turn. Past a bound, 429 `rate-limited`. Each kind of package
 * has its own (`IirdsSends`, `DitaSends`), so one never takes the other's
 * turns.
 */
export class PackageSends {
  private open = 0;
  private readonly byActor = new Map<string, number>();
  private readonly perActor: number;

  constructor(
    private readonly settings: PackageSendSettings,
    /** What is sent, for messages: "DITA package". */
    private readonly what: string,
  ) {
    this.perActor = Math.max(
      1,
      Math.min(settings.perActor, MAX_PACKAGE_SENDS_PER_ACTOR),
    );
  }

  /**
   * The body to send `chunks` as, once a turn is free for `actor`; else
   * `TooManyRequestsError`, thrown before anything is read. `onCut` runs
   * when a timeout ends the send (to cut the connection), never when the
   * body closes on its own.
   */
  send(
    actor: Actor,
    chunks: AsyncIterable<Uint8Array>,
    options: { readonly onCut?: () => void } = {},
  ): Readable {
    const key = `${actor.kind}:${actor.id}`;
    if (this.open >= PACKAGE_SENDS_AT_ONCE) {
      throw new TooManyRequestsError(
        `Too many ${this.what}s are being sent: try again shortly.`,
        RETRY_AFTER_SECONDS,
      );
    }
    const mine = this.byActor.get(key) ?? 0;
    if (mine >= this.perActor) {
      throw new TooManyRequestsError(
        `You are downloading ${mine} ${this.what}${mine === 1 ? '' : 's'} already, as many as one reader may at once: try again once ${mine === 1 ? 'it ends' : 'one ends'}.`,
        RETRY_AFTER_SECONDS,
      );
    }
    this.open++;
    this.byActor.set(key, mine + 1);
    const timers: {
      idle?: NodeJS.Timeout;
      total?: NodeJS.Timeout;
      pace?: NodeJS.Timeout;
    } = {};
    let sent = 0;
    const started = Date.now();
    let released = false;
    // Once, the first of: the body closed, or a timeout cutting it (a source
    // that never yields again keeps `close` from coming, #433 review).
    const release = () => {
      if (released) return;
      released = true;
      clearTimeout(timers.idle);
      clearTimeout(timers.total);
      clearInterval(timers.pace);
      this.open--;
      const left = (this.byActor.get(key) ?? 1) - 1;
      if (left === 0) this.byActor.delete(key);
      else this.byActor.set(key, left);
    };
    // Each chunk is made when the client reads (backpressure), so a stalled client pulls none.
    async function* watched(): AsyncIterable<Uint8Array> {
      for await (const chunk of chunks) {
        // In slices, so a large entry read slowly still counts as progress.
        for (let at = 0; at < chunk.length; at += SLICE_BYTES) {
          const slice = chunk.subarray(at, at + SLICE_BYTES);
          timers.idle?.refresh();
          sent += slice.length;
          yield slice;
        }
      }
    }
    const body = Readable.from(watched());
    const cut = (reason: PackageSendTimeout['reason']) => {
      if (released) return;
      release();
      body.destroy(new PackageSendTimeout(reason, this.what));
      options.onCut?.();
    };
    timers.idle = setTimeout(() => cut('idle'), this.settings.idleTimeoutMs);
    timers.total = setTimeout(() => cut('total'), this.settings.sendTimeoutMs);
    // Past its first idle timeout, a send read more slowly than the minimum on average is cut too.
    const check = Math.max(250, Math.floor(this.settings.idleTimeoutMs / 4));
    timers.pace = setInterval(() => {
      const elapsed = Date.now() - started;
      if (elapsed < this.settings.idleTimeoutMs) return;
      if ((sent * 1000) / elapsed < this.settings.minBytesPerSecond) {
        cut('slow');
      }
    }, check);
    body.once('close', release);
    body.once('error', release);
    return body;
  }
}
