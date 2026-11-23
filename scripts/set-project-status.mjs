#!/usr/bin/env node
// `scripts/set-project-status.sh "<Status>" <issue> [<issue> ...]` runs this: sets each issue's
// Status (GH_PROJECT_FIELD, default "Status") on the board GH_PROJECT_OWNER / GH_PROJECT_NUMBER
// name, adding it to the board first. The ids it needs are cached in the repository's git
// folder (<git common dir>/project-status-cache.json, keyed by owner and project number): one
// file for the checkout and every worktree, never committed. scripts/project-status.mjs holds
// the logic; gh waits out GitHub's secondary rate limit (scripts/gh-api.mjs).
import path from 'node:path';

import { ghCli } from './gh-api.mjs';
import { fileCache, setProjectStatus } from './project-status.mjs';
import { runGit } from './run-git.mjs';

const [status, ...issues] = process.argv.slice(2);
const owner = process.env.GH_PROJECT_OWNER;
const number = process.env.GH_PROJECT_NUMBER;
if (!owner || !number) {
  console.error(
    'set GH_PROJECT_OWNER (the org or user owning the project) and GH_PROJECT_NUMBER (the ' +
      'number in the project URL)',
  );
  process.exit(1);
}
if (
  !status ||
  issues.length === 0 ||
  issues.some((issue) => !/^\d+$/.test(issue))
) {
  console.error(
    'usage: scripts/set-project-status.sh "<Status>" <issue> [<issue> ...]',
  );
  process.exit(2);
}

const gitDir = runGit(['rev-parse', '--git-common-dir'], { encoding: 'utf8' });
if (gitDir.status !== 0) {
  console.error('set-project-status: not inside a git checkout');
  process.exit(1);
}

try {
  setProjectStatus({
    gh: ghCli,
    cache: fileCache(
      path.resolve(gitDir.stdout.trim(), 'project-status-cache.json'),
    ),
    owner,
    number,
    fieldName: process.env.GH_PROJECT_FIELD || 'Status',
    status,
    issues,
    log: (line) => console.log(line),
  });
} catch (error) {
  console.error(
    `set-project-status: ${error instanceof Error ? error.message : error}`,
  );
  process.exit(1);
}
