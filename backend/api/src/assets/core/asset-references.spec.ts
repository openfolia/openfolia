import { FakeAssetUploads } from '../../../tests/fakes/fake-asset-uploads.js';
import type { Module } from '@openfolia/content-model';
import { FakeHeldBlobs } from '../../../tests/fakes/fake-held-blobs.js';
import { FakeChangeSetStore } from '../../../tests/fakes/fake-change-set-store.js';
import { FakeSnapshot, module } from '../../../tests/fakes/fake-content.js';
import { FakeWorkingCopyStore } from '../../../tests/fakes/fake-working-copy-store.js';
import {
  type ChangeSet,
  type ChangeSetState,
  changeSetBranch,
  newChangeSetId,
} from '../../change-sets/core/change-set.js';
import {
  ContentRepository,
  type ContentSnapshot,
  type RefInfo,
} from '../../content/core/content.repository.js';
import { FakeAssetReferenceStore } from '../../../tests/fakes/fake-asset-reference-store.js';
import { AssetReferenceIndex } from './asset-reference-index.js';
import { AssetReferences } from './asset-references.js';

const hash = (n: number) => n.toString(16).padStart(64, '0');

/** A module whose image blocks show `sha256:<hash>`. */
const showing = (id: string, lang: string, ...hashes: string[]): Module => ({
  ...module(id, lang),
  blocks: hashes.map((h, n) => ({
    type: 'image',
    id: `image-${n}`,
    asset: `sha256:${h}`,
    alt: 'An image',
  })),
});

/** Branches and tags, each at a snapshot of its own. */
class Repository extends ContentRepository {
  readonly snapshots = new Map<string, ContentSnapshot>();
  branches: RefInfo[] = [];
  tags: RefInfo[] = [];
  reads = 0;

  add(
    kind: 'branch' | 'tag',
    name: string,
    ...modules: Module[]
  ): FakeSnapshot {
    const snapshot = new FakeSnapshot({ modules });
    this.snapshots.set(snapshot.commit, snapshot);
    const list = kind === 'branch' ? this.branches : this.tags;
    list.push({ name, commit: snapshot.commit });
    return snapshot;
  }

  async at(ref: string) {
    this.reads++;
    return this.snapshots.get(ref);
  }

  async refs() {
    return { branches: this.branches, tags: this.tags };
  }
}

function changeSet(state: ChangeSetState): ChangeSet {
  const id = newChangeSetId();
  const now = new Date();
  return {
    id,
    title: 'Images',
    description: null,
    author: { kind: 'user', id: 'sample-author' },
    baseRef: 'main',
    baseCommit: 'c'.repeat(40),
    baseReleased: true,
    branch: changeSetBranch(id),
    state,
    createdAt: now,
    updatedAt: now,
  };
}

describe('AssetReferences', () => {
  it('finds a file at main, a tag, another branch, an open change set and a working copy', async () => {
    const open = changeSet('draft');
    const done = changeSet('abandoned');
    const repository = new Repository();
    repository.add('branch', 'main', showing('m', 'en', hash(1)));
    repository.add('branch', 'draft', showing('m', 'de', hash(2)));
    repository.add('branch', open.branch, showing('m', 'fr', hash(3)));
    // A closed change set's branch is kept, but no longer counts.
    repository.add('branch', done.branch, showing('m', 'fr', hash(4)));
    repository.add('tag', 'v1', showing('m', 'en', hash(1), hash(5)));
    const workingCopies = new FakeWorkingCopyStore();
    workingCopies.copies.set('copy', {
      content: showing('w', 'en', hash(6)),
    } as never);
    const uploads = new FakeAssetUploads();
    const uploaded = (changeSetId: string, sha256: string) =>
      uploads.uploads.push({ changeSetId, sha256 } as never);
    // An open change set's upload is used, placed or not; a closed one's is not.
    uploaded(open.id, hash(8));
    uploaded(done.id, hash(9));
    // An import's bundle, held while the import is kept.
    const held = new FakeHeldBlobs();
    held.hashes.add(hash(10));
    const store = new FakeAssetReferenceStore();
    const references = new AssetReferences(
      repository,
      new FakeChangeSetStore([open, done]),
      workingCopies,
      uploads,
      held,
      new AssetReferenceIndex(repository, store),
    );
    const all = Array.from({ length: 11 }, (_, n) => hash(n));
    const places = await references.placesOf(all);
    expect(places.get(hash(1))).toEqual([
      { in: 'main', ref: 'main' },
      { in: 'release', ref: 'v1' },
    ]);
    expect(places.get(hash(2))).toEqual([{ in: 'branch' }]);
    expect(places.get(hash(3))).toEqual([{ in: 'change-set' }]);
    expect(places.has(hash(4))).toBe(false);
    expect(places.get(hash(5))).toEqual([{ in: 'release', ref: 'v1' }]);
    expect(places.get(hash(6))).toEqual([{ in: 'working-copy' }]);
    expect(places.get(hash(8))).toEqual([{ in: 'change-set' }]);
    expect(places.has(hash(9))).toBe(false);
    expect(places.get(hash(10))).toEqual([{ in: 'import' }]);
    expect([...(await references.referenced())].sort()).toEqual(
      [1, 2, 3, 5, 6, 8, 10].map(hash),
    );
    // A commit is read once, and kept.
    const reads = repository.reads;
    await references.placesOf(all);
    await references.referenced();
    expect(repository.reads).toBe(reads);
    expect(store.commits.size).toBe(4);
  });

  it('reads a commit again only for the module files no indexed commit had', async () => {
    const repository = new Repository();
    const first = repository.add(
      'branch',
      'main',
      showing('a', 'en', hash(1)),
      showing('b', 'en', hash(2)),
    );
    const store = new FakeAssetReferenceStore();
    const index = new AssetReferenceIndex(repository, store);
    expect([...(await index.referencedAt([first.commit]))].sort()).toEqual([
      hash(1),
      hash(2),
    ]);
    // The next commit changes `b` only: `a` is not read again.
    const second = repository.add(
      'branch',
      'next',
      showing('a', 'en', hash(1)),
      showing('b', 'en', hash(3)),
    );
    // Reads of the files themselves, not of their revisions.
    const read: string[] = [];
    const file = second.file.bind(second);
    const revision = second.moduleRevision.bind(second);
    let revisions = 0;
    second.moduleRevision = async (id: string, lang: string) => {
      revisions++;
      return revision(id, lang);
    };
    second.file = async (path: string) => {
      read.push(path);
      return file(path);
    };
    expect(
      [...(await index.referencedAt([first.commit, second.commit]))].sort(),
    ).toEqual([hash(1), hash(2), hash(3)]);
    expect(revisions).toBe(2);
    // Two for the revisions, one for `b`'s text.
    expect(read.filter((path) => path.endsWith('.adoc')).sort()).toEqual([
      'modules/en/a.adoc',
      'modules/en/b.adoc',
      'modules/en/b.adoc',
    ]);
    expect(
      await index.mentioning([hash(1), hash(3)], [first.commit, second.commit]),
    ).toEqual(
      new Map([
        [hash(1), [first.commit, second.commit]],
        [hash(3), [second.commit]],
      ]),
    );
  });

  it('builds a commit the kept index lost again (another server dropped it)', async () => {
    const repository = new Repository();
    const main = repository.add('branch', 'main', showing('a', 'en', hash(1)));
    const store = new FakeAssetReferenceStore();
    const index = new AssetReferenceIndex(repository, store);
    expect(await index.mentioning([hash(1)], [main.commit])).toEqual(
      new Map([[hash(1), [main.commit]]]),
    );
    store.commits.clear();
    expect(await index.mentioning([hash(1)], [main.commit])).toEqual(
      new Map([[hash(1), [main.commit]]]),
    );
    expect(store.puts).toBe(2);
  });

  it('answers 503 rather than guess when a ref names a commit that is gone', async () => {
    const repository = new Repository();
    repository.branches.push({ name: 'main', commit: 'f'.repeat(40) });
    const index = new AssetReferenceIndex(
      repository,
      new FakeAssetReferenceStore(),
    );
    await expect(index.referencedAt(['f'.repeat(40)])).rejects.toMatchObject({
      code: 'content-unavailable',
    });
  });

  it('keeps nothing of a commit whose listed module file cannot be read (503)', async () => {
    const repository = new Repository();
    const main = repository.add('branch', 'main', showing('a', 'en', hash(1)));
    main.moduleRevision = async () => 'b'.repeat(40);
    main.file = async () => undefined;
    const store = new FakeAssetReferenceStore();
    const index = new AssetReferenceIndex(repository, store);
    await expect(index.referencedAt([main.commit])).rejects.toMatchObject({
      code: 'content-unavailable',
    });
    expect(store.commits.size).toBe(0);
  });

  it('rebuilds the commit of every branch and tag', async () => {
    const repository = new Repository();
    const main = repository.add('branch', 'main', showing('a', 'en', hash(1)));
    const v1 = repository.add('tag', 'v1', showing('a', 'en', hash(2)));
    const store = new FakeAssetReferenceStore();
    store.commits.set('e'.repeat(40), [hash(9)]);
    const index = new AssetReferenceIndex(repository, store);
    expect((await index.rebuild()).sort()).toEqual(
      [main.commit, v1.commit].sort(),
    );
    expect(store.commits).toEqual(
      new Map([
        [main.commit, [hash(1)]],
        [v1.commit, [hash(2)]],
      ]),
    );
  });

  it('counts a file a module that cannot be parsed mentions', async () => {
    const repository = new Repository();
    const main = repository.add('branch', 'main');
    Object.assign(main.content, { brokenModules: [{ id: 'x', lang: 'en' }] });
    main.file = async () =>
      new TextEncoder().encode(`not a module, but image::sha256:${hash(7)}[]`);
    const references = new AssetReferences(
      repository,
      new FakeChangeSetStore(),
      new FakeWorkingCopyStore(),
      new FakeAssetUploads(),
      new FakeHeldBlobs(),
      new AssetReferenceIndex(repository, new FakeAssetReferenceStore()),
    );
    expect((await references.placesOf([hash(7)])).get(hash(7))).toEqual([
      { in: 'main', ref: 'main' },
    ]);
  });
});
