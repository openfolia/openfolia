import { ContentChanges } from '../../src/chunks/core/content-changes.js';

/**
 * In-memory `ContentChanges`: `history` lists, per commit, the commits in
 * its history (itself included is implied); `changed` the paths that
 * differ between two commits, by `<from>..<to>`.
 */
export class FakeContentChanges extends ContentChanges {
  readonly asked: { from: string; to: string }[] = [];

  constructor(
    private readonly history: Record<string, readonly string[]> = {},
    private readonly changed: Record<string, readonly string[]> = {},
  ) {
    super();
  }

  contains(commit: string, since: string): Promise<boolean> {
    return Promise.resolve(
      commit === since || (this.history[commit] ?? []).includes(since),
    );
  }

  changedPaths(from: string, to: string): Promise<string[]> {
    this.asked.push({ from, to });
    return Promise.resolve([...(this.changed[`${from}..${to}`] ?? [])]);
  }
}
