#!/usr/bin/env node
// `pnpm review:diff [--base <ref>]`, in a worktree (or any checkout): writes the branch's own
// diff, `git diff <merge-base of the base and HEAD>...HEAD` plus every untracked new file, to
// .review/diff.patch in that checkout (git-ignored) and prints how to point /code-review and
// /security-review at it. Base: --base, BASE_BRANCH, the base the branch's agent slot names,
// else origin/main (review-diff-plan.mjs, pickBase); fetched first when it is a remote ref.
import { lstatSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import {
  REVIEW_DIFF_FILE,
  pickBase,
  reviewHeader,
  reviewHowTo,
} from './review-diff-plan.mjs';
import { runGit } from './run-git.mjs';
import { readSlots } from './slot-file.mjs';

function git(args, { allowFail = false } = {}) {
  const out = runGit(args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  // `git diff --no-index` exits 1 when the files differ, which is every untracked file here.
  if (out.status !== 0 && !allowFail) {
    console.error(`review:diff: git ${args.join(' ')} failed:\n${out.stderr}`);
    process.exit(1);
  }
  return String(out.stdout ?? '');
}

const top = git(['rev-parse', '--show-toplevel']).trim();
process.chdir(top);
const branchOut = runGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], {
  encoding: 'utf8',
});
const branch = branchOut.status === 0 ? String(branchOut.stdout).trim() : null;
// The main checkout holds the slot registry (.claude/stacks/), also seen from a worktree.
const main = path.dirname(
  git(['rev-parse', '--path-format=absolute', '--git-common-dir']).trim(),
);
let slotBase = null;
try {
  const slot = readSlots(main).find(
    (record) => branch && record?.branch === branch,
  );
  slotBase =
    typeof slot?.base === 'string' && slot.base !== '' ? slot.base : null;
} catch {
  // An unreadable registry: the other sources (or origin/main) decide.
}
let base;
try {
  ({ ref: base } = pickBase(process.argv.slice(2), process.env, slotBase));
} catch (error) {
  console.error(
    `review:diff: ${error instanceof Error ? error.message : error}`,
  );
  process.exit(2);
}
// The base reaches git as an argument: a ref name only, never an option (`--upload-pack=…`).
if (
  !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(base) ||
  base
    .split('/')
    .some(
      (part) => part === '' || part.startsWith('-') || part.startsWith('.'),
    ) ||
  runGit(['check-ref-format', '--allow-onelevel', base], { stdio: 'ignore' })
    .status !== 0
) {
  console.error(`review:diff: "${base}" is not a branch or ref name.`);
  process.exit(2);
}
const remotes = git(['remote']).split('\n').filter(Boolean);
const [remote, ...rest] = base.split('/');
if (rest.length && remotes.includes(remote)) {
  if (
    runGit(['fetch', '--', remote, rest.join('/')], { stdio: 'ignore' })
      .status !== 0
  ) {
    console.warn(`review:diff: could not fetch ${base}; using the local ref.`);
  }
}
if (
  runGit(['rev-parse', '--verify', '--quiet', `${base}^{commit}`], {
    stdio: 'ignore',
  }).status
) {
  console.error(
    `review:diff: no ${base} here: fetch it, or pass --base <ref>.`,
  );
  process.exit(1);
}

const head = git(['rev-parse', 'HEAD']).trim();
const mergeBase = git(['merge-base', base, 'HEAD']).trim();
const lines = (text) => text.split('\n').filter(Boolean);
const committed = git(['diff', '--binary', `${mergeBase}...HEAD`]);
const changed = lines(git(['diff', '--name-only', `${mergeBase}...HEAD`]));
const untracked = lines(git(['ls-files', '--others', '--exclude-standard']));
const uncommitted = lines(git(['diff', '--name-only', 'HEAD']));
const newFiles = untracked.map((file) =>
  git(['diff', '--no-index', '--binary', '--', '/dev/null', file], {
    allowFail: true,
  }),
);

const file = path.join(top, REVIEW_DIFF_FILE);
mkdirSync(path.dirname(file), { recursive: true });
// Never write through a symlink planted at .review/ or at the file itself.
for (const target of [path.dirname(file), file]) {
  let stat = null;
  try {
    stat = lstatSync(target);
  } catch {
    // Missing: fine, it is created below.
  }
  if (stat?.isSymbolicLink()) {
    console.error(
      `review:diff: ${target} is a symlink; remove it and run again.`,
    );
    process.exit(1);
  }
}
writeFileSync(
  file,
  reviewHeader({ worktree: top, branch, base, mergeBase, head, untracked }) +
    committed +
    newFiles.join(''),
);
console.log(
  reviewHowTo({
    file,
    worktree: top,
    branch,
    files: [...changed, ...untracked],
    uncommitted,
  }),
);
