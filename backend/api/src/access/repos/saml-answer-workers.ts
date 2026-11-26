import { Worker } from 'node:worker_threads';
import type { XmlElement } from '@openfolia/xml';
import {
  type AnswerConfig,
  type FromWorker,
  type SignInRequest,
  type ToWorker,
  WORKER_ROLE,
  WORKER_URL,
} from './saml-answer.js';

/**
 * How long checking one answer may take in its worker. A sign-in takes a few milliseconds, the
 * slowest answers found within the bounds (`checkAnswer`) a few hundred (#946).
 */
export const ANSWER_LIMIT_MS = 2_000;
/** How long the database may take to record an assertion; past it, an error (never a refusal). */
const RECORD_LIMIT_MS = 30_000;
/** The least time left after the assertion is recorded, for the checks that follow. */
const AFTER_RECORD_MS = 100;
/** The workers at most. */
const WORKERS = 2;
/** The answers waiting for a worker at most; past it, refused as too many at once. */
const MAX_WAITING = 64;

/** The answer was refused: by its check, by its time, or its worker ended with it. */
export class SamlAnswerRefusedError extends Error {
  override readonly name = 'SamlAnswerRefusedError';

  constructor(
    /** The identity provider's status was no success. */
    readonly status: boolean,
    why: string,
  ) {
    super(why);
  }
}

/** Too many answers wait for a worker: none of them is checked. */
export class SamlAnswersBusyError extends Error {
  override readonly name = 'SamlAnswersBusyError';
}

interface Job {
  readonly message: Extract<ToWorker, { type: 'check' }>;
  readonly resolve: (assertion: XmlElement | undefined) => void;
  readonly reject: (error: unknown) => void;
  /** Why its assertion could not be recorded (the database), if it could not. */
  failure?: unknown;
}

interface Slot {
  readonly worker: Worker;
  ready: boolean;
  job: Job | undefined;
  timer: NodeJS.Timeout | undefined;
  /** The job's time left, and since when it runs down. */
  left: number;
  since: number;
}

const startWorker = () =>
  new Worker(new URL(WORKER_URL), {
    workerData: WORKER_ROLE,
    // Nothing of the server's: no settings, and not its flags (an inspector port, a loader).
    env: {},
    execArgv: [],
    // An answer within the bounds needs a few MB: one that takes more ends its worker only.
    resourceLimits: { maxOldGenerationSizeMb: 128 },
  });

/**
 * Verifies and reads SAML answers in worker threads (#951), so that none holds up the server,
 * whatever it holds: each may take `limitMs` in its worker (waiting for one, and for the database
 * recording its assertion, not counted), past which it is refused and its worker ended; a new one
 * starts for the next answer. Workers start as answers come, at most `WORKERS`, and then stay
 * (without holding the process open; shortcut: nothing closes them when the app closes, which
 * only tests that start many apps in one process notice: close them from a shutdown hook then).
 * The assertion is recorded by `record`, here, so the replay store stays the server's: the worker
 * waits for it.
 */
export class SamlAnswerWorkers {
  /** How long one answer may take in its worker. */
  limitMs = ANSWER_LIMIT_MS;
  /** How long the database may take to record an assertion. */
  recordLimitMs = RECORD_LIMIT_MS;
  private readonly slots = new Set<Slot>();
  private readonly waiting: Job[] = [];

  constructor(
    private readonly record: (key: string, until: Date) => Promise<boolean>,
    private readonly start: () => Worker = startWorker,
  ) {}

  /**
   * The assertion of a verified `answer` (none: it holds none). Rejects with
   * `SamlAnswerRefusedError` for a refusal, `SamlAnswersBusyError` when too many wait, and with
   * the error itself when the assertion could not be recorded or no worker starts.
   */
  check(
    answer: string,
    config: AnswerConfig,
    request: SignInRequest | undefined,
  ): Promise<XmlElement | undefined> {
    if (this.waiting.length >= MAX_WAITING) {
      return Promise.reject(
        new SamlAnswersBusyError(
          `More than ${MAX_WAITING} answers wait to be checked.`,
        ),
      );
    }
    return new Promise((resolve, reject) => {
      this.waiting.push({
        message: { type: 'check', answer, config, request },
        resolve,
        reject,
      });
      this.dispatch();
    });
  }

  /** Ends the workers; what waits or runs is refused. */
  async close(): Promise<void> {
    const ended = new Error('The SAML answer workers were closed.');
    for (const job of this.waiting.splice(0)) job.reject(ended);
    await Promise.all(
      [...this.slots].map((slot) => {
        slot.job?.reject(ended);
        return this.drop(slot);
      }),
    );
  }

  /** Gives waiting answers to idle workers, and starts workers for those left. */
  private dispatch(): void {
    for (const slot of this.slots) {
      if (!slot.ready || slot.job) continue;
      const job = this.waiting.shift();
      if (!job) return;
      slot.job = job;
      slot.worker.postMessage(job.message);
      this.run(slot, this.limitMs);
    }
    let starting = [...this.slots].filter((slot) => !slot.ready).length;
    while (this.waiting.length > starting && this.slots.size < WORKERS) {
      if (!this.spawn()) return;
      starting++;
    }
  }

  private spawn(): boolean {
    let worker: Worker;
    try {
      worker = this.start();
    } catch (error) {
      for (const job of this.waiting.splice(0)) job.reject(error);
      return false;
    }
    worker.unref();
    const slot: Slot = {
      worker,
      ready: false,
      job: undefined,
      timer: undefined,
      left: 0,
      since: 0,
    };
    this.slots.add(slot);
    worker.on('message', (message: FromWorker) => this.heard(slot, message));
    worker.on('error', (error) => this.lost(slot, error));
    worker.on('exit', (code) =>
      this.lost(slot, new Error(`The worker exited with ${code}.`)),
    );
    return true;
  }

  private heard(slot: Slot, message: FromWorker): void {
    if (!this.slots.has(slot)) return;
    if (message.type === 'ready') {
      slot.ready = true;
      this.dispatch();
      return;
    }
    const job = slot.job;
    if (!job) return;
    if (message.type === 'record') {
      // The database's time is not the answer's, but has a bound of its own: a database that
      // hangs never holds the workers.
      clearTimeout(slot.timer);
      // The worker asked in time (the signature verified): at least a little is left for the rest,
      // however long the server itself was busy meanwhile.
      slot.left = Math.max(
        slot.left - (performance.now() - slot.since),
        AFTER_RECORD_MS,
      );
      const limit = this.recordLimitMs;
      slot.timer = setTimeout(() => {
        void this.drop(slot);
        job.reject(
          new Error(`Recording the assertion took longer than ${limit} ms.`),
        );
        this.dispatch();
      }, limit);
      const reply = (saved: boolean | null) => {
        if (!this.slots.has(slot) || slot.job !== job) return;
        clearTimeout(slot.timer);
        slot.worker.postMessage({ type: 'recorded', saved } satisfies ToWorker);
        this.run(slot, slot.left);
      };
      this.record(message.key, new Date(message.until))
        .then(reply, (error: unknown) => {
          job.failure = error;
          reply(null);
        })
        // Never an unhandled rejection: a reply that fails ends its job as a lost worker would.
        .catch((error: unknown) => this.lost(slot, error as Error));
      return;
    }
    clearTimeout(slot.timer);
    slot.job = undefined;
    if (job.failure !== undefined) job.reject(job.failure);
    else if (message.type === 'checked') job.resolve(message.assertion);
    else job.reject(new SamlAnswerRefusedError(message.status, message.why));
    this.dispatch();
  }

  /** Lets the job's time run down from now, `ms` of it. */
  private run(slot: Slot, ms: number): void {
    slot.since = performance.now();
    slot.left = ms;
    const limit = this.limitMs;
    const job = slot.job;
    const timer: NodeJS.Timeout = setTimeout(
      () =>
        // Once more round the event loop first: an answer (or a record) the worker sent while the
        // server was busy is taken, not refused for the server's time.
        setImmediate(() => {
          if (
            !this.slots.has(slot) ||
            slot.job !== job ||
            slot.timer !== timer ||
            !job
          ) {
            return;
          }
          void this.drop(slot);
          job.reject(
            job.failure ??
              new SamlAnswerRefusedError(
                false,
                `Checking the answer took longer than ${limit} ms.`,
              ),
          );
          this.dispatch();
        }),
      Math.max(0, ms),
    );
    slot.timer = timer;
  }

  /** A worker that failed or ended by itself. */
  private lost(slot: Slot, error: Error): void {
    if (!this.slots.has(slot)) return;
    void this.drop(slot);
    const job = slot.job;
    if (job) {
      job.reject(
        job.failure ??
          new SamlAnswerRefusedError(
            false,
            `The worker checking the answer ended: ${error.message}`,
          ),
      );
    } else if (!slot.ready) {
      // It never started. Not one worker after another: with none that did, those waiting get
      // why; with one, it takes them as it comes free.
      if (![...this.slots].some((other) => other.ready)) {
        for (const waiting of this.waiting.splice(0)) waiting.reject(error);
      }
      return;
    }
    this.dispatch();
  }

  private async drop(slot: Slot): Promise<void> {
    clearTimeout(slot.timer);
    this.slots.delete(slot);
    // Ended either way: never an unhandled rejection.
    await slot.worker.terminate().catch(() => undefined);
  }
}
