import { DestroyRef, inject, Injectable, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { translated } from '@openfolia/ui/i18n';
import { ToastService } from '@openfolia/ui/toast';

import { ApiClient, pageQuery } from '../api';
import type { ModuleSummary } from '../content/browser-model';

/** The most IDs one read asks for: a full page (`filter[id]` takes as many as a page holds). */
export const IDS_PER_READ = 200;
/**
 * The most characters of IDs one read names, commas included, so its address stays well under
 * what servers and proxies take (8 KiB is a common limit for a request line).
 */
export const ID_CHARS_PER_READ = 6000;
/** How long the first retry after a failed read waits, in ms; each further failure doubles it. */
export const RETRY_FIRST = 2000;
/** The longest wait between two retries, in ms. */
export const RETRY_MAX = 60_000;

/**
 * The module summaries a manual's outline shows (#481): titles, languages, status and
 * deprecation of the modules it names, read by ID (`GET /module-summaries?filter[id]=`), never
 * the whole list. `want` reads the IDs not asked for yet in this reading, a page of them per
 * request; `reset` starts a new reading (another branch, person or head). IDs asked for that the
 * branch does not have (as the person sees it) are `absent`. A read that fails leaves its IDs
 * unknown and backs off (#561): nothing is read until the wait is over (`RETRY_FIRST`, doubled
 * per failure up to `RETRY_MAX`), then one retry asks for what the outline wants by then. The
 * first failure says so in a toast (with "Try again"), once until a read succeeds or a new
 * reading starts; either closes it, as leaving the page does.
 */
@Injectable()
export class OutlineSummaries {
  private readonly api = inject(ApiClient);
  private readonly known = signal<ReadonlyMap<string, ModuleSummary> | null>(
    null,
  );
  private readonly missing = signal<ReadonlySet<string>>(new Set());
  /** The summaries read in this reading, by module ID; null until the first answer. */
  readonly summaries = this.known.asReadonly();
  /** The IDs asked for that the branch has no module of. */
  readonly absent = this.missing.asReadonly();
  /** IDs asked for in this reading (answered, or on their way). */
  private asked = new Set<string>();
  private generation = 0;
  /** The IDs the last `want` named: what a retry asks for. */
  private latest: readonly string[] = [];
  /** Reads failed in a row in this reading. */
  private failures = 0;
  /** The retry waiting after a failure; nothing is read while it waits. */
  private retry: ReturnType<typeof setTimeout> | null = null;
  /** The failure's toast while it is shown. */
  private notice: number | null = null;
  /** The page is gone: a read still on its way neither retries nor says anything. */
  private destroyed = false;
  private readonly toast = inject(ToastService);

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      this.destroyed = true;
      this.generation++;
      this.stopRetry();
      this.dismissNotice();
    });
  }

  /**
   * A new reading: everything is asked for again. `keep`: what is known stays shown until the
   * new answers replace it; else it is forgotten at once.
   */
  reset(keep = false): void {
    this.generation++;
    this.asked = new Set();
    this.failures = 0;
    this.stopRetry();
    this.dismissNotice();
    if (!keep) {
      this.known.set(null);
      this.missing.set(new Set());
    }
  }

  /** Reads the summaries of these modules that this reading has not asked for yet. */
  async want(ids: Iterable<string>): Promise<void> {
    this.latest = [...new Set(ids)];
    // Backing off after a failure: the retry asks for these.
    if (this.retry !== null || this.destroyed) return;
    const todo = this.latest.filter((id) => !this.asked.has(id));
    if (todo.length === 0) return;
    for (const id of todo) this.asked.add(id);
    const generation = this.generation;
    let failed = false;
    await Promise.all(
      chunks(todo).map(async (chunk) => {
        try {
          const doc = await firstValueFrom(
            this.api.get('/module-summaries', {
              query: {
                'filter[id]': chunk.join(','),
                ...pageQuery({ number: 1, size: IDS_PER_READ }),
              },
            }),
          );
          if (generation !== this.generation) return;
          this.take(chunk, doc.data);
        } catch {
          if (generation !== this.generation) return;
          // Not known now: asked for again by the retry.
          for (const id of chunk) this.asked.delete(id);
          failed = true;
        }
      }),
    );
    if (generation !== this.generation) return;
    if (failed) this.backOff();
    // A read that began before another failed leaves that failure's count and wait alone.
    else if (this.retry === null) {
      this.failures = 0;
      this.dismissNotice();
    }
  }

  /** Reads now what is still unknown, without waiting for the backoff. */
  retryNow(): void {
    this.stopRetry();
    void this.want(this.latest);
  }

  private backOff(): void {
    if (this.retry !== null || this.destroyed) return;
    this.failures++;
    if (this.failures === 1) {
      this.notice = this.toast.error(
        translated('editor.manuals.summaries.failed'),
        {
          actionLabel: translated('editor.session.retry'),
          onAction: () => {
            this.notice = null;
            this.retryNow();
          },
        },
      );
    }
    const wait = Math.min(RETRY_FIRST * 2 ** (this.failures - 1), RETRY_MAX);
    this.retry = setTimeout(() => {
      this.retry = null;
      void this.want(this.latest);
    }, wait);
  }

  private dismissNotice(): void {
    if (this.notice === null) return;
    this.toast.dismiss(this.notice);
    this.notice = null;
  }

  private stopRetry(): void {
    if (this.retry === null) return;
    clearTimeout(this.retry);
    this.retry = null;
  }

  /** A module this page made or picked: shown at once with what is known of it. */
  put(summary: ModuleSummary): void {
    this.asked.add(summary.id);
    this.known.update((all) => new Map(all ?? []).set(summary.id, summary));
    this.missing.update((s) => without(s, [summary.id]));
  }

  private take(asked: readonly string[], found: readonly ModuleSummary[]) {
    const next = new Map(this.known() ?? []);
    const there = new Set<string>();
    for (const s of found) {
      next.set(s.id, s);
      there.add(s.id);
    }
    const gone = asked.filter((id) => !there.has(id));
    for (const id of gone) next.delete(id);
    this.known.set(next);
    const absent = new Set(without(this.missing(), there));
    for (const id of gone) absent.add(id);
    this.missing.set(absent);
  }
}

/** The IDs in reads of at most `IDS_PER_READ` IDs and `ID_CHARS_PER_READ` characters each. */
export function chunks(ids: readonly string[]): string[][] {
  const all: string[][] = [];
  let current: string[] = [];
  let chars = 0;
  for (const id of ids) {
    const more = id.length + (current.length > 0 ? 1 : 0);
    if (
      current.length > 0 &&
      (current.length >= IDS_PER_READ || chars + more > ID_CHARS_PER_READ)
    ) {
      all.push(current);
      current = [];
      chars = 0;
    }
    chars += id.length + (current.length > 0 ? 1 : 0);
    current.push(id);
  }
  if (current.length > 0) all.push(current);
  return all;
}

function without(
  set: ReadonlySet<string>,
  ids: Iterable<string>,
): ReadonlySet<string> {
  let next: Set<string> | null = null;
  for (const id of ids) {
    if (!set.has(id)) continue;
    next ??= new Set(set);
    next.delete(id);
  }
  return next ?? set;
}
