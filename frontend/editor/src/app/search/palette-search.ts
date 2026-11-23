import {
  computed,
  DestroyRef,
  inject,
  Injectable,
  signal,
} from '@angular/core';
import { takeUntilDestroyed, toObservable } from '@angular/core/rxjs-interop';
import {
  catchError,
  concat,
  map,
  of,
  switchMap,
  timer,
  type Observable,
  type Subscription,
} from 'rxjs';

import {
  ApiClient,
  pageQuery,
  ReadRef,
  toApiError,
  type ApiError,
  type Item,
} from '../api';
import { MeService } from '../permissions/me';
import { PermissionService } from '../permissions/permission.service';
import { SEARCH_RULE } from './search-palette.service';

export type SearchResult = Item<'/search'>;

/** The longest query the API takes (after trimming). */
export const QUERY_MAX = 200;
/** Results per page: enough to fill the palette; more come on request. */
export const SEARCH_PAGE_SIZE = 20;
/** How long typing has to pause before a search is sent, in ms. */
export const SEARCH_DEBOUNCE = 200;

/** What the palette shows for its query. */
export type SearchState =
  | { readonly status: 'idle' }
  | {
      readonly status: 'loading';
      readonly term: string;
      /** The previous query's results, shown until the new ones arrive. */
      readonly previous: readonly SearchResult[];
    }
  | {
      readonly status: 'ready';
      readonly term: string;
      readonly results: readonly SearchResult[];
      readonly total: number;
      /** The last page read. */
      readonly page: number;
      readonly lastPage: number;
    }
  | {
      readonly status: 'error';
      readonly term: string;
      readonly error: ApiError;
    };

interface Key {
  readonly term: string;
  readonly ref: string | undefined;
  readonly user: string;
  readonly attempt: number;
}

const sameKey = (a: Key, b: Key): boolean =>
  a.term === b.term &&
  a.ref === b.ref &&
  a.user === b.user &&
  a.attempt === b.attempt;

/**
 * The palette's search over `GET /search`: the query, trimmed and capped, is sent once typing
 * pauses; a newer query, another change set (`ReadRef`) or another person cancels the answer in
 * flight and asks again, so results always match what is typed and who may read them. Results
 * are paged (`page[number]`, `page[size]`); `loadMore` appends the next page. Provided by
 * the palette; closing the palette clears the query, which puts it back to idle.
 */
@Injectable()
export class PaletteSearch {
  private readonly api = inject(ApiClient);
  private readonly readRef = inject(ReadRef);
  private readonly me = inject(MeService);
  private readonly permissions = inject(PermissionService);
  private readonly destroyRef = inject(DestroyRef);

  /** What is typed. */
  readonly query = signal('');
  private readonly attempt = signal(0);
  private readonly current = signal<SearchState>({ status: 'idle' });
  private readonly moreState = signal<'idle' | 'loading' | 'error'>('idle');
  private more: Subscription | null = null;
  /** The key the state on screen was asked for. */
  private shownFor: Key | null = null;

  readonly state = this.current.asReadonly();
  /** Loading the next page: `loading`, or `error` when it failed (the option offers a retry). */
  readonly moreStatus = this.moreState.asReadonly();
  /** The query as it is sent: trimmed, at most `QUERY_MAX` characters. */
  readonly term = computed(() =>
    Array.from(this.query().trim()).slice(0, QUERY_MAX).join('').trim(),
  );

  private readonly key = computed<Key>(
    () => ({
      // A role that may not read content never searches (the palette offers it actions only).
      term:
        this.permissions.state(SEARCH_RULE).kind === 'hidden'
          ? ''
          : this.term(),
      ref: this.readRef.ref(),
      user: this.me.me().id,
      attempt: this.attempt(),
    }),
    { equal: sameKey },
  );

  constructor() {
    toObservable(this.key)
      .pipe(
        switchMap((key) => {
          this.cancelMore();
          const before = this.shownFor;
          this.shownFor = key;
          if (!key.term) return of<SearchState>({ status: 'idle' });
          const state = this.current();
          // Only the same person's results in the same change set stay on screen while the new
          // ones load: another person's (or another branch's) are never shown, even briefly.
          const sameScope =
            before !== null &&
            before.user === key.user &&
            before.ref === key.ref;
          const previous = !sameScope
            ? []
            : state.status === 'ready'
              ? state.results
              : state.status === 'loading'
                ? state.previous
                : [];
          return concat(
            of<SearchState>({ status: 'loading', term: key.term, previous }),
            timer(SEARCH_DEBOUNCE).pipe(switchMap(() => this.fetch(key, 1))),
          );
        }),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((state) => this.current.set(state));
    this.destroyRef.onDestroy(() => this.cancelMore());
  }

  /** Asks again after a failure. */
  retry(): void {
    this.attempt.update((n) => n + 1);
  }

  /** Reads the next page and appends it. */
  loadMore(): void {
    const state = this.current();
    if (state.status !== 'ready' || state.page >= state.lastPage) return;
    if (this.moreState() === 'loading') return;
    const key = this.key();
    this.moreState.set('loading');
    this.more = this.fetch(key, state.page + 1).subscribe((next) => {
      this.more = null;
      const now = this.current();
      // Another query (or person, or change set) took over meanwhile: this page is not theirs.
      if (!sameKey(key, this.key()) || now.status !== 'ready') return;
      if (next.status !== 'ready') {
        this.moreState.set('error');
        return;
      }
      const seen = new Set(now.results.map((r) => r.id));
      this.moreState.set('idle');
      this.current.set({
        ...next,
        results: [
          ...now.results,
          ...next.results.filter((r) => !seen.has(r.id)),
        ],
      });
    });
  }

  private cancelMore(): void {
    this.more?.unsubscribe();
    this.more = null;
    this.moreState.set('idle');
  }

  private fetch(key: Key, number: number): Observable<SearchState> {
    return this.api
      .get('/search', {
        query: {
          'filter[q]': key.term,
          ...pageQuery({ number, size: SEARCH_PAGE_SIZE }),
        },
      })
      .pipe(
        map((doc): SearchState => ({
          status: 'ready',
          term: key.term,
          results: doc.data,
          total: doc.meta.page.total,
          page: doc.meta.page.currentPage,
          lastPage: doc.meta.page.lastPage,
        })),
        catchError((error: unknown) =>
          of<SearchState>({
            status: 'error',
            term: key.term,
            error: toApiError(error),
          }),
        ),
      );
  }
}
