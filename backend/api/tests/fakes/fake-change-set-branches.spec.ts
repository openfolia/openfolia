import { fakeCommitId } from './fake-content.js';
import { FakeChangeSetBranches } from './fake-change-set-branches.js';

describe('FakeChangeSetBranches.merge', () => {
  const actor = { kind: 'user' as const, id: 'sample-reviewer' };
  const base = fakeCommitId();

  async function setUp() {
    const branches = new FakeChangeSetBranches();
    branches.heads.set('main', base);
    const commitOn = async (
      name: string,
      changes: Parameters<FakeChangeSetBranches['prepare']>[1]['changes'],
    ) => {
      if (!branches.heads.has(name)) await branches.create(name, base);
      const request = {
        parent: branches.heads.get(name) as string,
        message: 'Edit',
        author: actor,
        changeSetId: name,
      };
      const { tree } = await branches.prepare(name, { ...request, changes });
      const made = await branches.commit(name, { ...request, tree });
      if (!('commit' in made)) throw new Error('moved');
      return made.commit;
    };
    const merge = (head: string, more: object = {}) =>
      branches.merge({
        into: 'main',
        expected: branches.heads.get('main') as string,
        head,
        message: 'Merge',
        actor,
        changeSetId: 'x',
        ...more,
      });
    return { branches, commitOn, merge };
  }

  it('fast-forwards, merges, and is up to date as git is', async () => {
    const { branches, commitOn, merge } = await setUp();
    const a = await commitOn('change-sets/a', [
      { path: 'modules/en/a.adoc', content: 'a' },
    ]);
    expect(await merge(a)).toEqual({
      kind: 'merged',
      commit: a,
      fastForward: true,
    });
    const b = await commitOn('change-sets/b', [
      { path: 'modules/en/b.adoc', content: 'b' },
    ]);
    const merged = await merge(b);
    expect(merged).toMatchObject({ kind: 'merged', fastForward: false });
    expect(await merge(b)).toEqual({
      kind: 'up-to-date',
      commit: branches.heads.get('main'),
    });
  });

  it('models conflicts: the same path changed differently on both sides', async () => {
    const { branches, commitOn, merge } = await setUp();
    const a = await commitOn('change-sets/a', [
      { path: 'modules/en/x.adoc', content: 'a' },
      { path: 'modules/en/y.adoc', content: 'a' },
      { path: 'assets/same', content: 'same' },
    ]);
    const b = await commitOn('change-sets/b', [
      { path: 'modules/en/x.adoc', content: 'b' },
      { path: 'modules/en/y.adoc', delete: true },
      { path: 'assets/same', content: 'same' },
    ]);
    await merge(a);
    const at = branches.heads.get('main');
    expect(await merge(b)).toEqual({
      kind: 'conflicts',
      conflicts: [
        { path: 'modules/en/x.adoc', kinds: ['contents'] },
        { path: 'modules/en/y.adoc', kinds: ['modify/delete'] },
      ],
    });
    expect(branches.heads.get('main')).toBe(at);
  });

  it('compares and swaps the target', async () => {
    const { branches, commitOn, merge } = await setUp();
    const a = await commitOn('change-sets/a', [
      { path: 'modules/en/a.adoc', content: 'a' },
    ]);
    const moved = fakeCommitId();
    branches.beforeMerge = () => branches.heads.set('main', moved);
    expect(await merge(a)).toEqual({ kind: 'moved', head: moved });
  });
});
