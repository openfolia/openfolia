// Git exports GIT_DIR, GIT_INDEX_FILE and the like to a hook, and `npm run check:code` runs
// inside the post-merge hook: a test or script that spawned git with those inherited aimed it
// at the real repository (main moved, .git/config got core.bare=true and a test identity);
// `git -C <dir>` does not override them. Only the variables that say WHICH repository are
// dropped: GIT_SSH_COMMAND, GIT_ASKPASS, GIT_SSL_CAINFO, GIT_CONFIG_PARAMETERS, GIT_TRACE and
// the like are the developer's own and stay. This list is the one place that names them
// (.githooks/post-merge repeats it, with a test that they match).

/** The variables that point git at a repository, plus BASE_BRANCH (the scripts' base ref). */
export const GIT_LOCATION_VARS = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_NAMESPACE',
  'GIT_PREFIX',
  'GIT_CEILING_DIRECTORIES',
  'GIT_DISCOVERY_ACROSS_FILESYSTEM',
  'BASE_BRANCH',
];

/** True for a variable that aims git at a repository (or sets the scripts' base ref). */
export function isGitEnvKey(key) {
  return GIT_LOCATION_VARS.includes(key);
}

/**
 * Deletes them from `target` (default: this process's variables) and returns it.
 * @param {Record<string, string | undefined>} [target]
 */
export function stripGitEnv(target = process['env']) {
  for (const key of Object.keys(target))
    if (isGitEnvKey(key)) delete target[key];
  return target;
}
