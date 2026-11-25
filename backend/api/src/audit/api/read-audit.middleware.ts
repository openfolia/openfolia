import {
  type BeforeApplicationShutdown,
  Injectable,
  Logger,
  type NestMiddleware,
  type OnApplicationShutdown,
} from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import type { Actor } from '../../access/core/actor.js';
import {
  clip,
  type ReadGap,
  type ReadRequest,
  RecordReadAction,
} from '../core/actions/record-read.action.js';

/** Transactions recording at once, each on the shared pool. */
export const READS_RUNNING = 4;
/** Reads one transaction records at most. */
export const READS_PER_BATCH = 100;
/** Reads waiting to be recorded; past this, a read is counted in its account's gap. */
export const READS_WAITING = 1_000;
/** After a failed recording of gaps, the next try waits this long. */
export const READS_RETRY_MS = 5_000;
/** How long shutdown waits for the reads still waiting or recording. */
export const READS_SHUTDOWN_WAIT_MS = 5_000;
/** How often a failed recording is logged, at most. */
const REPORT_EVERY_MS = 60_000;

/** The header a client names itself in (#877; the MCP server sends `mcp/<tool>`). */
export const CLIENT_HEADER = 'X-OpenFolia-Client';

/** Methods that change nothing: a service account's request with one is a read. */
const READ_METHODS = new Set(['GET', 'HEAD']);

/** One header's value; undefined when it is missing or sent more than once. */
function single(value: string | string[] | number | undefined) {
  return typeof value === 'string' ? value : undefined;
}

/** A read waiting, with when it was made. */
type Queued = { read: ReadRequest; at: Date };
type Gap = { actor: Actor; count: number; from: Date; to: Date };
/** One transaction's work: reads, or gaps, never both. */
type Work = { reads: Queued[]; gaps: ReadGap[] };

/**
 * Reads of service accounts (#877): once the answer to a `GET` or `HEAD`
 * has gone out (or the client went away), records it as one `api.read`
 * event (`RecordReadAction`) when a service account's token authenticated
 * it (`request.serviceTokenId`, set by `ActorGuard`). A person's reads, the
 * shared token's and anything unauthenticated are not recorded. Recording
 * happens after the answer, so it never delays or fails one.
 *
 * Bounded, so a flood of reads cannot starve the database pool, and never
 * silent, so neither a flood nor a malformed read can hide reads: at most
 * `READS_RUNNING` transactions, each of up to `READS_PER_BATCH` reads, and
 * `READS_WAITING` reads waiting. A read past that is counted in its
 * account's gap; gaps are recorded in a transaction of their own, one
 * `api.read-gap` event per account (the count, first and last). When a
 * batch of reads fails, its reads are tried one at a time, so a read that
 * cannot be recorded costs only itself (counted in its gap). When gaps
 * cannot be recorded (the database gone), they stay counted and the next
 * try waits `READS_RETRY_MS`. Shutdown waits up to
 * `READS_SHUTDOWN_WAIT_MS` for what is waiting or recording, then only
 * counts; what is left is in an error log line, as failures are (at most
 * one a minute, counts and the error's name only).
 */
@Injectable()
export class ReadAuditMiddleware
  implements NestMiddleware, BeforeApplicationShutdown, OnApplicationShutdown
{
  private readonly logger = new Logger('ReadAudit');
  private readonly waiting: Queued[] = [];
  /** Reads of a failed batch, tried one per transaction. */
  private readonly alone: Queued[] = [];
  /** Per account (`kind/id`): service accounts are an admin's, so few. */
  private readonly gaps = new Map<string, Gap>();
  private running = 0;
  /** Reads (gaps by their count) in transactions now. */
  private recording = 0;
  private retryAt = 0;
  private retryTimer?: NodeJS.Timeout;
  private stopped = false;
  private failed = 0;
  private lastError = '';
  private reportedAt = 0;
  /** @internal `READS_WAITING`; a test sets less. */
  waitingLimit = READS_WAITING;

  constructor(private readonly recordRead: RecordReadAction) {}

  private now(): number {
    return Date.now();
  }

  use(req: Request, res: Response, next: NextFunction): void {
    if (READ_METHODS.has(req.method.toUpperCase())) {
      res.once('close', () => this.record(req, res));
    }
    next();
  }

  async beforeApplicationShutdown(): Promise<void> {
    clearTimeout(this.retryTimer);
    this.retryAt = 0;
    this.drain();
    const deadline = this.now() + READS_SHUTDOWN_WAIT_MS;
    while (this.pending() > 0 && this.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      this.drain();
    }
    this.stopped = true;
  }

  /**
   * Once the server has closed (after `beforeApplicationShutdown`, reads
   * still answered meanwhile are only counted): logs what is left.
   */
  onApplicationShutdown(): void {
    const left = this.pending();
    if (left > 0) {
      this.logger.error(
        `Shutting down with ${left} service account reads not recorded${this.lastError ? ` (${this.lastError})` : ''}.`,
      );
    }
  }

  /** Reads waiting, recording, or counted in a gap. */
  pending(): number {
    let count = this.waiting.length + this.alone.length + this.recording;
    for (const gap of this.gaps.values()) count += gap.count;
    return count;
  }

  private record(req: Request, res: Response): void {
    const actor = req.actor;
    const tokenId = req.serviceTokenId;
    if (!actor || tokenId === undefined) return;
    const route: unknown = (req.route as { path?: unknown } | undefined)?.path;
    const ref = req.query['ref'];
    const commit = single(res.getHeader('X-Ccms-Commit'));
    const client = single(req.headers[CLIENT_HEADER.toLowerCase()]);
    // Cut to what an event keeps (`RecordReadAction` cuts again), so a wait holds little.
    this.enqueue({
      actor,
      tokenId,
      path: clip(req.originalUrl.split('?')[0] ?? '/', 500),
      ...(typeof route === 'string' && { route: clip(route, 500) }),
      status: res.statusCode,
      ...(typeof ref === 'string' && { ref: clip(ref, 200) }),
      ...(commit !== undefined && { commit: clip(commit, 64) }),
      ...(client !== undefined && { client: client.slice(0, 101) }),
      ...(!res.writableFinished && { aborted: true }),
    });
  }

  private enqueue(read: ReadRequest): void {
    const at = new Date(this.now());
    if (this.stopped || this.waiting.length >= this.waitingLimit) {
      this.count(read.actor, 1, at, at);
    } else {
      this.waiting.push({ read, at });
    }
    this.drain();
  }

  /** Adds to an account's gap. */
  private count(actor: Actor, count: number, from: Date, to: Date): void {
    const key = `${actor.kind}/${actor.id}`;
    const gap = this.gaps.get(key);
    if (!gap) {
      this.gaps.set(key, { actor, count, from, to });
      return;
    }
    gap.count += count;
    if (from < gap.from) gap.from = from;
    if (to > gap.to) gap.to = to;
  }

  /**
   * The next transaction's work: gaps (so a database gone is found at
   * once, and waited out), else a read alone, else a batch of reads; none
   * while waiting to try again after the database failed.
   */
  private take(): Work | undefined {
    if (this.now() < this.retryAt) return undefined;
    if (this.gaps.size > 0) {
      const gaps = [...this.gaps.values()];
      this.gaps.clear();
      return { reads: [], gaps };
    }
    const read = this.alone.shift();
    if (read) return { reads: [read], gaps: [] };
    const reads = this.waiting.splice(0, READS_PER_BATCH);
    return reads.length > 0 ? { reads, gaps: [] } : undefined;
  }

  private drain(): void {
    while (!this.stopped && this.running < READS_RUNNING) {
      const work = this.take();
      if (!work) return;
      const size =
        work.reads.length + work.gaps.reduce((n, g) => n + g.count, 0);
      this.running++;
      this.recording += size;
      this.recordRead
        .handle(
          work.reads.map((q) => q.read),
          work.gaps,
        )
        .then(
          () => undefined,
          (error: unknown) => this.failedWith(work, error),
        )
        .finally(() => {
          this.running--;
          this.recording -= size;
          this.drain();
        })
        // Bookkeeping only: never an unhandled rejection.
        .catch(() => undefined);
    }
  }

  private failedWith(work: Work, error: unknown): void {
    this.failed++;
    this.lastError = error instanceof Error ? error.name : 'unknown error';
    if (work.reads.length > 1) {
      // One of them may be what failed: each on its own, so it costs only itself.
      this.alone.push(...work.reads);
      return;
    }
    // Nothing is lost silently: a read that cannot be recorded is counted in its gap.
    for (const { read, at } of work.reads) this.count(read.actor, 1, at, at);
    for (const gap of work.gaps) {
      this.count(gap.actor, gap.count, gap.from, gap.to);
    }
    this.report();
    if (work.gaps.length > 0 && !this.stopped) {
      // Gaps cannot be malformed: the database is what failed. Wait, then try again.
      this.retryAt = this.now() + READS_RETRY_MS;
      clearTimeout(this.retryTimer);
      this.retryTimer = setTimeout(() => {
        this.retryAt = 0;
        this.drain();
      }, READS_RETRY_MS);
      this.retryTimer.unref();
    }
  }

  /** Logs failed recordings since the last line, at most once a minute. */
  private report(): void {
    const now = this.now();
    if (now - this.reportedAt < REPORT_EVERY_MS) return;
    this.reportedAt = now;
    this.logger.error(
      `Recording service accounts' reads failed ${this.failed} times (${this.lastError}); what could not be recorded is counted and recorded as gaps once it works again.`,
    );
    this.failed = 0;
  }
}
