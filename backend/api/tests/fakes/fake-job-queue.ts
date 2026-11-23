import { randomUUID } from 'node:crypto';
import { type ClaimedJob, JobClaims } from '../../src/jobs/core/job-claims.js';
import {
  type EnqueueOptions,
  type JobInfo,
  JobQueue,
  type JobState,
} from '../../src/jobs/core/job-queue.js';
import {
  type JobKind,
  type JobPayload,
  MAX_PAYLOAD_BYTES,
} from '../../src/jobs/core/job.js';
import { fakeOf } from './fake-unit-of-work.js';

/** A job in memory, as `FakeJobQueue` keeps it. */
export interface FakeJob {
  readonly id: string;
  readonly queue: string;
  readonly key: string;
  readonly payload: unknown;
  state: JobState;
  retryCount: number;
  retryLimit: number;
  /** Bumped by every claim: the attempt a settlement must name. */
  claimed: number;
  /** Claimed before lower ones (`EnqueueOptions.priority`), oldest first among equals. */
  priority: number;
  /** Handed back unrun: the next claim keeps the retry count. */
  released?: boolean;
  messages: string[];
  readonly createdAt: Date;
  startedAt: Date | null;
  endedAt: Date | null;
}

const OPEN: readonly JobState[] = ['queued', 'retrying', 'running'];

/**
 * `JobQueue` and `JobClaims` in memory, for unit tests of producers and of
 * the worker: one job per kind and key while open, enqueued on commit when
 * given a fake transaction, settlements fenced to the claimed attempt (a
 * failure retries at once, without the real queue's pause). `jobs` holds
 * everything; `put` adds a job as if stored by anyone (any payload).
 */
export class FakeJobQueue extends JobQueue {
  readonly jobs: FakeJob[] = [];
  /** Where a queue's jobs go once they failed for good. */
  readonly failedQueues = new Map<string, string>();
  readonly claims: JobClaims;

  constructor() {
    super();
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const queue = this;
    this.claims = new (class extends JobClaims {
      claim = (name: string, limit: number) => queue.claim(name, limit);
      complete = (job: ClaimedJob) => queue.settle(job, 'done');
      fail = (job: ClaimedJob, message: string) =>
        queue.settle(job, 'failed', message);
      refuse = (job: ClaimedJob) => queue.settle(job, 'cancelled');
      release = async (claimed: ClaimedJob) => {
        const job = queue.current(claimed);
        if (!job) return false;
        // Claimed again at the same retry count.
        job.state = 'queued';
        job.claimed--;
        job.released = true;
        return true;
      };
      touch = async (job: ClaimedJob) => queue.current(job) !== undefined;
    })();
  }

  async enqueue<P extends JobPayload>(
    kind: JobKind<P>,
    payload: P,
    { key, tx, priority }: EnqueueOptions,
  ): Promise<string | undefined> {
    const data = kind.payload.parse(payload);
    if (Buffer.byteLength(JSON.stringify(data)) > MAX_PAYLOAD_BYTES) {
      throw new Error('payload too large');
    }
    const id = randomUUID();
    const add = () =>
      this.put(kind.name, data, {
        key,
        id,
        retryLimit: kind.retryLimit,
        ...(priority !== undefined && { priority }),
      });
    if (tx) {
      if (this.open(kind.name, key)) return undefined;
      fakeOf(tx).onCommit(() => {
        if (!this.open(kind.name, key)) add();
      });
      return id;
    }
    return add()?.id;
  }

  /** Adds a job (any payload), unless one of that queue and key is open. */
  put(
    queue: string,
    payload: unknown,
    options: {
      key?: string;
      id?: string;
      retryLimit?: number;
      priority?: number;
    } = {},
  ): FakeJob | undefined {
    const key = options.key ?? randomUUID();
    if (this.open(queue, key)) return undefined;
    const job: FakeJob = {
      id: options.id ?? randomUUID(),
      queue,
      key,
      payload,
      state: 'queued',
      retryCount: 0,
      retryLimit: options.retryLimit ?? 3,
      priority: options.priority ?? 0,
      claimed: 0,
      messages: [],
      createdAt: new Date(),
      startedAt: null,
      endedAt: null,
    };
    this.jobs.push(job);
    return job;
  }

  async find(kind: JobKind, id: string): Promise<JobInfo | undefined> {
    const job = this.jobs.find((j) => j.queue === kind.name && j.id === id);
    return job && this.info(job);
  }

  async latest(kind: JobKind, key: string): Promise<JobInfo | undefined> {
    const job = this.jobs.findLast(
      (j) => j.queue === kind.name && j.key === key,
    );
    return job && this.info(job);
  }

  private info(job: FakeJob): JobInfo {
    return {
      id: job.id,
      kind: job.queue,
      key: job.key,
      state: job.state,
      attempts: job.claimed,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      endedAt: job.endedAt,
    };
  }

  async openKeys(
    kind: JobKind,
    keys: readonly string[],
  ): Promise<ReadonlySet<string>> {
    return new Set(keys.filter((key) => this.open(kind.name, key)));
  }

  async prioritize(
    kind: JobKind,
    key: string,
    priority: number,
  ): Promise<boolean> {
    const job = this.jobs.find(
      (j) =>
        j.queue === kind.name &&
        j.key === key &&
        (j.state === 'queued' || j.state === 'retrying'),
    );
    if (!job || job.priority >= priority) return false;
    job.priority = priority;
    return true;
  }

  async cancel(kind: JobKind, id: string): Promise<boolean> {
    const job = this.jobs.find((j) => j.queue === kind.name && j.id === id);
    if (!job || !OPEN.includes(job.state)) return false;
    this.end(job, 'cancelled');
    return true;
  }

  private open(queue: string, key: string): boolean {
    return this.jobs.some(
      (j) => j.queue === queue && j.key === key && OPEN.includes(j.state),
    );
  }

  private async claim(queue: string, limit: number): Promise<ClaimedJob[]> {
    // As pg-boss claims: the highest priority first, the oldest among equals.
    const due = this.jobs
      .filter(
        (j) =>
          j.queue === queue && (j.state === 'queued' || j.state === 'retrying'),
      )
      .sort((a, b) => b.priority - a.priority)
      .slice(0, limit);
    return due.map((job) => {
      if (job.claimed > 0 && !job.released) job.retryCount++;
      job.released = false;
      job.claimed++;
      job.state = 'running';
      job.startedAt = new Date();
      return {
        queue,
        id: job.id,
        retryCount: job.retryCount,
        retryLimit: job.retryLimit,
        payload: job.payload,
      };
    });
  }

  /** The job, while `claimed` is still its running attempt. */
  current(claimed: ClaimedJob): FakeJob | undefined {
    const job = this.jobs.find((j) => j.id === claimed.id);
    return job?.state === 'running' && job.retryCount === claimed.retryCount
      ? job
      : undefined;
  }

  private async settle(
    claimed: ClaimedJob,
    state: 'done' | 'failed' | 'cancelled',
    message?: string,
  ): Promise<boolean> {
    const job = this.current(claimed);
    if (!job) return false;
    if (message) job.messages.push(message);
    if (state === 'failed' && job.retryCount < job.retryLimit) {
      job.state = 'retrying';
      return true;
    }
    this.end(job, state);
    const failed = this.failedQueues.get(job.queue);
    if (state === 'failed' && failed) this.put(failed, job.payload);
    return true;
  }

  private end(job: FakeJob, state: JobState): void {
    job.state = state;
    job.endedAt = new Date();
  }
}
