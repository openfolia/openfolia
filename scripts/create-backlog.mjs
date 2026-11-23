#!/usr/bin/env node
// `pnpm backlog:create <file.json>`: makes the backlog a file describes
// (scripts/backlog.schema.json) on GitHub and the board, creating only what is missing:
// an item is matched by its key marker, so a re-run makes nothing twice and rewrites nothing
// (scripts/backlog-plan.mjs). The board comes from GH_PROJECT_OWNER / GH_PROJECT_NUMBER, in
// the environment or .claude/settings.local.json's `env` (pnpm setup:board writes them).
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { applyBacklog } from './backlog-apply.mjs';
import { readProject } from './board-github.mjs';
import { currentRepo, ghCli } from './gh-api.mjs';

const HELP = `Usage: pnpm backlog:create <backlog.json> [--dry-run]

  --dry-run   read GitHub and print what would be made; change nothing
  --help      this text

The file's format: scripts/backlog.schema.json. Needs gh with the project scope
(gh auth refresh -s project) and the board's fields (pnpm setup:board).`;

const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: { 'dry-run': { type: 'boolean' }, help: { type: 'boolean' } },
});
if (opts.help || positionals.length !== 1) {
  console.log(HELP);
  process.exit(opts.help ? 0 : 2);
}

function boardSettings() {
  const file = path.join(process.cwd(), '.claude', 'settings.local.json');
  const local = existsSync(file)
    ? (JSON.parse(readFileSync(file, 'utf8')).env ?? {})
    : {};
  const owner = process.env.GH_PROJECT_OWNER || local.GH_PROJECT_OWNER;
  const number = process.env.GH_PROJECT_NUMBER || local.GH_PROJECT_NUMBER;
  if (!owner || !number) {
    throw new Error(
      'no GH_PROJECT_OWNER / GH_PROJECT_NUMBER: run pnpm setup:board first',
    );
  }
  return { owner, number };
}

try {
  const backlog = JSON.parse(readFileSync(positionals[0], 'utf8'));
  const { owner, number } = boardSettings();
  const project = readProject(ghCli, owner, number);
  if (!project)
    throw new Error(`no project #${number} of ${owner}: run pnpm setup:board`);
  const notes = applyBacklog({
    gh: ghCli,
    repo: currentRepo(ghCli),
    project,
    backlog,
    dryRun: Boolean(opts['dry-run']),
    log: (line) => console.log(line),
  });
  if (notes.length)
    console.log(
      `\nLeft as they are (for the report):\n- ${notes.join('\n- ')}`,
    );
} catch (error) {
  console.error(`backlog:create: ${error.message}`);
  process.exit(1);
}
