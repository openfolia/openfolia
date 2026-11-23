import { AssetReferenceStore } from '../../src/assets/core/asset-reference-index.js';

/** In-memory `AssetReferenceStore`: per commit, its hashes; never prunes. */
export class FakeAssetReferenceStore extends AssetReferenceStore {
  readonly commits = new Map<string, readonly string[]>();
  /** How many commits were put. */
  puts = 0;

  async referencedAt(commits: readonly string[]) {
    const indexed = new Set<string>();
    const hashes = new Set<string>();
    for (const commit of commits) {
      const found = this.commits.get(commit);
      if (!found) continue;
      indexed.add(commit);
      for (const hash of found) hashes.add(hash);
    }
    return { indexed, hashes };
  }

  async mentioning(hashes: readonly string[], commits: readonly string[]) {
    const indexed = new Set<string>();
    const found = new Map<string, string[]>();
    for (const commit of commits) {
      const at = this.commits.get(commit);
      if (!at) continue;
      indexed.add(commit);
      for (const hash of hashes) {
        if (!at.includes(hash)) continue;
        const list = found.get(hash);
        if (list) list.push(commit);
        else found.set(hash, [commit]);
      }
    }
    return { indexed, commits: found };
  }

  async put(commit: string, hashes: readonly string[]): Promise<void> {
    this.puts++;
    if (!this.commits.has(commit)) this.commits.set(commit, [...hashes]);
  }

  async clear(): Promise<void> {
    this.commits.clear();
  }
}
