import { sql } from 'drizzle-orm';
import type { Actor } from '../src/access/core/actor.js';
import { ErrorDocument } from '../src/base/api/json-api.js';
import { actorWith } from './fakes/actors.js';
import type { TestApp } from './test-app.js';

/** What the e2e tests of the search's limits (#539) share. */
export const reader = (id: string): Actor => ({
  ...actorWith(['content.read']),
  id,
});
export const q = (query: string) =>
  `/search?filter[q]=${encodeURIComponent(query)}`;
export const errors = (body: unknown) => ErrorDocument.parse(body).errors;

/** Every read of a scope's member sets sleeps `seconds` once per statement, until `speedUp`. */
export async function slowDown(t: TestApp, seconds: number): Promise<void> {
  await t.database.db.execute(
    sql.raw('alter table search_member_sets rename to search_member_sets_real'),
  );
  await t.database.db.execute(
    sql.raw(`create view search_member_sets as select * from search_member_sets_real
      where (select pg_sleep(${seconds})::text) is not null`),
  );
}
export async function speedUp(t: TestApp): Promise<void> {
  await t.database.db.execute(sql.raw('drop view search_member_sets'));
  await t.database.db.execute(
    sql.raw('alter table search_member_sets_real rename to search_member_sets'),
  );
}
