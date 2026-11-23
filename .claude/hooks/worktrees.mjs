// Which agent worktrees a repository really has, from `git worktree list --porcelain`: the
// parsing is pure so scripts/__tests__/claude-hooks.test.ts can pin it; pre-tool-use.mjs runs git.

/**
 * The agent worktrees (under `.claude/worktrees/`) in porcelain output, leaving out a stale
 * entry: one git marks `prunable`, or whose folder no longer exists.
 * @param {string} porcelain `git worktree list --porcelain`
 * @param {(dir: string) => boolean} exists Whether a folder exists.
 * @returns {string[]} The worktree paths.
 */
export function agentWorktrees(porcelain, exists) {
  return porcelain
    .split(/\n\s*\n/)
    .map((entry) => entry.split('\n'))
    .filter(
      (lines) =>
        !lines.some(
          (line) => line === 'prunable' || line.startsWith('prunable '),
        ),
    )
    .map((lines) =>
      lines
        .find((line) => line.startsWith('worktree '))
        ?.slice('worktree '.length),
    )
    .filter(
      (dir) =>
        typeof dir === 'string' &&
        dir.includes('/.claude/worktrees/') &&
        exists(dir),
    );
}
