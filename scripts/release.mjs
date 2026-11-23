#!/usr/bin/env node
// The release step (#421; CONTRIBUTING.md, "Releases"): on a vX.Y.Z tag, writes the release's
// notes from the merged pull requests (grouped by `.github/release.yml`) with its upgrade notes,
// creates or updates its GitHub Release, adds its entry to CHANGELOG.md and writes its data to
// changelog/<version>.json, which the docs site's /changelog is built from. The logic is in
// release-plan.mjs; this wires it to git, gh and the disk.
//
//   node scripts/release.mjs v1.2.0                    # the tag must exist
//   node scripts/release.mjs v1.2.0 --dry-run --to HEAD  # print what a tag on HEAD would get
//
// Needs `gh` signed in with access to the repository (GH_TOKEN in a workflow).
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { ghCli } from './gh-api.mjs';
import { runRelease, USAGE } from './release-plan.mjs';
import { execGit, runGit } from './run-git.mjs';

/** More merged pull requests than this and the step stops rather than miss one. */
const MAX_PULL_REQUESTS = 50000;

const git = (args) =>
  execGit(args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const gitOk = (args) => runGit(args, { stdio: 'ignore' }).status === 0;

/** `gh` with the notes in a file of their own (gh reads `--notes-file`, not stdin, for a release). */
function withNotesFile(notes, run) {
  const dir = mkdtempSync(join(tmpdir(), 'release-notes-'));
  try {
    const file = join(dir, 'notes.md');
    writeFileSync(file, notes);
    return run(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const github = {
  repo: () => JSON.parse(ghCli(['repo', 'view', '--json', 'url'])),
  // Every merged pull request, paged through GraphQL (not the search API, which stops at 1000
  // results): the release's commits then pick its own (`since` is not needed for that).
  mergedPullRequests() {
    const prs = JSON.parse(
      ghCli([
        'pr',
        'list',
        '--state',
        'merged',
        '--limit',
        String(MAX_PULL_REQUESTS),
        '--json',
        'number,title,labels,body,mergeCommit',
      ]),
    );
    if (prs.length >= MAX_PULL_REQUESTS)
      throw new Error(
        `${prs.length} merged pull requests, the most the step reads: raise MAX_PULL_REQUESTS`,
      );
    return prs.map((pr) => ({
      ...pr,
      mergeCommit: pr.mergeCommit?.oid ?? null,
    }));
  },
  hasRelease(tag) {
    try {
      ghCli(['release', 'view', tag, '--json', 'tagName']);
      return true;
    } catch (error) {
      if (/release not found|not found/i.test(String(error?.message)))
        return false;
      throw error;
    }
  },
  createRelease: (tag, notes) =>
    withNotesFile(notes, (file) =>
      ghCli([
        'release',
        'create',
        tag,
        '--verify-tag',
        '--title',
        tag,
        '--notes-file',
        file,
      ]),
    ),
  editRelease: (tag, notes) =>
    withNotesFile(notes, (file) =>
      ghCli(['release', 'edit', tag, '--notes-file', file]),
    ),
};

const files = {
  read(path) {
    try {
      return readFileSync(path, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
  },
  write(path, text) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  },
};

try {
  runRelease(process.argv.slice(2), {
    git,
    gitOk,
    github,
    files,
    log: (line) => console.log(line),
  });
} catch (error) {
  console.error(`release: ${error.message}\n\n${USAGE}`);
  process.exit(1);
}
