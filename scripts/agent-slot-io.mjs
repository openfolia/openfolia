// The processes agent-slot.mjs and its create and remove flows run: git, lsof, pnpm and the
// project's own slot steps (kit.config.json `slot`: its setup command, and the scripts that
// drop a slot's bucket and databases).
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

import { readKitConfig } from '../.claude/hooks/kit-config.mjs';
import { gitEnv } from './run-git.mjs';

const { slot: slotConfig } = readKitConfig();

/** A command's stdout (throws when it fails); git with the hook-safe environment. */
export function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    ...(cmd === 'git' ? { env: gitEnv() } : {}),
    ...opts,
  });
}

/** The pids listening on a TCP port (lsof), as strings. */
export function listeners(port) {
  const out = spawnSync('lsof', ['-tiTCP:' + port, '-sTCP:LISTEN'], {
    encoding: 'utf8',
  });
  return (out.stdout ?? '').split('\n').filter(Boolean);
}

/** Whether anything listens on a TCP port. */
export function listening(port) {
  return listeners(port).length > 0;
}

/** Whether the process `pid` still runs (EPERM: it does, another user's). */
function running(pid) {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
}

/**
 * Stops whatever listens on `port`, by port and never by name, and waits (at most `waitMs`)
 * until those processes are gone, so their database connections are closed too; whether
 * anything listened.
 */
export function stopPort(port, { waitMs = 15_000 } = {}) {
  const pids = listeners(port);
  if (pids.length === 0) return false;
  spawnSync('kill', pids);
  const until = Date.now() + waitMs;
  while (pids.some(running) && Date.now() < until) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
  }
  return true;
}

/** Whether `ref` (a full ref name or a commit-ish) exists in the repository at `cwd`. */
export function refExists(cwd, ref) {
  return (
    spawnSync(
      'git',
      ['-C', cwd, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`],
      {
        env: gitEnv(),
        stdio: 'ignore',
      },
    ).status === 0
  );
}

/** The slot's dependencies, from pnpm's store: the lockfile as it is, nothing resolved anew. */
export function installDependencies(worktree) {
  const out = spawnSync(
    'pnpm',
    ['install', '--frozen-lockfile', '--prefer-offline'],
    {
      cwd: worktree,
      stdio: 'inherit',
    },
  );
  if (out.status !== 0) throw new Error(`pnpm install failed in ${worktree}.`);
}

/**
 * The worktree's own local settings (its .env.local) and whatever else the project's servers
 * need: the command `slot.setup` names, run in the worktree; nothing when it names none.
 */
export function setupLocal(worktree) {
  if (!slotConfig.setup) return;
  const [cmd, ...args] = slotConfig.setup;
  const out = spawnSync(cmd, args, { cwd: worktree, stdio: 'inherit' });
  if (out.status !== 0) {
    throw new Error(`${slotConfig.setup.join(' ')} failed in ${worktree}.`);
  }
}

/** The main checkout's script a slot step runs (`slot.<key>`), or null when there is none. */
function slotScript(root, key) {
  const script = slotConfig[key] && `${root}/${slotConfig[key]}`;
  return script && existsSync(script) ? script : null;
}

/**
 * Deletes the slot's bucket (and its blobs) on a local storage service, with the main
 * checkout's own script (`slot.bucketScript`, run as `node <script> drop <worktree>`), never
 * the worktree's. Whether it went through (a missing bucket counts); `undefined` when there is
 * no such script.
 */
export function dropLocalBucket(root, worktree) {
  const script = slotScript(root, 'bucketScript');
  if (!script) return undefined;
  const out = spawnSync('node', [script, 'drop', worktree], {
    cwd: root,
    stdio: 'inherit',
    timeout: 120_000,
  });
  return out.status === 0;
}

/**
 * The slot's own databases on a local database server, dropped with the main checkout's own
 * script (`slot.databasesScript`, run as `node <script> drop <name> --settings
 * <worktree>/.env.local [--dry-run]`), never the worktree's, on the server the slot's settings
 * name. `dryRun`: only says which it would drop. Whether it went through (the server down, or
 * a database in use, counts); `undefined` when there is no such script.
 */
export function dropSlotDatabases(
  root,
  name,
  worktree,
  { dryRun = false } = {},
) {
  const script = slotScript(root, 'databasesScript');
  if (!script) return undefined;
  const args = [script, 'drop', name, '--settings', `${worktree}/.env.local`];
  if (dryRun) args.push('--dry-run');
  const out = spawnSync('node', args, {
    cwd: root,
    stdio: 'inherit',
    timeout: 120_000,
  });
  return out.status === 0;
}

/**
 * `slot prune-databases`: the databases of slots that are gone, listed, and dropped only with
 * `yes` (`node <slot.databasesScript> prune [--yes]`). Whether it went through.
 */
export function pruneSlotDatabases(root, { yes = false } = {}) {
  if (!slotConfig.databasesScript) {
    console.error(
      'No slot databases here: kit.config.json names no slot.databasesScript.',
    );
    return false;
  }
  const script = slotScript(root, 'databasesScript');
  if (!script) {
    console.error(
      `${root}/${slotConfig.databasesScript} is missing: update the main checkout first.`,
    );
    return false;
  }
  const out = spawnSync('node', [script, 'prune', ...(yes ? ['--yes'] : [])], {
    cwd: root,
    stdio: 'inherit',
    timeout: 600_000,
  });
  return out.status === 0;
}
