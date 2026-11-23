import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import type { ConfigService } from '@nestjs/config';
import { GitWriter } from '@openfolia/content-repo';
import { createBareSampleRepo } from '@openfolia/content-repo/testing';
import { ConflictError } from '../../base/core/errors.js';
import type { Env } from '../../config/env.js';
import { changeSetBranch, newChangeSetId } from '../core/change-set.js';
import { GitChangeSetBranches } from './git-change-set-branches.js';

describe('GitChangeSetBranches', () => {
  let sample: ReturnType<typeof createBareSampleRepo>;
  let branches: GitChangeSetBranches;
  const withDefault = (ref: string) =>
    new GitChangeSetBranches({
      get: (key: keyof Env) =>
        ({ CCMS_CONTENT_DIR: sample.dir, CCMS_DEFAULT_REF: ref })[
          key as 'CCMS_DEFAULT_REF'
        ],
    } as unknown as ConfigService<Env, true>);
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', sample.dir, ...args], {
      encoding: 'utf8',
    }).trim();

  beforeEach(() => {
    sample = createBareSampleRepo();
    const settings: Partial<Env> = {
      CCMS_CONTENT_DIR: sample.dir,
      CCMS_DEFAULT_REF: 'main',
    };
    branches = new GitChangeSetBranches({
      get: (key: keyof Env) => settings[key],
    } as unknown as ConfigService<Env, true>);
  });
  afterEach(
    () => sample && rmSync(sample.dir, { recursive: true, force: true }),
  );

  it('creates, lists and deletes change-set branches by compare-and-swap', async () => {
    const name = changeSetBranch(newChangeSetId());
    await branches.create(name, sample.commits.main);
    expect(git('rev-parse', `refs/heads/${name}`)).toBe(sample.commits.main);
    expect(await branches.list()).toEqual([
      { name, commit: sample.commits.main },
    ]);
    await expect(branches.create(name, sample.commits.v1)).rejects.toThrow(
      ConflictError,
    );
    // Moved: nothing deleted.
    expect(await branches.deleteIfAt(name, sample.commits.v1)).toBe(false);
    expect(await branches.deleteIfAt(name, sample.commits.main)).toBe(true);
    expect(await branches.list()).toEqual([]);
    expect(await branches.deleteIfAt(name, sample.commits.main)).toBe(false);
  });

  it('touches no branch but a change set’s', async () => {
    for (const name of ['main', 'draft', 'change-sets/x', 'refs/heads/main']) {
      await expect(branches.create(name, sample.commits.main)).rejects.toThrow(
        'is not a change-set branch',
      );
      await expect(
        branches.deleteIfAt(name, sample.commits.main),
      ).rejects.toThrow('is not a change-set branch');
    }
    expect(git('rev-parse', 'refs/heads/main')).toBe(sample.commits.main);
  });

  it('names the default base: the default ref, or the branch HEAD names', async () => {
    expect(await withDefault('HEAD').defaultBase()).toBe('main');
    expect(await withDefault('draft').defaultBase()).toBe('draft');
    expect(await withDefault('v1').defaultBase()).toBe('v1');
    git('update-ref', '--no-deref', 'HEAD', sample.commits.main);
    expect(await withDefault('HEAD').defaultBase()).toBeUndefined();
  });

  it('tells whether a branch holds commits no other ref has', async () => {
    const shared = changeSetBranch(newChangeSetId());
    await branches.create(shared, sample.commits.main);
    expect(await branches.hasOwnCommits(shared, sample.commits.main)).toBe(
      false,
    );
    // A commit only on this branch.
    const own = changeSetBranch(newChangeSetId());
    const tree = git('rev-parse', `${sample.commits.main}^{tree}`);
    const commit = execFileSync(
      'git',
      [
        '-C',
        sample.dir,
        'commit-tree',
        tree,
        '-p',
        sample.commits.main,
        '-m',
        'own',
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 'T',
          GIT_AUTHOR_EMAIL: 't@example.com',
          GIT_COMMITTER_NAME: 'T',
          GIT_COMMITTER_EMAIL: 't@example.com',
        },
      },
    ).trim();
    await branches.create(own, commit);
    expect(await branches.hasOwnCommits(own, commit)).toBe(true);
    // Another change set's branch is no keeper: it may go at the same time.
    const sibling = changeSetBranch(newChangeSetId());
    await branches.create(sibling, commit);
    expect(await branches.hasOwnCommits(own, commit)).toBe(true);
  });

  it('prepares a tree, then commits it by compare-and-swap with trailers', async () => {
    const id = newChangeSetId();
    const name = changeSetBranch(id);
    await branches.create(name, sample.commits.main);
    const author = { kind: 'user' as const, id: 'sample-author' };
    const request = {
      parent: sample.commits.main,
      message: 'Update things',
      author,
      changeSetId: id,
    };
    const { tree } = await branches.prepare(name, {
      ...request,
      changes: [
        { path: 'modules/en/new.adoc', content: '= New\n' },
        { path: 'modules/en/internals.adoc', delete: true },
      ],
    });
    // Prepared: objects only, the branch has not moved.
    expect(git('rev-parse', `refs/heads/${name}`)).toBe(sample.commits.main);
    const made = await branches.commit(name, { ...request, tree });
    if (!('commit' in made)) throw new Error('not committed');
    expect(git('rev-parse', `refs/heads/${name}`)).toBe(made.commit);
    expect(git('log', '-1', '--format=%an <%ae>%n%B', made.commit)).toBe(
      `sample-author <sample-author@user.openfolia.invalid>\nUpdate things\n\nChange-set: ${id}\nActor: user/sample-author`,
    );
    // History names parents and trees, never what the trailers claim.
    expect(await branches.history(name, made.commit, 5)).toEqual([
      { commit: made.commit, parent: sample.commits.main, parents: 1, tree },
      expect.objectContaining({ commit: sample.commits.main }),
      expect.objectContaining({ commit: sample.commits.v1 }),
    ]);
    expect(
      await branches.changedPaths(sample.commits.main, made.commit),
    ).toEqual([
      { path: 'modules/en/internals.adoc', deleted: true },
      { path: 'modules/en/new.adoc', deleted: false },
    ]);

    // The head moved: nothing written, where it is now.
    const { tree: other } = await branches.prepare(name, {
      ...request,
      changes: [{ path: 'modules/en/new.adoc', content: 'other\n' }],
    });
    expect(await branches.commit(name, { ...request, tree: other })).toEqual({
      moved: made.commit,
    });
    expect(git('rev-parse', `refs/heads/${name}`)).toBe(made.commit);

    // What a client can get wrong is a 422, before anything is written;
    // nothing outside change sets is touched.
    await expect(
      branches.prepare(name, {
        ...request,
        parent: made.commit,
        changes: [{ path: 'openfolia.yaml', content: 'x: 1\n' }],
        message: 'Edit\n\nApproved-by: Mallory',
      }),
    ).rejects.toMatchObject({ code: 'invalid-message' });
    await expect(
      branches.prepare('main', {
        ...request,
        changes: [{ path: 'openfolia.yaml', content: 'x: 1\n' }],
      }),
    ).rejects.toThrow('not a change-set branch');
    await expect(branches.commit('main', { ...request, tree })).rejects.toThrow(
      'not a change-set branch',
    );
  });

  it('reads nothing a pusher wrote: a pushed commit is only its parent and tree', async () => {
    const id = newChangeSetId();
    const name = changeSetBranch(id);
    await branches.create(name, sample.commits.main);
    const { commit, tree } = await new GitWriter(sample.dir).commit({
      branch: name,
      parent: sample.commits.main,
      changes: [{ path: 'openfolia.yaml', content: 'x: 1\n' }],
      message: 'Pushed from elsewhere',
      author: {
        name: 'sample-author',
        email: 'sample-author@user.openfolia.invalid',
      },
      trailers: [
        { key: 'Change-set', value: id },
        { key: 'Actor', value: 'user/sample-author' },
      ],
    });
    const [top] = await branches.history(name, commit, 1);
    expect(top).toEqual({
      commit,
      parent: sample.commits.main,
      parents: 1,
      tree,
    });
  });
});
