import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBareSampleRepo } from '../testing.js';
import { GitError, GitRepo } from './git.js';
import { parseMergeTree } from './merge-tree.js';
import {
  GitWriter,
  MergeConflictError,
  RefConflictError,
  WriteError,
  type FileChange,
  type MergeRequest,
} from './writer.js';

// Git runs a process per step; on a loaded machine that adds up.
vi.setConfig({ testTimeout: 30_000 });

const ACTOR = { name: 'Ada Approver', email: 'ada@example.com' };
const LINES = ['one', 'two', 'three', 'four', 'five'];
const cleanups: (() => void)[] = [];
afterAll(() => cleanups.forEach((c) => c()));

function bare() {
  const repo = createBareSampleRepo();
  cleanups.push(() => rmSync(repo.dir, { recursive: true, force: true }));
  return repo;
}

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
}

const text = (lines: readonly string[]) => `${lines.join('\n')}\n`;

/**
 * A bare sample with a five-line module on `main` (`base`), and a writer;
 * `commitOn` adds a commit to a branch (created at `base` when missing).
 */
async function fixture() {
  const { dir } = bare();
  const writer = new GitWriter(dir);
  const main = git(dir, 'rev-parse', 'refs/heads/main');
  const { commit: base } = await writer.commit({
    branch: 'main',
    parent: main,
    changes: [{ path: 'modules/en/lines.adoc', content: text(LINES) }],
    message: 'Lines',
    author: ACTOR,
  });
  const commitOn = async (branch: string, changes: FileChange[]) => {
    let parent: string;
    try {
      parent = git(dir, 'rev-parse', '--verify', '-q', `refs/heads/${branch}`);
    } catch {
      await writer.createBranch(branch, base);
      parent = base;
    }
    const { commit } = await writer.commit({
      branch,
      parent,
      changes,
      message: `Edit ${branch}`,
      author: ACTOR,
    });
    return commit;
  };
  const merge = (more: Partial<MergeRequest> & { source: string }) =>
    writer.merge({
      branch: 'main',
      expected: git(dir, 'rev-parse', 'refs/heads/main'),
      message: 'Merge change set',
      author: ACTOR,
      ...more,
    });
  const file = (commit: string, path: string) =>
    git(dir, 'cat-file', 'blob', `${commit}:${path}`);
  const refs = () =>
    git(dir, 'for-each-ref', '--format=%(refname) %(objectname)');
  return { dir, writer, base, commitOn, merge, file, refs };
}

describe('mergedFiles', () => {
  it('reads what a clean line-by-line merge holds, moving no ref', async () => {
    const f = await fixture();
    const main = git(f.dir, 'rev-parse', 'refs/heads/main');
    const ours = await f.commitOn('main', [
      {
        path: 'modules/en/lines.adoc',
        content: text(['ONE', ...LINES.slice(1)]),
      },
    ]);
    const theirs = await f.commitOn('change-sets/a', [
      {
        path: 'modules/en/lines.adoc',
        content: text([...LINES.slice(0, 4), 'FIVE']),
      },
      { path: 'terms/new.yaml', content: 'x\n' },
    ]);
    const refs = f.refs();
    const files = await f.writer.mergedFiles(ours, theirs, [
      'modules/en/lines.adoc',
      'terms/new.yaml',
      'modules/en/none.adoc',
    ]);
    expect(files).toEqual(
      new Map([
        [
          'modules/en/lines.adoc',
          Buffer.from(text(['ONE', ...LINES.slice(1, 4), 'FIVE'])),
        ],
        ['terms/new.yaml', Buffer.from('x\n')],
        ['modules/en/none.adoc', null],
      ]),
    );
    expect(f.refs()).toBe(refs);
    expect(main).not.toBe(ours);
  });

  it('answers a conflict, and takes no path a commit may not write', async () => {
    const f = await fixture();
    const ours = await f.commitOn('main', [
      { path: 'modules/en/lines.adoc', content: 'ours\n' },
    ]);
    const theirs = await f.commitOn('change-sets/a', [
      { path: 'modules/en/lines.adoc', content: 'theirs\n' },
    ]);
    expect(
      await f.writer.mergedFiles(ours, theirs, ['modules/en/lines.adoc']),
    ).toBe('conflicts');
    await expect(
      f.writer.mergedFiles(ours, theirs, ['../outside']),
    ).rejects.toThrow(WriteError);
  });
});

describe('applyChange', () => {
  /**
   * A line (`maintenance/x`) from `base` with a commit of its own, a
   * change on top of it (`from` → `to`), and `main` moved on meanwhile.
   */
  async function carried(mainChanges: FileChange[]) {
    const f = await fixture();
    const from = await f.commitOn('maintenance/x', [
      {
        path: 'modules/en/lines.adoc',
        content: text(['one', 'two', 'THREE', 'four', 'five']),
      },
      { path: 'modules/en/gone.adoc', content: 'gone\n' },
    ]);
    const to = await f.commitOn('maintenance/x', [
      {
        path: 'modules/en/lines.adoc',
        content: text(['one', 'two', 'THREE', 'four', 'FIVE']),
      },
      { path: 'terms/new.yaml', content: 'x\n' },
    ]);
    const onto = await f.commitOn('main', mainChanges);
    return { ...f, from, to, onto };
  }

  it('applies only the change from → to onto another branch, moving no ref', async () => {
    const f = await carried([
      {
        path: 'modules/en/lines.adoc',
        content: text(['ONE', 'two', 'three', 'four', 'five']),
      },
    ]);
    const refs = f.refs();
    const result = await f.writer.applyChange({
      from: f.from,
      to: f.to,
      onto: f.onto,
      paths: ['modules/en/lines.adoc', 'terms/new.yaml'],
    });
    expect(result.conflicts).toEqual([]);
    // The line's own earlier commit (THREE) is not carried, only the change.
    expect(result.files).toEqual(
      new Map([
        [
          'modules/en/lines.adoc',
          Buffer.from(text(['ONE', 'two', 'three', 'four', 'FIVE'])),
        ],
        ['terms/new.yaml', Buffer.from('x\n')],
      ]),
    );
    expect(f.refs()).toBe(refs);
  });

  it('carries a deletion, and leaves out what is the same on the target already', async () => {
    const f = await fixture();
    const from = await f.commitOn('maintenance/x', [
      { path: 'terms/old.yaml', content: 'old\n' },
      { path: 'terms/same.yaml', content: 'a\n' },
    ]);
    const to = await f.commitOn('maintenance/x', [
      { path: 'terms/old.yaml', delete: true },
      { path: 'terms/same.yaml', content: 'b\n' },
    ]);
    const onto = await f.commitOn('main', [
      { path: 'terms/old.yaml', content: 'old\n' },
      { path: 'terms/same.yaml', content: 'b\n' },
    ]);
    const result = await f.writer.applyChange({
      from,
      to,
      onto,
      paths: ['terms/old.yaml', 'terms/same.yaml'],
    });
    expect(result).toEqual({
      files: new Map([['terms/old.yaml', null]]),
      conflicts: [],
    });
  });

  it('lists conflicts, never resolved, and applies what is clean', async () => {
    const f = await carried([
      {
        path: 'modules/en/lines.adoc',
        content: text(['one', 'two', 'three', 'four', 'V']),
      },
    ]);
    const result = await f.writer.applyChange({
      from: f.from,
      to: f.to,
      onto: f.onto,
      paths: ['modules/en/lines.adoc', 'terms/new.yaml'],
    });
    expect(result.conflicts).toEqual([
      { path: 'modules/en/lines.adoc', kinds: ['contents'] },
    ]);
    expect(result.files).toEqual(
      new Map([['terms/new.yaml', Buffer.from('x\n')]]),
    );
  });

  it('refuses a path a commit may not write and an ID that is no commit', async () => {
    const f = await carried([{ path: 'terms/other.yaml', content: 'o\n' }]);
    await expect(
      f.writer.applyChange({
        from: f.from,
        to: f.to,
        onto: f.onto,
        paths: ['../outside'],
      }),
    ).rejects.toThrow(WriteError);
    await expect(
      f.writer.applyChange({
        from: 'main',
        to: f.to,
        onto: f.onto,
        paths: [],
      }),
    ).rejects.toThrow(WriteError);
  });
});

describe('merge', () => {
  it('fast-forwards when the branch head is an ancestor of the source', async () => {
    const f = await fixture();
    const source = await f.commitOn('change-sets/a', [
      { path: 'modules/en/new.adoc', content: 'new\n' },
    ]);
    expect(await f.merge({ source })).toEqual({
      kind: 'fast-forward',
      commit: source,
    });
    expect(git(f.dir, 'rev-parse', 'refs/heads/main')).toBe(source);
  });

  it('makes a merge commit with both parents and the trailers when fast-forward is off', async () => {
    const f = await fixture();
    const source = await f.commitOn('change-sets/a', [
      { path: 'modules/en/new.adoc', content: 'new\n' },
    ]);
    const result = await f.merge({
      source,
      fastForward: 'never',
      trailers: [
        { key: 'Change-set', value: 'a' },
        { key: 'Approved-by', value: 'user/reviewer' },
      ],
      date: new Date('2026-01-02T03:04:05Z'),
    });
    if (result.kind !== 'merge') throw new Error(result.kind);
    expect(git(f.dir, 'rev-parse', 'refs/heads/main')).toBe(result.commit);
    expect(git(f.dir, 'log', '-1', '--format=%P', result.commit)).toBe(
      `${f.base} ${source}`,
    );
    expect(result.tree).toBe(git(f.dir, 'rev-parse', `${source}^{tree}`));
    expect(git(f.dir, 'log', '-1', '--format=%B', result.commit)).toBe(
      'Merge change set\n\nChange-set: a\nApproved-by: user/reviewer',
    );
    expect(
      git(f.dir, 'log', '-1', '--format=%an <%ae> %at', result.commit),
    ).toBe(
      `Ada Approver <ada@example.com> ${Date.parse('2026-01-02T03:04:05Z') / 1000}`,
    );
  });

  it('merges diverged histories three-way, changes in the same file included', async () => {
    const f = await fixture();
    const source = await f.commitOn('change-sets/a', [
      {
        path: 'modules/en/lines.adoc',
        content: text(['ONE', ...LINES.slice(1)]),
      },
      { path: 'modules/en/new.adoc', content: 'new\n' },
    ]);
    const other = await f.commitOn('main', [
      {
        path: 'modules/en/lines.adoc',
        content: text([...LINES.slice(0, 4), 'FIVE']),
      },
      { path: 'modules/en/internals.adoc', delete: true },
    ]);
    const result = await f.merge({ source });
    if (result.kind !== 'merge') throw new Error(result.kind);
    expect(git(f.dir, 'log', '-1', '--format=%P', result.commit)).toBe(
      `${other} ${source}`,
    );
    expect(f.file(result.commit, 'modules/en/lines.adoc')).toBe(
      ['ONE', 'two', 'three', 'four', 'FIVE'].join('\n'),
    );
    expect(f.file(result.commit, 'modules/en/new.adoc')).toBe('new');
    expect(() =>
      git(
        f.dir,
        'cat-file',
        '-e',
        `${result.commit}:modules/en/internals.adoc`,
      ),
    ).toThrow();
    expect(git(f.dir, 'rev-parse', 'refs/heads/main')).toBe(result.commit);
    // Only git's own checks: a merge commit fsck accepts.
    git(f.dir, 'fsck', '--no-dangling', '--strict');
  });

  it('reports conflicts per path, typed, and writes nothing to any ref', async () => {
    const f = await fixture();
    const source = await f.commitOn('change-sets/a', [
      { path: 'modules/en/lines.adoc', content: text(['ours', ...LINES]) },
      { path: 'modules/en/charging.adoc', content: 'changed here\n' },
      { path: 'manuals/new.yaml', content: 'a: 1\n' },
    ]);
    await f.commitOn('main', [
      { path: 'modules/en/lines.adoc', content: text(['theirs', ...LINES]) },
      { path: 'modules/en/charging.adoc', delete: true },
      { path: 'manuals/new.yaml', content: 'a: 2\n' },
    ]);
    const before = f.refs();
    const error = await f.merge({ source }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MergeConflictError);
    const conflict = error as MergeConflictError;
    expect(conflict.source).toBe(source);
    expect(conflict.ref).toBe('refs/heads/main');
    expect(
      [...conflict.conflicts].sort((a, b) => a.path.localeCompare(b.path)),
    ).toEqual([
      { path: 'manuals/new.yaml', kinds: ['contents'] },
      { path: 'modules/en/charging.adoc', kinds: ['modify/delete'] },
      { path: 'modules/en/lines.adoc', kinds: ['contents'] },
    ]);
    expect(f.refs()).toBe(before);
    // Fast-forward off makes no difference to a conflict.
    await expect(f.merge({ source, fastForward: 'never' })).rejects.toThrow(
      MergeConflictError,
    );
    expect(f.refs()).toBe(before);
  });

  it('never conflicts on a content-addressed asset added on both sides', async () => {
    const f = await fixture();
    const asset = Buffer.from('the same image on both sides');
    const path = `assets/${createHash('sha256').update(asset).digest('hex')}`;
    const source = await f.commitOn('change-sets/a', [
      { path, content: asset },
      { path: 'modules/en/a.adoc', content: 'a\n' },
    ]);
    await f.commitOn('main', [
      { path, content: asset },
      { path: 'modules/en/b.adoc', content: 'b\n' },
    ]);
    const result = await f.merge({ source });
    expect(result.kind).toBe('merge');
  });

  it('does not let a .gitattributes in the content resolve a conflict', async () => {
    const f = await fixture();
    // Content pushed from outside the API, with a merge driver that would
    // combine both sides silently.
    const work = mkdtempSync(join(tmpdir(), 'openfolia-work-'));
    cleanups.push(() => rmSync(work, { recursive: true, force: true }));
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: 'T',
      GIT_AUTHOR_EMAIL: 't@example.com',
      GIT_COMMITTER_NAME: 'T',
      GIT_COMMITTER_EMAIL: 't@example.com',
    };
    const w = (...args: string[]) =>
      execFileSync('git', ['-C', work, ...args], { env, encoding: 'utf8' });
    execFileSync('git', ['clone', '-q', f.dir, work], { env });
    writeFileSync(join(work, '.gitattributes'), '* merge=union\n');
    w('add', '.gitattributes');
    w('commit', '-q', '-m', 'attributes');
    w('push', '-q', 'origin', 'HEAD:refs/heads/main');
    const head = git(f.dir, 'rev-parse', 'refs/heads/main');
    await f.writer.createBranch('change-sets/a', head);
    const source = (
      await f.writer.commit({
        branch: 'change-sets/a',
        parent: head,
        changes: [
          { path: 'modules/en/lines.adoc', content: text(['ours', ...LINES]) },
        ],
        message: 'ours',
        author: ACTOR,
      })
    ).commit;
    await f.writer.commit({
      branch: 'main',
      parent: head,
      changes: [
        { path: 'modules/en/lines.adoc', content: text(['theirs', ...LINES]) },
      ],
      message: 'theirs',
      author: ACTOR,
    });
    await expect(f.merge({ source })).rejects.toThrow(MergeConflictError);
  });

  it('lists the history since a merged commit: the merge and what came after, back to where they met', async () => {
    const f = await fixture();
    const source = await f.commitOn('change-sets/a', [
      { path: 'modules/en/new.adoc', content: 'new\n' },
    ]);
    const before = await f.commitOn('main', [
      { path: 'modules/en/other.adoc', content: 'other\n' },
    ]);
    const merged = await f.merge({ source, fastForward: 'never' });
    if (merged.kind !== 'merge') throw new Error(merged.kind);
    let tip = merged.commit;
    for (let i = 0; i < 3; i++) {
      tip = await f.commitOn('main', [
        { path: 'modules/en/later.adoc', content: `${i}\n` },
      ]);
    }
    const repo = new GitRepo(f.dir);
    const since = await repo.history(tip, 1000, { excluding: source });
    // Three after it, the merge, and `main`'s own commit before it; the
    // base both share (and all before it) is left out.
    expect(since.map((e) => e.commit).slice(3)).toEqual([
      merged.commit,
      before,
    ]);
    expect(since).toHaveLength(5);
    await expect(repo.history(tip, 1, { excluding: 'main' })).rejects.toThrow(
      'not a commit ID',
    );
    repo.close();
  });

  it('is up to date, writing nothing, when the source is already merged', async () => {
    const f = await fixture();
    const before = f.refs();
    const main = git(f.dir, 'rev-parse', 'refs/heads/main');
    for (const source of [main, f.base]) {
      for (const fastForward of ['allow', 'never'] as const) {
        expect(await f.merge({ source, fastForward })).toEqual({
          kind: 'up-to-date',
          commit: main,
        });
      }
    }
    expect(f.refs()).toBe(before);
  });

  it('refuses a stale expected head with a typed conflict and leaves the branch alone', async () => {
    const f = await fixture();
    const source = await f.commitOn('change-sets/a', [
      { path: 'modules/en/new.adoc', content: 'new\n' },
    ]);
    const moved = await f.commitOn('main', [
      { path: 'modules/en/other.adoc', content: 'other\n' },
    ]);
    const error = await f
      .merge({ source, expected: f.base })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RefConflictError);
    expect(error).toMatchObject({ expected: f.base, actual: moved });
    expect(git(f.dir, 'rev-parse', 'refs/heads/main')).toBe(moved);
    // Even when the source is already in the stale head's history.
    await expect(f.merge({ source: f.base, expected: f.base })).rejects.toThrow(
      RefConflictError,
    );
  });

  it('lets exactly one of N racing merges into the same branch win; the rest retry on top', async () => {
    const f = await fixture();
    // Three racers are a race (one wins, two retry); each racer is a dozen writer steps, which on
    // a loaded machine took five of them past the test's 30 s (#615).
    const sources: string[] = [];
    for (let i = 0; i < 3; i++) {
      sources.push(
        await f.commitOn(`change-sets/${i}`, [
          { path: `modules/en/new-${i}.adoc`, content: `${i}\n` },
        ]),
      );
    }
    // Diverge main, so every merge is a real merge commit.
    await f.commitOn('main', [
      { path: 'modules/en/main.adoc', content: 'main\n' },
    ]);
    const expected = git(f.dir, 'rev-parse', 'refs/heads/main');
    const results = await Promise.allSettled(
      sources.map((source) => f.merge({ source, expected })),
    );
    const won = results.filter((r) => r.status === 'fulfilled');
    const lost = results.filter((r) => r.status === 'rejected');
    expect(won).toHaveLength(1);
    for (const r of lost) expect(r.reason).toBeInstanceOf(RefConflictError);
    const winner = (won[0] as PromiseFulfilledResult<{ commit: string }>).value
      .commit;
    expect(git(f.dir, 'rev-parse', 'refs/heads/main')).toBe(winner);

    // Each loser retries on the new head; in the end every change is in.
    for (const [i, r] of results.entries()) {
      if (r.status === 'fulfilled') continue;
      await f.merge({ source: sources[i] as string });
    }
    const head = git(f.dir, 'rev-parse', 'refs/heads/main');
    for (let i = 0; i < 3; i++) {
      expect(f.file(head, `modules/en/new-${i}.adoc`)).toBe(String(i));
    }
    expect(f.file(head, 'modules/en/main.adoc')).toBe('main');
  });

  it('refuses unrelated histories, missing commits and bad requests before writing', async () => {
    const f = await fixture();
    const orphan = await f.writer.commit({
      branch: 'orphan',
      parent: null,
      changes: [{ path: 'openfolia.yaml', content: 'x: 1\n' }],
      message: 'Orphan',
      author: ACTOR,
    });
    const before = f.refs();
    const code = (p: Promise<unknown>) =>
      p.then(
        () => 'ok',
        (e: unknown) => (e instanceof WriteError ? e.code : String(e)),
      );
    expect(await code(f.merge({ source: orphan.commit }))).toBe(
      'unrelated-histories',
    );
    expect(await code(f.merge({ source: '0'.repeat(40) }))).toBe(
      'invalid-commit',
    );
    expect(await code(f.merge({ source: 'main' }))).toBe('invalid-commit');
    const tag = git(f.dir, 'rev-parse', 'refs/tags/v1');
    expect(await code(f.merge({ source: tag }))).toBe('invalid-commit');
    expect(
      await code(f.merge({ source: f.base, branch: 'refs/heads/main' })),
    ).toBe('invalid-ref');
    expect(
      await code(
        f.merge({
          source: f.base,
          fastForward: 'sometimes' as unknown as 'never',
        }),
      ),
    ).toBe('invalid-merge');
    expect(
      await code(
        f.merge({ source: f.base, message: 'Merge\n\nApproved-by: forged' }),
      ),
    ).toBe('invalid-message');
    expect(f.refs()).toBe(before);
  });

  it('fails clearly on a git without merge-tree --write-tree', async () => {
    const f = await fixture();
    const bin = mkdtempSync(join(tmpdir(), 'openfolia-old-git-'));
    cleanups.push(() => rmSync(bin, { recursive: true, force: true }));
    const script = join(bin, 'git');
    writeFileSync(
      script,
      [
        '#!/bin/sh',
        'for a in "$@"; do',
        '  if [ "$a" = version ]; then echo "git version 2.39.5"; exit 0; fi',
        'done',
        'exec git "$@"',
        '',
      ].join('\n'),
    );
    chmodSync(script, 0o755);
    const old = new GitWriter(f.dir, { gitBinary: script });
    const source = await f.commitOn('change-sets/a', [
      { path: 'modules/en/new.adoc', content: 'new\n' },
    ]);
    const error = await old
      .merge({
        branch: 'main',
        expected: f.base,
        source,
        message: 'Merge',
        author: ACTOR,
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitError);
    expect((error as Error).message).toMatch(/need git 2\.40 or later/);
  });
});

describe('merge into a change-set branch, keeping resolved files', () => {
  /** `main` and a change-set branch that changed the same files differently. */
  async function diverged() {
    const f = await fixture();
    const branch = 'change-sets/a';
    const ours = await f.commitOn(branch, [
      { path: 'modules/en/lines.adoc', content: text(['ours', ...LINES]) },
      { path: 'modules/en/charging.adoc', content: 'changed here\n' },
    ]);
    const theirs = await f.commitOn('main', [
      { path: 'modules/en/lines.adoc', content: text(['theirs', ...LINES]) },
      { path: 'modules/en/charging.adoc', delete: true },
      { path: 'terms/new.yaml', content: 'x\n' },
    ]);
    const into = (more: Partial<MergeRequest> = {}) =>
      f.writer.merge({
        branch,
        expected: ours,
        source: theirs,
        message: 'Update from main',
        author: ACTOR,
        ...more,
      });
    return { ...f, branch, ours, theirs, into };
  }

  it('keeps the branch’s file where every conflict is kept, merging the rest', async () => {
    const f = await diverged();
    const result = await f.into({
      keep: ['modules/en/lines.adoc', 'modules/en/charging.adoc'],
    });
    expect(result.kind).toBe('merge');
    const commit = (result as { commit: string }).commit;
    expect(git(f.dir, 'rev-parse', `refs/heads/${f.branch}`)).toBe(commit);
    expect(git(f.dir, 'log', '-1', '--format=%P', commit)).toBe(
      `${f.ours} ${f.theirs}`,
    );
    expect(f.file(commit, 'modules/en/lines.adoc')).toBe(
      text(['ours', ...LINES]).trim(),
    );
    expect(f.file(commit, 'modules/en/charging.adoc')).toBe('changed here');
    expect(f.file(commit, 'terms/new.yaml')).toBe('x');
    git(f.dir, 'fsck', '--no-dangling', '--strict');
  });

  it('keeps a file at its own path when the other side moved it', async () => {
    const f = await fixture();
    const ours = await f.commitOn('change-sets/c', [
      { path: 'modules/en/lines.adoc', content: text([...LINES, 'ours']) },
      { path: 'terms/a.yaml', content: 'ours\n' },
    ]);
    // Moved, nearly unchanged: git would see a rename.
    const theirs = await f.commitOn('main', [
      { path: 'modules/en/lines.adoc', delete: true },
      { path: 'modules/en/moved.adoc', content: text(['theirs', ...LINES]) },
      { path: 'terms/a.yaml', content: 'theirs\n' },
    ]);
    const request = {
      branch: 'change-sets/c',
      expected: ours,
      source: theirs,
      message: 'Update from main',
      author: ACTOR,
    };
    const result = await f.writer.merge({
      ...request,
      keep: ['terms/a.yaml', 'modules/en/lines.adoc'],
    });
    const commit = (result as { commit: string }).commit;
    // Its own edit stays where it made it; the moved file is the base's.
    expect(f.file(commit, 'modules/en/lines.adoc')).toBe(
      text([...LINES, 'ours']).trim(),
    );
    expect(f.file(commit, 'modules/en/moved.adoc')).toBe(
      text(['theirs', ...LINES]).trim(),
    );
    expect(f.file(commit, 'terms/a.yaml')).toBe('ours');
  });

  it('keeps a deletion on the branch’s side', async () => {
    const f = await fixture();
    const ours = await f.commitOn('change-sets/b', [
      { path: 'modules/en/lines.adoc', delete: true },
    ]);
    const theirs = await f.commitOn('main', [
      { path: 'modules/en/lines.adoc', content: text(['theirs', ...LINES]) },
    ]);
    const result = await f.writer.merge({
      branch: 'change-sets/b',
      expected: ours,
      source: theirs,
      message: 'Update from main',
      author: ACTOR,
      keep: ['modules/en/lines.adoc'],
    });
    const commit = (result as { commit: string }).commit;
    expect(() =>
      git(f.dir, 'cat-file', '-e', `${commit}:modules/en/lines.adoc`),
    ).toThrow();
  });

  it('resolves nothing while one conflict is not kept, and writes nothing', async () => {
    const f = await diverged();
    const before = f.refs();
    const error = await f
      .into({ keep: ['modules/en/lines.adoc'] })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MergeConflictError);
    expect((error as MergeConflictError).conflicts).toEqual([
      { path: 'modules/en/charging.adoc', kinds: ['modify/delete'] },
    ]);
    expect(f.refs()).toBe(before);
  });

  it('previews what a merge would do, moving no ref', async () => {
    const f = await diverged();
    const before = f.refs();
    const conflicts = await f.writer.previewMerge(f.ours, f.theirs);
    expect(conflicts.kind).toBe('conflicts');
    expect(
      (conflicts as { conflicts: { path: string }[] }).conflicts
        .map((c) => c.path)
        .sort(),
    ).toEqual(['modules/en/charging.adoc', 'modules/en/lines.adoc']);
    const kept = await f.writer.previewMerge(f.ours, f.theirs, [
      'modules/en/lines.adoc',
      'modules/en/charging.adoc',
    ]);
    expect(kept).toEqual({
      kind: 'merge',
      changed: [{ path: 'terms/new.yaml', deleted: false }],
    });
    expect(await f.writer.previewMerge(f.theirs, f.base)).toEqual({
      kind: 'up-to-date',
    });
    expect(await f.writer.previewMerge(f.base, f.theirs)).toEqual({
      kind: 'fast-forward',
      changed: [
        { path: 'modules/en/charging.adoc', deleted: true },
        { path: 'modules/en/lines.adoc', deleted: false },
        { path: 'terms/new.yaml', deleted: false },
      ],
    });
    expect(f.refs()).toBe(before);
  });

  it('refuses a path no commit may write in keep', async () => {
    const f = await diverged();
    await expect(f.into({ keep: ['../x'] })).rejects.toThrow(WriteError);
    await expect(
      f.writer.previewMerge(f.ours, f.theirs, ['.git/config']),
    ).rejects.toThrow(WriteError);
  });
});

describe('parseMergeTree', () => {
  const tree = 'a'.repeat(40);

  it('reads a clean merge and conflicts with their types', () => {
    expect(parseMergeTree(`${tree}\0`, false)).toEqual({
      tree,
      conflicts: [],
    });
    const out = [
      tree,
      'a.adoc',
      'b.adoc',
      '',
      '1',
      'a.adoc',
      'Auto-merging',
      'Auto-merging a.adoc\n',
      '1',
      'a.adoc',
      'CONFLICT (contents)',
      'CONFLICT (content): Merge conflict in a.adoc\n',
      '2',
      'b.adoc',
      'c.adoc',
      'CONFLICT (rename/delete)',
      'text\n',
      '',
    ].join('\0');
    expect(parseMergeTree(out, true)).toEqual({
      tree,
      conflicts: [
        { path: 'a.adoc', kinds: ['contents'] },
        { path: 'b.adoc', kinds: ['rename/delete'] },
      ],
    });
  });

  it('refuses output it cannot read rather than guessing', () => {
    expect(() => parseMergeTree('nonsense\0', false)).toThrow(
      'unexpected git merge-tree output',
    );
    expect(() => parseMergeTree(`${tree}\0\0`, true)).toThrow('no path');
  });
});

describe('createTag', () => {
  it('creates an annotated tag on the exact commit, with tagger and metadata', async () => {
    const { dir, commits } = bare();
    const writer = new GitWriter(dir);
    const result = await writer.createTag({
      name: 'release/x-200/1.2.0',
      commit: commits.main,
      message: 'Release 1.2.0\n\nWhat changed.',
      tagger: { name: ' Ada Publisher. ', email: 'ada@example.com' },
      trailers: [
        { key: 'Product', value: 'x-200' },
        { key: 'Revision', value: '1.2.0' },
      ],
      date: new Date('2026-03-04T05:06:07Z'),
    });
    expect(result).toEqual({
      ref: 'refs/tags/release/x-200/1.2.0',
      tag: git(dir, 'rev-parse', 'refs/tags/release/x-200/1.2.0'),
      commit: commits.main,
      tagger: { name: 'Ada Publisher', email: 'ada@example.com' },
    });
    expect(git(dir, 'cat-file', '-t', result.tag)).toBe('tag');
    expect(git(dir, 'cat-file', 'tag', result.tag)).toBe(
      [
        `object ${commits.main}`,
        'type commit',
        'tag release/x-200/1.2.0',
        `tagger Ada Publisher <ada@example.com> ${Date.parse('2026-03-04T05:06:07Z') / 1000} +0000`,
        '',
        'Release 1.2.0',
        '',
        'What changed.',
        '',
        'Product: x-200',
        'Revision: 1.2.0',
      ].join('\n'),
    );
    git(dir, 'fsck', '--no-dangling', '--strict');
    const repo = new GitRepo(dir);
    expect(await repo.tag('release/x-200/1.2.0')).toEqual({
      name: 'release/x-200/1.2.0',
      tag: result.tag,
      commit: commits.main,
      taggedAt: new Date('2026-03-04T05:06:07Z'),
      message: 'Release 1.2.0\n\nWhat changed.',
      trailers: [
        { key: 'Product', value: 'x-200' },
        { key: 'Revision', value: '1.2.0' },
      ],
    });
    // Only an annotated tag of exactly that name.
    expect(await repo.tag('release/x-200')).toBeUndefined();
    expect(await repo.tag('release/x-200/1.2.0/more')).toBeUndefined();
    expect(await repo.tag('main')).toBeUndefined();
    expect(await repo.tag('../v1')).toBeUndefined();
    git(dir, 'tag', 'light', commits.main);
    expect(await repo.tag('light')).toBeUndefined();
    // One without trailers keeps its whole message.
    expect(await repo.tag('v1')).toMatchObject({
      name: 'v1',
      commit: commits.v1,
      message: 'release 1',
      trailers: [],
    });
  });

  it('never moves an existing tag', async () => {
    const { dir, commits } = bare();
    const writer = new GitWriter(dir);
    const tag = (commit: string) =>
      writer.createTag({
        name: 'release/x/1',
        commit,
        message: 'Release',
        tagger: ACTOR,
      });
    const first = await tag(commits.main);
    for (const commit of [commits.v1, commits.main]) {
      const error = await tag(commit).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(RefConflictError);
      expect(error).toMatchObject({ actual: first.tag });
    }
    expect(git(dir, 'rev-parse', 'refs/tags/release/x/1')).toBe(first.tag);
    // The sample's own tag, too.
    const v1 = git(dir, 'rev-parse', 'refs/tags/v1');
    await expect(
      writer.createTag({
        name: 'v1',
        commit: commits.main,
        message: 'Again',
        tagger: ACTOR,
      }),
    ).rejects.toThrow(RefConflictError);
    expect(git(dir, 'rev-parse', 'refs/tags/v1')).toBe(v1);
  });

  it('lets exactly one of N racing creates of a tag win', async () => {
    const { dir, commits } = bare();
    const writer = new GitWriter(dir);
    const results = await Promise.allSettled(
      [commits.v1, commits.main, commits.draft, commits.main].map((commit) =>
        writer.createTag({
          name: 'release/race/1',
          commit,
          message: 'Release',
          tagger: ACTOR,
        }),
      ),
    );
    const won = results.filter((r) => r.status === 'fulfilled');
    expect(won).toHaveLength(1);
    for (const r of results) {
      if (r.status === 'rejected') {
        expect(r.reason).toBeInstanceOf(RefConflictError);
      }
    }
    expect(git(dir, 'rev-parse', 'refs/tags/release/race/1')).toBe(
      (won[0] as PromiseFulfilledResult<{ tag: string }>).value.tag,
    );
  });

  it('refuses invalid names, clashing names, missing commits and forged metadata', async () => {
    const { dir, commits } = bare();
    const writer = new GitWriter(dir);
    const before = git(dir, 'for-each-ref');
    const code = (name: string, more: object = {}) =>
      writer
        .createTag({
          name,
          commit: commits.main,
          message: 'Release',
          tagger: ACTOR,
          ...more,
        })
        .then(
          () => 'ok',
          (e: unknown) => (e instanceof WriteError ? e.code : String(e)),
        );
    for (const name of [
      '',
      'a..b',
      'a b',
      'x.lock',
      'x/',
      '/x',
      'a//b',
      '-x',
      '.x',
      'a/.b',
      'a.',
      'v1@{0}',
      'a~1',
      'a^',
      'a:b',
      'a*',
      'a?',
      'a[b',
      'a\\b',
      'HEAD',
      'refs/tags/x',
      'abcdef1',
      'x'.repeat(300),
    ]) {
      expect([name, await code(name)]).toEqual([name, 'invalid-ref']);
    }
    // Clashes with an existing branch or tag, in any case or as a folder.
    for (const name of ['main', 'V1', 'Draft', 'v1/x', 'main/x']) {
      expect([name, await code(name)]).toEqual([name, 'invalid-ref']);
    }
    expect(await code('r/1', { commit: '0'.repeat(40) })).toBe(
      'invalid-commit',
    );
    expect(await code('r/1', { commit: 'main' })).toBe('invalid-commit');
    expect(
      await code('r/1', { commit: git(dir, 'rev-parse', 'refs/tags/v1') }),
    ).toBe('invalid-commit');
    expect(await code('r/1', { message: 'Release\n\nRevision: forged' })).toBe(
      'invalid-message',
    );
    expect(
      await code('r/1', { message: 'a\n-----BEGIN PGP SIGNATURE-----' }),
    ).toBe('invalid-message');
    expect(
      await code('r/1', {
        tagger: { name: 'Eve <x>', email: 'e@example.com' },
      }),
    ).toBe('invalid-identity');
    expect(git(dir, 'for-each-ref')).toBe(before);
  });
});
