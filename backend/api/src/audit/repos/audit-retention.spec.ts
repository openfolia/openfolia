import {
  createTestDatabase,
  type PgliteDatabase,
} from '../../../tests/database.js';
import { type AuditPosition, SINK_START } from '../core/audit-sink.js';
import { DrizzleAuditLog } from './drizzle-audit-log.js';
import { DrizzleAuditSinkCursor } from './drizzle-audit-sink-cursor.js';

/** The SQL of backend/api/README.md, "After a restore" (without the setval and VACUUM). */
const RESTORE_RECIPE = `
      BEGIN;
      UPDATE audit_sink SET last_tx_id = '1',
        last_id = LEAST((SELECT min(e.id) - 1 FROM audit_events e
                         WHERE (e.tx_id, e.id) > (audit_sink.last_tx_id, audit_sink.last_id)),
                        audit_sink.last_id)
        WHERE last_tx_id <> '0';
      UPDATE audit_sink SET blocked = false;
      ALTER TABLE audit_events DISABLE TRIGGER audit_events_append_only;
      UPDATE audit_events SET tx_id = '1';
      ALTER TABLE audit_events ENABLE TRIGGER audit_events_append_only;
      COMMIT;
    `;

const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY);

let database: PgliteDatabase;
beforeEach(async () => {
  database = await createTestDatabase();
});
afterEach(() => database?.close());

/** Records an event at `at`, each in a transaction of its own (autocommit). */
async function insert(subjectId: string, at: Date): Promise<void> {
  await database.client.query(
    `insert into audit_events (actor_kind, actor_id, action, subject_type, subject_id, at)
     values ('user', 'ada', 'role.update', 'role', $1, $2)`,
    [subjectId, at.toISOString()],
  );
}

async function rows() {
  const result = await database.client.query<{
    id: string;
    subject_id: string;
    action: string;
    actor_id: string;
    data: Record<string, unknown>;
  }>(
    `select id::text, subject_id, action, actor_id, data from audit_events order by id`,
  );
  return result.rows;
}

describe('audit_events_prune (retention)', () => {
  it('removes only events older than the period, oldest first, and records the removal', async () => {
    await insert('a', daysAgo(40));
    await insert('b', daysAgo(31));
    await insert('c', daysAgo(29));
    await insert('d', new Date());
    const log = new DrizzleAuditLog(database);

    expect(await log.prune(daysAgo(30), 5_000)).toBe(2);

    const left = await rows();
    expect(left.map((r) => r.subject_id)).toEqual(['c', 'd', 'audit-events']);
    const pruned = left[2]!;
    expect(pruned).toMatchObject({
      action: 'audit-log.prune',
      actor_id: 'audit-retention',
      data: { removed: 2, firstId: '1', lastId: '2' },
    });
    expect(Date.parse(pruned.data.before as string)).toBeLessThan(
      daysAgo(29.9).getTime(),
    );
    // Nothing left to remove: no call, no event.
    expect(await log.prune(daysAgo(30), 5_000)).toBe(0);
    expect(await rows()).toHaveLength(3);
  });

  it('removes at most max_rows per call, the oldest', async () => {
    for (const [i, days] of [50, 40, 45, 35].entries()) {
      await insert(`e${i}`, daysAgo(days));
    }
    const log = new DrizzleAuditLog(database);
    expect(await log.prune(daysAgo(30), 2)).toBe(2);
    expect((await rows()).map((r) => r.subject_id)).toEqual([
      'e1',
      'e3',
      'audit-events',
    ]);
  });

  it('keeps every event after the sink position', async () => {
    await insert('sent', daysAgo(40));
    await insert('unsent', daysAgo(40));
    const cursor = new DrizzleAuditSinkCursor(database);
    const from = await cursor.claim('me', 60_000);
    const [first] = await cursor.read(from as AuditPosition, 1);
    expect(
      await cursor.advance('me', from as AuditPosition, first!.position),
    ).toBe(true);

    const log = new DrizzleAuditLog(database);
    expect(await log.prune(daysAgo(30), 100, await cursor.position())).toBe(1);
    expect((await rows()).map((r) => r.subject_id)).toEqual([
      'unsent',
      'audit-events',
    ]);
    // A sink that has sent nothing keeps everything.
    expect(await log.prune(daysAgo(30), 100, SINK_START)).toBe(0);
  });

  it('refuses a period of less than a day, or a batch out of range, whoever calls it', async () => {
    await insert('a', daysAgo(2));
    const prune = (before: string, max: number) =>
      database.client.query(
        `select audit_events_prune($1::timestamptz, $2::integer)`,
        [before, max],
      );
    await expect(prune(new Date().toISOString(), 10)).rejects.toThrow(
      'before must lie at least 23 hours back',
    );
    await expect(prune(daysAgo(0.5).toISOString(), 10)).rejects.toThrow(
      'before must lie at least 23 hours back',
    );
    await expect(prune(daysAgo(1.5).toISOString(), 0)).rejects.toThrow(
      'max_rows must be from 1 to 10000',
    );
    await expect(prune(daysAgo(1.5).toISOString(), 10_001)).rejects.toThrow(
      'max_rows must be from 1 to 10000',
    );
    await expect(
      database.client.query(
        `select audit_events_prune(now() - interval '2 days', 10, '1'::xid8, null)`,
      ),
    ).rejects.toThrow('kept_tx and kept_id go together');
    expect(await rows()).toHaveLength(1);
  });

  it('still refuses every other DELETE, UPDATE and TRUNCATE, and leaves no flag behind', async () => {
    await insert('a', daysAgo(40));
    await expect(
      database.client.query(`delete from audit_events`),
    ).rejects.toThrow('DELETE is allowed only through audit_events_prune');
    await expect(
      database.client.query(`update audit_events set comment = 'x'`),
    ).rejects.toThrow('UPDATE is not allowed');
    await expect(
      database.client.query(`truncate audit_events`),
    ).rejects.toThrow('TRUNCATE is not allowed');
    // In one transaction: the flag is off again once the function returns.
    await expect(
      database.client.transaction(async (tx) => {
        await tx.query(
          `select audit_events_prune(now() - interval '30 days', 10)`,
        );
        await tx.query(`delete from audit_events`);
      }),
    ).rejects.toThrow('DELETE is allowed only through audit_events_prune');
    expect((await rows()).map((r) => r.subject_id)).toEqual(['a']);
  });

  it('runs for a role that may only read, insert and execute it: DELETE stays denied to that role', async () => {
    await insert('old', daysAgo(40));
    const q = (text: string) => database.client.exec(text);
    // The role setup of backend/api/README.md, "Audit log".
    await q(`
      create role ccms_app nologin;
      grant select, insert on audit_events to ccms_app;
      grant execute on function audit_events_prune(timestamptz, integer, xid8, bigint) to ccms_app;
      create role ccms_other nologin;
      grant select, insert on audit_events to ccms_other;
    `);
    try {
      await q(`set role ccms_app`);
      // Even with the flag set by hand, the grant holds.
      await expect(
        database.client.transaction(async (tx) => {
          await tx.query(`select set_config('ccms.audit_prune', 'on', true)`);
          await tx.query(`delete from audit_events`);
        }),
      ).rejects.toThrow('permission denied');
      const pruned = await database.client.query<{ n: number }>(
        `select audit_events_prune(now() - interval '30 days', 10) as n`,
      );
      expect(pruned.rows[0]!.n).toBe(1);
      await q(`reset role`);
      // Revoked from PUBLIC: a role it was not granted to cannot run it.
      await q(`set role ccms_other`);
      await expect(
        database.client.query(
          `select audit_events_prune(now() - interval '30 days', 10)`,
        ),
      ).rejects.toThrow('permission denied');
    } finally {
      await q(`reset role`);
    }
    expect((await rows()).map((r) => r.action)).toEqual(['audit-log.prune']);
  });

  it('pins its search_path, the built-ins first', async () => {
    const result = await database.client.query<{ config: string[] }>(
      `select proconfig as config from pg_proc where proname = 'audit_events_prune'`,
    );
    expect(result.rows[0]!.config).toEqual([
      'search_path=pg_catalog, public, pg_temp',
    ]);
  });
});

describe('DrizzleAuditSinkCursor', () => {
  it('reads in (transaction, id) order after the cursor and moves it while holding the lease', async () => {
    await insert('a', new Date());
    // Two events of one transaction, then one more.
    await database.client.transaction(async (tx) => {
      for (const id of ['b', 'c']) {
        await tx.query(
          `insert into audit_events (actor_kind, actor_id, action, subject_type, subject_id) values ('user', 'ada', 'role.update', 'role', $1)`,
          [id],
        );
      }
    });
    await insert('d', new Date());
    const cursor = new DrizzleAuditSinkCursor(database);
    expect(await cursor.position()).toEqual(SINK_START);

    const from = await cursor.claim('one', 60_000);
    expect(from).toEqual(SINK_START);
    const batch = await cursor.read(from as AuditPosition, 3);
    expect(batch.map((e) => e.event.subject.id)).toEqual(['a', 'b', 'c']);
    expect(batch[1]!.position.tx).toBe(batch[2]!.position.tx);
    expect(BigInt(batch[0]!.position.tx)).toBeLessThan(
      BigInt(batch[1]!.position.tx),
    );

    expect(
      await cursor.advance('one', from as AuditPosition, batch[2]!.position),
    ).toBe(true);
    // A move from where the cursor no longer is does nothing.
    expect(
      await cursor.advance('one', from as AuditPosition, batch[0]!.position),
    ).toBe(false);
    const next = await cursor.claim('one', 60_000);
    expect(next).toEqual(batch[2]!.position);
    expect(
      (await cursor.read(next as AuditPosition, 100)).map(
        (e) => e.event.subject.id,
      ),
    ).toEqual(['d']);
    // The cursor is in the database: a new server (a restart) goes on from there.
    expect(await new DrizzleAuditSinkCursor(database).position()).toEqual(
      batch[2]!.position,
    );
  });

  it('lets one holder send at a time, until its lease runs out', async () => {
    await insert('a', new Date());
    const one = new DrizzleAuditSinkCursor(database);
    const two = new DrizzleAuditSinkCursor(database);
    const from = await one.claim('one', 60_000);
    expect(await two.claim('two', 60_000)).toBeUndefined();
    const [entry] = await one.read(from as AuditPosition, 1);
    expect(
      await two.advance('two', from as AuditPosition, entry!.position),
    ).toBe(false);

    await database.client.query(
      `update audit_sink set claimed_until = now() - interval '1 second'`,
    );
    expect(await two.claim('two', 60_000)).toEqual(SINK_START);
    // The first holder's late move is refused: the lease is the other's now.
    expect(
      await one.advance('one', from as AuditPosition, entry!.position),
    ).toBe(false);
    expect(
      await two.advance('two', from as AuditPosition, entry!.position),
    ).toBe(true);
  });

  it('stamps every event with its own transaction, whatever an insert gives', async () => {
    const same = await database.client.transaction(async (tx) => {
      await tx.query(
        `insert into audit_events (actor_kind, actor_id, action, subject_type, subject_id, tx_id)
         values ('user', 'ada', 'role.update', 'role', 'forged', '999999999999'::xid8)`,
      );
      const result = await tx.query<{ same: boolean }>(
        `select tx_id = pg_current_xact_id() as same from audit_events`,
      );
      return result.rows;
    });
    expect(same).toEqual([{ same: true }]);
  });

  it('answers ahead for a position past every transaction (a restored database), and retention removes nothing then', async () => {
    await insert('old', daysAgo(40));
    const cursor = new DrizzleAuditSinkCursor(database);
    await cursor.claim('one', 60_000);
    await database.client.query(
      `update audit_sink set last_tx_id = '999999999999'::xid8, last_id = 5`,
    );
    expect(await cursor.claim('one', 60_000)).toBe('ahead');
    await expect(
      new DrizzleAuditLog(database).prune(daysAgo(30), 100, {
        tx: '999999999999',
        id: '5',
      }),
    ).rejects.toMatchObject({
      cause: {
        message: expect.stringContaining('the sink position lies ahead'),
      },
    });
    expect((await rows()).map((r) => r.subject_id)).toEqual(['old']);
  });

  it('answers ahead too when restored events lie past every transaction, with the cursor at the start', async () => {
    await insert('restored', daysAgo(1));
    // As a restore onto another server leaves them.
    await database.client.exec(`
      alter table audit_events disable trigger audit_events_append_only;
      update audit_events set tx_id = '999999999999';
      alter table audit_events enable trigger audit_events_append_only;
    `);
    expect(
      await new DrizzleAuditSinkCursor(database).claim('one', 60_000),
    ).toBe('ahead');
  });

  it('stays blocked once found ahead, until the recipe clears it, and retention removes nothing meanwhile', async () => {
    await insert('old', daysAgo(40));
    const cursor = new DrizzleAuditSinkCursor(database);
    await cursor.claim('one', 60_000);
    await database.client.query(
      `update audit_sink set last_tx_id = '999999999999'::xid8`,
    );
    expect(await cursor.claim('one', 60_000)).toBe('ahead');
    // The count caught up (as if): the latch still holds.
    await database.client.query(`update audit_sink set last_tx_id = '1'`);
    expect(await cursor.claim('one', 60_000)).toBe('ahead');
    await expect(
      new DrizzleAuditLog(database).prune(daysAgo(30), 100, {
        tx: '1',
        id: '0',
      }),
    ).rejects.toMatchObject({
      cause: {
        message: expect.stringContaining('the sink position lies ahead'),
      },
    });
    await database.client.query(`update audit_sink set blocked = false`);
    expect(await cursor.claim('one', 60_000)).toEqual({ tx: '1', id: '0' });
  });

  it('gives the lease up on release, for another holder at once', async () => {
    const one = new DrizzleAuditSinkCursor(database);
    const two = new DrizzleAuditSinkCursor(database);
    await one.claim('one', 60_000);
    expect(await two.claim('two', 60_000)).toBeUndefined();
    await two.release('two');
    expect(await two.claim('two', 60_000)).toBeUndefined();
    await one.release('one');
    expect(await two.claim('two', 60_000)).toEqual(SINK_START);
  });

  it('the restore recipe (backend/api/README.md, "After a restore") sends the unsent restored events and those recorded since, in ID order', async () => {
    for (const id of ['r1', 'r2', 'r3', 'r4']) await insert(id, new Date());
    // As a restore leaves them: the other server's transaction count, the cursor after r2.
    await database.client.exec(`
      alter table audit_events disable trigger audit_events_append_only;
      update audit_events set tx_id = ('999999000' || id)::xid8;
      alter table audit_events enable trigger audit_events_append_only;
      insert into audit_sink (name, last_tx_id, last_id) values ('sink', '9999990002', 2);
    `);
    // Recorded on the restored stack before the recipe runs.
    await insert('new1', new Date());
    await insert('new2', new Date());
    const cursor = new DrizzleAuditSinkCursor(database);
    expect(await cursor.claim('one', 60_000)).toBe('ahead');

    await database.client.exec(RESTORE_RECIPE);

    const from = await cursor.claim('one', 60_000);
    expect(from).toEqual({ tx: '1', id: '2' });
    expect(
      (await cursor.read(from as AuditPosition, 10)).map(
        (e) => e.event.subject.id,
      ),
    ).toEqual(['r3', 'r4', 'new1', 'new2']);
  });

  it('the restore recipe sends what was recorded since the restore when the sink had sent everything', async () => {
    for (const id of ['r1', 'r2']) await insert(id, new Date());
    await database.client.exec(`
      alter table audit_events disable trigger audit_events_append_only;
      update audit_events set tx_id = ('999999000' || id)::xid8;
      alter table audit_events enable trigger audit_events_append_only;
      insert into audit_sink (name, last_tx_id, last_id) values ('sink', '9999990002', 2);
    `);
    await insert('new1', new Date());
    await insert('new2', new Date());
    await database.client.exec(RESTORE_RECIPE);
    const cursor = new DrizzleAuditSinkCursor(database);
    const from = await cursor.claim('one', 60_000);
    expect(from).toEqual({ tx: '1', id: '2' });
    expect(
      (await cursor.read(from as AuditPosition, 10)).map(
        (e) => e.event.subject.id,
      ),
    ).toEqual(['new1', 'new2']);
  });
});
