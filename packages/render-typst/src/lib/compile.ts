import { fork, spawnSync, type ChildProcess } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deserialize, serialize } from 'node:v8';
import {
  assertPrivateDirectory,
  createWorkspace,
  memoryMarker,
  ONCE_ARG,
  ONCE_INPUT,
  ONCE_RESULT,
  safeRelativePath,
  WORKER_ARG,
  WORKER_URL,
  type AccessibilityProblem,
  type CoreInput,
  type CoreResult,
  type FontFile,
  type WorkerRequest,
  type WorkerResponse,
} from './compile-core.js';
import { withProducer } from './pdf-producer.js';
import { DEFAULT_TEMPLATE } from './template.js';
import { printTheme } from './tokens.js';
import {
  BUILTIN_FILES,
  DEFAULT_LOGO_PATH,
  isReservedPath,
} from './builtins.js';
import {
  DEFAULT_PDF_STANDARD,
  type PdfStandard,
} from '@openfolia/content-model';
import { DESIGN_FILES, layoutWarnings, type LayoutWarning } from './design.js';

export interface CompileInput {
  /** The generated document (from `renderTypst`). */
  source: string;
  /** Template source; defaults to `DEFAULT_TEMPLATE`, the product's design. */
  template?: string;
  /** Other files the document needs (images, safety symbols), by relative path; not `main.typ`, `template.typ`, `tokens.typ` or anything under `openfolia/` (the compiler's own). */
  files?: Record<string, Uint8Array>;
  /**
   * Font files to load in addition to the theme's fonts and Typst's built-in ones: TrueType,
   * OpenType, WOFF or WOFF2; one given with a `family` is loaded as that family (a design's,
   * `RenderResult.fonts`).
   */
  fonts?: FontFile[];
  /**
   * The PDF standard (`pdf.standard` in the configuration): `ua-1`, PDF/UA-1, by
   * default (a document that cannot meet it fails with `TypstAccessibilityError`),
   * or `none`, a plain PDF. Page images ignore it.
   */
  standard?: PdfStandard;
  /**
   * The time the PDF says it was made (its creation and modification dates,
   * and the document ID derived from them), in whole seconds since the epoch,
   * e.g. the commit time of the content: the same input then always gives
   * the same bytes. Left out: the time of rendering, so two renderings differ.
   */
  creationTimestamp?: number;
  /**
   * Strings the document and template read as `sys.inputs` (`RenderResult.inputs`: a page
   * design's settings, #391). Data only: Typst never evaluates them.
   */
  inputs?: Record<string, string>;
}

/** A PDF with what its layout reported (a page design's region or running head that did not fit). */
export interface CompiledPdf {
  pdf: Buffer;
  warnings: LayoutWarning[];
}

/** A compilation's result inside the package: the bytes and the layout's warnings. */
interface Compiled {
  data: Buffer;
  warnings: LayoutWarning[];
}

/** The compiler's own design files (#391), as files to map. */
const DESIGN_FILE_BYTES: Record<string, Uint8Array> = Object.fromEntries(
  Object.entries(DESIGN_FILES).map(([path, text]) => [
    path,
    new TextEncoder().encode(text),
  ]),
);

/**
 * The document compiled, but cannot be exported to its PDF standard
 * (PDF/UA-1): e.g. an image without alt text, a document without a title,
 * a heading level skipped. `problems` are Typst's messages and hints, safe
 * to show to the author.
 */
export class TypstAccessibilityError extends Error {
  readonly problems: AccessibilityProblem[];
  /**
   * What the layout could not fit (`CompiledPdf.warnings`): the document was laid out before
   * the export refused it, so its warnings are known too (#554).
   */
  readonly warnings: LayoutWarning[];
  constructor(
    problems: AccessibilityProblem[],
    warnings: LayoutWarning[] = [],
  ) {
    super(
      `The document does not meet PDF/UA-1:\n${problems.map((p) => p.message).join('\n')}`,
    );
    this.name = 'TypstAccessibilityError';
    this.problems = problems;
    this.warnings = warnings;
  }
}

export class TypstCompileError extends Error {
  readonly diagnostics: unknown[];
  constructor(diagnostics: unknown[]) {
    super(
      `Typst compilation failed:\n${diagnostics.map((d) => JSON.stringify(d)).join('\n')}`,
    );
    this.name = 'TypstCompileError';
    this.diagnostics = diagnostics;
  }
}

/** The compilation (including time waiting for a worker) exceeded its timeout. */
export class TypstTimeoutError extends Error {
  /**
   * True if most of the time went to waiting for a worker (the server is
   * busy; a retry may succeed), false if the compilation itself took most
   * of it (the document is too slow; a retry would most likely fail again).
   */
  readonly queued: boolean;
  constructor(ms: number, queued = false) {
    super(
      queued
        ? `no PDF worker became free within ${ms} ms`
        : `Typst compilation did not finish within ${ms} ms`,
    );
    this.name = 'TypstTimeoutError';
    this.queued = queued;
  }
}

/**
 * The compiling process used more memory than its limit (`PoolOptions.memoryLimitMb`,
 * `WorkerOptions.memoryLimitMb`) and was stopped (#396): a document or template that exhausts
 * memory. A retry would fail again.
 */
export class TypstMemoryError extends Error {
  /** The limit it passed, in MiB. */
  readonly limitMb: number;
  constructor(limitMb: number) {
    super(`Typst compilation used more than ${limitMb} MiB of memory`);
    this.name = 'TypstMemoryError';
    this.limitMb = limitMb;
  }
}

/**
 * How much memory a compiling process may use, in MiB, when none is configured: its resident
 * memory, the compiler's own included (a worker stays at about 100–150 MB with a reused compiler, at most about 450 MB, "Memory").
 */
export const DEFAULT_MEMORY_LIMIT_MB = 2048;
/** Bounds for a memory limit, in MiB. */
export const MEMORY_LIMIT_MB = { min: 256, max: 65_536 } as const;

/** `limitMb`, checked: a whole number within `MEMORY_LIMIT_MB`, else `RangeError`. */
function memoryLimit(limitMb: number): number {
  if (
    !Number.isInteger(limitMb) ||
    limitMb < MEMORY_LIMIT_MB.min ||
    limitMb > MEMORY_LIMIT_MB.max
  ) {
    throw new RangeError(
      `memoryLimitMb must be a whole number from ${MEMORY_LIMIT_MB.min} to ${MEMORY_LIMIT_MB.max}, got ${limitMb}`,
    );
  }
  return limitMb;
}

/** Whether the process `pid` left its memory marker in `root` (and removes it). */
function ranOutOfMemory(root: string, pid: number | undefined): boolean {
  if (pid === undefined) return false;
  const marker = memoryMarker(root, pid);
  if (!existsSync(marker)) return false;
  rmSync(marker, { force: true });
  return true;
}

/** The worker pool was shut down (`closeWorkerPool`); no more compilations. */
export class TypstClosedError extends Error {
  constructor() {
    super('the PDF worker pool is closed');
    this.name = 'TypstClosedError';
  }
}

/** The document has fewer pages than the one asked for. */
export class TypstPageNotFoundError extends Error {
  /** How many pages the document has. */
  readonly pages: number;
  constructor(pages: number) {
    super(`the document has ${pages} page${pages === 1 ? '' : 's'}`);
    this.name = 'TypstPageNotFoundError';
    this.pages = pages;
  }
}

/** Too many compilations are already waiting. */
export class TypstBusyError extends Error {
  constructor() {
    super('too many PDF compilations are waiting; try again later');
    this.name = 'TypstBusyError';
  }
}

function coreInput(input: CompileInput): CoreInput {
  const stamp = input.creationTimestamp;
  // PDF dates run from year 0 to 9999; a time before 1970 is no commit's.
  if (
    stamp !== undefined &&
    (!Number.isSafeInteger(stamp) || stamp < 0 || stamp > 253_402_300_799)
  ) {
    throw new RangeError(
      `creationTimestamp must be whole seconds from 0 to 253402300799, got ${stamp}`,
    );
  }
  // A copy: what is checked is what compiles, even if the caller changes its object later.
  const files = { ...(input.files ?? {}) };
  for (const path of Object.keys(files)) {
    if (isReservedPath(safeRelativePath(path))) {
      throw new Error(`invalid file path "${path}": reserved for the compiler`);
    }
  }
  const { tokens, fontDir, logo } = printTheme();
  return {
    source: input.source,
    template: input.template ?? DEFAULT_TEMPLATE,
    files: {
      ...files,
      ...BUILTIN_FILES,
      ...DESIGN_FILE_BYTES,
      [DEFAULT_LOGO_PATH]: logo,
    },
    fonts: input.fonts ?? [],
    fontDirs: [fontDir],
    tokens,
    standard: input.standard ?? DEFAULT_PDF_STANDARD,
    ...(input.creationTimestamp !== undefined && {
      creationTimestamp: input.creationTimestamp,
    }),
    ...(input.inputs !== undefined && { inputs: { ...input.inputs } }),
  };
}

/** The file a compiling child process runs. */
const WORKER_PATH = fileURLToPath(WORKER_URL);

/**
 * Where a compiling process's downloads would go: port 0 on the loopback
 * interface, which no process can listen on (binding port 0 picks another),
 * so every request fails at once and none leaves the machine. reqwest takes
 * it as a proxy (a proxy it could not parse would be ignored: a direct
 * request); tried with typst-ts 0.7.0, with the network up.
 */
export const BLOCKED_PROXY = 'http://127.0.0.1:0';

/**
 * The whole environment of a compiling child process, whose directory
 * `root` is private (0700) and holds its workspaces. The compiler resolves
 * Typst packages (`@preview/…`, `@local/…`) from the home directory's cache
 * and data directories and downloads missing ones from the package
 * registry; it has no option to turn that off. So the child's home is
 * `root/home`, which never exists (no package is ever found there), and
 * every download goes to `BLOCKED_PROXY`. Nothing else is inherited: no
 * secrets, no `NODE_OPTIONS`. Linux and macOS read these variables; on
 * Windows the compiler finds the user's folders by another way.
 */
export function sandboxEnv(root: string): NodeJS.ProcessEnv {
  if (process.platform === 'win32') {
    throw new Error(
      'PDF compilation is not supported on Windows: the compiler finds Typst packages there without the environment, so the sandbox would not hold',
    );
  }
  const home = join(root, 'home');
  const proxy = Object.fromEntries(
    ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY'].flatMap((name) => [
      [name, BLOCKED_PROXY],
      [name.toLowerCase(), BLOCKED_PROXY],
    ]),
  );
  return {
    HOME: home,
    XDG_CACHE_HOME: join(home, '.cache'),
    XDG_DATA_HOME: join(home, '.local', 'share'),
    XDG_CONFIG_HOME: join(home, '.config'),
    ...proxy,
    // The time zone a document's `datetime.today()` uses stays the server's.
    ...(process.env['TZ'] !== undefined && { TZ: process.env['TZ'] }),
    // Windows cannot start a process without it.
    ...(process.env['SystemRoot'] !== undefined && {
      SystemRoot: process.env['SystemRoot'],
    }),
  };
}

/** The options every compiling child process starts with: only `sandboxEnv`, in its private directory. */
export function childOptions(root: string): {
  env: NodeJS.ProcessEnv;
  cwd: string;
} {
  return { env: sandboxEnv(root), cwd: root };
}

/**
 * Compiles to PDF in a child process (`sandboxEnv`); no Typst installation
 * needed. Blocks until done, at most `timeoutMs` (default 60 s; then
 * `TypstTimeoutError`); servers should use `compilePdfInWorker`. Uses a
 * fresh private directory that is removed afterwards.
 */
export function compilePdf(
  input: CompileInput,
  options: WorkerOptions = {},
): Buffer {
  return compilePdfReport(input, options).pdf;
}

/** `compilePdf`, with what the layout reported (`CompiledPdf.warnings`). */
export function compilePdfReport(
  input: CompileInput,
  {
    timeoutMs = 60_000,
    memoryLimitMb = DEFAULT_MEMORY_LIMIT_MB,
  }: WorkerOptions = {},
): CompiledPdf {
  const limitMb = memoryLimit(memoryLimitMb);
  const core = coreInput(input);
  const root = mkdtempSync(join(tmpdir(), 'openfolia-typst-once-'));
  try {
    const workspace = createWorkspace(root);
    writeFileSync(join(root, ONCE_INPUT), serialize(core), { mode: 0o600 });
    const run = spawnSync(
      process.execPath,
      [WORKER_PATH, ONCE_ARG, root, workspace, String(limitMb * MIB)],
      {
        ...childOptions(root),
        stdio: ['ignore', 'inherit', 'inherit'],
        timeout: timeoutMs,
        killSignal: 'SIGKILL',
      },
    );
    if (
      (run.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT'
    ) {
      throw new TypstTimeoutError(timeoutMs);
    }
    if (run.error) throw run.error;
    if (ranOutOfMemory(root, run.pid)) throw new TypstMemoryError(limitMb);
    if (run.status !== 0) {
      throw new Error(
        `Typst compilation process exited with ${run.status ?? run.signal}`,
      );
    }
    const result = deserialize(
      readFileSync(join(root, ONCE_RESULT)),
    ) as CoreResult;
    const compiled = unwrap(result);
    return { pdf: withProducer(compiled.data), warnings: compiled.warnings };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * Deletes a pool or workspace directory. Logs instead of throwing: it runs
 * in event handlers and during shutdown, where a throw would crash the
 * process.
 */
function removeDir(path: string): boolean {
  try {
    rmSync(path, { recursive: true, force: true });
    return true;
  } catch (e) {
    console.error(`Could not remove PDF directory ${path}:`, e);
    return false;
  }
}

const MIB = 1024 * 1024;

/** setTimeout's limit; larger delays would fire immediately. */
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

/**
 * Compilers a worker makes before it is replaced (#436): every `NodeCompiler.create` keeps
 * memory until the process ends, so a run of jobs that each need a new compiler (each with
 * fonts of its own, or failing) is bounded as every job was before compilers were reused.
 */
export const COMPILERS_PER_WORKER = 50;

/** Default `PoolOptions.jobsPerWorker`: a reused compiler grows little per job ("Memory"). */
export const DEFAULT_JOBS_PER_WORKER = 500;

/** Upper bound for the number of PDF worker processes. */
export const MAX_POOL_SIZE = 64;

function unwrap(result: CoreResult): Compiled {
  if (result.ok) {
    return {
      data: Buffer.from(result.data),
      warnings: layoutWarnings(result.warnings),
    };
  }
  if ('pages' in result) throw new TypstPageNotFoundError(result.pages);
  // Server-side problems are plain errors: logged, never shown as document diagnostics.
  if ('internal' in result) throw new Error(result.internal);
  if ('accessibility' in result) {
    throw new TypstAccessibilityError(
      result.accessibility,
      layoutWarnings(result.warnings),
    );
  }
  throw new TypstCompileError(result.diagnostics);
}

/**
 * Which compilations go first while every worker is busy: `interactive`
 * ones (someone waits for the answer: a PDF download, a preview, a check)
 * start before every waiting `background` one (bulk work nobody watches,
 * such as a release's files); within each, first come, first served.
 */
export type WorkerPriority = 'interactive' | 'background';

export interface WorkerOptions {
  /**
   * Deadline for the whole job, waiting included. Default: 60 s. A `background` job's deadline
   * is for its compilation alone, from when a worker takes it (#497: its wait behind
   * interactive jobs is no fault of the document); it waits at most `waitMs` for a worker,
   * then fails as waiting (`TypstTimeoutError.queued`).
   */
  timeoutMs?: number;
  /** A `background` job's longest wait for a worker, in ms. Default: its `timeoutMs`. */
  waitMs?: number;
  /** Default: `interactive`. */
  priority?: WorkerPriority;
  /**
   * A `background` job someone now waits for (#497: a reader asking for the same PDF): once
   * this signal aborts, the job, while it still waits, goes ahead as an `interactive` one,
   * its deadline counting from then, waiting included.
   */
  raise?: AbortSignal;
  /**
   * `compilePdf` and `compilePdfReport` only (a pool's processes take `PoolOptions.memoryLimitMb`):
   * the memory the compiling process may use, in MiB. Default: `DEFAULT_MEMORY_LIMIT_MB`.
   */
  memoryLimitMb?: number;
}

export interface PoolOptions {
  /** Worker processes, 1 to `MAX_POOL_SIZE`. Default: one per spare CPU, at most `MAX_POOL_SIZE`. */
  size?: number;
  /** Jobs allowed to wait for a worker (0 = none); more are rejected with `TypstBusyError`. Default: 4 per worker. */
  maxQueue?: number;
  /**
   * Jobs a worker runs before it is replaced, to return its memory: its compiler, reused from
   * job to job, keeps a little of each (README, "Memory"). A worker is also replaced once it has
   * made `COMPILERS_PER_WORKER` compilers. Default: `DEFAULT_JOBS_PER_WORKER` (500).
   */
  jobsPerWorker?: number;
  /**
   * The memory a worker process may use, in MiB (`MEMORY_LIMIT_MB`): its resident memory, the
   * compiler's included. Past it the process is stopped, and its job fails with
   * `TypstMemoryError` (#396). Default: `DEFAULT_MEMORY_LIMIT_MB`.
   */
  memoryLimitMb?: number;
}

interface Job {
  id: number;
  /** Waits behind every interactive job (`WorkerPriority`). */
  background: boolean;
  /** Its deadline (`WorkerOptions.timeoutMs`). */
  timeoutMs: number;
  /** When it was handed to a worker (the latest time, if retried). */
  startedAt?: number;
  /** Already sent back once after its worker found the pool directory broken. */
  retried?: boolean;
  input: CoreInput;
  resolve: (result: Compiled) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface Slot {
  worker: ChildProcess;
  job?: Job;
  jobs: number;
  /** Compilers its process has made (`WorkerResponse`'s `compilers`): each keeps memory (#436). */
  compilers: number;
  /** Errored or timed out: gets no more jobs, but keeps its place until its process exits. */
  dead: boolean;
  /** Its process has exited (or never started) and it was cleaned up. */
  gone: boolean;
  /** Resolves once `gone`. */
  exited: Promise<void>;
  markExited: () => void;
  /** The pool directory the worker was started with. */
  root: string;
  /** Workspaces the worker uses; deleted when it exits. */
  workspaces: string[];
}

/**
 * A pool of long-lived worker processes (child processes with
 * `sandboxEnv`'s environment) with one capacity rule: `slots` holds the
 * workers that count toward `size`. A job starts when a worker is idle or
 * there is room for another; otherwise it waits, if the queue has room, or
 * is rejected with `TypstBusyError`.
 *
 * A job that misses its deadline is rejected and its worker killed; that
 * worker keeps its place until its process has exited, so runaway
 * compilations never add processes. A worker retired while idle (after its
 * job quota, or because the pool directory changed) gives up its place at
 * once; for the moments it takes to exit, one idle process more than
 * `size` may exist. A process returns all its memory when it ends, which
 * the compiler does not while it lives (`jobsPerWorker`).
 */
class WorkerPool {
  private readonly slots = new Set<Slot>();
  private readonly queue: Job[] = [];
  private nextId = 1;
  /**
   * Private (0700) directory holding every worker's workspace, made with
   * mkdtemp. Replaced, together with its idle workers, when a worker
   * reports it unsafe, or when a dispatch finds it gone or no longer
   * private. Every directory the pool made is
   * removed on close and when the process exits (which also covers
   * workers still running then; their own exit cleanup never runs).
   */
  private root: string;
  private readonly roots: string[] = [];
  /** Every worker process still alive, including retired ones that are exiting. */
  private readonly processes = new Set<Slot>();
  private closed = false;
  /** A worker reported the directory unsafe, or replacing it failed: replace before the next dispatch. */
  private rootBroken = false;

  private readonly onProcessExit = () => {
    // Children would otherwise outlive the server until their job ends.
    for (const slot of this.processes) slot.worker.kill('SIGKILL');
    this.removeRoots();
  };

  constructor(
    private readonly size: number,
    private readonly maxQueue: number,
    private readonly jobsPerWorker: number,
    private readonly memoryLimitMb: number,
  ) {
    this.root = this.makeRoot();
    process.once('exit', this.onProcessExit);
  }

  run(
    input: CoreInput,
    timeoutMs: number,
    priority: WorkerPriority = 'interactive',
    raise?: AbortSignal,
    waitMs = timeoutMs,
  ): Promise<Compiled> {
    if (this.closed) return Promise.reject(new TypstClosedError());
    const canStart =
      this.idleSlot() !== undefined || this.slots.size < this.size;
    if (!canStart && this.queue.length >= this.maxQueue) {
      return Promise.reject(new TypstBusyError());
    }
    return new Promise<Compiled>((resolve, reject) => {
      // Raised before it got here (a reader joined while its input was read): interactive.
      const background = priority === 'background' && raise?.aborted !== true;
      const onRaise = () => this.raise(job);
      const settled = () => raise?.removeEventListener('abort', onRaise);
      const job: Job = {
        id: this.nextId++,
        background,
        timeoutMs,
        input,
        resolve: (result) => {
          settled();
          resolve(result);
        },
        reject: (error) => {
          settled();
          reject(error);
        },
        // A background job's wait, then it counts as waiting; else the whole deadline.
        timer: background
          ? setTimeout(() => this.expireWaiting(job, waitMs), waitMs)
          : setTimeout(() => this.expire(job, timeoutMs), timeoutMs),
      };
      if (background && raise) {
        raise.addEventListener('abort', onRaise, { once: true });
      }
      this.enqueue(job);
      this.dispatch();
      // Expected to start but could not (a worker failed to start): apply the limit now.
      if (this.queue.length > this.maxQueue && this.queue.includes(job)) {
        this.queue.splice(this.queue.indexOf(job), 1);
        this.fail(job, new TypstBusyError());
      }
    });
  }

  /**
   * Someone waits for a background job now (`WorkerOptions.raise`): while it still waits, it
   * becomes interactive, ahead of every waiting background job, its deadline (waiting
   * included) counting from now. One a worker has taken already keeps its compile deadline.
   */
  private raise(job: Job): void {
    const at = this.queue.indexOf(job);
    if (at < 0 || !job.background) return;
    this.queue.splice(at, 1);
    job.background = false;
    clearTimeout(job.timer);
    job.timer = setTimeout(
      () => this.expire(job, job.timeoutMs),
      job.timeoutMs,
    );
    this.enqueue(job);
  }

  /** Into the queue: an interactive job before every waiting background one, else last. */
  private enqueue(job: Job): void {
    const firstBackground = job.background
      ? -1
      : this.queue.findIndex((waiting) => waiting.background);
    if (firstBackground < 0) this.queue.push(job);
    else this.queue.splice(firstBackground, 0, job);
  }

  /**
   * Rejects waiting and running jobs and refuses new ones, stops every
   * worker (retired ones still exiting included) and removes all directories.
   */
  async close(): Promise<void> {
    this.closed = true;
    const error = new TypstClosedError();
    for (const job of this.queue.splice(0)) this.fail(job, error);
    this.slots.clear();
    const processes = [...this.processes];
    for (const slot of processes) {
      const job = slot.job;
      slot.dead = true;
      slot.job = undefined;
      if (job) this.fail(job, error);
    }
    // Never rejects: shutdown must go on even if a process or folder resists.
    for (const slot of processes) {
      try {
        // Held until it has exited, so the wait below keeps the process alive.
        hold(slot.worker, true);
        slot.worker.kill('SIGKILL');
      } catch (e) {
        console.error('Could not stop a PDF worker:', e);
      }
    }
    await Promise.all(processes.map((slot) => slot.exited));
    this.removeRoots();
    // Kept until now: if the process exits mid-close, the listener still cleans up.
    process.removeListener('exit', this.onProcessExit);
  }

  private dispatch(): void {
    if (this.closed || this.queue.length === 0) return;
    // Before jobs go out, replace the pool directory if it is gone, no
    // longer private, or still marked unsafe (a replacement that failed).
    if (this.rootBroken || !isPrivateDirectory(this.root)) {
      if (!this.replaceRoot()) return;
    }
    while (this.queue.length > 0) {
      const slot = this.idleSlot() ?? this.spawn();
      if (!slot) return;
      const job = this.queue.shift() as Job;
      slot.job = job;
      if (job.background && job.startedAt === undefined) {
        // Its deadline is its compilation's, from now (#497).
        clearTimeout(job.timer);
        job.timer = setTimeout(
          () => this.expire(job, job.timeoutMs),
          job.timeoutMs,
        );
      }
      job.startedAt = Date.now();
      slot.jobs++;
      hold(slot.worker, true);
      slot.worker.send({
        id: job.id,
        input: job.input,
      } satisfies WorkerRequest);
    }
  }

  private idleSlot(): Slot | undefined {
    // Workers on an old directory are retired by renewRoot or after their job.
    for (const slot of this.slots) {
      if (!slot.dead && !slot.job && slot.root === this.root) return slot;
    }
    return undefined;
  }

  /** A new worker if the pool has room; undefined if it is full or the worker cannot start. */
  private spawn(): Slot | undefined {
    if (this.closed || this.slots.size >= this.size) return undefined;
    let worker: ChildProcess;
    let workspace: string;
    try {
      workspace = createWorkspace(this.root);
      try {
        worker = fork(
          WORKER_PATH,
          [WORKER_ARG, this.root, workspace, String(this.memoryLimitMb * MIB)],
          {
            ...childOptions(this.root),
            // Not the server's own flags (an inspector port, a loader).
            execArgv: [],
            serialization: 'advanced',
            stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
          },
        );
      } catch (e) {
        removeDir(workspace);
        throw e;
      }
    } catch (e) {
      this.failIfNoWorker(e as Error);
      return undefined;
    }
    const { promise: exited, resolve: markExited } =
      Promise.withResolvers<void>();
    const slot: Slot = {
      worker,
      jobs: 0,
      compilers: 0,
      dead: false,
      gone: false,
      exited,
      markExited,
      root: this.root,
      workspaces: [workspace],
    };
    this.slots.add(slot);
    this.processes.add(slot);
    hold(worker, false);
    worker.on('message', (message: WorkerResponse) =>
      this.onMessage(slot, message),
    );
    worker.on('error', (error) => {
      const job = slot.job;
      // A failed kill emits 'error' too: kill only a worker not already dead, so never twice.
      const wasDead = slot.dead;
      slot.dead = true;
      slot.job = undefined;
      if (!wasDead && worker.pid !== undefined) worker.kill('SIGKILL');
      if (job) this.fail(job, error);
      // It never started: no 'exit' follows, and a retry would fail alike.
      if (worker.pid === undefined) {
        this.cleanUp(slot);
        this.failIfNoWorker(error);
        return;
      }
      this.dispatch();
    });
    worker.on('exit', (code, signal) => {
      const job = slot.job;
      slot.job = undefined;
      // Read before cleaning up: its directory may go with it.
      const outOfMemory = ranOutOfMemory(slot.root, worker.pid);
      this.cleanUp(slot);
      if (job) {
        this.fail(
          job,
          outOfMemory
            ? new TypstMemoryError(this.memoryLimitMb)
            : new Error(
                `Typst worker exited with ${code ?? signal ?? 'no code'}`,
              ),
        );
      }
      this.dispatch();
    });
    return slot;
  }

  /** With no live worker, nothing would ever serve the queue: fails it with the real cause. */
  private failIfNoWorker(error: Error): void {
    if (![...this.slots].some((slot) => !slot.dead)) {
      for (const job of this.queue.splice(0)) this.fail(job, error);
    }
  }

  /** Forgets a worker whose process is gone and removes its directories; once. */
  private cleanUp(slot: Slot): void {
    if (slot.gone) return;
    slot.gone = true;
    slot.dead = true;
    this.slots.delete(slot);
    this.processes.delete(slot);
    for (const path of slot.workspaces) removeDir(path);
    this.dropRootIfUnused(slot.root);
    slot.markExited();
  }

  private onMessage(slot: Slot, message: WorkerResponse): void {
    if (message.type === 'workspace') {
      slot.workspaces.push(message.path);
      return;
    }
    const job = slot.job;
    if (!job || job.id !== message.id) return;
    const { result } = message;
    slot.compilers = message.compilers;
    slot.job = undefined;
    hold(slot.worker, false);
    const brokenRoot =
      !result.ok && 'internal' in result && result.brokenRoot === true;
    // The worker found the directory unsafe after dispatch checked it: trust
    // that (no re-check a quick chmod could pass). Its idle workers stop
    // now and the directory is replaced below. The job never ran, so it
    // goes back once.
    if (brokenRoot && slot.root === this.root) {
      this.rootBroken = true;
      this.retireIdle((root) => root === this.root);
    }
    if (brokenRoot && !job.retried) {
      job.retried = true;
      this.queue.unshift(job);
    } else {
      clearTimeout(job.timer);
      try {
        job.resolve(unwrap(result));
      } catch (e) {
        job.reject(e as Error);
      }
    }
    if (
      !slot.dead &&
      (slot.jobs >= this.jobsPerWorker ||
        slot.compilers >= COMPILERS_PER_WORKER ||
        slot.root !== this.root ||
        this.rootBroken)
    ) {
      this.retire(slot);
    }
    // Replace a reported directory now, before dispatch, so nothing stays
    // on it even while the pool is idle.
    if (brokenRoot && this.rootBroken && !this.closed) this.replaceRoot();
    this.dispatch();
  }

  /**
   * Switches to a new pool directory. If none can be made, every waiting
   * job fails with that cause and idle workers on the unsafe directory are
   * stopped; the next dispatch tries again. Returns whether it worked.
   */
  private replaceRoot(): boolean {
    try {
      this.renewRoot();
      return true;
    } catch (e) {
      this.rootBroken = true;
      for (const job of this.queue.splice(0)) this.fail(job, e as Error);
      this.retireIdle((root) => root === this.root);
      return false;
    }
  }

  /** Switches to a new pool directory; idle workers on the old one are replaced. */
  private renewRoot(): void {
    this.root = this.makeRoot();
    this.rootBroken = false;
    this.retireIdle((root) => root !== this.root);
    // Removes the old directory once unused, and retries ones that failed before.
    for (const root of [...this.roots]) this.dropRootIfUnused(root);
  }

  /** Retires every idle worker whose pool directory matches. */
  private retireIdle(onRoot: (root: string) => boolean): void {
    for (const slot of [...this.slots]) {
      if (!slot.dead && !slot.job && onRoot(slot.root)) this.retire(slot);
    }
  }

  /** Removes an old pool directory once no worker uses it anymore. */
  private dropRootIfUnused(root: string): void {
    if (root === this.root) return;
    for (const slot of this.processes) if (slot.root === root) return;
    // Kept on the list if removal failed, so close or exit tries again.
    if (!removeDir(root)) return;
    const index = this.roots.indexOf(root);
    if (index >= 0) this.roots.splice(index, 1);
  }

  /** Stops an idle worker and frees its place now; its directories are removed when it exits. */
  private retire(slot: Slot): void {
    this.kill(slot);
    this.slots.delete(slot);
  }

  /** Marks a worker dead and stops it; it keeps its place until 'exit' unless retired. */
  private kill(slot: Slot): void {
    slot.dead = true;
    slot.job = undefined;
    // A compilation cannot be interrupted, only its process ended.
    slot.worker.kill('SIGKILL');
  }

  private fail(job: Job, error: Error): void {
    clearTimeout(job.timer);
    job.reject(error);
  }

  /** A background job that found no worker within its deadline: refused as waiting, never as slow. */
  private expireWaiting(job: Job, waited: number): void {
    const queued = this.queue.indexOf(job);
    if (queued < 0) return;
    this.queue.splice(queued, 1);
    job.reject(new TypstTimeoutError(waited, true));
  }

  private expire(job: Job, timeoutMs: number): void {
    const queued = this.queue.indexOf(job);
    if (queued >= 0) this.queue.splice(queued, 1);
    for (const slot of this.slots) if (slot.job === job) this.kill(slot);
    // Classified by how long it actually compiled, not where it was at the end.
    const compiledMs =
      queued >= 0 || job.startedAt === undefined
        ? 0
        : Date.now() - job.startedAt;
    job.reject(new TypstTimeoutError(timeoutMs, compiledMs < timeoutMs / 2));
  }

  private makeRoot(): string {
    const root = mkdtempSync(join(tmpdir(), 'openfolia-typst-pool-'));
    this.roots.push(root);
    return root;
  }

  private removeRoots(): void {
    for (const root of this.roots) {
      removeDir(root);
    }
  }
}

/**
 * Whether a worker keeps the server's event loop alive: only while it has
 * a job (its process and its IPC channel both count).
 */
function hold(worker: ChildProcess, busy: boolean): void {
  if (busy) {
    worker.ref();
    worker.channel?.ref();
  } else {
    worker.unref();
    worker.channel?.unref();
  }
}

/** Whether `path` passes `assertPrivateDirectory`. */
function isPrivateDirectory(path: string): boolean {
  try {
    assertPrivateDirectory(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * The running pool, or 'closed' after `closeWorkerPool` (even if no pool
 * had started), so a request still in flight during shutdown cannot start
 * one; `configureWorkerPool` starts a new pool.
 */
let pool: WorkerPool | 'closed' | undefined;
let closing: Promise<void> | undefined;

/**
 * Shuts the worker pool down: rejects waiting and running jobs, stops the
 * workers and removes their workspaces. Later `compilePdfInWorker` calls
 * are rejected (so nothing starts new processes during shutdown) until
 * `configureWorkerPool` sets up a new pool. This holds even if no pool had
 * started yet: a request still in flight during shutdown cannot start one.
 */
export async function closeWorkerPool(): Promise<void> {
  const current = pool;
  pool = 'closed';
  // Every caller waits for the same shutdown, including later ones.
  if (current instanceof WorkerPool) closing = current.close();
  await closing;
}

/**
 * Sets the worker pool's limits. Call before the first `compilePdfInWorker`
 * (or after `closeWorkerPool`); throws `RangeError` for invalid limits.
 */
export function configureWorkerPool(options: PoolOptions): void {
  if (pool instanceof WorkerPool)
    throw new Error('the worker pool is already running');
  pool = createPool(options);
}

/** The pool's size when `PoolOptions.size` is left out: one worker per spare CPU, at most `MAX_POOL_SIZE`. */
export function defaultPoolSize(): number {
  return Math.min(MAX_POOL_SIZE, Math.max(1, availableParallelism() - 1));
}

function createPool(options: PoolOptions): WorkerPool {
  const size = options.size ?? defaultPoolSize();
  const maxQueue = options.maxQueue ?? size * 4;
  const jobsPerWorker = options.jobsPerWorker ?? DEFAULT_JOBS_PER_WORKER;
  const memoryLimitMb = memoryLimit(
    options.memoryLimitMb ?? DEFAULT_MEMORY_LIMIT_MB,
  );
  const check = (name: string, value: number, min: number, max = Infinity) => {
    if (!Number.isInteger(value) || value < min || value > max) {
      throw new RangeError(
        `${name} must be a whole number from ${min} to ${max}, got ${value}`,
      );
    }
  };
  check('size', size, 1, MAX_POOL_SIZE);
  check('maxQueue', maxQueue, 0);
  check('jobsPerWorker', jobsPerWorker, 1);
  return new WorkerPool(size, maxQueue, jobsPerWorker, memoryLimitMb);
}

/**
 * Compiles to PDF in a worker process, so the event loop stays free.
 * Rejects with `TypstTimeoutError` when the job (waiting included) takes
 * longer than `timeoutMs`, with `TypstBusyError` when the queue is full,
 * and with `RangeError` for a timeout outside 1 ms – ~24.8 days. Never
 * throws synchronously.
 */
export function compilePdfInWorker(
  input: CompileInput,
  options: WorkerOptions = {},
): Promise<Buffer> {
  return compilePdfReportInWorker(input, options).then(({ pdf }) => pdf);
}

/** `compilePdfInWorker`, with what the layout reported (`CompiledPdf.warnings`). */
export function compilePdfReportInWorker(
  input: CompileInput,
  options: WorkerOptions = {},
): Promise<CompiledPdf> {
  // The producer is added here, on the main thread: the worker runs only compile-core.
  return inWorker(input, undefined, options).then(({ data, warnings }) => ({
    pdf: withProducer(data),
    warnings,
  }));
}

/** Bounds for a page image's width, in pixels. */
export const PAGE_WIDTH = { min: 16, max: 2400 } as const;

/**
 * One page (1-based) of the document as a PNG `width` pixels wide (the
 * height follows the page's proportions), compiled and rasterised on a
 * worker process like `compilePdfInWorker` (same pool, limits and errors),
 * for thumbnails. Rejects with `TypstPageNotFoundError` when the document
 * has no such page, with `RangeError` for a page or width out of bounds.
 */
export function compilePagePngInWorker(
  input: CompileInput,
  page: { number: number; width: number },
  options: WorkerOptions = {},
): Promise<Buffer> {
  if (!Number.isInteger(page.number) || page.number < 1) {
    return Promise.reject(
      new RangeError(`page must be a whole number from 1, got ${page.number}`),
    );
  }
  if (
    !Number.isInteger(page.width) ||
    page.width < PAGE_WIDTH.min ||
    page.width > PAGE_WIDTH.max
  ) {
    return Promise.reject(
      new RangeError(
        `width must be a whole number from ${PAGE_WIDTH.min} to ${PAGE_WIDTH.max}, got ${page.width}`,
      ),
    );
  }
  return inWorker(
    input,
    { number: page.number, width: page.width },
    options,
  ).then(({ data }) => data);
}

function inWorker(
  input: CompileInput,
  page: { number: number; width: number } | undefined,
  options: WorkerOptions,
): Promise<Compiled> {
  try {
    const timeoutMs = options.timeoutMs ?? 60_000;
    if (
      !Number.isInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > MAX_TIMEOUT_MS
    ) {
      throw new RangeError(
        `timeoutMs must be a whole number from 1 to ${MAX_TIMEOUT_MS}, got ${timeoutMs}`,
      );
    }
    const workerInput = {
      ...coreInput(input),
      ...(page === undefined ? {} : { page }),
    };
    if (pool === 'closed') throw new TypstClosedError();
    pool ??= createPool({});
    const waitMs = options.waitMs ?? timeoutMs;
    if (!Number.isInteger(waitMs) || waitMs < 1 || waitMs > MAX_TIMEOUT_MS) {
      throw new RangeError(
        `waitMs must be a whole number from 1 to ${MAX_TIMEOUT_MS}, got ${waitMs}`,
      );
    }
    return pool.run(
      workerInput,
      timeoutMs,
      options.priority,
      options.raise,
      waitMs,
    );
  } catch (e) {
    return Promise.reject(e as Error);
  }
}
