import { defineJob, type JobHandler, type JobKind } from './job.js';

/** What a queue's jobs are for: running the kind's work, or reporting that it failed for good. */
export type JobPhase = 'run' | 'failed';

/** One queue the jobs component claims from. */
export interface JobQueueSpec {
  /** The kind's name, or `<kind>/failed` for the jobs that failed for good. */
  readonly name: string;
  readonly phase: JobPhase;
  /** The queue's retries, timeout and concurrency. */
  readonly policy: JobKind;
  /** Where a job of this queue goes once it has failed for good (the `failed` queue), if anywhere. */
  readonly failedQueue?: string;
  readonly handler: JobHandler;
}

/** The queue of a kind's jobs that failed for good. */
export const failedQueueOf = (kind: string): string => `${kind}/failed`;

/**
 * Reporting a failure (`JobHandler.failed`) is retried more often than
 * work usually is: it is short and it is the only thing that keeps a
 * record from waiting forever.
 */
const REPORT_POLICY = {
  retryLimit: 10,
  retryDelaySeconds: 10,
  timeoutSeconds: 5 * 60,
  concurrency: 1,
} as const;

/**
 * Every job handler of the app (one per kind) and the queues they need:
 * the kind's own and, for a handler with `failed`, the queue its jobs move
 * to once they failed for good.
 */
export class JobHandlers {
  private loaded?: {
    readonly queues: readonly JobQueueSpec[];
    readonly byQueue: ReadonlyMap<string, JobQueueSpec>;
  };

  /** Empty until `load`; the jobs component loads the app's handlers as it starts. */
  constructor(handlers?: readonly JobHandler[]) {
    if (handlers) this.load(handlers);
  }

  /** Takes the handlers, once. Two for one kind is a programming error. */
  load(handlers: readonly JobHandler[]): void {
    if (this.loaded) throw new Error('The job handlers are loaded already.');
    const queues: JobQueueSpec[] = [];
    const kinds = new Set<string>();
    for (const handler of handlers) {
      const { kind } = handler;
      if (kinds.has(kind.name)) {
        throw new Error(`Two job handlers for the job kind ${kind.name}.`);
      }
      kinds.add(kind.name);
      const failed = handler.failed && failedQueueOf(kind.name);
      queues.push({
        name: kind.name,
        phase: 'run',
        policy:
          handler.concurrency === undefined
            ? kind
            : defineJob({ ...kind, concurrency: handler.concurrency }),
        handler,
        ...(failed && { failedQueue: failed }),
      });
      if (failed) {
        queues.push({
          name: failed,
          phase: 'failed',
          policy: defineJob({
            name: kind.name,
            payload: kind.payload,
            ...REPORT_POLICY,
          }),
          handler,
        });
      }
    }
    this.loaded = { queues, byQueue: new Map(queues.map((q) => [q.name, q])) };
  }

  /** Every queue a handler runs: a kind's own, and its failed queue after it. */
  get queues(): readonly JobQueueSpec[] {
    return this.loaded?.queues ?? [];
  }

  /** The queue of that name, if a handler runs it. */
  queue(name: string): JobQueueSpec | undefined {
    return this.loaded?.byQueue.get(name);
  }

  /** Whether a handler runs this kind. */
  handles(kind: JobKind): boolean {
    return this.queue(kind.name)?.handler.kind === kind;
  }
}
