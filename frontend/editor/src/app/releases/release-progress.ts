import { Injectable, signal } from '@angular/core';

import type { OutputProgress } from './releases-model';

/**
 * How far each release's files are, for the list: the list's answer says it of every release on
 * the page, and a release's own read of that release (`meta.outputs`: being planned, rendering,
 * done or failed, counted as the person may read them), so the list makes no read per release
 * (#481). `take` keeps what an answer says. A release whose files cannot be counted (its tag
 * unreadable: `meta.outputs` null) counts as failed to read.
 */
@Injectable()
export class ReleaseProgress {
  private readonly counts = signal<ReadonlyMap<string, OutputProgress>>(
    new Map(),
  );
  /** Counts that failed to read, by release. */
  private readonly failures = signal<ReadonlySet<string>>(new Set());

  /** The release's progress; undefined until counted. */
  of(releaseId: string): OutputProgress | undefined {
    return this.counts().get(releaseId);
  }

  failed(releaseId: string): boolean {
    return this.failures().has(releaseId);
  }

  /** Forgets every count (another person acts now). */
  clear(): void {
    this.counts.set(new Map());
    this.failures.set(new Set());
  }

  /** Keeps where the files of these releases stand, as an answer that lists them says. */
  take(
    releases: readonly {
      readonly id: string;
      readonly meta: { readonly outputs: OutputProgress | null };
    }[],
  ): void {
    if (releases.length === 0) return;
    const counts = new Map(this.counts());
    const failures = new Set(this.failures());
    for (const { id, meta } of releases) {
      if (meta.outputs) {
        counts.set(id, meta.outputs);
        failures.delete(id);
      } else {
        counts.delete(id);
        failures.add(id);
      }
    }
    this.counts.set(counts);
    this.failures.set(failures);
  }
}
