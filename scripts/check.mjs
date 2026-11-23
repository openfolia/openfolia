// `pnpm check` (`node scripts/check.mjs run-many`) and `pnpm check:changed`
// (`node scripts/check.mjs affected`): test, lint, typecheck and build, then the editor's
// browser flows (`e2e`, `frontend/editor-e2e/README.md`), then, once all of that has finished,
// the speed criteria (`perf`, `backend/api/README.md`), so none of them competes with another
// for the machine. Three Nx runs, and the arguments (`--base=… --head=…`, `--skip-nx-cache`)
// reach all of them: a package.json `a && b` would hand them to `b` only. In affected mode the
// e2e run also gets `CCMS_E2E_SELECT=affected` and the base and head, so it runs only the flows
// the change touches. Stops at the first run that fails, with its exit code.
//
// Every run prints a failing task's own output (the failing spec and its error) in the log. Test,
// lint, typecheck and build run with `--output-style=static-failures-only` (a passed or cached
// task is one line); the browser flows and the speed criteria with `--output-style=static`, so
// their summaries (the flows' run time and load average, each measurement) are there when they
// pass too. Arguments naming another style or a TUI choice (`--tui`, `--no-tui`) leave it to Nx.
// Without a style Nx picks one from the terminal, and run by an agent that is `summary`, which
// names only the file holding a failed task's output, so a flake could not be named without a
// rerun. `pnpm check --output-style=tui` brings the TUI back.

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** The value of `--name=value` or `--name value` in `args`, if given. */
function option(args, name) {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === `--${name}`) return args[i + 1];
    if (args[i].startsWith(`--${name}=`)) return args[i].slice(name.length + 3);
  }
  return undefined;
}

/**
 * The Nx runs of a check, in order: `[command, args, env]` each (`env`: added to the
 * environment).
 */
export function checkRuns(mode, args = []) {
  if (mode !== 'run-many' && mode !== 'affected') {
    throw new Error(
      `check: the mode is run-many or affected, not ${String(mode)}`,
    );
  }
  // The caller's own style, or a TUI choice (Nx refuses `--tui` next to a style).
  const ownStyle = args.some((arg) =>
    /^--(output-style|outputStyle|tui|no-tui)(=|$)/.test(arg),
  );
  const style = (name) => (ownStyle ? [] : [`--output-style=${name}`]);
  const base = option(args, 'base');
  const head = option(args, 'head');
  const e2eEnv =
    mode === 'affected'
      ? {
          CCMS_E2E_SELECT: 'affected',
          ...(base && { CCMS_E2E_BASE: base }),
          ...(head && { CCMS_E2E_HEAD: head }),
        }
      : {};
  return [
    [
      'nx',
      [
        mode,
        '-t',
        'test',
        'lint',
        'typecheck',
        'build',
        ...style('static-failures-only'),
        ...args,
      ],
      {},
    ],
    ['nx', [mode, '-t', 'e2e', ...style('static'), ...args], e2eEnv],
    ['nx', [mode, '-t', 'perf', ...style('static'), ...args], {}],
  ];
}

/**
 * What a check adds to the environment of every run: in a linked worktree (an agent's slot),
 * no Nx daemon, unless the caller chose (`NX_DAEMON` set). There the daemon's file watcher sees
 * no change to a tracked file, so tasks would be hashed as the files were when it started: stale
 * outputs from the cache, or another slot's results under the same old hash (#615; a slot made
 * since sets it in its own settings too, `SLOT_NX_SETTINGS`).
 */
export function checkEnv({ inWorktree, env }) {
  return inWorktree && env.NX_DAEMON === undefined
    ? { NX_DAEMON: 'false' }
    : {};
}

/** Whether `cwd` is in a linked worktree: its git folder is not the repository's own. */
function inLinkedWorktree(cwd = process.cwd()) {
  const dirs = spawnSync(
    'git',
    ['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir'],
    { cwd, encoding: 'utf8' },
  );
  if (dirs.status !== 0) return false;
  const [gitDir, commonDir] = dirs.stdout.trim().split('\n');
  return gitDir !== commonDir;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [mode, ...args] = process.argv.slice(2);
  const ownEnv = checkEnv({ inWorktree: inLinkedWorktree(), env: process.env });
  for (const [command, runArgs, env] of checkRuns(mode, args)) {
    const { status, error } = spawnSync(command, runArgs, {
      stdio: 'inherit',
      env: { ...process.env, ...ownEnv, ...env },
    });
    if (error) throw error;
    if (status !== 0) process.exit(status ?? 1);
  }
}
