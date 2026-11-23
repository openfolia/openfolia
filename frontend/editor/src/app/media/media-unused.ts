import { Injectable, inject } from '@angular/core';
import { firstValueFrom, Observable } from 'rxjs';

import { ApiClient } from '../api';

/** The unused list is read in pages this large to find a file on it (the API's largest). */
export const SCAN_PAGE_SIZE = 200;
/** At most this many such pages are read: past them, where the file is stays unknown. */
export const SCAN_PAGES = 5;

/**
 * Where a file is on the "Unused" list (unfiltered): `index`, its position (from 0); `absent` when
 * the whole list was read and it is not there; `unknown` when the list is longer than what was
 * read.
 */
export type UnusedPlace =
  | { readonly kind: 'listed'; readonly index: number }
  | { readonly kind: 'absent' }
  | { readonly kind: 'unknown' };

/** One page of the unused list: the hashes on it, in order, and how many pages there are. */
export interface UnusedPage {
  readonly ids: readonly string[];
  readonly lastPage: number;
}

/**
 * Finds a file on the unused list, reading it page by page (`SCAN_PAGE_SIZE`, at most
 * `SCAN_PAGES` pages, one after the other, never past an abort), and answers its position.
 */
export async function findUnused(
  hash: string,
  read: (page: number) => Promise<UnusedPage>,
  abort?: AbortSignal,
): Promise<UnusedPlace> {
  for (let page = 1; page <= SCAN_PAGES; page++) {
    abort?.throwIfAborted();
    const { ids, lastPage } = await read(page);
    const at = ids.indexOf(hash);
    if (at >= 0)
      return { kind: 'listed', index: (page - 1) * SCAN_PAGE_SIZE + at };
    if (ids.length < SCAN_PAGE_SIZE || page >= lastPage)
      return { kind: 'absent' };
  }
  return { kind: 'unknown' };
}

/**
 * Looks a file up on the "Unused" list (`GET /assets?filter[unused]=true`, no other filter), so
 * the details of a file no module shown uses can say whether it can be deleted there. Only for a
 * role that may list unused files (else the API answers 403).
 */
@Injectable()
export class UnusedLocator {
  private readonly api = inject(ApiClient);

  find(hash: string, abort?: AbortSignal): Promise<UnusedPlace> {
    return findUnused(
      hash,
      async (page) => {
        const doc = await firstValueFrom(
          this.api
            .get('/assets', {
              query: {
                'filter[unused]': 'true',
                'page[number]': page,
                'page[size]': SCAN_PAGE_SIZE,
              },
            })
            .pipe(takeUntilAborted(abort)),
        );
        return {
          ids: doc.data.map((f) => f.id),
          lastPage: doc.meta.page.lastPage,
        };
      },
      abort,
    );
  }
}

/** Ends the request (unsubscribing cancels it) once `abort` fires, failing with its reason. */
function takeUntilAborted<T>(abort?: AbortSignal) {
  return (source: Observable<T>): Observable<T> =>
    new Observable<T>((subscriber) => {
      if (abort?.aborted) {
        subscriber.error(abort.reason);
        return;
      }
      const stop = () => subscriber.error(abort?.reason);
      abort?.addEventListener('abort', stop, { once: true });
      const sub = source.subscribe(subscriber);
      return () => {
        abort?.removeEventListener('abort', stop);
        sub.unsubscribe();
      };
    });
}
