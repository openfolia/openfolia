import { firstValueFrom } from 'rxjs';

import { type ApiClient, pageQuery } from '../api';
import type { RoleItem } from './admin-model';

/** Roles read per page, and the most pages read, for a picker of every role. */
const PAGE = 200;
const MAX_PAGES = 10;

/** Every role (up to 2,000), by name: what a role picker offers and how role IDs are named. */
export async function loadAllRoles(api: ApiClient): Promise<RoleItem[]> {
  const roles: RoleItem[] = [];
  for (let number = 1; number <= MAX_PAGES; number++) {
    const doc = await firstValueFrom(
      api.get('/roles', { query: pageQuery({ number, size: PAGE }) }),
    );
    roles.push(...doc.data);
    if (number >= doc.meta.page.lastPage) break;
  }
  return roles;
}
