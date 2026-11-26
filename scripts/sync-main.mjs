#!/usr/bin/env node
// `pnpm sync:main [--base <branch>]`: brings the main checkout up to origin/<base> (default
// the main branch, kit.config.json `mainBranch`) by a fast-forward only, then runs what .githooks/post-merge runs (`pnpm check:changed`
// over what the fast-forward brought in). It refuses, saying why, when the main checkout has
// local changes (tracked or untracked, not ignored), isn't on <base> or can't fast-forward, and
// stops when fetching origin/<base> fails; it never stashes, merges, rebases or discards
// anything. When the check failed only on timed-out unit tests, those files run again on their
// own once per project (scripts/check-triage.mjs), passed the way each project's test executor
// takes files, and both results are reported; a re-run that ran no test is reported as such.
// The one way to update the main checkout while agent worktrees exist (the PreToolUse guard
// blocks git checkout/switch/merge/pull there). Exits non-zero when it refused or the check
// failed.
// Decisions: scripts/sync-main-plan.mjs.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

import {
  RERUN_TIMEOUT_MS,
  rerunArgs,
  rerunOutcome,
  testTarget,
  timeoutOnlyFailures,
  triageMessage,
  unsafeFiles,
} from './check-triage.mjs';
import { gitEnv, runGit } from './run-git.mjs';
import {
  baseName,
  dirtyReason,
  lockfileNote,
  postMergeSteps,
  syncDecision,
  triageOutput,
} from './sync-main-plan.mjs';

const args = process.argv.slice(2);
const at = args.findIndex(
  (arg) => arg === '--base' || arg.startsWith('--base='),
);
const base = baseName(
  at === -1
    ? undefined
    : args[at].includes('=')
      ? args[at].split('=')[1]
      : args[at + 1],
);

function git(gitArgs) {
  const out = runGit(['-C', root, ...gitArgs], { encoding: 'utf8' });
  return {
    ok: out.status === 0,
    stdout: String(out.stdout ?? '').trim(),
    stderr: out.stderr,
  };
}

const common = runGit(
  ['rev-parse', '--path-format=absolute', '--git-common-dir'],
  {
    encoding: 'utf8',
  },
);
if (common.status !== 0) {
  console.error('sync:main: not inside a git repository.');
  process.exit(1);
}
// The main checkout, also when run from inside an agent worktree.
const root = path.dirname(common.stdout.trim());

const branch = git(['symbolic-ref', '--quiet', '--short', 'HEAD']);
const porcelain = git(['status', '--porcelain']).stdout;
const dirty = dirtyReason({ where: 'The main checkout', dir: root, porcelain });

// Fetched only once the checkout could take it: a refusal changes nothing, not even a ref. A
// failed fetch stops here: "already at origin/<base>" against a stale ref would claim a sync
// that never happened (merge:pr relies on this exit code).
if (
  branch.ok &&
  branch.stdout === base &&
  !dirty &&
  !git(['fetch', 'origin', base]).ok
) {
  console.error(
    `sync:main: git fetch origin ${base} failed, so origin/${base} may be stale; nothing was changed. Check the network or the remote, then run this again.`,
  );
  process.exit(1);
}
const head = git(['rev-parse', 'HEAD']).stdout;
const targetRef = git([
  'rev-parse',
  '--verify',
  '--quiet',
  `refs/remotes/origin/${base}`,
]);
const target = targetRef.ok ? targetRef.stdout : null;
const decision = syncDecision({
  base,
  branch: branch.ok ? branch.stdout : null,
  dirty,
  head,
  target,
  ancestor: target
    ? git(['merge-base', '--is-ancestor', head, target]).ok
    : false,
});

if (decision.action === 'refuse') {
  console.error(`sync:main: ${decision.reason}`);
  process.exit(1);
}
if (decision.action === 'current') {
  console.log(
    `sync:main: ${base} is already at origin/${base} (${head.slice(0, 8)}).`,
  );
  process.exit(0);
}

// The installed hook would run the same steps again: skipped here, run once below.
const merged = runGit(['-C', root, 'merge', '--ff-only', `origin/${base}`], {
  stdio: 'inherit',
  env: { ...process.env, SKIP_POST_MERGE_CHECK: '1' },
});
if (merged.status !== 0) {
  console.error(
    `sync:main: git merge --ff-only origin/${base} failed; nothing else ran.`,
  );
  process.exit(1);
}
console.log(
  `sync:main: ${base} fast-forwarded ${head.slice(0, 8)} → ${target.slice(0, 8)}.`,
);

const changedPaths = git(['diff', '--name-only', head, target]).stdout.split(
  '\n',
);
const note = lockfileNote(changedPaths);
if (note) console.log(`sync:main: ${note}`);

// As the hook: no variable aiming git elsewhere, no BASE_BRANCH, from the checkout's root.
const env = gitEnv();
delete env.BASE_BRANCH;
delete env.SKIP_POST_MERGE_CHECK;
const plan = postMergeSteps({
  nodeModules: existsSync(path.join(root, 'node_modules')),
  head,
  target,
  lockfileChanged: changedPaths.includes('pnpm-lock.yaml'),
});
if (plan.note) console.log(`sync:main: ${plan.note}`);

/** How long a stopped re-run gets between SIGTERM and SIGKILL, and then before it is given up. */
const KILL_GRACE_MS = 10_000;

/**
 * Runs a step with its output shown as it comes and kept, for the triage below. With
 * `timeoutMs` (a re-run only), the step runs in its own process group, which is stopped as a
 * whole at the deadline (SIGTERM, then SIGKILL): the tests run in pnpm's grandchildren, which
 * hold the output pipes, so stopping pnpm alone would not end the wait. Should even that not
 * close the pipes, the step is given up and resolved as timed out.
 */
function tee(cmd, cmdArgs, { timeoutMs } = {}) {
  return new Promise((resolve) => {
    let output = '';
    let timedOut = false;
    let settled = false;
    const timers = [];
    const cleanups = [];
    const done = (result) => {
      if (settled) return;
      settled = true;
      timers.forEach(clearTimeout);
      cleanups.forEach((cleanup) => cleanup());
      resolve(result);
    };
    const child = spawn(cmd, cmdArgs, {
      cwd: root,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: Boolean(timeoutMs),
    });
    const killGroup = (signal) => {
      try {
        process.kill(-child.pid, signal);
      } catch {
        // The group is already gone.
      }
    };
    for (const [stream, out] of [
      [child.stdout, process.stdout],
      [child.stderr, process.stderr],
    ]) {
      stream.on('data', (chunk) => {
        output += chunk;
        out.write(chunk);
      });
    }
    if (timeoutMs) {
      // Stopping sync:main (Ctrl-C) also stops the re-run's group, which no longer gets the
      // terminal's signals itself; the handlers go once the re-run has ended.
      const onSignal = () => {
        killGroup('SIGTERM');
        process.exit(130);
      };
      process.once('SIGINT', onSignal);
      process.once('SIGTERM', onSignal);
      cleanups.push(() => {
        process.off('SIGINT', onSignal);
        process.off('SIGTERM', onSignal);
      });
      timers.push(
        setTimeout(() => {
          timedOut = true;
          killGroup('SIGTERM');
          timers.push(
            setTimeout(() => {
              killGroup('SIGKILL');
              timers.push(
                setTimeout(() => {
                  child.stdout.destroy();
                  child.stderr.destroy();
                  done({ status: 1, signal: 'SIGKILL', timedOut, output });
                }, KILL_GRACE_MS),
              );
            }, KILL_GRACE_MS),
          );
        }, timeoutMs),
      );
    }
    child.on('error', (error) =>
      done({ status: 1, output: `${output}\n${error.message}` }),
    );
    child.on('close', (status, signal) =>
      done({ status: status ?? 1, signal, timedOut, output }),
    );
  });
}

const results = [];
for (const step of plan.steps) {
  console.log(`sync:main: ${step.label} …`);
  const result = await tee(step.cmd, step.args);
  results.push({ step, status: result.status, output: result.output });
}
const failures = results.filter(({ status }) => status !== 0);
if (failures.length > 0) {
  // Only timed-out unit tests in the check, and no other step failed (triageOutput): run those
  // files again on their own once before calling it a break (a loaded machine times tests out),
  // and report both runs.
  const timedOut = timeoutOnlyFailures(triageOutput(results));
  if (timedOut) {
    const outcomes = [];
    for (const run of timedOut.runs) {
      console.log(
        `\nsync:main: re-running ${run.project}'s timed-out test files on their own: ${run.files.join(' ')}`,
      );
      // The test target's executor decides how the files are passed (scripts/check-triage.mjs).
      const shown = spawnSync(
        'pnpm',
        ['-s', 'nx', 'show', 'project', run.project, '--json'],
        {
          cwd: root,
          env,
          encoding: 'utf8',
          maxBuffer: 64 * 1024 * 1024,
          timeout: 5 * 60 * 1000,
        },
      );
      let config = null;
      try {
        if (shown.status === 0) config = JSON.parse(shown.stdout);
      } catch {
        config = null;
      }
      if (!config) {
        outcomes.push({
          project: run.project,
          kind: 'no-tests',
          reason: `its configuration could not be read (nx show project: ${
            shown.error?.message ??
            (String(shown.stderr ?? '')
              .trim()
              .split('\n')
              .at(-1) ||
              `exit ${shown.status}`)
          })`,
        });
        continue;
      }
      const unsafe = unsafeFiles(run.files);
      if (unsafe.length > 0) {
        outcomes.push({
          project: run.project,
          kind: 'no-tests',
          reason: `not re-run: unsafe file names ${unsafe.join(' ')}`,
        });
        continue;
      }
      const again = await tee('pnpm', rerunArgs(run, testTarget(config)), {
        timeoutMs: RERUN_TIMEOUT_MS,
      });
      outcomes.push({ project: run.project, ...rerunOutcome(again) });
    }
    const passed = outcomes.every(({ kind }) => kind === 'passed');
    const files = timedOut.runs.flatMap((run) =>
      run.files.map((file) => `${run.project}/${file}`),
    );
    console[passed ? 'log' : 'error'](
      `\nsync:main: ${triageMessage({ files, outcomes })}`,
    );
    process.exit(passed ? 0 : 1);
  }
  console.error(
    `\nsync:main: ${failures.map(({ step }) => step.label).join(', ')} FAILED after this fast-forward. Fix it now, naming the two changes that collided.`,
  );
  process.exit(1);
}
