#!/usr/bin/env node
// PreToolUse hook (.claude/settings.json): blocks the clear matches .claude/hooks/guard-rules.mjs
// decides, with exit code 2 and the reason on stderr (Claude reads it). It fails open: on any
// error of its own it exits 0, so a broken hook never stops a session.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { decide } from './guard-rules.mjs';
import { agentWorktrees } from './worktrees.mjs';

function git(dir, args) {
  return execFileSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 3000,
  }).trim();
}

/**
 * Whether the repository at `root` has live agent worktrees (a stale `prunable` entry, or one
 * whose folder is gone, doesn't count); `fallback` when git can't tell.
 */
function worktreesIn(root, fallback) {
  try {
    return (
      agentWorktrees(git(root, ['worktree', 'list', '--porcelain']), existsSync)
        .length > 0
    );
  } catch {
    return fallback;
  }
}

/** The nearest directory of `file` that exists (a new file's folder may not yet). */
function existingDir(file) {
  let dir = file;
  while (!existsSync(dir) && path.dirname(dir) !== dir) dir = path.dirname(dir);
  return dir;
}

/** `fn` with its answers kept per argument (one git call per directory per tool call). */
function memo(fn) {
  const seen = new Map();
  return (arg) => {
    if (!seen.has(arg)) seen.set(arg, fn(arg));
    return seen.get(arg);
  };
}

const ctx = {
  cwd: process.cwd(),
  home: os.homedir(),
  isMainCheckout: memo((dir) => {
    try {
      const [gitDir, commonDir] = git(existingDir(dir), [
        'rev-parse',
        '--absolute-git-dir',
        '--git-common-dir',
      ]).split('\n');
      return (
        path.resolve(existingDir(dir), gitDir) ===
        path.resolve(existingDir(dir), commonDir)
      );
    } catch {
      return false;
    }
  }),
  // The hook's own repository: this file sits in <repo>/.claude/hooks, whatever the cwd.
  // Unknown (git failed) is null.
  projectWorktreesActive() {
    const root = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '..',
      '..',
    );
    return worktreesIn(root, null);
  },
  worktreeBranch(worktree) {
    try {
      return git(worktree, ['branch', '--show-current']) || null;
    } catch {
      return null;
    }
  },
  agentWorktreesActive: memo((dir) => worktreesIn(existingDir(dir), false)),
};

try {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  const input = JSON.parse(raw);
  if (typeof input.cwd === 'string' && input.cwd) ctx.cwd = input.cwd;
  const decision = decide(input, ctx);
  if (decision.block) {
    process.stderr.write(`${decision.reason}\n`);
    process.exit(2);
  }
} catch {
  // Fail open: the guard's own failure never blocks a tool call.
}
process.exit(0);
