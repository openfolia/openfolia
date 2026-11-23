import { actorWith } from '../../../tests/fakes/actors.js';
import { FakeChangeSetStore } from '../../../tests/fakes/fake-change-set-store.js';
import type { Actor } from '../../access/core/actor.js';
import {
  type ChangeSet,
  changeSetBranch,
  newChangeSetId,
} from './change-set.js';
import { ChangeSetAuthoredBranches } from './change-set-authored-branches.js';

const author: Actor = {
  ...actorWith(['content.read', 'content.edit']),
  id: 'sample-author',
};

function changeSet(over: Partial<ChangeSet> = {}): ChangeSet {
  const id = newChangeSetId();
  const now = new Date();
  return {
    id,
    title: 'x',
    description: null,
    author: { kind: 'user', id: author.id },
    baseRef: 'main',
    baseCommit: 'a'.repeat(40),
    baseReleased: true,
    branch: changeSetBranch(id),
    state: 'draft',
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

describe('ChangeSetAuthoredBranches', () => {
  it('names its author’s branch, in any state, when it started from released content', async () => {
    const own = changeSet();
    const abandoned = changeSet({ state: 'abandoned' });
    const branches = new ChangeSetAuthoredBranches(
      new FakeChangeSetStore([own, abandoned]),
    );
    expect(await branches.authoredBy(author, own.branch)).toBe(true);
    expect(await branches.authoredBy(author, abandoned.branch)).toBe(true);
  });

  it('names no other branch, and no branch of anyone else', async () => {
    const own = changeSet();
    const fromDraft = changeSet({ baseRef: 'draft', baseReleased: false });
    const theirs = changeSet({ author: { kind: 'user', id: 'sample-other' } });
    const branches = new ChangeSetAuthoredBranches(
      new FakeChangeSetStore([own, fromDraft, theirs]),
    );
    for (const [actor, branch] of [
      // Started from a draft: others' unreleased work is on it.
      [author, fromDraft.branch],
      [author, theirs.branch],
      // A service of the same ID is someone else.
      [{ ...author, kind: 'service' }, own.branch],
      // Only the exact name.
      [author, `refs/heads/${own.branch}`],
      [author, own.branch.toUpperCase()],
      [author, `change-sets/${own.id.toUpperCase()}`],
      [author, own.id],
      [author, 'main'],
      [author, changeSetBranch(newChangeSetId())],
    ] as const) {
      expect([branch, await branches.authoredBy(actor, branch)]).toEqual([
        branch,
        false,
      ]);
    }
  });

  it('names a change set’s branch as visible to whoever may read that change set, in any state', async () => {
    const own = changeSet();
    const fromDraft = changeSet({ baseRef: 'draft', baseReleased: false });
    const theirs = changeSet({
      author: { kind: 'user', id: 'sample-other' },
      state: 'abandoned',
    });
    const branches = new ChangeSetAuthoredBranches(
      new FakeChangeSetStore([own, fromDraft, theirs]),
    );
    const draftReader = actorWith(['content.read', 'content.read.draft']);
    for (const [actor, branch, visible] of [
      [author, own.branch, true],
      // Their own, even started from a draft: GET /change-sets/:id finds it.
      [author, fromDraft.branch, true],
      [author, theirs.branch, false],
      [draftReader, theirs.branch, true],
      [{ ...author, kind: 'service' }, own.branch, false],
      [author, `refs/heads/${own.branch}`, false],
      [draftReader, changeSetBranch(newChangeSetId()), false],
      [draftReader, 'main', false],
    ] as const) {
      expect([branch, await branches.visibleChangeSet(actor, branch)]).toEqual([
        branch,
        visible,
      ]);
    }
  });
});
