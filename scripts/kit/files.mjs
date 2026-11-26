// What the kit is (scripts/kit/README.md): the files `scripts/kit/install.mjs` copies into a
// repository, the package.json scripts and .gitignore lines it adds there, and the files it
// writes only when they are missing. This repository runs on these same files in place, with
// its own kit.config.json, so the kit and this repository never drift: a change to the tooling
// is a change to the kit. scripts/__tests__/kit.test.ts keeps the list whole (every file there,
// every import inside the kit) and free of this project's own names.

/** Copied as they are, overwriting the repository's copy (a folder: every file in it). */
export const KIT_FILES = [
  '.claude/hooks',
  '.claude/agents/build-agent.md',
  '.claude/skills/board',
  '.claude/skills/factory',
  '.claude/skills/project-workflow',
  '.claude/skills/requirements-to-backlog',
  '.claude/skills/verify-before-done',
  '.githooks/post-merge',
  'docs/handover-template.md',
  'scripts/kit/README.md',
  'scripts/agent-slot.mjs',
  'scripts/agent-slot-brief.mjs',
  'scripts/agent-slot-create.mjs',
  'scripts/agent-slot-files.mjs',
  'scripts/agent-slot-io.mjs',
  'scripts/agent-slot-plan.mjs',
  'scripts/agent-slot-remove.mjs',
  'scripts/backlog-apply.mjs',
  'scripts/backlog-github.mjs',
  'scripts/backlog-plan.mjs',
  'scripts/backlog-validate.mjs',
  'scripts/backlog.schema.json',
  'scripts/board-github.mjs',
  'scripts/board-plan.mjs',
  'scripts/check-triage.mjs',
  'scripts/check.mjs',
  'scripts/create-backlog.mjs',
  'scripts/gh-api.mjs',
  'scripts/merge-pr-flow.mjs',
  'scripts/merge-pr-hold.mjs',
  'scripts/merge-pr-next.mjs',
  'scripts/merge-pr-plan.mjs',
  'scripts/merge-pr-report.mjs',
  'scripts/merge-pr.mjs',
  'scripts/pr-assets-github.mjs',
  'scripts/pr-assets-plan.mjs',
  'scripts/pr-assets.mjs',
  'scripts/project-status.mjs',
  'scripts/registry-lock.mjs',
  'scripts/review-diff-plan.mjs',
  'scripts/review-diff.mjs',
  'scripts/run-git.mjs',
  'scripts/set-project-status.mjs',
  'scripts/set-project-status.sh',
  'scripts/setup-board.mjs',
  'scripts/setup-git-hooks.mjs',
  'scripts/slot-file.mjs',
  'scripts/strip-git-env.mjs',
  'scripts/sync-main-plan.mjs',
  'scripts/sync-main.mjs',
];

/** The package.json scripts the kit's commands run by (the guard knows merge:pr and sync:main). */
export const KIT_PACKAGE_SCRIPTS = {
  check: 'node scripts/check.mjs run-many',
  'check:changed': 'node scripts/check.mjs affected',
  'setup:board': 'node scripts/setup-board.mjs',
  'backlog:create': 'node scripts/create-backlog.mjs',
  slot: 'node scripts/agent-slot.mjs',
  'review:diff': 'node scripts/review-diff.mjs',
  'merge:pr': 'node scripts/merge-pr.mjs',
  'sync:main': 'node scripts/sync-main.mjs',
  'pr:assets': 'node scripts/pr-assets.mjs',
  'setup:git-hooks': 'node scripts/setup-git-hooks.mjs',
};

/** The kit's local state, never committed: the .gitignore lines it needs. */
export const KIT_IGNORES = [
  '.env',
  '.env.*',
  '!.env.example',
  '.claude/worktrees/',
  '.claude/handover/',
  '.claude/board/',
  '.claude/stacks/',
  '.claude/settings.local.json',
  '.review/',
  '.factory-tmp/',
  'docs/internal/',
];

/** The hooks and permissions file: merged into the repository's own (scripts/kit/install.mjs). */
export const KIT_SETTINGS = '.claude/settings.json';
