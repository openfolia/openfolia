import {
  ContentRepository,
  type ContentSnapshot,
} from '../../src/content/core/content.repository.js';
import { OpenSnapshotAction } from '../../src/content/core/actions/open-snapshot.action.js';
import { FakeAuthoredBranches } from './fake-authored-branches.js';
import { type FakeContent, FakeSnapshot } from './fake-content.js';

/**
 * A repository in which every ref resolves to `snapshot` unless `branches`
 * names another for it. By default every branch is at `main`'s commit, as
 * a new change set's is, so it reads as released content (`content.read`);
 * `released: false` gives every branch a commit of its own (a draft).
 */
export class FakeRepository extends ContentRepository {
  readonly branches = new Map<string, ContentSnapshot>();
  readonly main: ContentSnapshot;

  constructor(
    readonly snapshot: ContentSnapshot = new FakeSnapshot(),
    { released = true } = {},
  ) {
    super();
    this.main = released ? snapshot : new FakeSnapshot();
  }

  at(ref: string): Promise<ContentSnapshot | undefined> {
    return Promise.resolve(
      ref === 'main' ? this.main : (this.branches.get(ref) ?? this.snapshot),
    );
  }

  refs() {
    return Promise.resolve({
      branches: [{ name: 'main', commit: this.main.commit }],
      tags: [],
    });
  }
}

/** `OpenSnapshotAction` over a `FakeRepository` of `content`. */
export const fakeOpenSnapshot = (
  content: FakeContent = {},
  options: { released?: boolean } = {},
) =>
  new OpenSnapshotAction(
    new FakeRepository(new FakeSnapshot(content), options),
    new FakeAuthoredBranches(),
  );
