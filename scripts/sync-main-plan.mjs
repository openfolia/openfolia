// What `pnpm sync:main` (scripts/sync-main.mjs) decides, as plain functions a test can pin:
// whether a checkout is clean, whether it may fast-forward to origin/<base>, and the steps
// .githooks/post-merge runs afterwards. scripts/merge-pr-flow.mjs uses the same checks before a
// merge, so a merge never ends on a checkout that can't be synced or a slot that can't be removed.

/**
 * The paths `git status --porcelain` lists (tracked changes and untracked, non-ignored files).
 * Each line is `XY path`; a caller that trimmed the output took the first line's leading space
 * (` M a` → `M a`), so the one- or two-letter status is read up to its space, not sliced.
 */
export function dirtyPaths(porcelain) {
  return String(porcelain ?? '')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => line.replace(/^[ A-Z?!]{1,2} /, '').replace(/^.* -> /, ''));
}

/** Why a checkout (`where`: a label, `dir`: its path) isn't clean, or null when it is. */
export function dirtyReason({ where, dir, porcelain }) {
  const paths = dirtyPaths(porcelain);
  if (paths.length === 0) return null;
  const shown =
    paths.slice(0, 10).join(', ') + (paths.length > 10 ? ', …' : '');
  return (
    `${where} (${dir}) has local changes (${shown}). Commit, move or remove them first; ` +
    'nothing is discarded or stashed for you.'
  );
}

/** `main`, `origin/main` and `refs/heads/main` all name the base branch `main`. */
export function baseName(value) {
  return String(value ?? 'main')
    .replace(/^refs\/heads\//, '')
    .replace(/^origin\//, '');
}

/**
 * What sync:main does with the checkout: `{ action: 'refuse', reason }`, `{ action: 'current' }`
 * (already at origin/<base>) or `{ action: 'fast-forward' }`. `branch`: what the checkout has
 * checked out (null when detached); `dirty`: dirtyReason's answer; `head`/`target`: the commits
 * of HEAD and origin/<base>; `ancestor`: whether HEAD is an ancestor of the target.
 */
export function syncDecision({ base, branch, dirty, head, target, ancestor }) {
  if (branch !== base) {
    return {
      action: 'refuse',
      reason: `The main checkout is on ${branch ?? 'a detached HEAD'}, not ${base}: sync:main only fast-forwards ${base}. Put it back on ${base} yourself, or check ${base} in a worktree of it.`,
    };
  }
  if (dirty) return { action: 'refuse', reason: dirty };
  if (!target) {
    return {
      action: 'refuse',
      reason: `origin/${base} is not here: git fetch origin ${base}.`,
    };
  }
  if (head === target) return { action: 'current' };
  if (!ancestor) {
    return {
      action: 'refuse',
      reason: `${base} can't fast-forward to origin/${base}: it has commits origin/${base} doesn't (git log origin/${base}..${base}). Push them on a branch and open a PR, or reset ${base} yourself; sync:main never merges or rebases.`,
    };
  }
  return { action: 'fast-forward' };
}

/**
 * What runs after the fast-forward from `head` to `target`, as steps `{ label, cmd, args }`, or
 * a note when nothing can run (no node_modules): `pnpm check:changed` over the projects the
 * fast-forward touched, as .githooks/post-merge runs it after a merge (sync:main runs it itself:
 * a fast-forward with `--ff-only` fires that hook too, but its exit is never the script's).
 */
export function postMergeSteps({
  nodeModules,
  head,
  target,
  lockfileChanged = false,
}) {
  if (!nodeModules) {
    return {
      steps: [],
      note: 'No node_modules here: run pnpm install, then pnpm check:changed.',
    };
  }
  return {
    steps: [
      // New or changed dependencies first, or the check fails on a missing package.
      ...(lockfileChanged
        ? [
            {
              label: 'pnpm install (pnpm-lock.yaml changed)',
              cmd: 'pnpm',
              args: ['install', '--frozen-lockfile'],
            },
          ]
        : []),
      {
        label: 'check:changed (a clean merge can still break the build)',
        // Its timed-out tests are re-run before it is called a break (triageOutput).
        triage: true,
        cmd: 'pnpm',
        args: ['check:changed', `--base=${head}`, `--head=${target}`],
      },
    ],
    note: null,
  };
}

/**
 * The output the timeout triage (scripts/check-triage.mjs) reads once the steps ran, or null
 * when there is nothing to triage. `results`: one per step run, `{ step, status, output }`.
 * Only when exactly one step failed and it is the check (`triage: true`): a step that
 * succeeded, the install before it say, never counts; a failed install is a break of its own.
 */
export function triageOutput(results) {
  const failed = results.filter(({ status }) => status !== 0);
  return failed.length === 1 && failed[0].step.triage ? failed[0].output : null;
}

/** A line to print when the fast-forward changed the lockfile (node_modules may be behind). */
export function lockfileNote(changedPaths) {
  return changedPaths.includes('pnpm-lock.yaml')
    ? 'pnpm-lock.yaml changed: dependencies are installed before the check.'
    : null;
}
