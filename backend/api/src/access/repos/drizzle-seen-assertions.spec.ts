import {
  createTestDatabase,
  type PgliteDatabase,
} from '../../../tests/database.js';
import { DrizzleSeenAssertions } from './drizzle-seen-assertions.js';
import { samlSeenAssertions } from './saml.tables.js';

describe('DrizzleSeenAssertions (#376)', () => {
  let database: PgliteDatabase;
  let seen: DrizzleSeenAssertions;
  let clock: number;
  beforeEach(async () => {
    database = await createTestDatabase();
    seen = new DrizzleSeenAssertions(database);
    clock = Date.parse('2026-11-25T10:00:00Z');
    seen.now = () => clock;
  });
  afterEach(async () => {
    await database.close();
  });

  const at = (ms: number) => new Date(clock + ms);

  it('records an assertion once, and only once at the same time', async () => {
    const results = await Promise.all([
      seen.recordOnce('["assertion","idp","_a1"]', at(60_000)),
      seen.recordOnce('["assertion","idp","_a1"]', at(60_000)),
    ]);
    expect(results.sort()).toEqual([false, true]);
    expect(await seen.recordOnce('["assertion","idp","_a2"]', at(60_000))).toBe(
      true,
    );
  });

  it('takes a key again once its time has passed, and deletes those past theirs', async () => {
    expect(await seen.recordOnce('a', at(60_000))).toBe(true);
    expect(await seen.recordOnce('b', at(10_000))).toBe(true);
    clock += 30_000;
    expect(await seen.recordOnce('a', at(60_000))).toBe(false);
    clock += 60_000;
    expect(await seen.recordOnce('a', at(60_000))).toBe(true);
    const rows = await database.db.select().from(samlSeenAssertions);
    // `b` went; only the key's hash is kept.
    expect(rows).toHaveLength(1);
    expect(rows[0]!.keyHash).toMatch(/^[0-9a-f]{64}$/);
  });
});
