import { Injectable } from '@nestjs/common';
import type { UnguardedAction } from '../../../access/core/policy.js';
import type { ClaimedJob } from '../job-claims.js';
import { JobHandlers } from '../job-handlers.js';

/** How an attempt ended. */
export type JobOutcome =
  | { readonly outcome: 'done' }
  | { readonly outcome: 'failed'; readonly message: string }
  /** Never run: no handler for its queue, or a payload its kind's schema refuses. */
  | { readonly outcome: 'refused'; readonly reason: 'no-handler' | 'payload' };

/** The longest failure message kept with a job. */
export const MAX_FAILURE_MESSAGE = 1_000;

/**
 * Runs one claimed attempt with its kind's handler: `run` for the kind's
 * own queue, `failed` for the queue of jobs that failed for good. The
 * stored payload is checked against the kind's schema first and never
 * reaches the handler when it does not fit. Says how it ended; settling
 * it is the worker's (`JobWorker`). Runs for nobody: the worker starts it,
 * and a handler acts as its component's service actor.
 */
@Injectable()
export class RunJobAction implements UnguardedAction {
  readonly policy = 'internal';

  constructor(private readonly handlers: JobHandlers) {}

  async handle(job: ClaimedJob, signal: AbortSignal): Promise<JobOutcome> {
    const queue = this.handlers.queue(job.queue);
    if (!queue) return { outcome: 'refused', reason: 'no-handler' };
    const parsed = queue.policy.payload.safeParse(job.payload);
    if (!parsed.success) return { outcome: 'refused', reason: 'payload' };
    try {
      if (queue.phase === 'failed') {
        await queue.handler.failed?.(parsed.data);
      } else {
        await queue.handler.run(parsed.data, {
          id: job.id,
          attempt: job.retryCount + 1,
          lastAttempt: job.retryCount >= job.retryLimit,
          signal,
        });
      }
      return { outcome: 'done' };
    } catch (error) {
      return { outcome: 'failed', message: failureMessage(error) };
    }
  }
}

/**
 * What is kept of a failure: the error's name and message, bounded; never
 * its stack or its fields, which may hold more than an operator needs.
 */
export function failureMessage(error: unknown): string {
  const text =
    error instanceof Error
      ? `${error.name}: ${error.message}`
      : `Thrown: ${String(error)}`;
  return text.length > MAX_FAILURE_MESSAGE
    ? `${text.slice(0, MAX_FAILURE_MESSAGE - 1)}…`
    : text;
}
