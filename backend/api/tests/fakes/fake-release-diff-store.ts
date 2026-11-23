import type { StoredReleaseDiff } from '../../src/releases/core/release-changes.js';
import { ReleaseDiffStore } from '../../src/releases/core/release-diff-store.js';

/**
 * `ReleaseDiffStore` in memory, by `<base>|<head>`. What is kept goes
 * through JSON, as Postgres's `jsonb` takes it, and like it holds no
 * `\0` in a string: such a diff is not kept (as the real store logs).
 */
export class FakeReleaseDiffStore extends ReleaseDiffStore {
  readonly rows = new Map<string, string>();

  find(
    base: string | undefined,
    head: string,
  ): Promise<StoredReleaseDiff | undefined> {
    const row = this.rows.get(`${base ?? ''}|${head}`);
    return Promise.resolve(
      row === undefined ? undefined : (JSON.parse(row) as StoredReleaseDiff),
    );
  }

  keep(
    base: string | undefined,
    head: string,
    diff: StoredReleaseDiff,
  ): Promise<void> {
    const json = JSON.stringify(diff);
    if (!json.includes('\\u0000')) this.rows.set(`${base ?? ''}|${head}`, json);
    return Promise.resolve();
  }
}
