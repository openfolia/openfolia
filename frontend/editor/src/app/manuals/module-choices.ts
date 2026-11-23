import { computed, inject, Injectable, signal, untracked } from '@angular/core';
import { takeUntilDestroyed, toObservable } from '@angular/core/rxjs-interop';
import {
  catchError,
  combineLatest,
  debounceTime,
  distinctUntilChanged,
  EMPTY,
  exhaustMap,
  filter,
  map,
  of,
  startWith,
  Subject,
  switchMap,
} from 'rxjs';

import { ApiClient, pageQuery, ReadRef } from '../api';
import type { ModuleSummary } from '../content/browser-model';
import { MeService } from '../permissions/me';

/** Modules the add list reads at a time; typing narrows them on the server, "Show more" reads on. */
export const CHOICES_SHOWN = 50;
/** How long typing pauses before the list is searched, in ms. */
export const CHOICES_DEBOUNCE = 200;
/** The longest search the API takes (`filter[q]`). */
const QUERY_MAX = 200;

/** What the add list shows: the modules found, how many there are, and how the search stands. */
export interface ModuleChoicesState {
  readonly status: 'idle' | 'loading' | 'ready' | 'error';
  /** The modules found, by title; while loading, those of the last search (shown dimmed). */
  readonly items: readonly ModuleSummary[];
  /** How many modules the search found in all (`meta.page.total`). */
  readonly total: number;
  /** A page after the last one read exists (`meta.page.lastPage`): "Show more" reads it. */
  readonly more: boolean;
  /** Reading the next page failed: what was read stays, "Show more" reads that page again. */
  readonly moreFailed: boolean;
}

const IDLE: ModuleChoicesState = {
  status: 'idle',
  items: [],
  total: 0,
  more: false,
  moreFailed: false,
};

/**
 * The modules a manual's add list offers (#481): searched on the server by title or ID
 * (`GET /module-summaries?filter[q]=`), a page of `CHOICES_SHOWN` by title, only while the list is
 * open, never the whole collection; `more` adds the next page (a manual holding most of the first
 * page's modules still offers the rest). `open` starts reading (and `reload` reads again: a search
 * failed, a module was made), `close` stops; `query` is what is typed. Another person, ref or head
 * of the branch reads the list again by itself, and shows nothing of the one before meanwhile; an
 * answer read for the one before never lands (#716).
 */
@Injectable()
export class ModuleChoices {
  private readonly api = inject(ApiClient);
  private readonly me = inject(MeService).me;
  private readonly readRef = inject(ReadRef);
  private readonly active = signal(false);
  private readonly reloads = signal(0);
  /** What is typed in the add list. */
  readonly query = signal('');
  private readonly current = signal<ModuleChoicesState>(IDLE);
  private readonly more$ = new Subject<void>();
  /** The search the list shows (or reads): what is typed, once the pause is over. */
  private searched = '';
  /** Who reads, and at which ref: what is shown was read for these only. */
  private readonly scope = computed(
    () => `${this.me().id}\n${this.readRef.ref() ?? ''}`,
  );
  /** The scope the list in `current` was read in. */
  private shownScope = '';
  readonly state = this.current.asReadonly();

  constructor() {
    const term$ = toObservable(this.query).pipe(
      debounceTime(CHOICES_DEBOUNCE),
      map(searchTerm),
      startWith(''),
      distinctUntilChanged(),
    );
    combineLatest([
      toObservable(this.active),
      term$,
      toObservable(this.reloads),
      toObservable(this.scope),
      // A new head of the same branch (an update from main, #466): read again, the list kept.
      toObservable(this.readRef.moves),
    ])
      .pipe(
        switchMap(([active, term, , scope]) => {
          this.searched = term;
          if (!active) return of(IDLE);
          // The last answer stays (dimmed) until this one is there: only the same person's, at
          // the same ref.
          const shown = scope === this.shownScope ? this.current() : IDLE;
          this.shownScope = scope;
          // Read for another person or ref than the one now (it changed, and nothing has reacted
          // yet): dropped; the change reads again.
          const live = () => untracked(this.scope) === scope;
          let items: readonly ModuleSummary[] = [];
          let read = 0;
          let total = 0;
          let more = false;
          return this.more$.pipe(
            startWith(undefined),
            // One page at a time: "Show more" while one is on its way reads nothing more.
            exhaustMap(() => {
              const number = read + 1;
              const before: ModuleChoicesState =
                read === 0
                  ? shown
                  : { status: 'ready', items, total, more, moreFailed: false };
              return this.api
                .get('/module-summaries', {
                  query: {
                    ...(term ? { 'filter[q]': term } : {}),
                    ...pageQuery({ number, size: CHOICES_SHOWN }),
                  },
                })
                .pipe(
                  filter(live),
                  map((doc): ModuleChoicesState => {
                    read = number;
                    // A module renamed or added between two pages may come twice: once is enough.
                    const listed = new Set(items.map((s) => s.id));
                    items =
                      number === 1
                        ? doc.data
                        : [
                            ...items,
                            ...doc.data.filter((s) => !listed.has(s.id)),
                          ];
                    total = doc.meta.page.total;
                    // The API's last page, not the count: modules that came twice are
                    // dropped, so the list can hold fewer than the total and still be complete.
                    more =
                      doc.data.length > 0 && number < doc.meta.page.lastPage;
                    return {
                      status: 'ready',
                      items,
                      total,
                      more,
                      moreFailed: false,
                    };
                  }),
                  startWith<ModuleChoicesState>({
                    ...before,
                    status: 'loading',
                  }),
                  // The first page failed: the search did. A later one: what was read stays.
                  catchError(() =>
                    !live()
                      ? EMPTY
                      : of<ModuleChoicesState>(
                          number === 1
                            ? { ...IDLE, status: 'error' }
                            : {
                                status: 'ready',
                                items,
                                total,
                                more,
                                moreFailed: true,
                              },
                        ),
                  ),
                );
            }),
          );
        }),
        takeUntilDestroyed(),
      )
      .subscribe((state) => this.current.set(state));
  }

  /** The add list opened: its modules are read. */
  open(): void {
    this.active.set(true);
  }

  /** The add list closed: nothing more is read, and the search starts empty next time. */
  close(): void {
    this.active.set(false);
    this.query.set('');
  }

  /**
   * Adds the next page of what the search found (again, after it failed). False when nothing
   * is read: a search typed or still on its way, or no page left.
   */
  more(): boolean {
    const state = this.current();
    if (state.status !== 'ready' || !state.more) return false;
    // Typed, the pause not over: the next page would be the old search's.
    if (searchTerm(this.query()) !== this.searched) return false;
    this.more$.next();
    return true;
  }

  /** Reads again what is shown (another branch or person, or after a failure). */
  reload(): void {
    if (this.active()) this.reloads.update((n) => n + 1);
  }
}

/** What is typed, as the search sends it: trimmed, at most `QUERY_MAX` characters. */
function searchTerm(text: string): string {
  return Array.from(text.trim()).slice(0, QUERY_MAX).join('').trim();
}
