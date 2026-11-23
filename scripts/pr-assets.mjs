#!/usr/bin/env node
// `pnpm pr:assets <PR number> <image files…> | --dir <dir> [--dry-run]`: uploads a PR's
// screenshots to the current repository's `pr-assets` branch through GitHub's API and prints
// Markdown image links for the PR body. The rules: scripts/pr-assets-plan.mjs; this is the
// shell around them (the disk, `gh`).
import { readdirSync, readFileSync } from 'node:fs';

import { currentRepo, ghCli } from './gh-api.mjs';
import { USAGE, parseArgs, runPrAssets } from './pr-assets-plan.mjs';

try {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
  } else {
    const lines = runPrAssets(args, {
      gh: ghCli,
      readFile: (file) => readFileSync(file),
      listDir: (dir) => readdirSync(dir),
      currentRepo: () => {
        const repo = currentRepo(ghCli);
        return `${repo.owner}/${repo.name}`;
      },
    });
    console.log(lines.join('\n'));
  }
} catch (error) {
  console.error(`pr:assets: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
}
