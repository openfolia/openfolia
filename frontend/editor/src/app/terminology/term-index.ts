import { inject, Injectable, signal, untracked } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { ApiClient, pageQuery } from '../api';
import { MeService } from '../permissions/me';
import { isReadable } from './terms-model';

/** Terms are read this many at a time (the API's largest page), for at most this many pages. */
const INDEX_PAGE = 200;
const INDEX_PAGES = 10;

/** One term as the index keeps it: enough to name it, filter by domain and find its links. */
export interface IndexedTerm {
  readonly id: string;
  /** The preferred variant per language. */
  readonly preferred: Readonly<Record<string, string>>;
  readonly domain: string | undefined;
  readonly status: string;
  readonly replacedBy: string | undefined;
}

/**
 * Every term at the branch read (`GET /terms`, a page of 200 at a time, at most 2,000 terms):
 * the domains the filter offers, the terms a deprecated one may name as its replacement, the IDs
 * a new term may not take and the terms that name another as their replacement (which keeps that
 * one from being deleted). `complete` is false when there were more than it read. A failed read
 * leaves none (the API's own checks still hold): what it had may be another ref's or another
 * person's, and a read started for the person before the one acting now never lands (#706).
 */
@Injectable()
export class TermIndex {
  private readonly api = inject(ApiClient);
  private readonly me = inject(MeService).me;

  readonly terms = signal<readonly IndexedTerm[]>([]);
  readonly complete = signal(true);
  readonly ready = signal(false);
  private runs = 0;
  /** Who `terms` were read for. */
  private readFor: string | null = null;

  async load(): Promise<void> {
    const run = ++this.runs;
    const who = untracked(() => this.me().id);
    const live = () =>
      run === this.runs && who === untracked(() => this.me().id);
    // Another person: what was read for the one before goes at once.
    if (who !== this.readFor) {
      this.readFor = who;
      this.terms.set([]);
      this.ready.set(false);
    }
    const found: IndexedTerm[] = [];
    try {
      for (let page = 1; page <= INDEX_PAGES; page++) {
        const doc = await firstValueFrom(
          this.api.get('/terms', {
            query: pageQuery({ number: page, size: INDEX_PAGE }),
          }),
        );
        if (!live()) return;
        for (const item of doc.data) {
          if (!isReadable(item)) continue;
          const a = item.attributes;
          found.push({
            id: item.id,
            preferred: Object.fromEntries(
              Object.entries(a.languages).map(([l, e]) => [l, e.preferred]),
            ),
            domain: a.domain,
            status: a.status,
            replacedBy: a.replacedBy,
          });
        }
        if (page >= doc.meta.page.lastPage) {
          this.complete.set(true);
          break;
        }
        if (page === INDEX_PAGES) this.complete.set(false);
      }
      this.terms.set(found);
      this.ready.set(true);
    } catch {
      // A help, not a condition: the filter offers none, and the API checks the rest.
      if (live()) {
        this.terms.set([]);
        this.ready.set(true);
      }
    }
  }

  /** The domains in use, sorted as the person reads them. */
  domains(locale: string): string[] {
    const seen = new Map<string, string>();
    for (const t of this.terms()) {
      if (!t.domain) continue;
      const key = t.domain.toLocaleLowerCase(locale);
      if (!seen.has(key)) seen.set(key, t.domain);
    }
    return [...seen.values()].sort((a, b) => a.localeCompare(b, locale));
  }

  /** The terms that name `id` as their replacement. */
  linksTo(id: string): readonly IndexedTerm[] {
    return this.terms().filter((t) => t.replacedBy === id && t.id !== id);
  }

  has(id: string): boolean {
    return this.terms().some((t) => t.id === id);
  }
}
