import { sql } from 'drizzle-orm';
import {
  createTestDatabase,
  type PgliteDatabase,
} from '../../../tests/database.js';
import { FakeUnitOfWork } from '../../../tests/fakes/fake-unit-of-work.js';
import type { Actor } from '../../access/core/actor.js';
import {
  drizzleOf,
  DrizzleUnitOfWork,
} from '../../database/drizzle-unit-of-work.js';
import type { NewAuditEvent } from '../core/audit-event.js';
import { auditEvents } from './audit.tables.js';
import { DrizzleAuditLog, STREAM_BATCH } from './drizzle-audit-log.js';

const admin: Actor = { kind: 'user', id: 'sample-admin', roles: [] };
const importer: Actor = { kind: 'service', id: 'importer', roles: [] };
const event = (over: Partial<NewAuditEvent> = {}): NewAuditEvent => ({
  action: 'role.assign',
  subject: { type: 'user', id: 'sample-reader' },
  ...over,
});

describe('DrizzleAuditLog', () => {
  let database: PgliteDatabase;
  let log: DrizzleAuditLog;
  let unit: DrizzleUnitOfWork;
  const all = { number: 1, size: 50 };

  beforeEach(async () => {
    database = await createTestDatabase();
    log = new DrizzleAuditLog(database);
    unit = new DrizzleUnitOfWork(database);
  });
  afterEach(() => database?.close());

  it('records events and lists them newest first', async () => {
    await unit.run(async (tx) => {
      await log.record(tx, admin, {
        action: 'role.assign',
        subject: { type: 'user', id: 'sample-reader' },
        comment: 'Joins the review team.',
        data: { role: 'reviewer', nested: { list: [1, null, true] } },
      });
      await log.record(tx, admin, event({ action: 'role.unassign' }));
    });
    const { items, total } = await log.list({}, all);
    expect(total).toBe(2);
    expect(items.map((e) => e.action)).toEqual([
      'role.unassign',
      'role.assign',
    ]);
    expect(items[1]).toEqual({
      id: expect.stringMatching(/^\d+$/),
      at: expect.any(Date),
      actor: { kind: 'user', id: 'sample-admin' },
      action: 'role.assign',
      subject: { type: 'user', id: 'sample-reader' },
      comment: 'Joins the review team.',
      data: { role: 'reviewer', nested: { list: [1, null, true] } },
    });
    expect(items[0]).toMatchObject({ comment: null, data: {} });
  });

  it('keeps no event when the work fails after recording (same transaction)', async () => {
    await expect(
      unit.run(async (tx) => {
        await log.record(tx, admin, event());
        throw new Error('the change itself failed');
      }),
    ).rejects.toThrow('the change itself failed');
    expect((await log.list({}, all)).total).toBe(0);
  });

  it('keeps no event when the work fails at the database after recording', async () => {
    await expect(
      unit.run(async (tx) => {
        await log.record(tx, admin, event());
        await drizzleOf(tx).execute(sql`select 1 / 0`);
      }),
    ).rejects.toThrow();
    expect((await log.list({}, all)).total).toBe(0);
  });

  it('fails the run when the work caught a database error (no silent rollback)', async () => {
    await expect(
      unit.run(async (tx) => {
        await log.record(tx, admin, event());
        try {
          await drizzleOf(tx).execute(sql`select 1 / 0`);
        } catch {
          // e.g. "already exists, ignore": the transaction is aborted all the same
        }
        return 'done';
      }),
    ).rejects.toThrow();
    expect((await log.list({}, all)).total).toBe(0);
  });

  it('stores what U+0000-free text and JSON allow, exactly', async () => {
    const data = { quote: 'it\'s "fine" \\ ünïcødé 😀', list: [1.5, -2, null] };
    await unit.run((tx) =>
      log.record(tx, admin, event({ comment: 'Line 1\nLine 2', data })),
    );
    expect((await log.list({}, all)).items[0]).toMatchObject({
      comment: 'Line 1\nLine 2',
      data,
    });
  });

  it('filters by subject, actor and action, and pages', async () => {
    await unit.run(async (tx) => {
      await log.record(tx, admin, event());
      await log.record(
        tx,
        admin,
        event({
          action: 'module.write',
          subject: { type: 'module', id: 'en/a' },
        }),
      );
      await log.record(tx, importer, event());
      await log.record(
        tx,
        admin,
        event({ subject: { type: 'user', id: 'sample-author' } }),
      );
    });
    const actions = async (filter: Parameters<typeof log.list>[0]) =>
      (await log.list(filter, all)).items.map(
        (e) => `${e.actor.id} ${e.action} ${e.subject.id}`,
      );
    expect(await actions({ subject: { type: 'module', id: 'en/a' } })).toEqual([
      'sample-admin module.write en/a',
    ]);
    expect(await actions({ subject: { type: 'user' } })).toHaveLength(3);
    expect(await actions({ actor: { kind: 'service' } })).toEqual([
      'importer role.assign sample-reader',
    ]);
    expect(
      await actions({
        actor: { kind: 'user', id: 'sample-admin' },
        action: 'role.assign',
      }),
    ).toEqual([
      'sample-admin role.assign sample-author',
      'sample-admin role.assign sample-reader',
    ]);
    expect(await actions({ action: 'nothing.matches' })).toEqual([]);

    const page2 = await log.list({}, { number: 2, size: 3 });
    expect(page2.total).toBe(4);
    expect(page2.items.map((e) => e.action)).toEqual(['role.assign']);
    expect((await log.list({}, { number: 3, size: 3 })).items).toEqual([]);
  });

  it('filters by time: from inclusive, to exclusive', async () => {
    const day = (d: number) => new Date(Date.UTC(2026, 0, d));
    await database.db.insert(auditEvents).values(
      [1, 2, 3, 4].map((d) => ({
        at: day(d),
        actorKind: 'user',
        actorId: 'sample-admin',
        action: 'role.assign',
        subjectType: 'user',
        subjectId: `on-${d}`,
      })),
    );
    const subjects = async (filter: Parameters<typeof log.list>[0]) =>
      (await log.list(filter, all)).items.map((e) => e.subject.id);
    expect(await subjects({ from: day(2) })).toEqual(['on-4', 'on-3', 'on-2']);
    expect(await subjects({ to: day(3) })).toEqual(['on-2', 'on-1']);
    expect(await subjects({ from: day(2), to: day(4) })).toEqual([
      'on-3',
      'on-2',
    ]);
    expect(await subjects({ from: day(4), to: day(4) })).toEqual([]);
    const streamed: string[] = [];
    for await (const e of log.stream({ from: day(2), to: day(4) })) {
      streamed.push(e.subject.id);
    }
    expect(streamed).toEqual(['on-3', 'on-2']);
  });

  it('streams every matching event newest first, across batches, as list orders them', async () => {
    const count = STREAM_BATCH * 2 + 3;
    await database.db.insert(auditEvents).values(
      Array.from({ length: count }, (_, i) => ({
        actorKind: i % 3 === 0 ? 'service' : 'user',
        actorId: 'someone',
        action: 'role.assign',
        subjectType: 'user',
        subjectId: `u-${i}`,
      })),
    );
    const streamed = async (filter: Parameters<typeof log.stream>[0]) => {
      const ids: string[] = [];
      for await (const e of log.stream(filter)) ids.push(e.id);
      return ids;
    };
    const everything = await streamed({});
    expect(everything).toHaveLength(count);
    expect(new Set(everything).size).toBe(count);
    const pages = [
      ...(await log.list({}, { number: 1, size: 200 })).items,
      ...(await log.list({}, { number: 2, size: 200 })).items,
      ...(await log.list({}, { number: 3, size: 200 })).items,
      ...(await log.list({}, { number: 4, size: 200 })).items,
      ...(await log.list({}, { number: 5, size: 200 })).items,
      ...(await log.list({}, { number: 6, size: 200 })).items,
    ];
    expect(pages.map((e) => e.id)).toEqual(everything);
    const services = await streamed({ actor: { kind: 'service' } });
    expect(services).toEqual(
      (
        await log.list({ actor: { kind: 'service' } }, { number: 1, size: 200 })
      ).items
        .map((e) => e.id)
        .concat(
          (
            await log.list(
              { actor: { kind: 'service' } },
              { number: 2, size: 200 },
            )
          ).items.map((e) => e.id),
        ),
    );
    expect(services).toHaveLength(Math.ceil(count / 3));
    expect(await streamed({ action: 'nothing.matches' })).toEqual([]);
  });

  it('streams no event recorded after the export began', async () => {
    await database.db.insert(auditEvents).values(
      Array.from({ length: STREAM_BATCH + 1 }, (_, i) => ({
        actorKind: 'user',
        actorId: 'someone',
        action: 'role.assign',
        subjectType: 'user',
        subjectId: `u-${i}`,
      })),
    );
    const seen: string[] = [];
    for await (const e of log.stream({})) {
      if (seen.length === 0) {
        await unit.run((tx) =>
          log.record(
            tx,
            admin,
            event({ subject: { type: 'user', id: 'late' } }),
          ),
        );
      }
      seen.push(e.subject.id);
    }
    expect(seen).toHaveLength(STREAM_BATCH + 1);
    expect(seen).not.toContain('late');
  });

  it('refuses UPDATE, DELETE and TRUNCATE at the database', async () => {
    await unit.run((tx) => log.record(tx, admin, event()));
    const { db } = database;
    await expect(
      db.update(auditEvents).set({ comment: 'rewritten' }),
    ).rejects.toThrow();
    await expect(db.delete(auditEvents)).rejects.toThrow();
    // Even when nothing matches.
    await expect(
      db.execute(sql`update audit_events set comment = 'x' where false`),
    ).rejects.toThrow();
    await expect(
      db.execute(sql`delete from audit_events where false`),
    ).rejects.toThrow();
    await expect(db.execute(sql`truncate audit_events`)).rejects.toThrow();
    const [row] = await db.select().from(auditEvents);
    expect(row?.comment).toBeNull();
    expect(await db.$count(auditEvents)).toBe(1);
  });

  it('names the append-only rule in the refusal', async () => {
    await expect(
      database.client.query(`delete from audit_events`),
    ).rejects.toThrow(
      'audit_events is append-only: DELETE is allowed only through audit_events_prune',
    );
    await expect(
      database.client.query(`update audit_events set comment = 'x'`),
    ).rejects.toThrow('audit_events is append-only: UPDATE is not allowed');
  });

  it('refuses malformed rows in the database itself', async () => {
    const insert = (row: Partial<typeof auditEvents.$inferInsert>) =>
      database.db.insert(auditEvents).values({
        actorKind: 'user',
        actorId: 'sample-admin',
        action: 'role.assign',
        subjectType: 'user',
        subjectId: 'sample-reader',
        ...row,
      });
    await expect(insert({})).resolves.toBeDefined();
    await expect(insert({ actorKind: 'robot' })).rejects.toThrow();
    await expect(insert({ actorId: '' })).rejects.toThrow();
    await expect(insert({ action: 'assign' })).rejects.toThrow();
    await expect(insert({ action: 'role.Assign' })).rejects.toThrow();
    await expect(insert({ subjectType: 'User' })).rejects.toThrow();
    await expect(insert({ subjectId: '' })).rejects.toThrow();
    await expect(insert({ comment: '' })).rejects.toThrow();
    await expect(
      insert({ data: [1] as unknown as Record<string, unknown> }),
    ).rejects.toThrow();
    // The ID is the database's: never set by a caller.
    await expect(
      database.db.execute(
        sql`insert into audit_events (id, actor_kind, actor_id, action, subject_type, subject_id) values (1, 'user', 'a', 'role.assign', 'user', 'b')`,
      ),
    ).rejects.toThrow();
  });

  it('refuses a transaction that has ended or is not its own', async () => {
    const escaped = await unit.run(async (tx) => tx);
    await expect(log.record(escaped, admin, event())).rejects.toThrow(
      'The transaction has ended',
    );
    await expect(
      new FakeUnitOfWork().run((tx) => log.record(tx, admin, event())),
    ).rejects.toThrow('Not a transaction of the Drizzle unit of work');
    expect((await log.list({}, all)).total).toBe(0);
  });
});
