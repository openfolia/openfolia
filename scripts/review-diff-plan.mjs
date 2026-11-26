// What `pnpm review:diff` (scripts/review-diff.mjs) writes and prints, as plain functions a
// test can pin. /code-review and /security-review run from a worktree can read the main
// checkout's (empty) diff instead of the worktree's: a file holding the worktree's own diff is
// a target they can't resolve elsewhere.
import { readKitConfig } from '../.claude/hooks/kit-config.mjs';

const { mainBranch } = readKitConfig();

/**
 * The base ref to diff against and where it came from: `--base <ref>` / `--base=<ref>` (`arg`),
 * BASE_BRANCH (`env`), the base the branch's agent slot names (`slot`: its slot.json `base`, read
 * through scripts/slot-file.mjs), else origin/<mainBranch> (`default`, kit.config.json). Throws for a `--base` without a
 * ref, or a ref starting with `-` (git would read it as an option).
 * @param {string[]} args
 * @param {Record<string, string | undefined>} env
 * @param {string | null} [slotBase]
 */
export function pickBase(args, env, slotBase = null) {
  const at = args.findIndex(
    (arg) => arg === '--base' || arg.startsWith('--base='),
  );
  const given =
    at === -1
      ? undefined
      : args[at] === '--base'
        ? args[at + 1]
        : args[at].slice('--base='.length);
  if (at !== -1 && !given)
    throw new Error('--base needs a ref (e.g. --base origin/sprint-2).');
  const base = given
    ? { ref: given, source: 'arg' }
    : env.BASE_BRANCH
      ? { ref: env.BASE_BRANCH, source: 'env' }
      : slotBase
        ? { ref: slotBase, source: 'slot' }
        : { ref: `origin/${mainBranch}`, source: 'default' };
  if (base.ref.startsWith('-'))
    throw new Error(`The base ${base.ref} is not a ref.`);
  return base;
}

/** Where the diff goes, relative to the worktree's root (git-ignored: .gitignore's /.review/). */
export const REVIEW_DIFF_FILE = '.review/diff.patch';

/** The header on top of the file: what it holds, so a reviewer can check it is the right one. */
export function reviewHeader({
  worktree,
  branch,
  base,
  mergeBase,
  head,
  untracked,
}) {
  return [
    `# Review diff of ${worktree}`,
    `# branch ${branch ?? '(detached)'} at ${head}; against ${base} (merge-base ${mergeBase})`,
    `# git diff ${mergeBase.slice(0, 12)}...HEAD` +
      (untracked.length > 0
        ? `, plus ${untracked.length} untracked new file(s)`
        : ''),
    '',
  ].join('\n');
}

/**
 * What to print once the file is written: where it is and how to point each review at it.
 * `uncommitted`: tracked files changed but not committed (not in the file: commit them first).
 */
export function reviewHowTo({ file, worktree, branch, files, uncommitted }) {
  const lines = [
    `review:diff: wrote ${file} (${files.length} file(s) changed).`,
    '',
    'Point each review at this file, never an unscoped run:',
    `  /code-review high ${file}`,
    `  /security-review, telling it: "Review only the diff in ${file} (worktree ${worktree}, ` +
      `branch ${branch ?? 'detached'}); ignore the main checkout's state."`,
    "Check each review's own summary names these files before trusting a clean round:",
    ...files.slice(0, 20).map((name) => `  ${name}`),
    ...(files.length > 20 ? [`  … and ${files.length - 20} more`] : []),
  ];
  if (uncommitted.length > 0) {
    lines.push(
      '',
      `Not in the file (changed but not committed): ${uncommitted.join(', ')}. Commit them and run review:diff again.`,
    );
  }
  return lines.join('\n');
}
