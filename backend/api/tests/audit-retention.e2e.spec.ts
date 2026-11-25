import { AuditSinkConsumer } from '../src/audit/api/audit-sink-consumer.js';
import { createTestDatabase, type PgliteDatabase } from './database.js';
import { createTestApp, type TestApp } from './test-app.js';

// #379: retention through the database's own function (`audit_events_prune`),
// as the app runs it at start-up. A file of its own: the settings are read once
// per file.
describe('audit retention (e2e)', () => {
  let database: PgliteDatabase;
  let t: TestApp | undefined;

  afterEach(async () => {
    await t?.close();
    t = undefined;
  });

  it('removes only events older than the period, at start-up, and audits the removal', async () => {
    database = await createTestDatabase();
    for (const [id, days] of [
      ['old', 400],
      ['recent', 10],
    ] as const) {
      await database.client.query(
        `insert into audit_events (actor_kind, actor_id, action, subject_type, subject_id, at)
         values ('user', 'ada', 'role.update', 'role', $1, now() - $2 * interval '1 day')`,
        [id, days],
      );
    }
    t = await createTestApp({ CCMS_AUDIT_KEEP_DAYS: '365' }, { database });
    const app = t;
    // The run at start-up, then one more: nothing left to remove.
    await vi.waitFor(async () =>
      expect(
        (
          await database.client.query(
            `select 1 from audit_events where action = 'audit-log.prune'`,
          )
        ).rows,
      ).toHaveLength(1),
    );
    expect(await app.app.get(AuditSinkConsumer).pruneOnce()).toEqual({
      write: 0,
      read: 0,
    });

    app.actAs({
      kind: 'user',
      id: 'sample-admin',
      roles: [
        { id: 'role', name: 'Role', permissions: ['admin.roles'], scope: {} },
      ],
    });
    const res = await app.get('/audit-events?page[size]=10');
    expect(res.status).toBe(200);
    const listed = (
      res.body as {
        data: {
          attributes: {
            action: string;
            subject: { id: string };
            data: Record<string, unknown>;
          };
        }[];
      }
    ).data.map((d) => d.attributes);
    expect(listed.map((a) => a.subject.id)).toEqual(['audit-events', 'recent']);
    expect(listed[0]).toMatchObject({
      action: 'audit-log.prune',
      data: { removed: 1, firstId: '1', lastId: '1' },
    });
  });
});
