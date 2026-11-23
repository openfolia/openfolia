import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import type { ConfigService } from '@nestjs/config';
import { GitWriter } from '@openfolia/content-repo';
import { createBareSampleRepo } from '@openfolia/content-repo/testing';
import { ConflictError, UnprocessableError } from '../../base/core/errors.js';
import type { Env } from '../../config/env.js';
import { changeSetBranch, newChangeSetId } from '../core/change-set.js';
import { GitChangeSetBranches } from './git-change-set-branches.js';

describe('GitChangeSetBranches.merge', () => {
  let sample: ReturnType<typeof createBareSampleRepo>;
  let branches: GitChangeSetBranches;
  const author = { kind: 'user' as const, id: 'sample-author' };
  const approver = { kind: 'user' as const, id: 'sample-reviewer' };
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', sample.dir, ...args], {
      encoding: 'utf8',
    }).trim();
  const head = (branch: string) => git('rev-parse', `refs/heads/${branch}`);

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

  /** A change set with one commit writing `path` on top of `main`. */
  async function changeSet(path: string, content: string) {
    const id = newChangeSetId();
    const name = changeSetBranch(id);
    await branches.create(name, sample.commits.main);
    const request = {
      parent: sample.commits.main,
      message: 'Edit',
      author,
      changeSetId: id,
    };
    const { tree } = await branches.prepare(name, {
      ...request,
      changes: [{ path, content }],
    });
    const made = await branches.commit(name, { ...request, tree });
    if (!('commit' in made)) throw new Error('not committed');
    return { id, name, head: made.commit };
  }

  const mergeOf = (
    cs: { id: string; head: string },
    more: Partial<Parameters<GitChangeSetBranches['merge']>[0]> = {},
  ) =>
    branches.merge({
      into: 'main',
      expected: head('main'),
      head: cs.head,
      message: 'Approve',
      actor: approver,
      changeSetId: cs.id,
      approvedBy: [approver, { kind: 'service', id: 'sign-off' }],
      ...more,
    });

  it('updates a change-set branch from its base, and only a change-set branch', async () => {
    const cs = await changeSet('modules/en/new.adoc', 'new\n');
    const other = await changeSet('terms/x.yaml', 'x\n');
    const merged = await mergeOf(other);
    if (merged.kind !== 'merged') throw new Error(merged.kind);
    const base = head('main');
    const request = {
      expected: cs.head,
      base,
      keep: [],
      message: 'Update from main',
      actor: author,
      changeSetId: cs.id,
    };
    expect(await branches.previewRefresh(request)).toEqual({
      kind: 'clean',
      fastForward: false,
      changed: [{ path: 'terms/x.yaml', deleted: false }],
    });
    expect(await branches.behind(cs.head, base)).toBeGreaterThan(0);
    await expect(branches.refresh('main', request)).rejects.toThrow(
      'not a change-set branch',
    );
    expect(head('main')).toBe(base);
    const result = await branches.refresh(cs.name, request);
    if (result.kind !== 'merged') throw new Error(result.kind);
    expect(head(cs.name)).toBe(result.commit);
    expect(git('log', '-1', '--format=%P%n%B', result.commit)).toBe(
      [
        `${cs.head} ${base}`,
        'Update from main',
        '',
        `Updated-change-set: ${cs.id}`,
        'Updated-by: user/sample-author',
      ].join('\n'),
    );
    expect(await branches.behind(result.commit, base)).toBe(0);
    expect(await branches.refresh(cs.name, request)).toEqual({
      kind: 'moved',
      head: result.commit,
    });
  });

  it('records a merge commit with the change set, the actor and the approvals', async () => {
    const cs = await changeSet('modules/en/new.adoc', 'new\n');
    const result = await mergeOf(cs, { fastForward: 'never' });
    if (result.kind !== 'merged') throw new Error(result.kind);
    expect(result.fastForward).toBe(false);
    expect(head('main')).toBe(result.commit);
    expect(git('log', '-1', '--format=%P', result.commit)).toBe(
      `${sample.commits.main} ${cs.head}`,
    );
    expect(git('log', '-1', '--format=%an <%ae>%n%B', result.commit)).toBe(
      [
        'sample-reviewer <sample-reviewer@user.openfolia.invalid>',
        'Approve',
        '',
        `Merged-change-set: ${cs.id}`,
        'Merged-by: user/sample-reviewer',
        'Approved-by: user/sample-reviewer',
        'Approved-by: service/sign-off',
      ].join('\n'),
    );
  });

  it('finds a landed merge by reachability, with its merge commit and merger', async () => {
    const cs = await changeSet('modules/en/new.adoc', 'new\n');
    expect(await branches.mergedInto('main', cs.head, cs.id)).toBeUndefined();
    const result = await mergeOf(cs);
    if (result.kind !== 'merged') throw new Error(result.kind);
    expect(await branches.head('main')).toBe(result.commit);
    expect(await branches.head('no-such-branch')).toBeUndefined();
    expect(await branches.mergedInto('main', cs.head, cs.id)).toEqual({
      commit: result.commit,
      mergedBy: approver,
    });
    // Recovery skips a commit with two parents: a merge is never a save point.
    const [top] = await branches.history(cs.name, result.commit, 1);
    expect(top?.parents).toBe(2);
  });

  it('finds the merge commit however many commits landed on the base after it', async () => {
    const cs = await changeSet('modules/en/new.adoc', 'new\n');
    const result = await mergeOf(cs);
    if (result.kind !== 'merged') throw new Error(result.kind);
    // More commits on main than any fixed window would look through.
    const later = Array.from(
      { length: 300 },
      (_, i) =>
        `commit refs/heads/main\ncommitter Someone <someone@example.com> ${1_700_000_000 + i} +0000\ndata 6\nLater\n${i === 0 ? `from ${result.commit}\n` : ''}\n`,
    ).join('');
    execFileSync('git', ['-C', sample.dir, 'fast-import', '--quiet'], {
      input: later,
    });
    expect(git('rev-list', '--count', `${result.commit}..main`)).toBe('300');
    expect(await branches.mergedInto('main', cs.head, cs.id)).toEqual({
      commit: result.commit,
      mergedBy: approver,
    });
  });

  it('never fast-forwards a merge with approvals', async () => {
    const cs = await changeSet('modules/en/new.adoc', 'new\n');
    const result = await mergeOf(cs);
    expect(result).toMatchObject({ kind: 'merged', fastForward: false });
  });

  it('fast-forwards by default, and is up to date the second time', async () => {
    const cs = await changeSet('modules/en/new.adoc', 'new\n');
    expect(await mergeOf(cs, { approvedBy: [] })).toEqual({
      kind: 'merged',
      commit: cs.head,
      fastForward: true,
    });
    expect(await mergeOf(cs, { approvedBy: [] })).toEqual({
      kind: 'up-to-date',
      commit: cs.head,
    });
  });

  it('returns conflicts as data and moves nothing', async () => {
    const a = await changeSet('modules/en/charging.adoc', 'a\n');
    const b = await changeSet('modules/en/charging.adoc', 'b\n');
    const merged = await mergeOf(a);
    if (merged.kind !== 'merged') throw new Error(merged.kind);
    expect(await mergeOf(b)).toEqual({
      kind: 'conflicts',
      conflicts: [{ path: 'modules/en/charging.adoc', kinds: ['contents'] }],
    });
    expect(head('main')).toBe(merged.commit);
  });

  it('tells a racing loser where the target moved; its retry lands on top', async () => {
    const a = await changeSet('modules/en/a.adoc', 'a\n');
    const b = await changeSet('modules/en/b.adoc', 'b\n');
    const expected = head('main');
    const results = await Promise.all([
      mergeOf(a, { expected, fastForward: 'never' }),
      mergeOf(b, { expected, fastForward: 'never' }),
    ]);
    const won = results.filter((r) => r.kind === 'merged');
    const lost = results.filter((r) => r.kind === 'moved');
    expect(won).toHaveLength(1);
    expect(lost).toEqual([{ kind: 'moved', head: head('main') }]);
    const loser = results[0]?.kind === 'moved' ? a : b;
    const retried = await mergeOf(loser, { fastForward: 'never' });
    expect(retried.kind).toBe('merged');
    expect(git('cat-file', '-e', 'main:modules/en/a.adoc')).toBe('');
    expect(git('cat-file', '-e', 'main:modules/en/b.adoc')).toBe('');
  });

  it('refuses a change-set branch as target, unrelated histories and forged trailers', async () => {
    const cs = await changeSet('modules/en/new.adoc', 'new\n');
    for (const into of [cs.name, 'change-sets/not-an-id', 'Change-Sets/x']) {
      await expect(mergeOf(cs, { into })).rejects.toThrow(
        'is a change-set branch',
      );
    }
    const orphan = git(
      'commit-tree',
      git('rev-parse', `${sample.commits.main}^{tree}`),
      '-m',
      'orphan',
    );
    await expect(mergeOf({ id: cs.id, head: orphan })).rejects.toThrow(
      ConflictError,
    );
    await expect(
      mergeOf(cs, { message: 'Approve\n\nApproved-by: user/someone-else' }),
    ).rejects.toThrow(UnprocessableError);
    expect(head('main')).toBe(sample.commits.main);
  });
  it('reads who wrote a change set’s own line: the API’s commits and what they carried, nobody else (#597)', async () => {
    const cs = await changeSet('modules/en/new.adoc', 'new\n');
    // Main moves on with someone else's merged work; the change set is updated from it.
    const other = await changeSet('terms/x.yaml', 'x\n');
    const merged = await mergeOf(other, { fastForward: 'never' });
    if (merged.kind !== 'merged') throw new Error(merged.kind);
    const base = head('main');
    const refreshed = await branches.refresh(cs.name, {
      expected: cs.head,
      base,
      keep: [],
      message: 'Update from main',
      actor: { kind: 'user', id: 'refresher' },
      changeSetId: cs.id,
    });
    if (refreshed.kind !== 'merged') throw new Error(refreshed.kind);
    // A carry, by someone else, naming who wrote what it carries (each once, never itself).
    const carrier = { kind: 'user' as const, id: 'carrier' };
    const firstWriter = { kind: 'user' as const, id: 'first-writer' };
    const request = {
      parent: refreshed.commit,
      message: 'Carry',
      author: carrier,
      changeSetId: cs.id,
      carried: [firstWriter, carrier, firstWriter, author],
    };
    const { tree } = await branches.prepare(cs.name, {
      ...request,
      changes: [{ path: 'modules/en/carried.adoc', content: 'carried\n' }],
    });
    const carry = await branches.commit(cs.name, { ...request, tree });
    if (!('commit' in carry)) throw new Error('not committed');
    expect(git('log', '-1', '--format=%B', carry.commit)).toBe(
      [
        'Carry',
        '',
        `Change-set: ${cs.id}`,
        'Carried-author: user/first-writer',
        'Carried-author: user/sample-author',
        'Actor: user/carrier',
      ].join('\n'),
    );
    // Pushed from outside: one claiming an actor under another identity, one naming nobody.
    const writer = new GitWriter(sample.dir);
    const forged = await writer.commit({
      branch: cs.name,
      parent: carry.commit,
      changes: [{ path: 'modules/en/pushed.adoc', content: 'pushed\n' }],
      message: 'Pushed',
      author: { name: 'mallory', email: 'mallory@example.com' },
      trailers: [
        { key: 'Actor', value: 'user/mallory' },
        { key: 'Carried-author', value: 'user/mallory-friend' },
      ],
    });
    const plain = await writer.commit({
      branch: cs.name,
      parent: forged.commit,
      changes: [{ path: 'modules/en/pushed.adoc', content: 'again\n' }],
      message: 'Pushed again',
      author: { name: 'someone', email: 'someone@example.com' },
    });
    expect(await branches.writers(cs.name, plain.commit, base)).toEqual([
      carrier,
      firstWriter,
      author,
    ]);
    // From the change set's first commit only: its author alone.
    expect(
      await branches.writers(cs.name, cs.head, sample.commits.main),
    ).toEqual([author]);
    expect(
      await branches.writers(cs.name, sample.commits.main, sample.commits.main),
    ).toEqual([]);
    await expect(branches.writers('main', plain.commit, base)).rejects.toThrow(
      'not a change-set branch',
    );
  });
});
