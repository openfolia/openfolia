#!/usr/bin/env node
// The kit's smoke test (`pnpm nx run workflow:kit-smoke`, part of `nx test workflow`): installs
// the kit into an empty Nx + pnpm repository in a temporary folder (with a local bare `origin`)
// and runs its commands there as a coordinator would:
//   1. `pnpm slot create smoke`: a worktree, its install, its PORT and brief;
//   2. a commit in the slot, then `pnpm review:diff`: the diff file names it;
//   3. `pnpm merge:pr <N> --reviewed <head> --dry-run` against a stub `gh` (on PATH) that
//      answers for one open PR of that branch: every read-only check passes, the steps print;
//   4. the guard's own tests (scripts/__tests__/claude-hooks.test.ts, unchanged) on the
//      installed copy of the hooks (scripts/kit/vitest.guard.config.mts), so the kit's guard
//      allows and refuses exactly what this repository's does.
// Nothing reaches the network or GitHub. Exits non-zero at the first step that fails, with its
// output; the temporary folder is removed either way (KIT_SMOKE_KEEP=1 keeps it).
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { gitEnv } from '../run-git.mjs';
import { install } from './install.mjs';

const SOURCE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);
const IDENTITY = {
  GIT_AUTHOR_NAME: 'Kit smoke',
  GIT_AUTHOR_EMAIL: 'kit-smoke@example.invalid',
  GIT_COMMITTER_NAME: 'Kit smoke',
  GIT_COMMITTER_EMAIL: 'kit-smoke@example.invalid',
};

const top = realpathSync(mkdtempSync(path.join(tmpdir(), 'kit-smoke-')));
const origin = path.join(top, 'origin.git');
const repo = path.join(top, 'repo');
const bin = path.join(top, 'bin');
const prFile = path.join(top, 'pr.json');
// The environment every step runs in: no git variables of a hook around this run, no BASE_BRANCH,
// no global or system git config (signing, hooks), no GitHub token, repository or board, the
// stub gh first on PATH.
const env = {
  ...gitEnv(),
  ...IDENTITY,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  PATH: `${bin}${path.delimiter}${process.env.PATH}`,
  KIT_SMOKE_PR: prFile,
};
for (const name of [
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GH_REPO',
  'GH_HOST',
  'GH_PROJECT_OWNER',
  'GH_PROJECT_NUMBER',
  'NX_DAEMON',
])
  delete env[name];

/** Runs a step; on failure prints its output and throws. Returns stdout. */
function step(label, cmd, args, cwd, extraEnv = {}) {
  const out = spawnSync(cmd, args, {
    cwd,
    env: { ...env, ...extraEnv },
    encoding: 'utf8',
    timeout: 300_000,
  });
  if (out.status !== 0) {
    throw new Error(
      `kit smoke: ${label} failed (exit ${out.status ?? out.signal}):\n${out.stdout ?? ''}${out.stderr ?? ''}${out.error ? `\n${out.error.message}` : ''}`,
    );
  }
  return out.stdout;
}

const git = (cwd, ...args) => step(`git ${args[0]}`, 'git', args, cwd).trim();

/** Throws when `text` lacks `needle`. */
function expectIn(label, text, needle) {
  if (!text.includes(needle))
    throw new Error(`kit smoke: ${label}: expected "${needle}" in:\n${text}`);
}

/** The stub gh: `pr view` answers with pr.json, `api graphql` with no review threads. */
function writeStubGh() {
  mkdirSync(bin, { recursive: true });
  const file = path.join(bin, 'gh');
  writeFileSync(
    file,
    `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === 'pr' && args[1] === 'view') {
  process.stdout.write(fs.readFileSync(process.env.KIT_SMOKE_PR, 'utf8'));
} else if (args[0] === 'api' && args[1] === 'graphql') {
  process.stdout.write(JSON.stringify({ data: { viewer: { login: 'agent' }, repository: { pullRequest: { reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } } }));
} else {
  process.stderr.write('kit smoke: the stub gh has no answer for: gh ' + args.join(' ') + '\\n');
  process.exit(1);
}
`,
  );
  chmodSync(file, 0o755);
}

/** An empty Nx + pnpm repository on `main`, pushed to a local bare origin. */
function emptyRepository() {
  const packageManager = JSON.parse(
    readFileSync(path.join(SOURCE, 'package.json'), 'utf8'),
  ).packageManager;
  git(top, 'init', '-q', '--bare', '-b', 'main', origin);
  git(top, 'init', '-q', '-b', 'main', repo);
  writeFileSync(
    path.join(repo, 'package.json'),
    `${JSON.stringify({ name: 'kit-smoke', private: true, packageManager }, null, 2)}\n`,
  );
  writeFileSync(path.join(repo, 'nx.json'), '{}\n');
  writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n');
  step('pnpm install', 'pnpm', ['install'], repo);
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'an empty repository');
  git(repo, 'remote', 'add', 'origin', origin);
  git(repo, 'push', '-q', '-u', 'origin', 'main');
  git(repo, 'remote', 'set-head', 'origin', 'main');
}

try {
  writeStubGh();
  emptyRepository();

  for (const line of install(repo, SOURCE)) console.log(`kit smoke: ${line}`);
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'the agent kit');
  git(repo, 'push', '-q', 'origin', 'main');
  console.log('kit smoke: installed into an empty Nx + pnpm repository.');

  const created = step(
    'pnpm slot create',
    'pnpm',
    ['slot', 'create', 'smoke'],
    repo,
  );
  expectIn('slot create', created, '----- slot brief');
  const worktree = path.join(repo, '.claude', 'worktrees', 'smoke');
  expectIn(
    'slot create',
    readFileSync(path.join(worktree, '.env.local'), 'utf8'),
    'PORT=',
  );
  console.log('kit smoke: pnpm slot create made the slot.');

  writeFileSync(path.join(worktree, 'feature.txt'), 'a change\n');
  git(worktree, 'add', 'feature.txt');
  git(worktree, 'commit', '-q', '-m', 'a change');
  const reviewed = step('pnpm review:diff', 'pnpm', ['review:diff'], worktree);
  const patch = path.join(worktree, '.review', 'diff.patch');
  if (!existsSync(patch))
    throw new Error(`kit smoke: review:diff wrote no ${patch}:\n${reviewed}`);
  expectIn('review:diff', readFileSync(patch, 'utf8'), 'feature.txt');
  console.log('kit smoke: pnpm review:diff wrote the diff.');

  const head = git(worktree, 'rev-parse', 'HEAD');
  git(
    worktree,
    'push',
    '-q',
    'origin',
    'agent/smoke',
    'agent/smoke:refs/pull/1/head',
  );
  writeFileSync(
    prFile,
    JSON.stringify({
      number: 1,
      title: 'A change',
      body: `Closes #2\n\npnpm check ran on ${head}.`,
      state: 'OPEN',
      isDraft: false,
      mergeable: 'MERGEABLE',
      headRefOid: head,
      headRefName: 'agent/smoke',
      baseRefName: 'main',
      closingIssuesReferences: [{ number: 2 }],
      isCrossRepository: false,
      comments: [],
      reviews: [],
      url: 'https://example.invalid/pull/1',
      author: { login: 'agent' },
    }),
  );
  const dry = step(
    'pnpm merge:pr --dry-run',
    'pnpm',
    ['merge:pr', '1', '--reviewed', head, '--dry-run'],
    repo,
  );
  expectIn('merge:pr --dry-run', dry, 'passes the checks');
  expectIn('merge:pr --dry-run', dry, 'agent-slot.mjs remove smoke');
  console.log(
    'kit smoke: pnpm merge:pr --dry-run passed its checks against the stub.',
  );

  step(
    'the guard tests on the installed hooks',
    process.execPath,
    [
      path.join(SOURCE, 'node_modules', 'vitest', 'vitest.mjs'),
      'run',
      '--config',
      path.join(SOURCE, 'scripts', 'kit', 'vitest.guard.config.mts'),
    ],
    SOURCE,
    { KIT_GUARD_ROOT: repo },
  );
  console.log('kit smoke: the guard tests pass on the installed hooks.');
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  if (process.env.KIT_SMOKE_KEEP === '1') console.log(`kit smoke: kept ${top}`);
  else rmSync(top, { recursive: true, force: true });
}
