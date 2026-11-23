#!/usr/bin/env node
// `pnpm merge:pr <N> --reviewed <SHA> [--checked <SHA>] [--next <M|auto>] [--dry-run]`: the
// coordinator's merge of one PR in one command (scripts/merge-pr-flow.mjs: checks, merge,
// branch, board, slot, sync:main, the note for the running agents), stopping at the first
// problem with what to do; with --next, then the local merge queue's preparation of the next
// PR's idle slot (scripts/merge-pr-next.mjs; `--prepare <M>` runs only that). Run from the main
// checkout or any worktree of it; it acts on the main checkout. Only the coordinator merges:
// the PreToolUse guard refuses this command to every subagent.
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, openSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { ghCli } from './gh-api.mjs';
import { mergePr, prepareOnly } from './merge-pr-flow.mjs';
import { processesIn, queueEnv } from './merge-pr-next.mjs';
import { parseMergeArgs } from './merge-pr-plan.mjs';
import { runGit } from './run-git.mjs';
import { readSlots } from './slot-file.mjs';

const options = parseMergeArgs(process.argv.slice(2));
if (options.error) {
  console.error(options.error);
  process.exit(2);
}

const common = runGit(
  ['rev-parse', '--path-format=absolute', '--git-common-dir'],
  {
    encoding: 'utf8',
  },
);
if (common.status !== 0) {
  console.error('merge:pr: not inside a git repository.');
  process.exit(1);
}
const root = path.dirname(common.stdout.trim());
/** The prefix of the temporary worktrees earlier merge:pr runs made: removed when left over. */
const TEMP_PREFIX = 'merge-pr-';

const io = {
  root,
  env: process.env,
  gh: (args) => ghCli(args),
  git(args, cwd = root) {
    const out = runGit(['-C', cwd, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return {
      ok: out.status === 0,
      status: out.status,
      stdout: String(out.stdout ?? '').trim(),
    };
  },
  run(cmd, args, { cwd }) {
    const result = spawnSync(cmd, args, { cwd, stdio: 'inherit' });
    if (result.error) console.error(result.error.message);
    return result.status ?? 1;
  },
  slots: () => readSlots(root),
  isOwnTemp(dir) {
    const real = (file) => {
      try {
        return realpathSync(file);
      } catch {
        return file;
      }
    };
    return (
      path.basename(dir).startsWith(TEMP_PREFIX) &&
      real(path.dirname(dir)) === real(tmpdir())
    );
  },
  /** The processes working in `dir` (by their working directory), or null when lsof can't say. */
  processesIn(dir) {
    const out = spawnSync('lsof', ['-a', '-d', 'cwd', '-F', 'pcn'], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    // lsof exits 1 also when some processes couldn't be read; only no output is "can't say".
    if (out.error || !out.stdout) return null;
    const real = (file) => {
      try {
        return realpathSync(file);
      } catch {
        return file;
      }
    };
    return [
      ...new Set([
        ...processesIn(out.stdout, dir),
        ...processesIn(out.stdout, real(dir)),
      ]),
    ];
  },
  /** The queue's checks, detached with their output in `logFile`; returns the pid. */
  startBackground({ cwd, script, logFile, header }) {
    writeFileSync(logFile, `${header}\n${new Date().toISOString()}\n\n`);
    const out = openSync(logFile, 'a');
    const child = spawn('sh', ['-c', script], {
      cwd,
      env: queueEnv(process.env),
      detached: true,
      stdio: ['ignore', out, out],
    });
    child.unref();
    try {
      closeSync(out);
    } catch {
      // The child holds its own copy; a failed close here changes nothing for it.
    }
    // spawn reports a failed start as a later 'error' event, with no pid: null says so now.
    return child.pid ?? null;
  },
  log: (line) => console.log(line),
  error: (line) => console.error(line),
};

process.exit(
  options.prepare === undefined
    ? mergePr(options, io)
    : prepareOnly(options.prepare, io),
);
