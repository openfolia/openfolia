import { AuditSinkConsumer } from '../src/audit/api/audit-sink-consumer.js';
import { createTestDatabase, type PgliteDatabase } from './database.js';
import { createTestApp, type TestApp } from './test-app.js';

// #877: reads have a retention of their own (`CCMS_AUDIT_READ_KEEP_DAYS`), applied by the
// same sweep through `audit_events_prune_reads`, and changes are kept for theirs. A file of its
// own: the settings are read once per file.
describe('read retention (e2e)', () => {
  let database: PgliteDatabase;
  let t: TestApp | undefined;

  afterEach(async () => {
    await t?.close();
    t = undefined;
  });

  it('removes reads (and gaps) older than their period at start-up, keeps changes as old, and audits the removal', async () => {
    database = await createTestDatabase();
    for (const [kind, action, type, id, days] of [
      ['read', 'api.read', 'route', '/modules/old', 40],
      ['read', 'api.read-gap', 'service-account', 'agent', 40],
      ['read', 'api.read', 'route', '/modules/recent', 10],
      ['write', 'role.update', 'role', 'old-change', 40],
    ] as const) {
      await database.client.query(
        `insert into audit_events (kind, actor_kind, actor_id, action, subject_type, subject_id, at)
         values ($1, 'service', 'agent', $2, $3, $4, now() - $5 * interval '1 day')`,
        [kind, action, type, id, days],
      );
    }
    // Changes kept for ever (no CCMS_AUDIT_KEEP_DAYS), reads for 30 days.
    t = await createTestApp({ CCMS_AUDIT_READ_KEEP_DAYS: '30' }, { database });
    const app = t;
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

    const left = await database.client.query<{
      kind: string;
      subject_id: string;
      data: Record<string, unknown>;
    }>(`select kind, subject_id, data from audit_events order by id`);
    expect(left.rows.map((r) => [r.kind, r.subject_id])).toEqual([
      ['read', '/modules/recent'],
      ['write', 'old-change'],
      ['write', 'audit-events'],
    ]);
    expect(left.rows[2]!.data).toMatchObject({
      removed: 2,
      firstId: '1',
      lastId: '2',
      kind: 'read',
    });
  });
});
