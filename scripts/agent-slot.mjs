#!/usr/bin/env node
// A parallel agent's slot, from the main checkout (`pnpm slot ...`):
//
//   pnpm slot create <name> [--base <ref>] [--branch <branch>] [--offline]
//   pnpm slot remove <name> [--force] [--dry-run]
//   pnpm slot prune-databases [--yes]
//   pnpm slot list
//
// create: a worktree at .claude/worktrees/<name> on its branch (agent/<name> or --branch):
// the local branch when it exists, else one made from origin/<branch> when GitHub has it
// (git ls-remote, then fetched; a stale remote-tracking ref never counts; a failed ls-remote
// stops create unless --offline), else a new branch from the base (--base <ref> or
// --base=<ref>, BASE_BRANCH, else origin/<mainBranch>, fetched first); dependencies from pnpm's
// store (`pnpm install --frozen-lockfile --prefer-offline`); the project's own setup in the
// worktree (kit.config.json `slot.setup`: its .env.local, sample data, a database of its own)
// and the worktree's PORT in its .env.local, unique among slots, from `ownPort` + 1 and never
// `ownPort` (the person's own). The PORT and the slot's record (.claude/stacks/<name>/slot.json,
// scripts/slot-file.mjs) are written under an exclusive lock (.claude/stacks/.lock,
// scripts/registry-lock.mjs), so concurrent creates never share a PORT; a create that died
// before its worktree existed (`creating` pid gone) is ignored and replaced. Prints a summary
// and the slot's brief (scripts/agent-slot-brief.mjs) for the agent's prompt; warns, never
// refuses, when the machine looks loaded.
// remove: stops whatever listens on that slot's PORT (by port, never by name), drops the slot's
// own databases and bucket where the project has them (`slot.databasesScript`,
// `slot.bucketScript`; one in use stays, with a note), removes the worktree (refuses
// uncommitted changes without --force) and the record. The branch stays. --dry-run changes
// nothing and says which databases it would drop.
// prune-databases: lists the databases of slots that are gone (`slot.databasesScript`); drops
// them only with --yes.
import path from 'node:path';

import { create } from './agent-slot-create.mjs';
import { run } from './agent-slot-io.mjs';
import { slotName } from './agent-slot-plan.mjs';
import { listLines, pruneDatabases, remove } from './agent-slot-remove.mjs';

const [command, rawName, ...rest] = process.argv.slice(2);

/** The main checkout's root, also when run from inside a worktree. */
function mainRoot() {
  const common = run('git', [
    'rev-parse',
    '--path-format=absolute',
    '--git-common-dir',
  ]).trim();
  return path.dirname(common);
}

try {
  const root = mainRoot();
  if (command === 'list') {
    for (const line of listLines(root)) console.log(line);
  } else if (command === 'create') create(root, slotName(rawName), rest);
  else if (command === 'remove') {
    remove(root, slotName(rawName), {
      force: rest.includes('--force'),
      dryRun: rest.includes('--dry-run'),
    });
  } else if (command === 'prune-databases') {
    const args = [rawName, ...rest].filter(Boolean);
    const yes = args.includes('--yes') && !args.includes('--dry-run');
    if (!pruneDatabases(root, { yes })) process.exit(1);
  } else {
    console.error(
      'Usage: pnpm slot create|remove <name> | prune-databases [--yes] | list',
    );
    process.exit(2);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
