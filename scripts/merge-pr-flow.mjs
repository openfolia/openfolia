// The coordinator's merge of one PR (`pnpm merge:pr <N> --reviewed <SHA>`), stopping at the
// first problem with what to do. Every check that only reads runs first, so a refusal leaves
// nothing half-done: the PR on GitHub, open review findings, the latest base in the head, the
// slot clean (local changes in the main checkout only turn sync:main into a note). It lists what
// changed since the last `pnpm check` (the coordinator decides on a re-run), then runs the merge
// (the review findings read again right before it), the branch, the board, the slot and
// sync:main, and ends with the note for the running agents, the handover line and the leftover
// worktrees. gh and git are injected (`io`), so a test runs it without a network:
//   io.gh(args) → stdout (throws with gh's message), io.git(args, cwd?) → { ok, status, stdout },
//   io.run(cmd, args, { cwd }) → exit status, io.slots() → slot records, io.isOwnTemp(dir) →
//   whether merge:pr made that folder (an older run's temporary worktree), io.root (the main
//   checkout), io.env, io.log(line), io.error(line).
// Over ~250 lines on purpose: one sequence whose steps share the preflight's state; what can be
// pure already lives in merge-pr-plan.mjs and merge-pr-report.mjs.
import {
  AFTER_MERGE,
  PR_FIELDS,
  behindBaseMessage,
  mergeSteps,
  prProblem,
  remainingLines,
  slotForBranch,
  slotHeadProblem,
  stepLine,
} from './merge-pr-plan.mjs';
import { REVIEW_THREADS_QUERY, securityHold } from './merge-pr-hold.mjs';
import {
  checkedShaFrom,
  handoverLine,
  leftoverWorktrees,
  othersNote,
  sharedFiles,
  sinceCheckLines,
} from './merge-pr-report.mjs';
import { prepareNext } from './merge-pr-next.mjs';
import { dirtyReason } from './sync-main-plan.mjs';

/** A checkout's dirtyReason, read through io.git. */
function dirtyIn(io, where, dir) {
  return dirtyReason({
    where,
    dir,
    porcelain: io.git(['status', '--porcelain'], dir).stdout,
  });
}

const lines = (text) => text.split('\n').filter(Boolean);

/**
 * The PR's review threads (the background security-review hook's findings among them), every
 * page, and gh's own login (`viewer`, null when GitHub doesn't say: every author is then
 * another's). (`gh pr view --json comments` already pages through the comments itself.)
 */
function reviewThreads(io, number) {
  const threads = [];
  let viewer = null;
  let after = null;
  for (;;) {
    const out = JSON.parse(
      io.gh([
        'api',
        'graphql',
        '-F',
        'owner={owner}',
        '-F',
        'repo={repo}',
        '-F',
        `number=${number}`,
        ...(after ? ['-f', `after=${after}`] : []),
        '-f',
        `query=${REVIEW_THREADS_QUERY}`,
      ]),
    );
    const page = out.data?.repository?.pullRequest?.reviewThreads;
    if (!page)
      throw new Error(`GitHub returned no review threads for PR #${number}.`);
    threads.push(...(page.nodes ?? []));
    viewer = out.data?.viewer?.login ?? viewer;
    if (!page.pageInfo?.hasNextPage) return { threads, viewer };
    // Fails closed: a next page it can't ask for would leave its threads unread.
    const next = page.pageInfo.endCursor;
    if (!next || next === after)
      throw new Error(
        `GitHub's review-thread pages for PR #${number} don't advance.`,
      );
    after = next;
  }
}

/**
 * Why open review findings hold the merge, read again from GitHub right before it: the
 * preflight can take a while, and the background security-review hook may post meanwhile.
 */
function holdNow(io, pr) {
  const now = JSON.parse(
    io.gh(['pr', 'view', String(pr.number), '--json', 'comments,reviews']),
  );
  return securityHold({
    pr,
    ...reviewThreads(io, pr.number),
    comments: now.comments ?? [],
    reviews: now.reviews ?? [],
  });
}

/** What changed since `pnpm check`, or `{ problem }`. */
function sinceCheck(io, pr, checked) {
  if (!checked) {
    return {
      problem: `PR #${pr.number}'s body names no commit \`pnpm check\` ran on (a line with "pnpm check" and its SHA): pass --checked <SHA>.`,
    };
  }
  if (!io.git(['merge-base', '--is-ancestor', checked, pr.headRefOid]).ok) {
    return {
      problem: `${checked} (where pnpm check ran) is not here or not in PR #${pr.number}'s head ${pr.headRefOid}: the check ran on another history. Ask its agent to run pnpm check on the head.`,
    };
  }
  const files = lines(
    io.git(['diff', '--name-only', checked, pr.headRefOid]).stdout,
  );
  return { since: sinceCheckLines({ checked, head: pr.headRefOid, files }) };
}

/** The read-only checks; `{ problem }` or what the steps need. */
function preflight({ number, reviewed, checked }, io) {
  const pr = JSON.parse(
    io.gh(['pr', 'view', String(number), '--json', PR_FIELDS]),
  );
  const problem =
    prProblem(pr, reviewed) ??
    securityHold({
      pr,
      ...reviewThreads(io, pr.number),
      comments: pr.comments ?? [],
      reviews: pr.reviews ?? [],
    });
  if (problem) return { problem };
  const base = pr.baseRefName;
  const branch = pr.headRefName;
  if (!io.git(['fetch', 'origin', base]).ok)
    return { problem: `git fetch origin ${base} failed.` };
  // The head itself (a fork's PR has no branch here: its pull ref).
  if (!io.git(['fetch', 'origin', `pull/${pr.number}/head`]).ok) {
    return { problem: `git fetch origin pull/${pr.number}/head failed.` };
  }
  const slot = slotForBranch(io.slots(), branch);
  // GitHub's MERGEABLE says nothing of whether the head has the newest base: asked here.
  if (
    !io.git(['merge-base', '--is-ancestor', `origin/${base}`, pr.headRefOid]).ok
  ) {
    return { problem: behindBaseMessage({ pr, slot }) };
  }
  const isCommit = (sha) =>
    io.git(['rev-parse', '--verify', '--quiet', `${sha}^{commit}`]).ok;
  const since = sinceCheck(
    io,
    pr,
    checked ?? checkedShaFrom(pr.body, isCommit),
  );
  if (since.problem) return since;
  if (slot) {
    const slotHead = io.git(['rev-parse', 'HEAD'], slot.worktree);
    const headProblem = slotHeadProblem({
      pr,
      slot,
      slotHead: slotHead.ok ? slotHead.stdout : null,
    });
    if (headProblem) return { problem: headProblem };
    // Checked now: `agent-slot remove` refuses a dirty worktree after the merge, and it is
    // never forced on its own.
    const dirty = dirtyIn(io, `The slot "${slot.name}"`, slot.worktree);
    if (dirty) return { problem: dirty };
  }
  const mainBranch = io.git(['symbolic-ref', '--quiet', '--short', 'HEAD']);
  const syncMain = mainBranch.ok && mainBranch.stdout === base;
  // Local changes there don't hold the merge: the sync becomes a note, as on another branch.
  const mainDirty = syncMain ? dirtyIn(io, 'The main checkout', io.root) : null;
  // The repository's default branch (origin/HEAD), never deleted as a PR's head.
  const originHead = io.git([
    'symbolic-ref',
    '--quiet',
    '--short',
    'refs/remotes/origin/HEAD',
  ]);
  const defaultBranch = originHead.ok
    ? originHead.stdout.replace(/^origin\//, '')
    : null;
  const board = Boolean(io.env.GH_PROJECT_OWNER && io.env.GH_PROJECT_NUMBER);
  // For the note to the running agents: the PR's files.
  const files = lines(
    io.git(['diff', '--name-only', `origin/${base}...${pr.headRefOid}`]).stdout,
  );
  return {
    pr,
    slot,
    since: since.since,
    note: othersNote({ pr, shared: sharedFiles(files) }),
    steps: mergeSteps({
      pr,
      root: io.root,
      slot,
      board,
      syncMain,
      mainDirty,
      defaultBranch,
    }),
  };
}

/**
 * Whether GitHub still has the PR's branch, asked after the merge: a repository that deletes
 * merged branches itself has removed it during `gh pr merge`. Asked by its full ref name
 * (`ls-remote` matches a bare name by suffix, so `x` would also match `refs/heads/y/x`).
 * `git ls-remote --exit-code` exits 2 when no ref matches; any other failure (the network) is
 * not taken as "deleted", so the delete runs and reports it.
 */
function branchGone(io, branch) {
  const out = io.git([
    'ls-remote',
    '--exit-code',
    'origin',
    `refs/heads/${branch}`,
  ]);
  return !out.ok && out.status === 2;
}

/**
 * After the merge: merge:pr's own leftover worktrees (an older run's temporary ones) removed,
 * every other one listed.
 */
function cleanUp(io) {
  const { own, others } = leftoverWorktrees(
    io.git(['worktree', 'list', '--porcelain']).stdout,
    io.root,
    io.isOwnTemp,
    io.slots().map((slot) => slot?.worktree),
  );
  for (const dir of own) {
    const removed = io.git(['worktree', 'remove', '--force', dir]).ok;
    io.log(
      `merge:pr: ${removed ? 'removed' : "couldn't remove"} its leftover worktree ${dir}.`,
    );
  }
  if (others.length > 0) {
    io.log(
      'Other worktrees (not a slot, not made by merge:pr; remove yours once done):',
    );
    for (const dir of others) io.log(`  ${dir}`);
  }
}

/** Runs the merge; returns the exit code. */
export function mergePr(options, io) {
  let checked;
  try {
    checked = preflight(options, io);
  } catch (error) {
    io.error(`merge:pr: ${error instanceof Error ? error.message : error}`);
    return 1;
  }
  if (checked.problem) {
    io.error(`merge:pr: ${checked.problem}\nNothing was changed.`);
    return 1;
  }
  const { pr, slot, since, note, steps } = checked;
  // Steps that failed without stopping the flow (only the branch delete: cosmetic).
  const warnings = [];
  for (const line of since) io.log(line);
  if (options.dryRun) {
    io.log(
      `merge:pr: PR #${pr.number} passes the checks. The steps (--dry-run: none ran):`,
    );
    for (const step of steps) io.log(`  ${stepLine(step)}`);
    io.log('Then the note for the running agents:');
    for (const line of note) io.log(line);
    if (options.next) {
      io.log(
        `Then --next ${options.next}: merge origin/${pr.baseRefName} into that PR's idle slot and start its checks (never pushed).`,
      );
    }
    return 0;
  }
  for (const [index, step] of steps.entries()) {
    if (step.note) {
      io.log(`merge:pr: ${step.label}: ${step.note}`);
      continue;
    }
    if (step.key === 'branch' && branchGone(io, pr.headRefName)) {
      io.log(
        `merge:pr: ${pr.headRefName} is already gone on GitHub (deleted with the merge).`,
      );
      continue;
    }
    if (step.key === 'merge') {
      let hold;
      try {
        hold = holdNow(io, pr);
      } catch (error) {
        hold = `the review findings couldn't be read again (${error instanceof Error ? error.message : error}).`;
      }
      if (hold) {
        io.error(
          `merge:pr: ${hold}\nNothing was merged; stopped before the merge.`,
        );
        return 1;
      }
    }
    io.log(`merge:pr: ${step.label} …`);
    const status = io.run(step.cmd, step.args, { cwd: step.cwd });
    if (status !== 0 && step.key === 'branch') {
      // The PR is merged by now; a branch left on GitHub only clutters it, so the board, the
      // slot and sync:main still run, and the final report lists it.
      io.error(
        `merge:pr: ${step.label} failed (exit ${status}); going on without it.`,
      );
      warnings.push(
        `${step.label} failed: run \`${stepLine(step)}\` yourself.`,
      );
      continue;
    }
    if (status !== 0) {
      const merged = steps.findIndex((s) => s.key === 'merge') < index;
      io.error(
        [
          `merge:pr: ${step.label} failed (exit ${status}). ${merged ? `PR #${pr.number} IS merged;` : 'Nothing was merged;'} stopped here.`,
          ...(merged
            ? [
                'Still to do, once the cause is fixed:',
                ...warnings.map((warning) => `  ${warning}`),
                ...remainingLines(steps, index - 1),
              ]
            : []),
          ...(merged ? ['', ...note] : []),
        ].join('\n'),
      );
      return 1;
    }
  }
  io.log(`merge:pr: PR #${pr.number} merged.`);
  for (const warning of warnings) io.log(`merge:pr: still to do: ${warning}`);
  cleanUp(io);
  io.log('');
  for (const line of note) io.log(line);
  io.log('');
  io.log('Add to .claude/handover/handover.md:');
  io.log(handoverLine({ pr, slot }));
  for (const line of AFTER_MERGE) io.log(line);
  if (options.next) {
    io.log('');
    // The merge is done whatever the preparation says: it reports, and the exit stays 0.
    prepareNext(
      { which: options.next, base: pr.baseRefName, exclude: pr.number },
      queueIo(io),
    );
  }
  return 0;
}

/** `pnpm merge:pr --prepare <N>`: only the queue's preparation of one PR's slot. */
export function prepareOnly(number, io) {
  return prepareNext({ which: number }, queueIo(io));
}

/** The io prepareNext reads (scripts/merge-pr-next.mjs): merge:pr's own, with dirtyIn. */
function queueIo(io) {
  return { ...io, dirtyIn: (where, dir) => dirtyIn(io, where, dir) };
}
