import { actorWith, NOBODY, READER } from '../../../../tests/fakes/actors.js';
import { FakeSnapshot } from '../../../../tests/fakes/fake-content.js';
import { ForbiddenError } from '../../../base/core/errors.js';
import {
  ContentRepository,
  type ContentSnapshot,
} from '../content.repository.js';
import { OpenReleasedSnapshotsAction } from './open-released-snapshots.action.js';

const commit = (name: string) => name.padEnd(40, '0');

/** `main` and tag `v1` are released; branch `draft` and old commit `0ld` are not. */
class FakeRepository extends ContentRepository {
  listings = 0;
  readonly asked: (readonly string[])[] = [];
  private readonly commits: Record<string, string> = {
    main: commit('a'),
    v1: commit('b'),
    draft: commit('d'),
    [commit('0ld')]: commit('0ld'),
    [commit('b')]: commit('b'),
  };
  at(ref: string): Promise<ContentSnapshot | undefined> {
    const id = this.commits[ref];
    return Promise.resolve(
      id === undefined
        ? undefined
        : Object.assign(new FakeSnapshot(), { commit: id }),
    );
  }
  override atEach(refs: readonly string[]) {
    this.asked.push(refs);
    return super.atEach(refs);
  }
  refs() {
    this.listings++;
    return Promise.resolve({
      branches: [
        { name: 'main', commit: commit('a') },
        { name: 'draft', commit: commit('d') },
      ],
      tags: [{ name: 'v1', commit: commit('b') }],
    });
  }
}

describe('OpenReleasedSnapshotsAction', () => {
  it('opens each released ref through content.read, in order, and nothing else', async () => {
    const repository = new FakeRepository();
    const action = new OpenReleasedSnapshotsAction(repository);
    const drafts = actorWith(['content.read', 'content.read.draft']);
    const opened = await action.handle({
      actor: drafts,
      refs: ['v1', 'nope', 'draft', commit('0ld'), 'main', commit('b')],
    });
    expect(
      opened.map((content) => content && [content.commit, content.permission]),
    ).toEqual([
      [commit('b'), 'content.read'],
      undefined,
      // Never a draft, even for a reader of drafts.
      undefined,
      undefined,
      [commit('a'), 'content.read'],
      [commit('b'), 'content.read'],
    ]);
    // One call for all of them, and one listing to judge them.
    expect(repository.asked).toHaveLength(1);
    expect(repository.listings).toBe(1);
  });

  it('opens nothing for an actor without content.read, and lists nothing for no refs', async () => {
    const repository = new FakeRepository();
    const action = new OpenReleasedSnapshotsAction(repository);
    await expect(
      action.handle({ actor: NOBODY, refs: ['main'] }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(await action.handle({ actor: READER, refs: [] })).toEqual([]);
    expect(repository.listings).toBe(0);
  });
});
