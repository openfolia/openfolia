import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { printModule, type Module } from '@openfolia/content-model';
import { createBareSampleRepo } from '../testing.js';
import { GitError, GitRepo, withoutTrailers } from './git.js';
import { ContentError, ContentRepo } from './snapshot.js';
import { GitWriter } from './writer.js';

// Git runs a process per step; on a loaded machine that adds up.
vi.setConfig({ testTimeout: 30_000 });

const ACTOR = { name: 'Ada', email: 'ada@example.com' };
const PATH = 'modules/en/storage.adoc';
const cleanups: (() => void)[] = [];
afterAll(() => cleanups.forEach((c) => c()));

const storage = (text: string): Module => ({
  schemaVersion: 1,
  id: 'storage',
  meta: {
    title: 'Storage',
    type: 'procedure',
    lang: 'en',
    audience: 'public',
    facets: {},
  },
  blocks: [
    { type: 'paragraph', id: 'intro', content: [{ type: 'text', text }] },
  ],
});

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
}

/**
 * The bare sample, then on `main`: `storage` added directly, a change of
 * another file, a change of `storage` merged from a branch (whose own
 * commit is not on `main`'s first-parent line), and `storage` deleted.
 */
async function buildFixture() {
  const { dir } = createBareSampleRepo();
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const writer = new GitWriter(dir);
  const head = () => git(dir, 'rev-parse', 'refs/heads/main');
  const { commit: added } = await writer.commit({
    branch: 'main',
    parent: head(),
    changes: [{ path: PATH, content: printModule(storage('Keep it dry.')) }],
    message: 'Add storage',
    author: ACTOR,
    trailers: [{ key: 'Actor', value: 'user/ada' }],
  });
  const { commit: other } = await writer.commit({
    branch: 'main',
    parent: added,
    changes: [{ path: 'modules/en/notes.adoc', content: 'x' }],
    message: 'Something else',
    author: ACTOR,
  });
  await writer.createBranch('side', added);
  const { commit: sideCommit } = await writer.commit({
    branch: 'side',
    parent: added,
    changes: [{ path: PATH, content: printModule(storage('Keep it cool.')) }],
    message: 'Cooler',
    author: ACTOR,
  });
  const merged = await writer.merge({
    branch: 'main',
    expected: other,
    source: sideCommit,
    message: 'Cooler storage\n\nMerge change set 1.',
    author: ACTOR,
    trailers: [
      { key: 'Merged-by', value: 'user/pat' },
      { key: 'Approved-by', value: 'user/rey' },
      { key: 'Approved-by', value: 'user/sam' },
    ],
    fastForward: 'never',
  });
  if (merged.kind !== 'merge') throw new Error('expected a merge');
  const { commit: deleted } = await writer.commit({
    branch: 'main',
    parent: merged.commit,
    changes: [{ path: PATH, delete: true }],
    message: 'Drop storage',
    author: ACTOR,
  });
  return {
    dir,
    commits: { added, other, sideCommit, merge: merged.commit, deleted },
  };
}

/**
 * The fixture, built once per file (a dozen writer steps, each several `git` processes: seconds
 * on a loaded machine, #615) and copied for each test, which may write to its copy.
 */
let built: ReturnType<typeof buildFixture> | undefined;
async function fixture(): ReturnType<typeof buildFixture> {
  built ??= buildFixture();
  const { dir: template, commits } = await built;
  const dir = mkdtempSync(join(tmpdir(), 'openfolia-history-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  cpSync(template, dir, { recursive: true });
  return { dir, commits: { ...commits } };
}

describe('GitRepo.pathHistory', () => {
  it('lists the first-parent commits that changed the file, newest first', async () => {
    const { dir, commits } = await fixture();
    const repo = new GitRepo(dir);
    const history = await repo.pathHistory(commits.deleted, PATH, 1000);
    expect(history.truncated).toBe(false);
    expect(history.versions.map((v) => v.commit)).toEqual([
      commits.deleted,
      commits.merge,
      commits.added,
    ]);
    const [deleted, merge, added] = history.versions;
    expect(deleted?.blob).toBeUndefined();
    expect(merge).toMatchObject({
      parents: 2,
      parent: commits.other,
      message: 'Cooler storage\n\nMerge change set 1.',
      trailers: [
        { key: 'Merged-by', value: 'user/pat' },
        { key: 'Approved-by', value: 'user/rey' },
        { key: 'Approved-by', value: 'user/sam' },
      ],
      blob: git(dir, 'rev-parse', `${commits.merge}:${PATH}`),
      authorEmail: 'ada@example.com',
    });
    expect(added).toMatchObject({
      parents: 1,
      message: 'Add storage',
      trailers: [{ key: 'Actor', value: 'user/ada' }],
      blob: git(dir, 'rev-parse', `${commits.added}:${PATH}`),
    });
    expect(Date.parse(added?.committedAt ?? '')).not.toBeNaN();
    repo.close();
  });

  it('cuts the walk after the newest commits, telling what came before', async () => {
    const { dir, commits } = await fixture();
    const repo = new GitRepo(dir);
    // Looks at deleted, merge and other only.
    const history = await repo.pathHistory(commits.deleted, PATH, 3);
    expect(history.truncated).toBe(true);
    expect(history.versions.map((v) => v.commit)).toEqual([
      commits.deleted,
      commits.merge,
    ]);
    expect(history.before).toBe(
      git(dir, 'rev-parse', `${commits.added}:${PATH}`),
    );
    // A file that did not exist before the window.
    const fresh = await repo.pathHistory(commits.added, PATH, 1);
    expect(fresh).toMatchObject({ truncated: true });
    expect(fresh.before).toBeUndefined();
    expect(fresh.versions).toHaveLength(1);
    repo.close();
  });

  it('lists nothing for a file the line never had, and refuses bad input', async () => {
    const { dir, commits } = await fixture();
    const repo = new GitRepo(dir);
    const none = await repo.pathHistory(
      commits.deleted,
      'modules/en/x.adoc',
      5,
    );
    expect(none.versions).toEqual([]);
    await expect(
      repo.pathHistory(commits.deleted, '../x', 5),
    ).rejects.toBeInstanceOf(GitError);
    await expect(repo.pathHistory('main', PATH, 5)).rejects.toBeInstanceOf(
      GitError,
    );
    await expect(
      repo.pathHistory(commits.deleted, PATH, 0),
    ).rejects.toBeInstanceOf(GitError);
    // A pathspec is read literally: no glob reaches other files.
    const glob = await repo.pathHistory(commits.deleted, 'modules/en', 5);
    expect(glob.versions).toEqual([]);
    repo.close();
  });
});

describe('GitRepo.pathHistory and merges', () => {
  it('leaves out a merge that brought no change of the file in', async () => {
    const { dir, commits } = await fixture();
    const writer = new GitWriter(dir);
    await writer.createBranch('other', commits.deleted);
    const { commit: elsewhere } = await writer.commit({
      branch: 'other',
      parent: commits.deleted,
      changes: [{ path: 'modules/en/notes.adoc', content: 'y' }],
      message: 'Notes',
      author: ACTOR,
    });
    const merged = await writer.merge({
      branch: 'main',
      expected: commits.deleted,
      source: elsewhere,
      message: 'Merge notes',
      author: ACTOR,
      fastForward: 'never',
    });
    if (merged.kind !== 'merge') throw new Error('expected a merge');
    const repo = new GitRepo(dir);
    const history = await repo.pathHistory(merged.commit, PATH, 1000);
    expect(history.versions.map((v) => v.commit)).toEqual([
      commits.deleted,
      commits.merge,
      commits.added,
    ]);
    repo.close();
  });
});

describe('GitRepo.deletedFiles', () => {
  it('lists the files deleted on the first-parent line, with their last blob', async () => {
    const { dir, commits } = await fixture();
    const repo = new GitRepo(dir);
    const found = await repo.deletedFiles(commits.deleted, 'modules', 1000);
    expect(found.truncated).toBe(false);
    expect(found.files).toEqual([
      {
        path: PATH,
        blob: git(dir, 'rev-parse', `${commits.merge}:${PATH}`),
        commit: commits.deleted,
        committedAt: expect.any(String),
      },
    ]);
    // ISO 8601 with the offset, nothing after it.
    expect(found.files[0]?.committedAt).toMatch(
      /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(Z|[+-]\d\d:\d\d)$/,
    );
    // Before the deletion, nothing is deleted.
    const before = await repo.deletedFiles(commits.merge, 'modules', 1000);
    expect(before.files).toEqual([]);
    repo.close();
  });

  it('leaves out a file there again, and one deleted before the window', async () => {
    const { dir, commits } = await fixture();
    const writer = new GitWriter(dir);
    const { commit: back } = await writer.commit({
      branch: 'main',
      parent: commits.deleted,
      changes: [{ path: PATH, content: printModule(storage('Back.')) }],
      message: 'Storage again',
      author: ACTOR,
    });
    const repo = new GitRepo(dir);
    expect((await repo.deletedFiles(back, 'modules', 1000)).files).toEqual([]);
    const { commit: later } = await writer.commit({
      branch: 'main',
      parent: back,
      changes: [{ path: PATH, delete: true }],
      message: 'Drop it again',
      author: ACTOR,
    });
    const again = await repo.deletedFiles(later, 'modules', 1000);
    // Its newest deletion, and the file as it was before that one.
    expect(again.files.map((f) => [f.commit, f.blob])).toEqual([
      [later, git(dir, 'rev-parse', `${back}:${PATH}`)],
    ]);
    // A window of one commit: the deletion is not in it after one more commit.
    const { commit: next } = await writer.commit({
      branch: 'main',
      parent: later,
      changes: [{ path: 'modules/en/notes.adoc', content: 'z' }],
      message: 'Notes',
      author: ACTOR,
    });
    const cut = await repo.deletedFiles(next, 'modules', 1);
    expect(cut).toEqual({ files: [], truncated: true });
    expect((await repo.deletedFiles(next, 'modules', 2)).files).toHaveLength(1);
    repo.close();
  });

  it('counts a deletion a merge brought in, never one only on the merged branch', async () => {
    const { dir, commits } = await fixture();
    const writer = new GitWriter(dir);
    await writer.createBranch('drop', commits.merge);
    const { commit: dropped } = await writer.commit({
      branch: 'drop',
      parent: commits.merge,
      changes: [{ path: 'modules/en/notes.adoc', delete: true }],
      message: 'Drop notes',
      author: ACTOR,
    });
    const merged = await writer.merge({
      branch: 'main',
      expected: commits.deleted,
      source: dropped,
      message: 'Merge the drop',
      author: ACTOR,
      fastForward: 'never',
    });
    if (merged.kind !== 'merge') throw new Error('expected a merge');
    const repo = new GitRepo(dir);
    const found = await repo.deletedFiles(merged.commit, 'modules', 1000);
    expect(found.files.map((f) => [f.path, f.commit])).toEqual([
      ['modules/en/notes.adoc', merged.commit],
      [PATH, commits.deleted],
    ]);
    repo.close();
  });

  it('reads the folder literally and refuses bad input', async () => {
    const { dir, commits } = await fixture();
    const repo = new GitRepo(dir);
    expect(
      (await repo.deletedFiles(commits.deleted, 'modules/e', 5)).files,
    ).toEqual([]);
    expect(
      (await repo.deletedFiles(commits.deleted, 'manuals', 5)).files,
    ).toEqual([]);
    await expect(
      repo.deletedFiles(commits.deleted, '../x', 5),
    ).rejects.toBeInstanceOf(GitError);
    await expect(
      repo.deletedFiles('main', 'modules', 5),
    ).rejects.toBeInstanceOf(GitError);
    await expect(
      repo.deletedFiles(commits.deleted, 'modules', 0),
    ).rejects.toBeInstanceOf(GitError);
    repo.close();
  });
});

describe('Snapshot.deletedModules', () => {
  it('lists the module files deleted and not there, by ID and language', async () => {
    const { dir, commits } = await fixture();
    const repo = ContentRepo.open(dir);
    const snapshot = await repo.at(commits.deleted);
    const found = await snapshot?.deletedModules(1000);
    expect(found?.files).toEqual([
      {
        id: 'storage',
        lang: 'en',
        revision: git(dir, 'rev-parse', `${commits.merge}:${PATH}`),
        commit: commits.deleted,
        committedAt: expect.any(String),
      },
    ]);
    const last = await snapshot?.moduleAtRevision(
      'storage',
      'en',
      found?.files[0]?.revision ?? '',
    );
    expect(last?.blocks[0]).toMatchObject({
      content: [{ text: 'Keep it cool.' }],
    });
    repo.close();
  });
});

describe('withoutTrailers', () => {
  it('drops only the trailer lines of the last paragraph', () => {
    expect(withoutTrailers('Subject\n\nBody.\n\nA-b: 1\nC: 2\n', true)).toBe(
      'Subject\n\nBody.',
    );
    // Other lines among them stay, and so does what follows a divider.
    expect(
      withoutTrailers('Subject\n\nNote\nSigned-off-by: x\n  folded\n', true),
    ).toBe('Subject\n\nNote');
    // Git reads the last paragraph, past a divider, and `Key : v` too.
    expect(
      withoutTrailers(
        'Subject\n\nNote: kept\n---\nmore\n\nSigned-off-by: a\nKey : v',
        true,
      ),
    ).toBe('Subject\n\nNote: kept\n---\nmore');
    // The subject is never a trailer, nor is anything without trailers.
    expect(withoutTrailers('Fix: it\n', true)).toBe('Fix: it');
    expect(withoutTrailers('Subject\n\nKey: v', false)).toBe(
      'Subject\n\nKey: v',
    );
  });
});

describe('Snapshot.moduleHistory', () => {
  it('gives the revisions, readable as the module was', async () => {
    const { dir, commits } = await fixture();
    const repo = ContentRepo.open(dir);
    const snapshot = await repo.at(commits.deleted);
    const history = await snapshot?.moduleHistory('storage', 'en', 1000);
    expect(history?.versions.map((v) => v.revision !== undefined)).toEqual([
      false,
      true,
      true,
    ]);
    const merged = history?.versions[1]?.revision as string;
    expect(merged).toBe(
      await (await repo.at(commits.merge))?.moduleRevision('storage', 'en'),
    );
    expect(await snapshot?.moduleAtRevision('storage', 'en', merged)).toEqual(
      storage('Keep it cool.'),
    );
    // Not a module file of that language, or not a blob: nothing.
    expect(
      await snapshot?.moduleAtRevision('storage', 'en', '0'.repeat(40)),
    ).toBeUndefined();
    expect(
      await snapshot?.moduleAtRevision('storage', 'en', 'not-an-id'),
    ).toBeUndefined();
    await expect(
      snapshot?.moduleAtRevision('storage', 'de', merged),
    ).rejects.toBeInstanceOf(ContentError);
    expect(await snapshot?.moduleHistory('../x', 'en', 10)).toEqual({
      versions: [],
      truncated: false,
    });
    repo.close();
  });
});

describe('Snapshot.manifestHistory', () => {
  it('gives the versions of a manifest, readable as it was, and its deletion', async () => {
    const { dir } = createBareSampleRepo();
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const writer = new GitWriter(dir);
    const path = 'manuals/service.yaml';
    const start = git(dir, 'rev-parse', 'refs/heads/main');
    const original = git(dir, 'show', `${start}:${path}`);
    const { commit: renamed } = await writer.commit({
      branch: 'main',
      parent: start,
      changes: [
        {
          path,
          content: original.replace(/^title: .*$/m, 'title: Service, again'),
        },
      ],
      message: 'Rename the service manual',
      author: ACTOR,
      trailers: [{ key: 'Actor', value: 'user/ada' }],
    });
    const { commit: deleted } = await writer.commit({
      branch: 'main',
      parent: renamed,
      changes: [{ path, delete: true }],
      message: 'Drop the service manual',
      author: ACTOR,
    });
    const repo = ContentRepo.open(dir);
    const snapshot = await repo.at(deleted);
    const history = await snapshot?.manifestHistory('service', 1000);
    expect(history?.versions.map((v) => v.commit).slice(0, 2)).toEqual([
      deleted,
      renamed,
    ]);
    expect(history?.versions[0]?.revision).toBeUndefined();
    const last = history?.versions[1]?.revision as string;
    expect(last).toBe(
      await (await repo.at(renamed))?.manifestRevision('service'),
    );
    expect((await snapshot?.manifestAtRevision('service', last))?.title).toBe(
      'Service, again',
    );
    expect(await snapshot?.manifestRevision('service')).toBeUndefined();
    // Not a blob, or not a manual ID: nothing.
    expect(
      await snapshot?.manifestAtRevision('service', '0'.repeat(40)),
    ).toBeUndefined();
    expect(await snapshot?.manifestAtRevision('../x', last)).toBeUndefined();
    expect(await snapshot?.manifestHistory('../x', 10)).toEqual({
      versions: [],
      truncated: false,
    });
    expect((await snapshot?.deletedManifests(1000))?.files).toEqual([
      {
        id: 'service',
        revision: last,
        commit: deleted,
        committedAt: expect.any(String),
      },
    ]);
    repo.close();
  });
});
