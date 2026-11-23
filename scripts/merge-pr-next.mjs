// The local merge queue (`pnpm merge:pr <N> --reviewed <SHA> --next <M|auto>`, or
// `pnpm merge:pr --prepare <M>` on its own): once a PR is merged, the next ready PR's slot gets
// the new base merged in and its checks started, so the "merge the base, re-run, push" rounds
// no longer wait one after another. It only prepares and reports: it never pushes, never merges
// a PR, and touches nothing but that slot's worktree (a local `git merge` of origin/<base>,
// aborted on a conflict, then `pnpm install --frozen-lockfile && pnpm check` in the background
// with a log in the slot's folder under .claude/stacks/). The slot's agent reviews the merge,
// reads the log and pushes. gh, git and the runs are injected (`io`, as in merge-pr-flow.mjs),
// so a test runs it without a network:
//   io.root (the main checkout), io.gh(args) → stdout, io.git(args, cwd?) → { ok, status,
//   stdout }, io.slots(), io.processesIn(dir) → ['<pid> <command>', …] or null when it can't
//   tell, io.startBackground({ cwd, script, logFile, header }) → pid,
//   io.dirtyIn(where, dir) → dirtyReason or null, io.log(line), io.error(line).
// Over ~250 lines on purpose: one sequence (pick, the idle checks, merge or abort, start) whose
// safety checks belong together; the pure parts are exported for the test.
import { slotForBranch } from './merge-pr-plan.mjs';
import { stripGitEnv } from './strip-git-env.mjs';

/** The fields `gh pr list` / `gh pr view` read for a queue candidate. */
export const NEXT_FIELDS =
  'number,title,state,isDraft,headRefName,headRefOid,baseRefName';

/**
 * The log the background checks write: in the slot's folder of the main checkout `root`
 * (`.claude/stacks/<name>/`, beside its slot.json, outside every worktree).
 */
export function nextLogFile(slot, root) {
  return `${root}/.claude/stacks/${slot.name}/merge-queue.log`;
}

/** The slot records that are done being created (agent-slot marks one in progress `creating`). */
function readySlots(slots) {
  return slots.filter((slot) => slot && typeof slot.creating !== 'number');
}

/**
 * The open PRs on `base` that have a slot here, oldest first, each `{ pr, slot }`; `exclude`:
 * the PR just merged. A draft is skipped: it isn't ready.
 * @param {{ prs: any[], slots: any[], base: string, exclude?: number | null }} options
 * @returns {{ pr: any, slot: any }[]}
 */
export function nextCandidates({ prs, slots, base, exclude = null }) {
  const ready = readySlots(slots);
  return prs
    .filter(
      (pr) => pr.baseRefName === base && !pr.isDraft && pr.number !== exclude,
    )
    .map((pr) => ({ pr, slot: slotForBranch(ready, pr.headRefName) }))
    .filter(({ slot }) => slot !== null)
    .sort((a, b) => a.pr.number - b.pr.number);
}

/**
 * The processes `lsof -a -d cwd -F pcn` lists (`p<pid>`, `c<command>`, `n<cwd>` lines) whose
 * working directory is `dir` or inside it, as `<pid> <command>`.
 */
export function processesIn(lsofOutput, dir) {
  const found = [];
  let pid = null;
  let command = '';
  for (const line of String(lsofOutput ?? '').split('\n')) {
    if (line.startsWith('p')) [pid, command] = [line.slice(1), ''];
    else if (line.startsWith('c')) command = line.slice(1);
    else if (line.startsWith('n') && pid) {
      const cwd = line.slice(1);
      if (cwd === dir || cwd.startsWith(`${dir}/`))
        found.push(`${pid} ${command}`);
    }
  }
  return found;
}

/**
 * Why the slot can't be prepared now, or null. Every answer is read before anything changes:
 * the PR open and not a draft, the slot done being created, its worktree on the PR's branch at
 * exactly the PR head (no local commits, nothing pushed from elsewhere), clean (`dirty`:
 * dirtyReason's answer), and no process working in it (`busy`: from processesIn, null when
 * that couldn't be read, which counts as busy).
 */
export function nextProblem({ pr, slot, slotHead, slotBranch, dirty, busy }) {
  const n = `PR #${pr.number}`;
  if (pr.state !== 'OPEN')
    return `${n} is ${String(pr.state).toLowerCase()}, not open.`;
  if (pr.isDraft) return `${n} is a draft: not ready.`;
  if (!slot)
    return `${n} (${pr.headRefName}) has no slot here: its agent merges the base itself.`;
  if (typeof slot.creating === 'number')
    return `The slot "${slot.name}" is still being created.`;
  if (slotBranch !== pr.headRefName) {
    return `The slot "${slot.name}" has ${slotBranch ?? 'no branch (a detached HEAD)'} checked out, not ${pr.headRefName}.`;
  }
  if (slotHead !== pr.headRefOid) {
    return `The slot "${slot.name}" is at ${slotHead ?? 'an unknown commit'}, not ${n}'s head ${pr.headRefOid}: its agent is still at work (or has unpushed commits).`;
  }
  if (dirty) return dirty;
  if (busy === null) {
    return `Couldn't tell whether a process works in the slot "${slot.name}" (lsof): left alone.`;
  }
  if (busy.length > 0) {
    return `Processes work in the slot "${slot.name}" (${busy.slice(0, 3).join(', ')}): its agent is still at work.`;
  }
  return null;
}

/**
 * The background script: the dependencies the merged lockfile names, then the full check
 * (`pnpm check`: nx run-many -t test lint typecheck build, then -t perf), then the status line the log ends in.
 */
export function nextCheckScript() {
  return [
    'pnpm install --frozen-lockfile && pnpm check',
    'status=$?',
    'echo',
    'echo "merge-queue: finished, exit $status (0: green)"',
    'exit $status',
  ].join('; ');
}

/** The variables a coordinator's shell may hold that would aim the slot's run elsewhere. */
const FOREIGN_ENV = /^(npm_|pnpm_|PNPM_|INIT_CWD$|TEST_|PORT$|HOST$)/;

/**
 * The environment the background checks run with: merge:pr's own without what names another
 * place or run: git's repository variables and BASE_BRANCH (stripGitEnv), the package manager's
 * `npm_*` / `pnpm_*` and INIT_CWD from the coordinator's `pnpm merge:pr`, and
 * the port and test variables (the slot's .env.local gives its own; a shell's would win over it).
 */
export function queueEnv(env) {
  const out = stripGitEnv({ ...env });
  for (const key of Object.keys(out))
    if (FOREIGN_ENV.test(key)) delete out[key];
  return out;
}

/**
 * The git call that merges origin/<base> into the slot's branch: no editor, and no hooks (the
 * post-merge hook's check:changed is covered by the full check the background run starts).
 */
export function nextMergeArgs(base) {
  return [
    '-c',
    'core.hooksPath=/dev/null',
    'merge',
    '--no-edit',
    `origin/${base}`,
  ];
}

/** The report once the slot is prepared, ready to paste to its agent. */
export function preparedNote({ pr, slot, base, before, after, pid, logFile }) {
  return [
    `----- for the agent of PR #${pr.number} (slot "${slot.name}") -----`,
    `merge:pr merged origin/${base} into ${pr.headRefName} in your worktree: ${before.slice(0, 8)} → ${after.slice(0, 8)} (local only, not pushed).`,
    `It started pnpm install --frozen-lockfile && pnpm check there (pid ${pid}); the log: ${logFile}, ending in "merge-queue: finished, exit <n>".`,
    `Now: review the merge (git diff ${before.slice(0, 8)}..HEAD), read the log, then push and name ${after.slice(0, 8)} (or your newer head) as the SHA \`pnpm check\` ran on in the PR body.`,
    '----- end -----',
  ];
}

/**
 * Picks and prepares one slot; returns the exit code (0 also when nothing was ready in auto
 * mode). Never throws: a failure is reported, so a merge before it stays reported as done.
 * @param {{ which: number | 'auto', base?: string | null, exclude?: number | null }} options
 * @param {any} io
 */
export function prepareNext({ which, base = null, exclude = null }, io) {
  try {
    let candidates;
    if (which === 'auto') {
      const prs = JSON.parse(
        io.gh([
          'pr',
          'list',
          '--state',
          'open',
          '--base',
          base,
          '--limit',
          '200',
          '--json',
          NEXT_FIELDS,
        ]),
      );
      candidates = nextCandidates({ prs, slots: io.slots(), base, exclude });
      if (candidates.length === 0) {
        io.log(
          `merge:pr --next: no other open PR on ${base} has a slot here; nothing prepared.`,
        );
        return 0;
      }
    } else {
      const pr = JSON.parse(
        io.gh(['pr', 'view', String(which), '--json', NEXT_FIELDS]),
      );
      candidates = [{ pr, slot: slotForBranch(io.slots(), pr.headRefName) }];
    }
    for (const { pr, slot } of candidates) {
      const result = prepareOne(pr, slot, io);
      // One PR asked for: 0 only when its slot was prepared or had nothing to merge.
      if (which !== 'auto')
        return result === 'prepared' || result === 'uptodate' ? 0 : 1;
      if (result === 'prepared') return 0;
      // A slot left in a state to look at stops the queue, so its report isn't buried.
      if (result === 'failed') return 1;
    }
    io.log('merge:pr --next: no candidate was prepared (reasons above).');
    return 0;
  } catch (error) {
    io.error(
      `merge:pr --next: ${error instanceof Error ? error.message : error}`,
    );
    return 1;
  }
}

/** The answers nextProblem needs for `slot`, read now. */
function idleState(slot, io) {
  const head = io.git(['rev-parse', 'HEAD'], slot.worktree);
  const branch = io.git(
    ['symbolic-ref', '--quiet', '--short', 'HEAD'],
    slot.worktree,
  );
  return {
    slotHead: head.ok ? head.stdout : null,
    slotBranch: branch.ok ? branch.stdout : null,
    dirty: io.dirtyIn(`The slot "${slot.name}"`, slot.worktree),
    busy: io.processesIn(slot.worktree),
  };
}

/**
 * Prepares one PR's slot: 'prepared', 'uptodate' (it has the latest base: nothing to do),
 * 'skip' (not ready, or a conflict aborted cleanly; said why) or 'failed' (look at it).
 */
function prepareOne(pr, slot, io) {
  const notReady = (state) => nextProblem({ pr, slot, ...state });
  const problem = slot ? notReady(idleState(slot, io)) : notReady({});
  if (problem) {
    io.log(`merge:pr --next: PR #${pr.number} not prepared: ${problem}`);
    return 'skip';
  }
  const base = pr.baseRefName;
  if (!io.git(['fetch', 'origin', base], slot.worktree).ok) {
    io.error(
      `merge:pr --next: git fetch origin ${base} failed in ${slot.worktree}.`,
    );
    return 'failed';
  }
  if (
    io.git(
      ['merge-base', '--is-ancestor', `origin/${base}`, 'HEAD'],
      slot.worktree,
    ).ok
  ) {
    io.log(
      `merge:pr --next: PR #${pr.number} already has the latest origin/${base}; nothing to merge, no checks started.`,
    );
    return 'uptodate';
  }
  // Again right before the merge, the PR too: the fetch took a while, the agent may have
  // started, the PR may be closed, a draft or moved on.
  let fresh;
  try {
    fresh = JSON.parse(
      io.gh(['pr', 'view', String(pr.number), '--json', NEXT_FIELDS]),
    );
  } catch (error) {
    io.log(
      `merge:pr --next: PR #${pr.number} not prepared: it couldn't be read again (${error instanceof Error ? error.message : error}).`,
    );
    return 'skip';
  }
  const again =
    nextProblem({ pr: fresh, slot, ...idleState(slot, io) }) ??
    (fresh.headRefOid === pr.headRefOid && fresh.baseRefName === base
      ? null
      : `PR #${pr.number}'s head or base moved meanwhile.`);
  if (again) {
    io.log(`merge:pr --next: PR #${pr.number} not prepared: ${again}`);
    return 'skip';
  }
  const before = pr.headRefOid;
  if (!io.git(nextMergeArgs(base), slot.worktree).ok)
    return undoMerge(pr, slot, before, io);
  const after = io.git(['rev-parse', 'HEAD'], slot.worktree).stdout;
  const logFile = nextLogFile(slot, io.root);
  let pid = null;
  let why = 'no process started';
  try {
    // Throws only before the spawn (the log file); null when the spawn itself failed.
    pid = io.startBackground({
      cwd: slot.worktree,
      script: nextCheckScript(),
      logFile,
      header: `merge-queue: PR #${pr.number}, origin/${pr.baseRefName} merged: ${before} → ${after}; pnpm install, then pnpm check on ${after}`,
    });
  } catch (error) {
    why = error instanceof Error ? error.message : String(error);
  }
  if (!pid) {
    io.error(
      `merge:pr --next: PR #${pr.number}: origin/${base} IS merged into ${pr.headRefName} in ${slot.worktree} (${before.slice(0, 8)} → ${after.slice(0, 8)}, local only), but its checks didn't start (${why}). Start them there yourself (pnpm install --frozen-lockfile && pnpm check), or undo the merge: git -C ${slot.worktree} reset --hard ${before}.`,
    );
    return 'failed';
  }
  for (const line of preparedNote({
    pr,
    slot,
    base,
    before,
    after,
    pid,
    logFile,
  }))
    io.log(line);
  return 'prepared';
}

/**
 * After a failed `git merge`: aborts it when one is in progress (a conflict), then checks the
 * slot is back at `before` and clean, and says exactly what it found. 'skip' when the slot is
 * as it was (auto mode goes on to the next PR), 'failed' when it isn't.
 */
function undoMerge(pr, slot, before, io) {
  const inProgress = io.git(
    ['rev-parse', '-q', '--verify', 'MERGE_HEAD'],
    slot.worktree,
  ).ok;
  const conflicts = inProgress
    ? io.git(['diff', '--name-only', '--diff-filter=U'], slot.worktree).stdout
    : '';
  const aborted = inProgress
    ? io.git(['merge', '--abort'], slot.worktree).ok
    : true;
  const head = io.git(['rev-parse', 'HEAD'], slot.worktree);
  const dirty = io.dirtyIn(`The slot "${slot.name}"`, slot.worktree);
  const why = inProgress
    ? `origin/${pr.baseRefName} doesn't merge cleanly into ${pr.headRefName}${conflicts ? ` (conflicts: ${conflicts.split('\n').join(', ')})` : ''}`
    : `git merge of origin/${pr.baseRefName} failed before it began (a lock, an identity, a hook?)`;
  if (aborted && head.ok && head.stdout === before && !dirty) {
    io.error(
      `merge:pr --next: PR #${pr.number}: ${why}. ${inProgress ? 'The merge was aborted; ' : ''}the slot is as it was. ${inProgress ? 'Back to its agent: it merges the base, resolves them and reviews that fix itself.' : 'Nothing was merged.'}`,
    );
    return 'skip';
  }
  io.error(
    `merge:pr --next: PR #${pr.number}: ${why}, and the slot is NOT as it was (${aborted ? '' : 'git merge --abort failed; '}HEAD ${head.ok ? head.stdout : 'unknown'}, expected ${before}${dirty ? `; ${dirty}` : ''}). Look at ${slot.worktree} yourself before its agent goes on.`,
  );
  return 'failed';
}
