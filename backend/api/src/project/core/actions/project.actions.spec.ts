import { actorWith, READER } from '../../../../tests/fakes/actors.js';
import {
  config,
  FakeSnapshot,
  readable,
} from '../../../../tests/fakes/fake-content.js';
import { FakeWithdrawnReleases } from '../../../../tests/fakes/fake-withdrawn-releases.js';
import { ContentRepository } from '../../../content/core/content.repository.js';
import { ReadableRefs } from '../../../content/core/readable-refs.js';
import { GetConfigAction } from './get-config.action.js';
import { ListRefsAction } from './list-refs.action.js';

class FakeRepository extends ContentRepository {
  at() {
    return Promise.resolve(new FakeSnapshot());
  }
  refs() {
    return Promise.resolve({
      branches: [
        { name: 'draft', commit: 'd' },
        { name: 'main', commit: 'a' },
      ],
      tags: [
        { name: 'v1', commit: 'b' },
        { name: 'v2', commit: 'c' },
      ],
    });
  }
}

describe('ListRefsAction', () => {
  const repository = new FakeRepository();
  const withdrawn = new FakeWithdrawnReleases();
  const action = new ListRefsAction(
    repository,
    new ReadableRefs(repository, withdrawn),
  );

  it('pages branches, then tags', async () => {
    const page = await action.handle({
      actor: actorWith(['content.read', 'content.read.draft']),
      page: { number: 1, size: 2 },
    });
    expect(page).toEqual({
      total: 4,
      items: [
        { kind: 'branch', name: 'draft', commit: 'd' },
        { kind: 'branch', name: 'main', commit: 'a' },
      ],
    });
  });

  it('lists only main and the tags to a reader of released content', async () => {
    const page = await action.handle({
      actor: READER,
      page: { number: 1, size: 50 },
    });
    expect(page).toEqual({
      total: 3,
      items: [
        { kind: 'branch', name: 'main', commit: 'a' },
        { kind: 'tag', name: 'v1', commit: 'b', withdrawal: null },
        { kind: 'tag', name: 'v2', commit: 'c', withdrawal: null },
      ],
    });
  });

  it('marks the tag of a withdrawn release with its withdrawal', async () => {
    const withdrawal = withdrawn.withdraw('v2');
    try {
      const page = await action.handle({
        actor: READER,
        page: { number: 1, size: 50 },
      });
      expect(page.items.slice(1)).toEqual([
        { kind: 'tag', name: 'v1', commit: 'b', withdrawal: null },
        { kind: 'tag', name: 'v2', commit: 'c', withdrawal },
      ]);
    } finally {
      withdrawn.byTag.clear();
    }
  });
});

describe('GetConfigAction', () => {
  it('returns the project configuration', async () => {
    expect(
      await new GetConfigAction().handle({
        actor: READER,
        snapshot: readable(),
      }),
    ).toEqual(config);
  });
});
