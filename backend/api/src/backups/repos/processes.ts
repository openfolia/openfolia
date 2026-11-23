import { spawn, type ChildProcess } from 'node:child_process';

/** The most of a program's error output kept for a message. */
const STDERR_TAIL = 4_000;

export interface RunOptions {
  /** Added to a minimal environment (`PATH`, `HOME`, `LANG`); never logged. */
  readonly env?: Readonly<Record<string, string>>;
  readonly cwd?: string;
  /** Aborts the program (SIGTERM) past this many milliseconds. */
  readonly timeoutMs?: number;
}

/** The environment a program gets: only what it needs, never the server's secrets. */
export function programEnv(
  extra: Readonly<Record<string, string>> = {},
): NodeJS.ProcessEnv {
  return {
    PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: process.env['HOME'] ?? '/tmp',
    LANG: 'C.UTF-8',
    ...extra,
  };
}

/** A program that ended with an error, with the end of what it wrote to stderr. */
export class ProgramError extends Error {
  constructor(
    readonly program: string,
    readonly exitCode: number | null,
    readonly stderr: string,
  ) {
    const said = stderr.trim();
    super(
      `${program} ${exitCode === null ? 'was stopped' : `exited with ${exitCode}`}${said ? `: ${said}` : ''}`,
    );
    this.name = 'ProgramError';
  }
}

/** Starts `program`, keeping the end of its stderr. */
export function start(
  program: string,
  args: readonly string[],
  options: RunOptions & {
    stdin?: 'pipe' | 'ignore';
    stdout?: 'pipe' | 'ignore';
  } = {},
): { child: ChildProcess; done: Promise<void> } {
  const child = spawn(program, args, {
    cwd: options.cwd,
    env: programEnv(options.env),
    stdio: [options.stdin ?? 'ignore', options.stdout ?? 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    stderr = (stderr + chunk).slice(-STDERR_TAIL);
  });
  const timer =
    options.timeoutMs !== undefined
      ? setTimeout(() => child.kill('SIGTERM'), options.timeoutMs)
      : undefined;
  const done = new Promise<void>((resolve, reject) => {
    child.once('error', (error) => {
      if (timer) clearTimeout(timer);
      reject(new Error(`${program} could not be started: ${error.message}`));
    });
    child.once('close', (code) => {
      if (timer) clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new ProgramError(program, code, stderr));
    });
  });
  return { child, done };
}

/** Runs `program` to its end; rejects with `ProgramError` unless it exits with 0. */
export async function run(
  program: string,
  args: readonly string[],
  options: RunOptions = {},
): Promise<void> {
  await start(program, args, options).done;
}

/** Runs `program` and answers what it wrote to stdout. */
export async function output(
  program: string,
  args: readonly string[],
  options: RunOptions = {},
): Promise<string> {
  const { child, done } = start(program, args, { ...options, stdout: 'pipe' });
  let out = '';
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    out += chunk;
  });
  await done;
  return out;
}
