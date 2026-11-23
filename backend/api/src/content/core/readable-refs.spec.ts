import { FakeSnapshot } from '../../../tests/fakes/fake-content.js';
import { FakeWithdrawnReleases } from '../../../tests/fakes/fake-withdrawn-releases.js';
import { ContentRepository } from './content.repository.js';
import { ReadableRefs } from './readable-refs.js';

const COMMIT = 'c'.repeat(40);

class Repository extends ContentRepository {
  listed = 0;
  at() {
    return Promise.resolve(new FakeSnapshot());
  }
  refs() {
    this.listed++;
    return Promise.resolve({
      branches: [
        { name: 'main', commit: 'a' },
        // A branch named like a withdrawn release's tag: a read by that
        // name reads the branch.
        { name: 'release/shadowed', commit: 'b' },
      ],
      tags: [
        { name: 'release/1.0', commit: 'd' },
        { name: 'release/1.1', commit: 'e' },
        { name: 'release/shadowed', commit: 'f' },
      ],
    });
  }
}

describe('ReadableRefs.withdrawalAt', () => {
  const setup = () => {
    const repository = new Repository();
    const withdrawn = new FakeWithdrawnReleases();
    const withdrawal = withdrawn.withdraw('release/1.1');
    withdrawn.withdraw('release/shadowed');
    withdrawn.withdraw('release/gone');
    withdrawn.withdraw(COMMIT);
    return {
      repository,
      withdrawal,
      refs: new ReadableRefs(repository, withdrawn),
    };
  };

  it('gives the withdrawal of the release whose tag is read, by name or full ref', async () => {
    const { refs, withdrawal } = setup();
    expect(await refs.withdrawalAt('release/1.1')).toEqual(withdrawal);
    expect(await refs.withdrawalAt('refs/tags/release/1.1')).toEqual(
      withdrawal,
    );
  });

  it('gives none for a standing release, a branch, a commit or a tag that is gone', async () => {
    const { refs } = setup();
    expect(await refs.withdrawalAt('release/1.0')).toBeUndefined();
    expect(await refs.withdrawalAt('main')).toBeUndefined();
    expect(await refs.withdrawalAt('refs/heads/release/1.1')).toBeUndefined();
    expect(await refs.withdrawalAt(COMMIT)).toBeUndefined();
    expect(await refs.withdrawalAt('release/gone')).toBeUndefined();
  });

  it('gives none for a name a branch shadows, but the tag by its full ref', async () => {
    const { refs } = setup();
    expect(await refs.withdrawalAt('release/shadowed')).toBeUndefined();
    expect(await refs.withdrawalAt('refs/tags/release/shadowed')).toBeDefined();
  });

  it('lists the refs only for the name of a withdrawn release’s tag', async () => {
    const { refs, repository } = setup();
    await refs.withdrawalAt('main');
    await refs.withdrawalAt('release/1.0');
    expect(repository.listed).toBe(0);
  });
});
