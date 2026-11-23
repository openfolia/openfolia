import { sql } from 'drizzle-orm';
import {
  createTestDatabase,
  type PgliteDatabase,
} from '../../../tests/database.js';
import { users } from '../../access/repos/access.tables.js';
import { DEFAULT_PREFERENCES } from '../core/preferences.js';
import { DrizzlePreferenceStore } from './drizzle-preference-store.js';

let database: PgliteDatabase;
beforeAll(async () => {
  database = await createTestDatabase();
  await database.db.insert(users).values([
    { id: 'alice', name: 'Alice' },
    { id: 'bob', name: 'Bob' },
  ]);
});
afterAll(() => database?.close());
afterEach(() => database.db.execute(sql`delete from user_preferences`));

describe('DrizzlePreferenceStore', () => {
  it('reads the defaults until a first change, then what was changed', async () => {
    const store = new DrizzlePreferenceStore(database);
    expect(await store.read('alice')).toEqual({
      preferences: DEFAULT_PREFERENCES,
      updatedAt: null,
    });
    const first = await store.write('alice', { tourDone: true });
    expect(first?.preferences).toEqual({
      ...DEFAULT_PREFERENCES,
      tourDone: true,
    });
    const second = await store.write('alice', {
      showTips: false,
      dismissedTips: ['content.new-module', 'shell.search'],
    });
    expect(second?.preferences).toEqual({
      showTips: false,
      dismissedTips: ['content.new-module', 'shell.search'],
      tourDone: true,
    });
    expect(await store.read('alice')).toEqual(second);
    // Another person's are their own.
    expect((await store.read('bob')).preferences).toEqual(DEFAULT_PREFERENCES);
  });

  it('answers undefined for a user that does not exist, storing nothing', async () => {
    const store = new DrizzlePreferenceStore(database);
    expect(
      await store.write('nobody-here', { showTips: false }),
    ).toBeUndefined();
    const rows = await database.db.execute(
      sql`select count(*)::int as n from user_preferences`,
    );
    expect(rows.rows[0]).toEqual({ n: 0 });
  });

  it('goes with its user', async () => {
    const store = new DrizzlePreferenceStore(database);
    await database.db.insert(users).values({ id: 'carol', name: 'Carol' });
    await store.write('carol', { tourDone: true });
    await database.db.execute(sql`delete from users where id = 'carol'`);
    expect((await store.read('carol')).updatedAt).toBeNull();
  });
});
