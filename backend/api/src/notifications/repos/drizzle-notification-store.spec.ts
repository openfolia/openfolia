import { sql } from 'drizzle-orm';
import {
  createTestDatabase,
  type PgliteDatabase,
} from '../../../tests/database.js';
import { DrizzleUnitOfWork } from '../../database/drizzle-unit-of-work.js';
import type { NewNotification } from '../core/notification.js';
import { DrizzleNotificationStore } from './drizzle-notification-store.js';

let database: PgliteDatabase;
beforeAll(async () => {
  database = await createTestDatabase();
});
afterAll(() => database?.close());
afterEach(() => database.db.execute(sql`delete from notifications`));

const note = (
  outboxId: number,
  recipient: string,
  createdAt = new Date(),
): NewNotification => ({
  outboxId,
  recipient,
  kind: 'change-set.return',
  subject: { type: 'change-set', id: 'cs-1' },
  payload: { changeSetId: 'cs-1' },
  createdAt,
});

const page = { number: 1, size: 50 };

describe('DrizzleNotificationStore', () => {
  it('stores one per outbox row and recipient, and lists only the recipient’s, newest first', async () => {
    const store = new DrizzleNotificationStore(database);
    const unit = new DrizzleUnitOfWork(database);
    const old = new Date(Date.now() - 60_000);
    expect(
      await unit.run((tx) =>
        store.add(tx, [
          note(1, 'alice', old),
          note(2, 'alice'),
          note(1, 'bob'),
        ]),
      ),
    ).toBe(3);
    // The same batch again: nothing new.
    expect(
      await unit.run((tx) => store.add(tx, [note(1, 'alice'), note(1, 'bob')])),
    ).toBe(0);
    const alice = await store.list('alice', {}, page);
    expect(alice.total).toBe(2);
    expect(alice.unreadCount).toBe(2);
    expect(alice.items.map((n) => n.outboxId)).toEqual([2, 1]);
    expect(alice.items.every((n) => n.recipient === 'alice')).toBe(true);
    const bobs = (await store.list('bob', {}, page)).items[0];
    if (!bobs) throw new Error('none');
    expect(await store.find('alice', bobs.id)).toBeUndefined();
    expect(await store.find('bob', bobs.id)).toMatchObject({
      kind: 'change-set.return',
      subject: { type: 'change-set', id: 'cs-1' },
      payload: { changeSetId: 'cs-1' },
    });
  });

  it('marks only the recipient’s read, and counts what is left', async () => {
    const store = new DrizzleNotificationStore(database);
    const unit = new DrizzleUnitOfWork(database);
    await unit.run((tx) =>
      store.add(tx, [note(1, 'alice'), note(2, 'alice'), note(1, 'bob')]),
    );
    const [first] = (await store.list('alice', {}, page)).items;
    const [bobs] = (await store.list('bob', {}, page)).items;
    if (!first || !bobs) throw new Error('none');
    expect(
      await unit.run((tx) => store.owned(tx, 'alice', [first.id, bobs.id])),
    ).toEqual(new Set([first.id]));
    // Bob's ID marks nothing of Alice's, nor Bob's.
    expect(await unit.run((tx) => store.markRead(tx, 'alice', [bobs.id]))).toBe(
      0,
    );
    expect(
      await unit.run((tx) => store.markRead(tx, 'alice', [first.id])),
    ).toBe(1);
    expect(await store.unread('alice')).toMatchObject({ count: 1 });
    expect(await store.unread('bob')).toEqual({ count: 1, latest: bobs.id });
    expect(
      (await store.list('alice', { unread: false }, page)).items.map(
        (n) => n.id,
      ),
    ).toEqual([first.id]);
    expect(await unit.run((tx) => store.markRead(tx, 'alice', 'all'))).toBe(1);
    expect(await store.unread('alice')).toMatchObject({ count: 0 });
    expect(await store.unread('nobody')).toEqual({
      count: 0,
      latest: undefined,
    });
  });

  it('deletes those read before the cut-off, a batch at a time', async () => {
    const store = new DrizzleNotificationStore(database);
    const unit = new DrizzleUnitOfWork(database);
    const old = new Date(Date.now() - 100 * 86_400_000);
    await unit.run((tx) =>
      store.add(tx, [
        note(1, 'alice', old),
        note(2, 'alice', old),
        note(3, 'alice', old),
        note(4, 'alice'),
      ]),
    );
    await unit.run((tx) => store.markRead(tx, 'alice', 'all'));
    // Read long ago: 1 and 2; never: 3 (however old its event); just now: 4.
    await database.db.execute(
      sql`update notifications set read_at = now() - interval '100 days' where outbox_id in (1, 2)`,
    );
    await database.db.execute(
      sql`update notifications set read_at = null where outbox_id = 3`,
    );
    const cutOff = new Date(Date.now() - 90 * 86_400_000);
    expect(await store.removeReadBefore(cutOff, 1)).toBe(1);
    expect(await store.removeReadBefore(cutOff, 10)).toBe(1);
    expect(
      (await store.list('alice', {}, page)).items.map((n) => n.outboxId).sort(),
    ).toEqual([3, 4]);
  });
});
