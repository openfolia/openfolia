import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSampleRepo } from '../testing.js';
import {
  GitRepo,
  INDEX_SHARES,
  MODULE_LISTINGS_SHARE,
  REF_GENERATIONS_KEPT,
  refGeneration,
  refGenerationsKept,
  refsMoved,
} from './git.js';
import { ContentRepo } from './snapshot.js';

/** #552: every cache of a repository is bounded, the indexes by their bytes. */
const { dir, commits } = createSampleRepo();
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('ref generations (#552)', () => {
  it('stay bounded however many repositories are written', () => {
    const base = join(tmpdir(), 'openfolia-no-such-repository');
    for (let i = 0; i < REF_GENERATIONS_KEPT + 500; i++) {
      refsMoved(`${base}-${i}`);
    }
    expect(refGenerationsKept()).toBeLessThanOrEqual(REF_GENERATIONS_KEPT);
  });

  it('never read a forgotten repository as it was before its last write', () => {
    const repository = join(tmpdir(), 'openfolia-forgotten-repository');
    const before = refGeneration(repository);
    refsMoved(repository);
    const written = refGeneration(repository);
    expect(written).toBeGreaterThan(before);
    // Forgotten: as many other repositories written after it as are kept.
    for (let i = 0; i < REF_GENERATIONS_KEPT; i++) {
      refsMoved(join(tmpdir(), `openfolia-other-repository-${i}`));
    }
    const forgotten = refGeneration(repository);
    expect(forgotten).not.toBe(before);
    expect(forgotten).toBeGreaterThanOrEqual(written);
    // And a write after that is a new generation again.
    refsMoved(repository);
    expect(refGeneration(repository)).toBeGreaterThan(forgotten);
  });
});

describe('ref listings after a repository is forgotten (#552)', () => {
  it('never share a listing begun before the last write', async () => {
    // A repository of its own, never written in this process yet.
    const own = createSampleRepo();
    try {
      const git = new GitRepo(own.dir);
      const reads = vi.spyOn(
        git as unknown as { readRefs: () => Promise<unknown> },
        'readRefs',
      );
      const before = git.refs();
      refsMoved(own.dir);
      for (let i = 0; i < REF_GENERATIONS_KEPT; i++) {
        refsMoved(join(tmpdir(), `openfolia-evicting-repository-${i}`));
      }
      const after = git.refs();
      await Promise.all([before, after]);
      expect(reads).toHaveBeenCalledTimes(2);
      git.close();
    } finally {
      rmSync(own.dir, { recursive: true, force: true });
    }
  });
});

describe('index caches (#552)', () => {
  const budget = 64 * 1024;

  it('split the budget between them, all of it at most', () => {
    const shares =
      Object.values(INDEX_SHARES).reduce((a, b) => a + b, 0) +
      MODULE_LISTINGS_SHARE;
    expect(shares).toBeCloseTo(1);
    const git = new GitRepo(dir, 'git', { indexCacheBytes: budget });
    const capacities = Object.values(git.indexCacheWeights()).map(
      (w) => w.capacity,
    );
    const listings = new ContentRepo(git, {
      indexCacheBytes: budget,
    }).moduleListingsWeight().capacity;
    expect(
      capacities.reduce((a, b) => a + b, 0) + listings,
    ).toBeLessThanOrEqual(budget);
  });

  it('keep at most their bytes, however long and many the paths', async () => {
    const git = new GitRepo(dir, 'git', { indexCacheBytes: budget });
    const long = (i: number) => `modules/${'x'.repeat(400)}-${i}.adoc`;
    // Blob IDs by path, missing files included: each a long key.
    for (let i = 0; i < 300; i++) {
      await git.readFileWithId(commits.main, long(i));
    }
    // Folder listings and blob IDs by folder.
    for (let i = 0; i < 8; i++) {
      await git.listFiles(commits.main, `${'y'.repeat(300)}${i}`);
      await git.fileIds(commits.main, `${'z'.repeat(300)}${i}`);
    }
    await git.listFiles(commits.main, 'modules');
    await git.fileIds(commits.main, 'modules');
    await git.changedPaths(commits.v1, commits.main);
    await git.pathHistory(commits.main, 'manuals/operating.yaml', 50);
    await git.deletedFiles(commits.main, 'modules', 50);
    const weights = git.indexCacheWeights();
    for (const [name, { bytes, capacity }] of Object.entries(weights)) {
      expect(bytes, name).toBeLessThanOrEqual(capacity);
    }
    // Weighed in bytes, not entries: 300 keys of over 400 characters do not fit in its
    // 12.8 KiB, so it is full.
    expect(weights.fileIds.bytes).toBeGreaterThan(weights.fileIds.capacity / 2);
    git.close();
  }, 30_000);

  it('keep the newest whole-folder index however large the folder, whatever is read between', async () => {
    const git = new GitRepo(dir, 'git', { indexCacheBytes: 100 });
    const ids = await git.fileIds(commits.main, 'modules');
    const files = await git.listFiles(commits.main, 'modules');
    // Other folders read in between, as a manifest's and a module's revision are.
    await git.fileIds(commits.main, 'manuals');
    await git.listFiles(commits.main, 'manuals');
    await git.fileIds(commits.main, 'assets');
    const weights = git.indexCacheWeights();
    expect(weights.blobIds.pinned).toBeGreaterThan(weights.blobIds.capacity);
    expect(weights.listings.pinned).toBeGreaterThan(weights.listings.capacity);
    expect(weights.blobIds.bytes).toBeLessThanOrEqual(weights.blobIds.capacity);
    // From the cache: the same objects again.
    expect(await git.fileIds(commits.main, 'modules')).toBe(ids);
    expect(await git.listFiles(commits.main, 'modules')).toBe(files);
    git.close();
  });

  it('weigh a commit’s module listing by its files', async () => {
    const repo = ContentRepo.open(dir, { indexCacheBytes: budget });
    try {
      const snapshot = await repo.at('main');
      const modules = await snapshot!.modules();
      // Weighed again once listed.
      await Promise.resolve();
      const { bytes, capacity } = repo.moduleListingsWeight();
      expect(bytes).toBeGreaterThan(modules.length * 2);
      expect(bytes).toBeLessThanOrEqual(capacity);
    } finally {
      repo.close();
    }
  });
});
