#!/usr/bin/env node
// `pnpm setup:board`: this repo's GitHub project board, made once and filled in on every run.
// Finds the project (the settings' GH_PROJECT_NUMBER, else the open one with the title) or
// creates it linked to the repo, gives Status the workflow's five options and adds Priority,
// Size, Model, Review rounds and Stopped where they are missing (scripts/board-plan.mjs), then
// writes GH_PROJECT_OWNER and GH_PROJECT_NUMBER into .claude/settings.local.json's `env`, which
// scripts/set-project-status.sh and scripts/create-backlog.mjs read.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { setupBoard } from './board-github.mjs';
import { mergeLocalSettings } from './board-plan.mjs';
import { currentRepo, ghCli } from './gh-api.mjs';

const HELP = `Usage: pnpm setup:board [options]

  --owner <login>   the user or organisation that owns the board (default: the repo's owner)
  --title <title>   the board's title (default: the repo's name)
  --dry-run         read GitHub and print the plan; change nothing, write no settings
  --help            this text

Needs gh with the project scope: gh auth refresh -s project`;

const { values: opts } = parseArgs({
  options: {
    owner: { type: 'string' },
    title: { type: 'string' },
    'dry-run': { type: 'boolean' },
    help: { type: 'boolean' },
  },
});
if (opts.help) {
  console.log(HELP);
  process.exit(0);
}

const settingsPath = path.join(process.cwd(), '.claude', 'settings.local.json');
const settings = existsSync(settingsPath)
  ? JSON.parse(readFileSync(settingsPath, 'utf8'))
  : {};
const repo = currentRepo(ghCli);
const owner = opts.owner ?? repo.owner;
const title = opts.title ?? repo.name;
const dryRun = Boolean(opts['dry-run']);
const known =
  settings.env?.GH_PROJECT_OWNER === owner
    ? settings.env.GH_PROJECT_NUMBER
    : null;

try {
  const result = setupBoard({
    gh: ghCli,
    repo,
    owner,
    title,
    number: known,
    dryRun,
    log: (line) => console.log(line),
  });
  if (result.number != null && !dryRun) {
    const next = mergeLocalSettings(settings, { owner, number: result.number });
    writeFileSync(settingsPath, `${JSON.stringify(next, null, 2)}\n`);
    console.log(
      `.claude/settings.local.json: GH_PROJECT_OWNER=${owner}, GH_PROJECT_NUMBER=${result.number}`,
    );
  }
  if (result.problems.length) {
    result.problems.forEach((problem) =>
      console.error(`setup:board: ${problem}`),
    );
    process.exit(1);
  }
} catch (error) {
  console.error(`setup:board: ${error.message}`);
  process.exit(1);
}
