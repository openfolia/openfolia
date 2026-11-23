// How the scripts run git: without the variables that aim it at another repository (a hook
// exports GIT_DIR, and `git -C <dir>` does not override it; scripts/strip-git-env.mjs).
import { execFileSync, spawnSync } from 'node:child_process';

import { isGitEnvKey } from './strip-git-env.mjs';

/** The variables for a git child: this process's (or `base`) minus the location ones. */
export function gitEnv(base = process['env']) {
  const vars = { ...base };
  for (const key of Object.keys(vars)) if (isGitEnvKey(key)) delete vars[key];
  return vars;
}

/** `spawnSync('git', args, options)` with `gitEnv` (an `options.env` is the base). */
export function runGit(args, options = {}) {
  return spawnSync('git', args, { ...options, env: gitEnv(options.env) });
}

/** `execFileSync('git', args, options)` with `gitEnv`. */
export function execGit(args, options = {}) {
  return execFileSync('git', args, { ...options, env: gitEnv(options.env) });
}
