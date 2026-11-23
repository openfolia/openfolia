import { firstValueFrom } from 'rxjs';

import { type ApiClient, pageQuery } from '../../api';

/** Read per page, and the most pages read: up to 2,000 of each kind, deactivated ones too. */
const PAGE = 200;
const MAX_PAGES = 10;

/** Someone who may appear in the log: a person or a service account, by kind and ID. */
export interface KnownActor {
  readonly kind: 'user' | 'service';
  readonly id: string;
  readonly name: string;
}

/**
 * Every person and service account (up to 2,000 each): how the log names its actors. A kind
 * that cannot be read is left out (its actors are shown by ID).
 */
export async function loadActors(api: ApiClient): Promise<KnownActor[]> {
  const results = await Promise.allSettled([
    readAll(async (number) => {
      const doc = await firstValueFrom(
        api.get('/users', { query: pageQuery({ number, size: PAGE }) }),
      );
      return {
        items: doc.data.map((u): KnownActor => ({
          kind: 'user',
          id: u.id,
          name: u.attributes.name,
        })),
        last: doc.meta.page.lastPage,
      };
    }),
    readAll(async (number) => {
      const doc = await firstValueFrom(
        api.get('/service-accounts', {
          query: pageQuery({ number, size: PAGE }),
        }),
      );
      return {
        items: doc.data.map((s): KnownActor => ({
          kind: 'service',
          id: s.id,
          name: s.attributes.name,
        })),
        last: doc.meta.page.lastPage,
      };
    }),
  ]);
  return results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
}

async function readAll(
  page: (
    number: number,
  ) => Promise<{ items: readonly KnownActor[]; last: number }>,
): Promise<KnownActor[]> {
  const out: KnownActor[] = [];
  for (let number = 1; number <= MAX_PAGES; number++) {
    const { items, last } = await page(number);
    out.push(...items);
    if (number >= last) break;
  }
  return out;
}
