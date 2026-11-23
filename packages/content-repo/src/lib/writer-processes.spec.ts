import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBareSampleRepo } from '../testing.js';
import { GitWriter, type CommitRequest } from './writer.js';

// Git runs a process per step; on a loaded machine that adds up.
vi.setConfig({ testTimeout: 30_000 });

const ACTOR = { name: 'Ada Author', email: 'ada@example.com' };
const cleanups: (() => void)[] = [];
afterAll(() => cleanups.forEach((c) => c()));

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
}

function temporary(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * A writer on a new bare sample whose git is a script that logs each
 * process it starts (one line, one write, so racing processes never mix
 * lines) before running git; `started()` gives the git subcommands
 * started since it was last asked.
 */
function counted() {
  const { dir } = createBareSampleRepo();
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const bin = temporary('openfolia-count-');
  const log = join(bin, 'log');
  const gitBinary = join(bin, 'git');
  writeFileSync(log, '');
  writeFileSync(
    gitBinary,
    `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexec git "$@"\n`,
  );
  chmodSync(gitBinary, 0o755);
  const writer = new GitWriter(dir, { gitBinary });
  const started = () => {
    const lines = readFileSync(log, 'utf8').split('\n').filter(Boolean);
    writeFileSync(log, '');
    return lines.map((line) => {
      // `-C <dir>`, then `-c key=value` pairs, then the subcommand.
      const args = line.split(' ').slice(2);
      let i = 0;
      while (args[i] === '-c') i += 2;
      return args[i];
    });
  };
  const head = (branch = 'main') =>
    git(dir, 'rev-parse', `refs/heads/${branch}`);
  let edits = 0;
  const commit = (more: Partial<CommitRequest> = {}) =>
    writer.commit({
      branch: 'main',
      parent: head(more.branch),
      changes: [{ path: 'modules/en/one.adoc', content: `${++edits}\n` }],
      message: 'Edit',
      author: ACTOR,
      ...more,
    });
  return { dir, writer, started, head, commit };
}

/**
 * The git processes one operation may start, at most (#727). Before #727 a
 * commit of three files started 18 to 21, a merge 10 to 22. The bounds are
 * what it starts now: one that rises is a step that went back to a process
 * of its own.
 */
describe('git processes per operation', () => {
  it('commits three files with five processes, wherever they are', async () => {
    const r = counted();
    // The same commit as the next ones, so the counts below are a commit's.
    await r.commit();
    r.started();

    await r.commit({
      changes: [
        { path: 'modules/en/a.adoc', content: 'a\n' },
        { path: 'modules/en/b.adoc', content: 'b\n' },
        { path: 'modules/en/c.adoc', content: 'c\n' },
      ],
    });
    const oneFolder = r.started();
    await r.commit({
      changes: [
        { path: 'modules/de/a.adoc', content: 'a\n' },
        { path: 'terms/a.yaml', content: 'a\n' },
        { path: 'manuals/a.yaml', content: 'a\n' },
      ],
    });
    const threeFolders = r.started();

    for (const processes of [oneFolder, threeFolders]) {
      expect(processes.length).toBeLessThanOrEqual(5);
      // One reader for every object read, one write for every object made.
      expect(processes.filter((p) => p === 'cat-file')).toHaveLength(1);
      expect(processes.filter((p) => p === 'unpack-objects')).toHaveLength(1);
      expect(processes).not.toContain('hash-object');
      expect(processes).not.toContain('mktree');
      expect(processes).not.toContain('ls-tree');
      expect(processes).not.toContain('worktree');
    }
  });

  it('prepares and commits a tree in two steps with as few', async () => {
    const r = counted();
    await r.commit();
    r.started();
    const parent = r.head();
    const request = {
      parent,
      changes: [{ path: 'modules/en/two.adoc', content: 'two\n' }],
      message: 'Edit',
      author: ACTOR,
    };
    const { tree } = await r.writer.prepareCommit(request);
    expect(r.started().length).toBeLessThanOrEqual(3);
    await r.writer.commitPrepared({ ...request, branch: 'main', tree });
    expect(r.started().length).toBeLessThanOrEqual(5);
  });

  it('merges, fast-forwards, updates a change set and previews with few processes', async () => {
    const r = counted();
    const base = r.head();
    await r.writer.createBranch('change-sets/a', base);
    await r.commit({
      branch: 'change-sets/a',
      changes: [{ path: 'modules/en/one.adoc', content: 'change set\n' }],
    });
    await r.commit({
      changes: [{ path: 'modules/en/one.adoc', content: 'main\n' }],
    });
    // Asks for git's version, once per process.
    await r.writer.previewMerge(r.head('change-sets/a'), r.head());
    r.started();

    const preview = await r.writer.previewMerge(
      r.head('change-sets/a'),
      r.head(),
      ['modules/en/one.adoc'],
    );
    expect(preview.kind).toBe('merge');
    expect(r.started().length).toBeLessThanOrEqual(5);

    // Updating the change set from main, keeping its own file where they
    // conflict: the kept tree and the merge commit in one write.
    const update = await r.writer.merge({
      branch: 'change-sets/a',
      expected: r.head('change-sets/a'),
      source: r.head(),
      keep: ['modules/en/one.adoc'],
      message: 'Update from main',
      author: ACTOR,
    });
    expect(update.kind).toBe('merge');
    const updated = r.started();
    expect(updated.length).toBeLessThanOrEqual(8);
    expect(updated.filter((p) => p === 'unpack-objects')).toHaveLength(1);

    const merge = await r.writer.merge({
      branch: 'main',
      expected: r.head(),
      source: r.head('change-sets/a'),
      message: 'Merge change set',
      author: ACTOR,
      trailers: [{ key: 'Approved-by', value: 'user/reviewer' }],
      fastForward: 'never',
    });
    expect(merge.kind).toBe('merge');
    const merged = r.started();
    expect(merged.length).toBeLessThanOrEqual(8);
    // The refs are listed up front and again beside the write, the merge
    // bases asked once.
    expect(merged.filter((p) => p === 'for-each-ref')).toHaveLength(2);
    expect(merged.filter((p) => p === 'merge-base')).toHaveLength(1);

    await r.writer.createBranch('change-sets/b', r.head());
    await r.commit({ branch: 'change-sets/b' });
    r.started();
    const forward = await r.writer.merge({
      branch: 'main',
      expected: r.head(),
      source: r.head('change-sets/b'),
      message: 'Merge change set',
      author: ACTOR,
    });
    expect(forward.kind).toBe('fast-forward');
    expect(r.started().length).toBeLessThanOrEqual(5);
  });

  it('creates and deletes branches and tags a release with few processes', async () => {
    const r = counted();
    await r.writer.createBranch('change-sets/a', r.head());
    expect(r.started().length).toBeLessThanOrEqual(3);
    await r.writer.deleteBranch('change-sets/a', r.head());
    expect(r.started().length).toBeLessThanOrEqual(3);
    await r.writer.createTag({
      name: 'release/x/1.0',
      commit: r.head(),
      message: 'Release 1.0',
      tagger: ACTOR,
      trailers: [{ key: 'Revision', value: '1.0' }],
    });
    expect(r.started().length).toBeLessThanOrEqual(6);
  });
});

describe('objects written without a process each', () => {
  it('writes the commit git commit-tree would write, byte for byte', async () => {
    const { dir } = counted();
    const writer = new GitWriter(dir);
    const parent = git(dir, 'rev-parse', 'refs/heads/main');
    const date = new Date('2024-05-06T07:08:09Z');
    const author = { name: 'Zoë Ångström', email: 'zoe@example.com' };
    const committer = { name: 'Ada Author', email: 'ada@example.com' };
    const result = await writer.commit({
      branch: 'main',
      parent,
      changes: [{ path: 'modules/en/one.adoc', content: 'one\n' }],
      message: 'Edit one\n\nWith a body: and a colon.',
      author,
      committer,
      date,
      trailers: [
        { key: 'Change-set', value: '42' },
        { key: 'Approved-by', value: 'user/reviewer' },
      ],
    });
    const byGit = execFileSync(
      'git',
      [
        '-C',
        dir,
        'commit-tree',
        '--no-gpg-sign',
        '-p',
        parent,
        '-F',
        '-',
      ].concat(result.tree),
      {
        encoding: 'utf8',
        input:
          'Edit one\n\nWith a body: and a colon.\n\n' +
          'Change-set: 42\nApproved-by: user/reviewer\n',
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: author.name,
          GIT_AUTHOR_EMAIL: author.email,
          GIT_AUTHOR_DATE: '@1714979289 +0000',
          GIT_COMMITTER_NAME: committer.name,
          GIT_COMMITTER_EMAIL: committer.email,
          GIT_COMMITTER_DATE: '@1714979289 +0000',
        },
      },
    ).trim();
    expect(result.commit).toBe(byGit);
    git(dir, 'fsck', '--no-dangling', '--strict');
  });

  it('writes the tree git mktree would write, entries sorted as git sorts them', async () => {
    const { dir } = counted();
    const writer = new GitWriter(dir);
    const parent = git(dir, 'rev-parse', 'refs/heads/main');
    // `a.b` sorts before the folder `a` (read as `a/`), `a-` before both.
    const { tree } = await writer.prepareCommit({
      parent,
      changes: [
        { path: 'modules/a/x.adoc', content: 'x\n' },
        { path: 'modules/a.b', content: 'y\n' },
        { path: 'modules/a-', content: 'z\n' },
      ],
      message: 'Edit',
      author: ACTOR,
    });
    const modules = git(dir, 'rev-parse', `${tree}:modules`);
    const listed = execFileSync('git', ['-C', dir, 'ls-tree', '-z', modules]);
    const byGit = execFileSync('git', ['-C', dir, 'mktree', '-z'], {
      input: listed,
      encoding: 'utf8',
    }).trim();
    expect(modules).toBe(byGit);
    expect(
      git(dir, 'ls-tree', '--name-only', modules)
        .split('\n')
        .filter((n) => n.startsWith('a')),
    ).toEqual(['a-', 'a.b', 'a']);
    git(dir, 'fsck', '--no-dangling', '--strict');
  });

  it('commits, merges and keeps files in a SHA-256 repository', async (ctx) => {
    const dir = temporary('openfolia-sha256-');
    try {
      git(dir, 'init', '-q', '--bare', '--object-format=sha256', '-b', 'main');
    } catch (e) {
      // Skip only where this git has no SHA-256 support.
      const stderr = String((e as { stderr?: unknown }).stderr ?? '');
      if (!/object.format|sha256/i.test(stderr)) throw e;
      ctx.skip();
    }
    const writer = new GitWriter(dir);
    const edit = (branch: string, parent: string | null, content: string) =>
      writer.commit({
        branch,
        parent,
        changes: [
          { path: 'modules/en/deep/one.adoc', content },
          { path: 'terms/a.yaml', content: `${branch}\n` },
        ],
        message: 'Edit',
        author: ACTOR,
      });
    const base = await edit('main', null, 'base\n');
    await writer.createBranch('change-sets/a', base.commit);
    const ours = await edit('change-sets/a', base.commit, 'ours\n');
    const theirs = await edit('main', base.commit, 'theirs\n');
    const result = await writer.merge({
      branch: 'change-sets/a',
      expected: ours.commit,
      source: theirs.commit,
      keep: ['modules/en/deep/one.adoc', 'terms/a.yaml'],
      message: 'Update from main',
      author: ACTOR,
    });
    expect(result.kind).toBe('merge');
    const commit = (result as { commit: string }).commit;
    expect(commit).toMatch(/^[0-9a-f]{64}$/);
    expect(
      git(dir, 'cat-file', 'blob', `${commit}:modules/en/deep/one.adoc`),
    ).toBe('ours');
    expect(git(dir, 'rev-parse', 'refs/heads/change-sets/a')).toBe(commit);
    git(dir, 'fsck', '--no-dangling', '--strict');
  });
});

describe('checked-out branches, from the ref listing', () => {
  it('moves the branch a bare repository’s HEAD names, but none a linked worktree has', async () => {
    const r = counted();
    // HEAD of a bare repository names main: no files, no index, writable.
    await r.commit();
    const linked = temporary('openfolia-wt-');
    git(r.dir, 'worktree', 'add', '-q', join(linked, 'main'), 'main');
    git(r.dir, 'worktree', 'add', '-q', join(linked, 'draft'), 'draft');
    await expect(r.commit()).rejects.toMatchObject({ code: 'checked-out' });
    await expect(r.commit({ branch: 'draft' })).rejects.toMatchObject({
      code: 'checked-out',
    });
    git(r.dir, 'worktree', 'remove', '--force', join(linked, 'main'));
    await r.commit();
    await expect(r.commit({ branch: 'draft' })).rejects.toMatchObject({
      code: 'checked-out',
    });
  });
});
