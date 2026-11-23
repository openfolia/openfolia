import { Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { Actor } from '../src/access/core/actor.js';
import { ErrorDocument, JSON_API } from '../src/base/api/json-api.js';
import { NotificationsConsumer } from '../src/notifications/api/notifications-consumer.js';
import { OutboxStatusDocument } from '../src/outbox/api/outbox-status.resources.js';
import { actorWith } from './fakes/actors.js';
import { createTestApp, type TestApp } from './test-app.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const admin: Actor = { ...actorWith(['admin.roles']), id: 'sample-admin' };
const reader: Actor = { ...actorWith(['content.read']), id: 'rag-consumer' };

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t?.close());
afterEach(() => t?.actAs(undefined));

async function status() {
  t.actAs(admin);
  const res = await t.get('/outbox/status');
  expect(res.status).toBe(200);
  expect(res.headers['content-type']).toBe(JSON_API);
  return OutboxStatusDocument.parse(res.body).data;
}

describe('the outbox after a restore onto another server (#619)', () => {
  it('holds the change feed with 503 outbox-blocked and names the held consumers to an administrator, until the recipe', async () => {
    expect(await status()).toMatchObject({
      type: 'OutboxStatus',
      id: 'outbox',
      attributes: { blockedConsumers: [] },
      meta: { level: 'ok' },
    });
    t.actAs(reader);
    expect((await t.get('/changes')).status).toBe(200);

    // As a restore from another server leaves it: a row past every transaction here.
    await t.database.db.execute(
      sql`insert into outbox (topic, key, payload, tx_id) values ('release.withdrawn', 'restored', '{}', '999999999999'::xid8)`,
    );
    t.actAs(reader);
    const held = await t.get('/changes');
    expect(held.status).toBe(503);
    expect(held.headers['retry-after']).toBe('60');
    expect(ErrorDocument.parse(held.body).errors[0]?.code).toBe(
      'outbox-blocked',
    );
    expect(await status()).toMatchObject({
      attributes: { blockedConsumers: ['change-feed'] },
      meta: { level: 'error' },
    });

    // The recipe's last steps: every row on transaction 1, the latches cleared.
    await t.database.db.execute(sql`update outbox set tx_id = '1'`);
    await t.database.db.execute(
      sql`update outbox_consumers set blocked = false`,
    );
    t.actAs(reader);
    expect((await t.get('/changes')).status).toBe(200);
    expect((await status()).attributes.blockedConsumers).toEqual([]);
  });

  it('stops the notifications, logged once at error level, and goes on after the recipe', async () => {
    const errors = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const logs = vi
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined);
    await t.database.db.execute(
      sql`insert into outbox (topic, key, payload, tx_id) values ('release.withdrawn', 'restored-2', '{}', '999999999999'::xid8)`,
    );
    const consumer = t.app.get(NotificationsConsumer);
    expect(await consumer.runOnce()).toMatchObject({
      blocked: true,
      events: 0,
    });
    expect(await consumer.runOnce()).toMatchObject({ blocked: true });
    const held = errors.mock.calls.filter(([m]) =>
      String(m).includes('"Outbox", "After a restore"'),
    );
    expect(held).toHaveLength(1);
    expect((await status()).attributes.blockedConsumers).toContain(
      'notifications',
    );
    await t.database.db.execute(sql`update outbox set tx_id = '1'`);
    await t.database.db.execute(
      sql`update outbox_consumers set blocked = false`,
    );
    expect(await consumer.runOnce()).toMatchObject({ blocked: false });
    expect(logs.mock.calls.some(([m]) => String(m).includes('goes on'))).toBe(
      true,
    );
    errors.mockRestore();
    logs.mockRestore();
  });

  it('is for administrators only', async () => {
    t.actAs(reader);
    const res = await t.get('/outbox/status');
    expect(res.status).toBe(403);
    expect(res.body.errors[0].code).toBe('forbidden');
  });
});
