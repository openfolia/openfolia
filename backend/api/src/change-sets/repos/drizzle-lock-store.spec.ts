import { sql } from 'drizzle-orm';
import { DrizzleChangeSetEvents } from './drizzle-change-set-events.js';
import {
  createTestDatabase,
  type PgliteDatabase,
} from '../../../tests/database.js';
import { actorWith } from '../../../tests/fakes/actors.js';
import { fakeOpenSnapshot } from '../../../tests/fakes/fake-repository.js';
import { DrizzleAuditLog } from '../../audit/repos/drizzle-audit-log.js';
import { DrizzleUnitOfWork } from '../../database/drizzle-unit-of-work.js';
import { BreakLocksAction } from '../core/actions/break-locks.action.js';
import { holdingOf } from '../../../tests/fakes/fake-lock-holding.js';
import { AcquireLockAction } from '../core/actions/acquire-lock.action.js';
import { AbandonChangeSetAction } from '../core/actions/abandon-change-set.action.js';
import {
  type ChangeSet,
  changeSetBranch,
  newChangeSetId,
} from '../core/change-set.js';
import { type LockSubject, type NewLock, newLockId } from '../core/lock.js';
import { DrizzleChangeSetStore } from './drizzle-change-set-store.js';
import { DrizzleLockStore } from './drizzle-lock-store.js';
import { DrizzleWorkingCopyStore } from './drizzle-working-copy-store.js';

const charging: LockSubject = {
  type: 'module',
  lang: 'en',
  moduleId: 'battery-charging',
};

function changeSet(author = 'sample-author'): ChangeSet {
  const id = newChangeSetId();
  const now = new Date();
  return {
    id,
    title: 'x',
    description: null,
    author: { kind: 'user', id: author },
    baseRef: 'main',
    baseCommit: 'c'.repeat(40),
    baseReleased: true,
    branch: changeSetBranch(id),
    state: 'draft',
    createdAt: now,
    updatedAt: now,
  };
}

describe('DrizzleLockStore', () => {
  let database: PgliteDatabase;
  let store: DrizzleLockStore;
  let changeSets: DrizzleChangeSetStore;
  let unit: DrizzleUnitOfWork;
  let mine: ChangeSet;
  let theirs: ChangeSet;
  const all = { number: 1, size: 50 };
  const newLock = (over: Partial<NewLock> = {}): NewLock => ({
    id: newLockId(),
    subject: charging,
    changeSetId: mine.id,
    holder: { kind: 'user', id: 'sample-author' },
    ...over,
  });

  beforeEach(async () => {
    database = await createTestDatabase();
    store = new DrizzleLockStore(database);
    changeSets = new DrizzleChangeSetStore(database);
    unit = new DrizzleUnitOfWork(database);
    mine = changeSet();
    theirs = changeSet('sample-other');
    await unit.run(async (tx) => {
      await changeSets.insert(tx, mine);
      await changeSets.insert(tx, theirs);
    });
  });
  afterEach(() => database?.close());

  it('stores locks and reads them back exactly, stamped by the transaction', async () => {
    const lock = await unit.run((tx) => store.insert(tx, newLock()));
    expect(lock).toMatchObject({ subject: charging, changeSetId: mine.id });
    expect(lock?.since).toBeInstanceOf(Date);
    expect(await store.find(lock?.id ?? '')).toEqual(lock);
    expect(
      await unit.run((tx) =>
        store.findBySubject(tx, { ...charging, lang: 'en' }),
      ),
    ).toEqual(lock);
    expect(await store.find(newLockId())).toBeUndefined();
    expect(await store.find('nope')).toBeUndefined();
  });

  it('holds one lock per subject, and stays usable after the refusal', async () => {
    await unit.run((tx) => store.insert(tx, newLock()));
    const refused = await unit.run(async (tx) => {
      const lock = await store.insert(
        tx,
        newLock({
          changeSetId: theirs.id,
          holder: { kind: 'user', id: 'sample-other' },
        }),
      );
      // The transaction goes on: nothing failed in it.
      await store.insert(
        tx,
        newLock({
          changeSetId: theirs.id,
          subject: { type: 'manual', manualId: 'operating' },
        }),
      );
      return lock;
    });
    expect(refused).toBeUndefined();
    expect((await store.list({}, all)).total).toBe(2);
    // The database itself refuses a second lock on a subject.
    await expect(
      database.db.execute(
        sql`insert into locks values (${newLockId()}, 'module', 'en/battery-charging', ${theirs.id}, 'user', 'x', now())`,
      ),
    ).rejects.toThrow();
  });

  // PGlite is one connection: it runs these transactions one after another
  // (no two interleave), so this shows the outcome, not the wait inside
  // Postgres. That a waiting insert loses is the unique index's guarantee,
  // checked above; the action's retry covers a lock gone again meanwhile.
  it('lets one of many acquires win; the rest are told the holder', async () => {
    const audit = new DrizzleAuditLog(database);
    const acquire = new AcquireLockAction(
      changeSets,
      store,
      fakeOpenSnapshot(),
      audit,
      unit,
      holdingOf(changeSets),
    );
    const contenders: ChangeSet[] = [];
    await unit.run(async (tx) => {
      for (let i = 0; i < 8; i++) {
        const c = changeSet(`contender-${i}`);
        contenders.push(c);
        await changeSets.insert(tx, c);
      }
    });
    const results = await Promise.allSettled(
      contenders.map((c) =>
        acquire.handle({
          actor: {
            ...actorWith([
              'content.read',
              'content.edit',
              'content.read.draft',
            ]),
            id: c.author.id,
          },
          changeSetId: c.id,
          subject: charging,
        }),
      ),
    );
    const won = results.filter((r) => r.status === 'fulfilled');
    const lost = results.filter((r) => r.status === 'rejected');
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(7);
    const winner = won[0]?.value.lock;
    for (const r of lost) {
      expect(r.reason).toMatchObject({
        code: 'locked',
        meta: { lockId: winner?.id },
      });
    }
    const { items } = await store.list({ subject: charging }, all);
    expect(items).toEqual([winner]);
    const events = await database.db.execute(
      sql`select count(*)::int as n from audit_events where action = 'lock.acquire'`,
    );
    expect(events.rows).toEqual([{ n: 1 }]);
  });

  it.each(['change set', 'holder'] as const)(
    'breaks all locks by %s without losing or leaving one against concurrent acquires',
    async (by) => {
      const audit = new DrizzleAuditLog(database);
      const acquire = new AcquireLockAction(
        changeSets,
        store,
        fakeOpenSnapshot(),
        audit,
        unit,
        holdingOf(changeSets),
      );
      const breakAll = new BreakLocksAction(
        changeSets,
        store,
        audit,
        new DrizzleChangeSetEvents(),
        unit,
      );
      const author = {
        ...actorWith(['content.read', 'content.edit', 'content.read.draft']),
        id: 'sample-author',
      };
      const admin = actorWith(['admin.roles']);
      const subjects = Array.from({ length: 12 }, (_, i): LockSubject => ({
        type: 'manual',
        manualId: `race-${i}`,
      }));
      const acquires = subjects.map((subject) =>
        acquire.handle({ actor: author, changeSetId: mine.id, subject }),
      );
      const breaking = breakAll.handle({
        actor: admin,
        comment: 'Race.',
        ...(by === 'holder'
          ? { holder: { kind: 'user' as const, id: 'sample-author' } }
          : { changeSetId: mine.id }),
      });
      await Promise.allSettled(acquires);
      const broken = await breaking;
      const left = (await store.list({}, all)).items.length;
      const counted = await database.db.execute(
        sql`select action, count(*)::int as n from audit_events group by action`,
      );
      const n = (action: string) =>
        (counted.rows.find((r) => r.action === action)?.n as number) ?? 0;
      // Every lock taken is either broken (and audited) or still there.
      expect(n('lock.break')).toBe(broken);
      expect(n('lock.acquire')).toBe(broken + left);
    },
  );

  it('refuses an insert that loses to a lock taken since the read', async () => {
    const winner = await unit.run((tx) =>
      store.insert(
        tx,
        newLock({
          changeSetId: theirs.id,
          holder: { kind: 'user', id: 'sample-other' },
        }),
      ),
    );
    // Misses the winner on its first read, as when it commits in between:
    // the insert then meets it in the database, and the action reads it.
    class LateStore extends DrizzleLockStore {
      missed = false;
      override findBySubject(
        ...args: Parameters<DrizzleLockStore['findBySubject']>
      ) {
        if (this.missed) return super.findBySubject(...args);
        this.missed = true;
        return Promise.resolve(undefined);
      }
    }
    const late = new LateStore(database);
    const acquire = new AcquireLockAction(
      changeSets,
      late,
      fakeOpenSnapshot(),
      new DrizzleAuditLog(database),
      unit,
      holdingOf(changeSets),
    );
    await expect(
      acquire.handle({
        actor: {
          ...actorWith(['content.read', 'content.edit', 'content.read.draft']),
          id: 'sample-author',
        },
        changeSetId: mine.id,
        subject: charging,
      }),
    ).rejects.toMatchObject({ code: 'locked', meta: { lockId: winner?.id } });
    expect(late.missed).toBe(true);
    expect((await store.list({}, all)).items).toEqual([winner]);
  });

  it('lists newest first, filtered, paged', async () => {
    const a = await unit.run((tx) => store.insert(tx, newLock()));
    const b = await unit.run((tx) =>
      store.insert(
        tx,
        newLock({
          subject: { type: 'manual', manualId: 'operating' },
          changeSetId: theirs.id,
          holder: { kind: 'user', id: 'sample-other' },
        }),
      ),
    );
    const ids = async (filter: object, page = all) =>
      (await store.list(filter, page)).items.map((l) => l.id);
    expect(await ids({})).toEqual([b?.id, a?.id]);
    expect(await ids({ holder: 'sample-other' })).toEqual([b?.id]);
    expect(await ids({ changeSetId: mine.id })).toEqual([a?.id]);
    expect(await ids({ changeSetId: 'nope' })).toEqual([]);
    expect(await ids({ subject: charging })).toEqual([a?.id]);
    expect(
      await ids({ subject: { type: 'module', lang: 'de', moduleId: 'x' } }),
    ).toEqual([]);
    expect(await store.list({}, { number: 2, size: 1 })).toEqual({
      total: 2,
      items: [a],
    });
    // Every one, unpaged, filtered and ordered as `list`.
    expect(await store.all({})).toEqual([b, a]);
    expect(await store.all({ holder: 'sample-other' })).toEqual([b]);
    expect(await store.all({ changeSetId: 'nope' })).toEqual([]);
    expect(await store.all({ subject: charging })).toEqual([a]);
    // Module locks only in these languages; manual locks always.
    expect(await store.all({ moduleLanguages: ['en'] })).toEqual([b, a]);
    expect(await store.all({ moduleLanguages: ['de'] })).toEqual([b]);
    expect(await store.all({ moduleLanguages: [] })).toEqual([b]);
  });

  it('locks, counts and removes; abandoning releases a change set’s locks', async () => {
    const a = await unit.run((tx) => store.insert(tx, newLock()));
    const b = await unit.run((tx) =>
      store.insert(
        tx,
        newLock({ subject: { type: 'manual', manualId: 'operating' } }),
      ),
    );
    const c = await unit.run((tx) =>
      store.insert(
        tx,
        newLock({
          subject: { type: 'manual', manualId: 'service' },
          changeSetId: theirs.id,
        }),
      ),
    );
    await unit.run(async (tx) => {
      expect(
        await store.countHeldBy(tx, { kind: 'user', id: 'sample-author' }),
      ).toBe(3);
      expect(
        await store.countHeldBy(tx, { kind: 'service', id: 'sample-author' }),
      ).toBe(0);
      expect(await store.lock(tx, a?.id ?? '')).toEqual(a);
      expect(await store.lock(tx, 'nope')).toBeUndefined();
      await store.remove(tx, a?.id ?? '');
    });
    expect(await store.find(a?.id ?? '')).toBeUndefined();

    const audit = new DrizzleAuditLog(database);
    const abandon = new AbandonChangeSetAction(
      changeSets,
      store,
      new DrizzleWorkingCopyStore(database),
      audit,
      new DrizzleChangeSetEvents(),
      unit,
    );
    await abandon.handle({
      actor: { ...actorWith(['content.edit']), id: 'sample-author' },
      id: mine.id,
    });
    expect((await store.list({}, all)).items).toEqual([c]);
    const events = await database.db.execute(
      sql`select action, subject_id, data from audit_events order by id`,
    );
    expect(events.rows).toEqual([
      {
        action: 'change-set.abandon',
        subject_id: mine.id,
        data: { from: 'draft', to: 'abandoned' },
      },
      {
        action: 'lock.release',
        subject_id: 'operating',
        data: {
          lockId: b?.id,
          changeSetId: mine.id,
          reason: 'change-set.abandon',
        },
      },
    ]);
  });

  it('holds several locks at once in ID order, only those that exist', async () => {
    const subjects: LockSubject[] = ['c', 'a', 'b'].map((m) => ({
      type: 'module',
      lang: 'en',
      moduleId: `module-${m}`,
    }));
    const ids = [newLockId(), newLockId(), newLockId()];
    await unit.run(async (tx) => {
      // Inserted against ID order: the answer still follows the IDs.
      for (const [i, subject] of subjects.entries()) {
        await store.insert(tx, newLock({ id: ids[2 - i] as string, subject }));
      }
    });
    const held = await unit.run((tx) =>
      store.holdAll(tx, [
        ...subjects,
        { type: 'manual', manualId: 'not-locked' },
      ]),
    );
    expect(held.map((l) => l.id)).toEqual([...ids].sort());
    expect(await unit.run((tx) => store.holdAll(tx, []))).toEqual([]);
  });

  it('holds the formats in the database too', async () => {
    const bad: string[] = [
      `'module', 'battery-charging'`,
      `'module', 'en/Bad'`,
      `'module', 'EN/x'`,
      `'module', 'en/a/b'`,
      `'manual', 'en/x'`,
      `'role', 'admin'`,
    ];
    for (const subject of bad) {
      await expect(
        database.db.execute(
          sql.raw(
            `insert into locks values ('${newLockId()}', ${subject}, '${mine.id}', 'user', 'x', now())`,
          ),
        ),
      ).rejects.toThrow();
    }
    await expect(
      database.db.execute(
        sql`insert into locks values (${newLockId()}, 'manual', 'x', ${mine.id}, 'robot', 'x', now())`,
      ),
    ).rejects.toThrow();
    // Only for a change set that exists.
    await expect(
      database.db.execute(
        sql`insert into locks values (${newLockId()}, 'manual', 'x', ${newChangeSetId()}, 'user', 'x', now())`,
      ),
    ).rejects.toThrow();
    expect((await store.list({}, all)).total).toBe(0);
  });
});
