import type { Module } from '@openfolia/content-model';
import {
  ContentRepository,
  type ContentSnapshot,
  type RefInfo,
} from '../../src/content/core/content.repository.js';
import {
  type CommitIndex,
  ModuleIndex,
  ModuleIndexStore,
} from '../../src/modules/core/module-index.js';
import { ReadableModuleIndex } from '../../src/modules/core/readable-module-index.js';
import { fakeChangedPaths, fakeSnapshotAt } from './fake-content.js';

/** `ModuleIndexStore` in memory, for unit tests; counts what it is asked. */
export class FakeModuleIndexStore extends ModuleIndexStore {
  readonly kept = new Map<string, CommitIndex>();
  puts = 0;

  get(commit: string): Promise<CommitIndex | undefined> {
    return Promise.resolve(this.kept.get(commit));
  }

  put(index: CommitIndex, keep: number): Promise<void> {
    this.puts++;
    if (!this.kept.has(index.commit)) this.kept.set(index.commit, index);
    while (this.kept.size > Math.max(keep, 1)) {
      const oldest = this.kept.keys().next().value as string;
      this.kept.delete(oldest);
    }
    return Promise.resolve();
  }

  clear(): Promise<void> {
    this.kept.clear();
    return Promise.resolve();
  }
}

/** A repository holding every fake snapshot made in this test process, by commit (and no refs). */
class EveryFakeSnapshot extends ContentRepository {
  at(ref: string): Promise<ContentSnapshot | undefined> {
    return Promise.resolve(fakeSnapshotAt(ref));
  }

  refs(): Promise<{ branches: RefInfo[]; tags: RefInfo[] }> {
    return Promise.resolve({ branches: [], tags: [] });
  }

  override differingPaths(from: string, to: string) {
    return fakeChangedPaths(from, to);
  }
}

/**
 * The module index over `content` (by default, every fake snapshot by its
 * commit) with a `FakeModuleIndexStore`, and its readers' views.
 */
export function fakeModuleIndex(
  content: ContentRepository = new EveryFakeSnapshot(),
) {
  const store = new FakeModuleIndexStore();
  const index = new ModuleIndex(store, content);
  return { store, index, readable: new ReadableModuleIndex(index) };
}

/** `m` with a module reference block to each of `ids` (inside a section, to be found anywhere). */
export const referring = (m: Module, ...ids: string[]): Module => ({
  ...m,
  blocks: [
    ...m.blocks,
    {
      type: 'section',
      id: 'refs',
      title: [{ type: 'text', text: 'More' }],
      blocks: ids.map((id, i) => ({
        type: 'moduleRef' as const,
        id: `ref-${i}`,
        module: id,
      })),
    },
  ],
});
