import { actorWith, NOBODY, READER } from '../../../../tests/fakes/actors.js';
import { FakeAuthoredBranches } from '../../../../tests/fakes/fake-authored-branches.js';
import { FakeSnapshot } from '../../../../tests/fakes/fake-content.js';
import { ForbiddenError, NotFoundError } from '../../../base/core/errors.js';
import {
  ContentRepository,
  type ContentSnapshot,
} from '../content.repository.js';
import type { Actor } from '../../../access/core/actor.js';
import { ChangeSetBranchMissingError } from '../change-set-branch-missing.js';
import { OpenSnapshotAction } from './open-snapshot.action.js';

const commit = (name: string) => name.padEnd(40, '0');

/** `main` and tag `v1` are released, branch `draft` and old commit `0ld` are not. */
class FakeRepository extends ContentRepository {
  readonly opened: string[] = [];
  private readonly commits: Record<string, string> = {
    main: commit('a'),
    v1: commit('b'),
    draft: commit('d'),
    [commit('0ld')]: commit('0ld'),
    'change-sets/own': commit('e'),
    // Resolves to a commit other than the branch's head (moved meanwhile).
    'change-sets/moved': commit('f'),
    [commit('e')]: commit('e'),
  };
  at(ref: string): Promise<ContentSnapshot | undefined> {
    this.opened.push(ref);
    const id = this.commits[ref];
    return Promise.resolve(
      id === undefined
        ? undefined
        : Object.assign(new FakeSnapshot(), { commit: id }),
    );
  }
  refs() {
    return Promise.resolve({
      branches: [
        { name: 'main', commit: commit('a') },
        { name: 'draft', commit: commit('d') },
        { name: 'change-sets/own', commit: commit('e') },
        { name: 'change-sets/moved', commit: commit('9') },
      ],
      tags: [{ name: 'v1', commit: commit('b') }],
    });
  }
}

const DRAFT_READER = actorWith(['content.read', 'content.read.draft']);

describe('OpenSnapshotAction', () => {
  it('opens a ref for a reader; an unknown one is not found', async () => {
    const action = new OpenSnapshotAction(
      new FakeRepository(),
      new FakeAuthoredBranches(),
    );
    const main = await action.handle({ actor: READER, ref: 'main' });
    expect(main.commit).toBe(commit('a'));
    expect(main.permission).toBe('content.read');
    await expect(
      action.handle({ actor: READER, ref: 'nope' }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('opens released refs by content.read: main and tags, also by commit', async () => {
    const action = new OpenSnapshotAction(
      new FakeRepository(),
      new FakeAuthoredBranches(),
    );
    for (const ref of ['main', 'v1']) {
      const opened = await action.handle({ actor: DRAFT_READER, ref });
      expect([ref, opened.permission]).toEqual([ref, 'content.read']);
    }
  });

  it('opens an authored base commit by its ID, through content.read, and nothing else so', async () => {
    const action = new OpenSnapshotAction(
      new FakeRepository(),
      new FakeAuthoredBranches(),
    );
    const old = await action.handle({
      actor: READER,
      ref: commit('0ld'),
      authoredBase: true,
    });
    expect(old.permission).toBe('content.read');
    // Never by a name, and never without the action's check.
    await expect(
      action.handle({ actor: READER, ref: 'draft', authoredBase: true }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      action.handle({ actor: READER, ref: commit('0ld') }),
    ).rejects.toBeInstanceOf(NotFoundError);
    // A holder of content.read.draft reads it as a draft, as before.
    const asDraft = await action.handle({
      actor: DRAFT_READER,
      ref: commit('0ld'),
      authoredBase: true,
    });
    expect(asDraft.permission).toBe('content.read.draft');
  });

  it('opens any other ref only with content.read.draft, else not found like a missing one', async () => {
    const action = new OpenSnapshotAction(
      new FakeRepository(),
      new FakeAuthoredBranches(),
    );
    for (const ref of ['draft', commit('0ld')]) {
      const opened = await action.handle({ actor: DRAFT_READER, ref });
      expect([ref, opened.permission]).toEqual([ref, 'content.read.draft']);
      await expect(action.handle({ actor: READER, ref })).rejects.toThrow(
        new NotFoundError(`No branch, tag or commit "${ref}".`),
      );
    }
    // Held in a narrow scope still counts: the scope then filters the reads.
    const scoped = actorWith(['content.read', 'content.read.draft'], {
      languages: ['de'],
    });
    expect(
      (await action.handle({ actor: scoped, ref: 'draft' })).permission,
    ).toBe('content.read.draft');
  });

  it('refuses anyone else without touching the repository', async () => {
    const repo = new FakeRepository();
    await expect(
      new OpenSnapshotAction(repo, new FakeAuthoredBranches()).handle({
        actor: NOBODY,
        ref: 'main',
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(repo.opened).toEqual([]);
  });

  it('opens a branch its author authors by name, through content.read, without content.read.draft', async () => {
    const editor = { ...actorWith(['content.read', 'content.edit']), id: 'e' };
    const authored = new FakeAuthoredBranches(
      new Map([['user/e', ['change-sets/own', 'change-sets/moved']]]),
    );
    const action = new OpenSnapshotAction(new FakeRepository(), authored);
    const own = await action.handle({ actor: editor, ref: 'change-sets/own' });
    expect(own.commit).toBe(commit('e'));
    expect(own.permission).toBe('content.read');
    // Never by commit, never other than at the branch's head, never for
    // anyone else.
    for (const [actor, ref] of [
      [editor, commit('e')],
      [editor, 'change-sets/moved'],
      [editor, 'draft'],
      [READER, 'change-sets/own'],
    ] as const) {
      await expect(action.handle({ actor, ref })).rejects.toThrow(
        new NotFoundError(`No branch, tag or commit "${ref}".`),
      );
    }
    // A draft reader keeps reading it as a draft.
    const drafts = new OpenSnapshotAction(
      new FakeRepository(),
      new FakeAuthoredBranches(
        new Map([[`user/${DRAFT_READER.id}`, ['change-sets/own']]]),
      ),
    );
    expect(
      (await drafts.handle({ actor: DRAFT_READER, ref: 'change-sets/own' }))
        .permission,
    ).toBe('content.read.draft');
  });

  it('takes the caller’s decision on authorship when given, without asking', async () => {
    const editor = { ...actorWith(['content.read', 'content.edit']), id: 'e' };
    const asked: string[] = [];
    const authored = new (class extends FakeAuthoredBranches {
      override authoredBy(actor: Actor, branch: string) {
        asked.push(branch);
        return super.authoredBy(actor, branch);
      }
    })(new Map([['user/e', ['change-sets/own']]]));
    const action = new OpenSnapshotAction(new FakeRepository(), authored);
    await expect(
      action.handle({ actor: editor, ref: 'change-sets/own', authored: false }),
    ).rejects.toBeInstanceOf(NotFoundError);
    const other = await action.handle({
      actor: READER,
      ref: 'draft',
      authored: true,
    });
    expect(other.permission).toBe('content.read');
    expect(asked).toEqual([]);
    // Even then only a branch at its head opens.
    await expect(
      action.handle({ actor: editor, ref: commit('e'), authored: true }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('says a change set’s branch is missing to whoever may see that change set, and to nobody else', async () => {
    const editor = { ...actorWith(['content.read', 'content.edit']), id: 'e' };
    const gone = 'change-sets/gone';
    const asked: string[] = [];
    const authored = new (class extends FakeAuthoredBranches {
      override visibleChangeSet(actor: Actor, branch: string) {
        asked.push(branch);
        return super.visibleChangeSet(actor, branch);
      }
    })(new Map(), new Map([['user/e', [gone]]]));
    const action = new OpenSnapshotAction(new FakeRepository(), authored);
    const missing = action.handle({ actor: editor, ref: gone });
    await expect(missing).rejects.toBeInstanceOf(ChangeSetBranchMissingError);
    await expect(missing).rejects.toBeInstanceOf(NotFoundError);
    await expect(missing).rejects.toMatchObject({
      code: 'change-set-branch-missing',
      meta: { branch: gone },
    });
    // Anyone who may not see that change set, and any other ref: not found.
    for (const [actor, ref] of [
      [READER, gone],
      [editor, 'change-sets/other'],
      [editor, 'nope'],
    ] as const) {
      await expect(action.handle({ actor, ref })).rejects.toThrow(
        new NotFoundError(`No branch, tag or commit "${ref}".`),
      );
      await expect(action.handle({ actor, ref })).rejects.not.toBeInstanceOf(
        ChangeSetBranchMissingError,
      );
    }
    // The caller's decision on authorship, when given, is used: not asked.
    asked.length = 0;
    await expect(
      action.handle({ actor: READER, ref: gone, authored: true }),
    ).rejects.toBeInstanceOf(ChangeSetBranchMissingError);
    await expect(
      action.handle({ actor: editor, ref: gone, authored: false }),
    ).rejects.not.toBeInstanceOf(ChangeSetBranchMissingError);
    expect(asked).toEqual([]);
  });
});
