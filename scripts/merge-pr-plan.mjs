// What `pnpm merge:pr <N>` (scripts/merge-pr.mjs) decides, as plain functions a test can pin:
// the checks a PR must pass before the coordinator merges it, and the steps after them.
// scripts/merge-pr-flow.mjs runs them through injected gh/git callers.
import { BASE_BRANCH } from '../.claude/hooks/subagent-rules.mjs';

/** The fields `gh pr view --json` reads. */
export const PR_FIELDS =
  'number,title,body,state,isDraft,mergeable,headRefOid,headRefName,baseRefName,closingIssuesReferences,isCrossRepository,comments,reviews,url,author';

const USAGE =
  'Usage: pnpm merge:pr <PR number> --reviewed <SHA> [--checked <SHA>] [--next <PR|auto>] [--dry-run]\n' +
  '       pnpm merge:pr --prepare <PR number>\n' +
  '  --reviewed  the head commit the last clean /code-review and /security-review rounds read\n' +
  '  --checked   the commit the last `pnpm check` ran on (default: the one the PR body names)\n' +
  '  --next      after the merge, prepare the next PR (auto: the oldest ready one with a slot):\n' +
  '              merge the base into its idle slot and start its checks there; never pushes\n' +
  '  --prepare   only that preparation, for one PR (after a merge made elsewhere)\n' +
  '  --dry-run   run every check that only reads, then print the steps instead of running them\n' +
  'Run --dry-run first: it lists what changed since `pnpm check`, so you can ask for a re-run.\n' +
  'It holds a PR with an unresolved review thread; any comment or review summary by another\n' +
  'author (anyone but gh\'s own login and the PR\'s author) unless it is wholly a "no findings"\n' +
  'or a short approval ("LGTM", "looks good", "approved"); your own that read like a security\n' +
  'finding; each until a later PR comment by another author links it by its URL (a review: names\n' +
  'its id) and says "fixed in <sha>", "resolved in <sha>", "fixed by <sha|#PR|URL>", "not\n' +
  'applicable", "doesn\'t apply", "false positive" or "by design", raising no finding itself (an\n' +
  'acknowledgement like "will fix" or "+1" answers nothing); and a review requesting changes\n' +
  'until its author approves.';

const SHA = /^[0-9a-f]{7,40}$/i;

/** `--name <value>` or `--name=<value>`: the value (null when absent) and the words it used. */
function option(argv, name) {
  const at = argv.findIndex(
    (arg) => arg === name || arg.startsWith(`${name}=`),
  );
  if (at === -1) return { value: null, used: [] };
  if (argv[at].includes('='))
    return { value: argv[at].split('=')[1], used: [at] };
  return { value: argv[at + 1] ?? '', used: [at, at + 1] };
}

const PR_NUMBER = /^#?(\d+)$/;

/**
 * `{ number, reviewed, checked, next, dryRun }` from the arguments (`next`: another PR's
 * number, 'auto' or null), `{ prepare }` for `--prepare <N>` alone, or `{ error }` (with the
 * usage).
 */
export function parseMergeArgs(argv) {
  const prepare = option(argv, '--prepare');
  if (prepare.used.length > 0) {
    const value = PR_NUMBER.exec(prepare.value)?.[1];
    if (!value || argv.length !== prepare.used.length) {
      return {
        error: `merge:pr: --prepare takes one PR number and nothing else.\n${USAGE}`,
      };
    }
    return { prepare: Number(value) };
  }
  const reviewed = option(argv, '--reviewed');
  const checked = option(argv, '--checked');
  const next = option(argv, '--next');
  const used = new Set([...reviewed.used, ...checked.used, ...next.used]);
  const plain = argv.filter((arg, i) => !used.has(i) && arg !== '--dry-run');
  const number = PR_NUMBER.exec(plain[0] ?? '')?.[1];
  if (!number || plain.length > 1) return { error: USAGE };
  let nextPr = null;
  if (next.used.length > 0) {
    const nextNumber = PR_NUMBER.exec(next.value)?.[1];
    nextPr =
      next.value === 'auto' ? 'auto' : nextNumber ? Number(nextNumber) : null;
    if (nextPr === null || nextPr === Number(number)) {
      return {
        error: `merge:pr: --next takes another PR's number, or auto.\n${USAGE}`,
      };
    }
  }
  if (!reviewed.value || !SHA.test(reviewed.value)) {
    return {
      error: `merge:pr: --reviewed <SHA> (7–40 hex characters) is required: the head the last clean review rounds read. A head that moved since is reviewed again before it merges.\n${USAGE}`,
    };
  }
  if (checked.value !== null && !SHA.test(checked.value)) {
    return {
      error: `merge:pr: --checked takes a SHA (7–40 hex characters).\n${USAGE}`,
    };
  }
  return {
    number: Number(number),
    reviewed: reviewed.value.toLowerCase(),
    checked: checked.value?.toLowerCase() ?? null,
    next: nextPr,
    dryRun: argv.includes('--dry-run'),
  };
}

/** Why this PR may not merge as it stands on GitHub, or null. */
export function prProblem(pr, reviewed) {
  const n = `PR #${pr.number}`;
  if (pr.state !== 'OPEN')
    return `${n} is ${String(pr.state).toLowerCase()}, not open.`;
  if (pr.isDraft)
    return `${n} is a draft: mark it ready only once its review rounds are clean.`;
  if (pr.mergeable === 'CONFLICTING') {
    return `${n} has conflicts with ${pr.baseRefName}: back to its agent, which merges the base, resolves them and reviews that fix itself.`;
  }
  if (pr.mergeable !== 'MERGEABLE') {
    return `GitHub hasn't worked out whether ${n} merges cleanly yet (mergeable: ${pr.mergeable}): run this again in a minute.`;
  }
  if (!String(pr.headRefOid).toLowerCase().startsWith(reviewed)) {
    return `${n}'s head is ${pr.headRefOid}, not the reviewed ${reviewed}: the commits since were never reviewed. Back to its agent for a review round on them, then merge that head.`;
  }
  return null;
}

/** The slot whose branch is `branch` (one per branch; agent-slot never makes two). */
export function slotForBranch(slots, branch) {
  return slots.find((slot) => slot?.branch === branch) ?? null;
}

/** What to say when the PR's head doesn't contain the latest base. */
export function behindBaseMessage({ pr, slot }) {
  const where = slot
    ? `In its slot "${slot.name}" (${slot.worktree}): git fetch origin && git merge origin/${pr.baseRefName}, then pnpm install and pnpm check on that head, push it, and review the merge diff.`
    : `Its branch ${pr.headRefName} has no slot here: merge origin/${pr.baseRefName} into it in a worktree (pnpm slot create <name> --branch ${pr.headRefName}), then pnpm install, pnpm check, push.`;
  return `PR #${pr.number}'s head doesn't contain the latest origin/${pr.baseRefName}: the checks ran on an older base. ${where}`;
}

/** Why the slot's worktree can't vouch for the PR head, or null (`slotHead`: its HEAD). */
export function slotHeadProblem({ pr, slot, slotHead }) {
  if (slotHead === pr.headRefOid) return null;
  return `The slot "${slot.name}" (${slot.worktree}) is at ${slotHead ?? 'an unknown commit'}, not the PR head ${pr.headRefOid}: commits that are only local, or a head pushed from elsewhere. Settle it with the agent before merging.`;
}

/** The merge commit's subject, as the history names merges: `Merge pull request #N: <title>`. */
export function mergeSubject(pr) {
  return `Merge pull request #${pr.number}: ${String(pr.title).trim()}`;
}

/** The issues the PR closes (its "Closes #N" lines, as GitHub links them). */
export function closedIssues(pr) {
  return (pr.closingIssuesReferences ?? [])
    .map((issue) => issue.number)
    .filter(Boolean);
}

/**
 * Whether a PR's head branch is one merge:pr never deletes: `main`, the repository's default
 * branch (`defaultBranch`, null when unknown) or a base branch (`sprint-*`, the guard's
 * BASE_BRANCH): a `sprint-3` → `main` PR leaves `sprint-3` where it is.
 */
export function keepsHeadBranch(branch, defaultBranch) {
  return (
    BASE_BRANCH.test(branch) ||
    (Boolean(defaultBranch) && branch === defaultBranch)
  );
}

/**
 * The steps that change something, in order, each `{ key, label, cmd, args, cwd }`, or
 * `{ key, label, note }` for one that can't run and says why. `board`: GH_PROJECT_OWNER and
 * GH_PROJECT_NUMBER are set. `syncMain`: the main checkout is on the PR's base, and `mainDirty`
 * dirtyReason's answer for it (local changes: the merge goes ahead, the sync becomes a note), or
 * null. `defaultBranch`: the repository's default branch, or null when unknown.
 */
export function mergeSteps({
  pr,
  root,
  slot,
  board,
  syncMain,
  mainDirty = null,
  defaultBranch = null,
}) {
  const base = pr.baseRefName;
  const issues = closedIssues(pr);
  const steps = [
    {
      key: 'merge',
      label: `merge PR #${pr.number} at ${pr.headRefOid.slice(0, 8)}`,
      cmd: 'gh',
      args: [
        'pr',
        'merge',
        String(pr.number),
        '--merge',
        '--match-head-commit',
        pr.headRefOid,
        '--subject',
        mergeSubject(pr),
      ],
      cwd: root,
    },
  ];
  // Never `gh pr merge --delete-branch`: it removes clean worktrees. A fork's
  // branch is not origin's to delete. Whether GitHub still has it is asked after the merge (a
  // repository that deletes merged branches has already done it then): the flow skips it then.
  if (!pr.isCrossRepository && keepsHeadBranch(pr.headRefName, defaultBranch)) {
    steps.push({
      key: 'branch',
      label: 'branch',
      note: `${pr.headRefName} is a base branch (main, sprint-*, or the default): left on GitHub.`,
    });
  } else if (!pr.isCrossRepository) {
    steps.push({
      key: 'branch',
      label: `delete ${pr.headRefName} on GitHub (unless GitHub already did)`,
      cmd: 'git',
      args: ['push', 'origin', '--delete', pr.headRefName],
      cwd: root,
    });
  }
  if (issues.length === 0) {
    steps.push({
      key: 'board',
      label: 'board',
      note: 'the PR closes no issue: set the board yourself.',
    });
  } else if (!board) {
    steps.push({
      key: 'board',
      label: 'board',
      note: `GH_PROJECT_OWNER / GH_PROJECT_NUMBER aren't set (pnpm setup:board writes them): set ${issues.map((i) => `#${i}`).join(' ')} to Done yourself.`,
    });
  } else {
    // Adds an issue that isn't on the board yet, then sets it.
    steps.push({
      key: 'board',
      label: `board: ${issues.map((i) => `#${i}`).join(' ')} → Done`,
      cmd: 'bash',
      args: ['scripts/set-project-status.sh', 'Done', ...issues.map(String)],
      cwd: root,
    });
  }
  if (slot) {
    steps.push({
      key: 'slot',
      label: `remove the slot "${slot.name}"`,
      cmd: 'node',
      args: ['scripts/agent-slot.mjs', 'remove', slot.name],
      cwd: root,
    });
  }
  steps.push(
    syncMain && mainDirty
      ? {
          key: 'sync',
          label: 'sync',
          note: `not run: ${mainDirty} Then run pnpm sync:main (it fast-forwards to origin/${base}, then check:changed).`,
        }
      : syncMain
        ? {
            key: 'sync',
            label: `sync the main checkout to origin/${base} (then check:changed)`,
            cmd: 'node',
            args: ['scripts/sync-main.mjs', '--base', base],
            cwd: root,
          }
        : {
            key: 'sync',
            label: 'sync',
            note: `the main checkout isn't on ${base}: run pnpm check on origin/${base} in a worktree of it.`,
          },
  );
  return steps;
}

/** A step as one line to run by hand. */
export function stepLine(step) {
  if (step.note) return `${step.label}: ${step.note}`;
  const words = [step.cmd, ...step.args].map((word) =>
    /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`,
  );
  return `${step.cwd ? `(cd '${step.cwd}' && ` : '('}${words.join(' ')})`;
}

/** What is left to do after the step at `index` stopped the run, as lines. */
export function remainingLines(steps, index) {
  return steps.slice(index + 1).map((step) => `  ${stepLine(step)}`);
}

/** The reminders after a merge. */
export const AFTER_MERGE = [
  'Now: check every other open PR is still conflict-free (gh pr list), and notify the person.',
];
