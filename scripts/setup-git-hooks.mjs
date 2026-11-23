#!/usr/bin/env node
// `pnpm setup:git-hooks` (opt-in, once per clone): installs the one reviewed hook,
// .githooks/post-merge (pnpm check:changed after a merge or pull), as a copy in the
// repository's own hooks folder (`git rev-parse --git-common-dir`/hooks, shared by every
// worktree). It never points core.hooksPath at a tracked folder: then any branch checked out
// (a contributor's PR) could add hooks that run on later git commands. An older setup's
// `core.hooksPath = .githooks` is removed. A post-merge hook of someone else's stays unless
// --force. Idempotent; re-run it after .githooks/post-merge changes.
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
} from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { runGit } from './run-git.mjs';

export const HOOK_SOURCE = '.githooks/post-merge';
/** A line every copy of our hook has, to tell it from someone else's. */
export const HOOK_MARKER = 'pnpm check:changed';

/**
 * What to do, from what is there now: `{ unsetHooksPath, install, reason? }`. Installs only
 * the post-merge hook; leaves a different post-merge hook alone unless `force`.
 */
export function gitHooksPlan({
  currentHooksPath,
  existingHook,
  sourceHook,
  force = false,
}) {
  const unsetHooksPath = currentHooksPath === '.githooks';
  if (existingHook === null || existingHook === sourceHook) {
    return { unsetHooksPath, install: existingHook !== sourceHook };
  }
  if (existingHook.includes(HOOK_MARKER) || force)
    return { unsetHooksPath, install: true };
  return {
    unsetHooksPath,
    install: false,
    reason:
      'a different post-merge hook is installed; left alone (--force replaces it)',
  };
}

function git(args) {
  return runGit(args, { encoding: 'utf8' });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const common = git([
    'rev-parse',
    '--path-format=absolute',
    '--git-common-dir',
  ]);
  const top = git(['rev-parse', '--show-toplevel']);
  if (common.status !== 0 || top.status !== 0) {
    console.error('setup:git-hooks: not inside a git checkout.');
    process.exit(1);
  }
  const source = path.join(top.stdout.trim(), HOOK_SOURCE);
  const target = path.join(common.stdout.trim(), 'hooks', 'post-merge');
  const plan = gitHooksPlan({
    currentHooksPath: git(['config', '--get', 'core.hooksPath']).stdout.trim(),
    existingHook: existsSync(target) ? readFileSync(target, 'utf8') : null,
    sourceHook: readFileSync(source, 'utf8'),
    force: process.argv.includes('--force'),
  });
  if (plan.unsetHooksPath) {
    git(['config', '--unset', 'core.hooksPath']);
    console.log(
      'setup:git-hooks: removed core.hooksPath = .githooks (a tracked folder).',
    );
  }
  if (plan.install) {
    mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(source, target);
    chmodSync(target, 0o755);
    console.log(
      `setup:git-hooks: installed ${target} (pnpm check:changed after every merge).`,
    );
  } else if (plan.reason) {
    console.warn(`setup:git-hooks: ${plan.reason}`);
  } else {
    console.log('setup:git-hooks: the post-merge hook is already installed.');
  }
}
