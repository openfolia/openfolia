import { FakeChangeSetEvents } from '../../../../tests/fakes/fake-change-set-events.js';
import { actorWith } from '../../../../tests/fakes/actors.js';
import { FakeAuditLog } from '../../../../tests/fakes/fake-audit-log.js';
import { FakeChangeSetStore } from '../../../../tests/fakes/fake-change-set-store.js';
import {
  config as baseConfig,
  type FakeContent,
  manifest,
  module,
} from '../../../../tests/fakes/fake-content.js';
import { fakeOpenSnapshot } from '../../../../tests/fakes/fake-repository.js';
import { FakeWorkingCopyStore } from '../../../../tests/fakes/fake-working-copy-store.js';
import { FakeChangeSetBranches } from '../../../../tests/fakes/fake-change-set-branches.js';
import { FakeLockStore } from '../../../../tests/fakes/fake-lock-store.js';
import { FakeUnitOfWork } from '../../../../tests/fakes/fake-unit-of-work.js';
import { ProjectConfig } from '@openfolia/content-model';
import type { Actor, Scope } from '../../../access/core/actor.js';
import type { Permission } from '../../../access/core/permissions.js';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from '../../../base/core/errors.js';
import {
  type ChangeSet,
  changeSetBranch,
  newChangeSetId,
} from '../change-set.js';
import { LockHolding } from '../lock-holding.js';
import {
  type LockSubject,
  MAX_LOCKS_PER_HOLDER,
  newLockId,
  parseSubject,
  subjectKey,
} from '../lock.js';
import { AbandonChangeSetAction } from './abandon-change-set.action.js';
import { AcquireLockAction } from './acquire-lock.action.js';
import { BreakLockAction } from './break-lock.action.js';
import { GetLockAction, ListLocksAction } from './list-locks.action.js';
import { ReleaseLockAction } from './release-lock.action.js';

const EDITING: Permission[] = [
  'content.read',
  'content.edit',
  'content.read.draft',
];
const editor = (scope: Scope = {}, id = 'sample-author'): Actor => ({
  ...actorWith(EDITING, scope),
  id,
});
const author = editor();
const other: Actor = { ...author, id: 'sample-other' };
const admin = actorWith(['admin.roles']);

const charging: LockSubject = {
  type: 'module',
  lang: 'en',
  moduleId: 'battery-charging',
};
const operating: LockSubject = { type: 'manual', manualId: 'operating' };

function changeSet(by: Actor, over: Partial<ChangeSet> = {}): ChangeSet {
  const id = newChangeSetId();
  const now = new Date();
  return {
    id,
    title: 'x',
    description: null,
    author: { kind: by.kind, id: by.id },
    baseRef: 'main',
    baseCommit: 'a'.repeat(40),
    baseReleased: true,
    branch: changeSetBranch(id),
    state: 'draft',
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

/** `content`: what every change set's branch holds (at `main`'s commit). */
function setUp(content: FakeContent = {}) {
  const mine = changeSet(author);
  const theirs = changeSet(other);
  const changeSets = new FakeChangeSetStore([mine, theirs]);
  const locks = new FakeLockStore();
  const audit = new FakeAuditLog();
  const unit = new FakeUnitOfWork();
  const open = fakeOpenSnapshot(content);
  const events = new FakeChangeSetEvents();
  const copies = new FakeWorkingCopyStore();
  // Every branch at its base commit: no change set has changes yet.
  const branches = new FakeChangeSetBranches();
  for (const c of [mine, theirs]) branches.heads.set(c.branch, c.baseCommit);
  const holding = new LockHolding(changeSets, copies, branches);
  return {
    events,
    mine,
    theirs,
    changeSets,
    locks,
    audit,
    unit,
    copies,
    branches,
    acquire: new AcquireLockAction(
      changeSets,
      locks,
      open,
      audit,
      unit,
      holding,
    ),
    release: new ReleaseLockAction(
      locks,
      open,
      audit,
      unit,
      changeSets,
      holding,
    ),
    break: new BreakLockAction(locks, audit, events, unit),
    list: new ListLocksAction(locks, open),
    get: new GetLockAction(locks, open),
    abandon: new AbandonChangeSetAction(
      changeSets,
      locks,
      new FakeWorkingCopyStore(),
      audit,
      new FakeChangeSetEvents(),
      unit,
    ),
  };
}

/** A commit on `changeSet`'s branch changing the file at `path`. */
function commitOf(changeSet: ChangeSet, path: string) {
  return {
    changes: [{ path, content: 'changed' }],
    message: 'A change',
    author: changeSet.author,
    changeSetId: changeSet.id,
  };
}

/** A working copy of `subject` in `changeSet`, saved. */
async function saveCopy(
  s: ReturnType<typeof setUp>,
  changeSet: ChangeSet,
  subject: LockSubject,
): Promise<void> {
  await s.unit.run((tx) =>
    s.copies.save(
      tx,
      {
        changeSetId: changeSet.id,
        subject,
        content: {},
        baseCommit: changeSet.baseCommit,
        updatedBy: changeSet.author,
      } as never,
      0,
    ),
  );
}

describe('lock subjects', () => {
  it('name a module in a language or a manual, as the audit log does', () => {
    expect(subjectKey(charging)).toEqual({
      type: 'module',
      id: 'en/battery-charging',
    });
    expect(subjectKey(operating)).toEqual({ type: 'manual', id: 'operating' });
    expect(parseSubject('module/en/battery-charging')).toEqual(charging);
    expect(parseSubject('manual/operating')).toEqual(operating);
    // One key per subject: the language in its canonical case.
    expect(parseSubject('module/PT-br/x')).toEqual({
      type: 'module',
      lang: 'pt-BR',
      moduleId: 'x',
    });
    for (const bad of [
      'module/en',
      'module/en/a/b',
      'module/en/Bad',
      'manual/a/b',
      'manual/',
      'role/admin',
      '',
    ]) {
      expect([bad, parseSubject(bad)]).toEqual([bad, undefined]);
    }
  });
});

describe('AcquireLockAction', () => {
  it('takes the lock for its author’s draft, audited', async () => {
    const s = setUp();
    const { lock, created } = await s.acquire.handle({
      actor: author,
      changeSetId: s.mine.id,
      subject: charging,
    });
    expect(created).toBe(true);
    expect(lock).toMatchObject({
      subject: charging,
      changeSetId: s.mine.id,
      holder: { kind: 'user', id: 'sample-author' },
    });
    expect(s.locks.locks).toEqual([lock]);
    expect(s.audit.events).toMatchObject([
      {
        action: 'lock.acquire',
        actor: { kind: 'user', id: 'sample-author' },
        subject: { type: 'module', id: 'en/battery-charging' },
        data: { lockId: lock.id, changeSetId: s.mine.id },
      },
    ]);
  });

  it('answers a subject the change set holds with its lock, changing nothing', async () => {
    const s = setUp();
    const first = await s.acquire.handle({
      actor: author,
      changeSetId: s.mine.id,
      subject: operating,
    });
    const again = await s.acquire.handle({
      actor: author,
      changeSetId: s.mine.id,
      subject: operating,
    });
    expect(again).toEqual({ lock: first.lock, created: false });
    expect(s.locks.locks).toHaveLength(1);
    expect(s.audit.events).toHaveLength(1);
  });

  it('refuses a subject another change set holds, naming the holder', async () => {
    const s = setUp();
    const { lock } = await s.acquire.handle({
      actor: other,
      changeSetId: s.theirs.id,
      subject: charging,
    });
    // Even the same holder's other change set.
    const second = changeSet(other);
    s.changeSets.changeSets.push(second);
    for (const [actor, changeSetId] of [
      [author, s.mine.id],
      [other, second.id],
    ] as const) {
      await expect(
        s.acquire.handle({ actor, changeSetId, subject: charging }),
      ).rejects.toMatchObject({
        constructor: ConflictError,
        code: 'locked',
        meta: {
          lockId: lock.id,
          holder: { kind: 'user', id: 'sample-other' },
          changeSetId: s.theirs.id,
          since: lock.since.toISOString(),
          changeSetTitle: s.theirs.title,
          changeSetState: 'draft',
          hasChanges: false,
        },
      });
    }
    expect(s.locks.locks).toEqual([lock]);
    expect(s.audit.events).toHaveLength(1);
  });

  it('loses to a concurrent transaction that took the subject first', async () => {
    const s = setUp();
    const winner = {
      id: newLockId(),
      subject: charging,
      changeSetId: s.theirs.id,
      holder: { kind: 'user' as const, id: other.id },
      since: new Date(),
    };
    // The subject was free when read, and is taken before the insert.
    s.locks.beforeInsert = () => {
      s.locks.beforeInsert = undefined;
      s.locks.locks.push(winner);
    };
    await expect(
      s.acquire.handle({
        actor: author,
        changeSetId: s.mine.id,
        subject: charging,
      }),
    ).rejects.toMatchObject({ code: 'locked', meta: { lockId: winner.id } });
    expect(s.locks.locks).toEqual([winner]);
    expect(s.audit.events).toEqual([]);
  });

  it('tries again when the lock that won is gone again, then gives up', async () => {
    const s = setUp();
    // Each insert conflicts, and the lock is gone when read again.
    const insert = s.locks.insert.bind(s.locks);
    let inserts = 0;
    s.locks.insert = async () => {
      inserts++;
      return undefined;
    };
    await expect(
      s.acquire.handle({
        actor: author,
        changeSetId: s.mine.id,
        subject: charging,
      }),
    ).rejects.toMatchObject({ code: 'lock-contended' });
    expect(inserts).toBe(3);

    s.locks.insert = async (tx, lock) =>
      ++inserts === 5 ? insert(tx, lock) : undefined;
    const { created } = await s.acquire.handle({
      actor: author,
      changeSetId: s.mine.id,
      subject: charging,
    });
    expect(created).toBe(true);
  });

  it('is only for the change set’s author, on a draft that exists', async () => {
    const s = setUp();
    await expect(
      s.acquire.handle({
        actor: other,
        changeSetId: s.mine.id,
        subject: charging,
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      s.acquire.handle({
        actor: author,
        changeSetId: newChangeSetId(),
        subject: charging,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    for (const state of [
      'in-review',
      'approved',
      'merged',
      'abandoned',
    ] as const) {
      const closed = changeSet(author, { state });
      s.changeSets.changeSets.push(closed);
      await expect(
        s.acquire.handle({
          actor: author,
          changeSetId: closed.id,
          subject: charging,
        }),
      ).rejects.toMatchObject({ code: 'invalid-state', meta: { state } });
    }
    await expect(
      s.acquire.handle({
        actor: actorWith(['content.read.draft']),
        changeSetId: s.mine.id,
        subject: charging,
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(s.locks.locks).toEqual([]);
    expect(s.audit.events).toEqual([]);
  });

  it('caps the locks one holder holds, across change sets', async () => {
    const s = setUp();
    const another = changeSet(author);
    s.changeSets.changeSets.push(another);
    for (let i = 0; i < MAX_LOCKS_PER_HOLDER; i++) {
      s.locks.locks.push({
        id: newLockId(),
        subject: { type: 'manual', manualId: `m${i}` },
        changeSetId: i % 2 ? s.mine.id : another.id,
        holder: { kind: 'user', id: author.id },
        since: new Date(),
      });
    }
    await expect(
      s.acquire.handle({
        actor: author,
        changeSetId: s.mine.id,
        subject: charging,
      }),
    ).rejects.toMatchObject({
      code: 'too-many-locks',
      meta: { max: MAX_LOCKS_PER_HOLDER },
    });
    // One it holds already is still answered; others hold their own.
    const held = await s.acquire.handle({
      actor: author,
      changeSetId: s.mine.id,
      subject: { type: 'manual', manualId: 'm1' },
    });
    expect(held.created).toBe(false);
    const theirs = await s.acquire.handle({
      actor: other,
      changeSetId: s.theirs.id,
      subject: charging,
    });
    expect(theirs.created).toBe(true);
  });

  it('locks a module only in a language the actor edits', async () => {
    const s = setUp();
    const german = editor({ languages: ['de'] });
    // Another role reading in English grants no editing there.
    const reading: Actor = {
      ...german,
      roles: [
        ...german.roles,
        { ...actorWith(['content.read.draft']).roles[0]!, id: 'reader' },
      ],
    };
    for (const actor of [german, reading]) {
      await expect(
        s.acquire.handle({ actor, changeSetId: s.mine.id, subject: charging }),
      ).rejects.toBeInstanceOf(ForbiddenError);
    }
    const de = await s.acquire.handle({
      actor: german,
      changeSetId: s.mine.id,
      subject: { ...charging, lang: 'de' },
    });
    expect(de.created).toBe(true);
    expect(s.locks.locks).toEqual([de.lock]);
  });

  it('says it has changes when a save point lands while it looks (#935)', async () => {
    const s = setUp();
    await s.acquire.handle({
      actor: author,
      changeSetId: s.mine.id,
      subject: charging,
    });
    // The copy is gone by the time it is read: the save point moved the branch before.
    vi.spyOn(s.copies, 'find').mockImplementation(async () => {
      await new Promise((resolve) => setImmediate(resolve));
      s.branches.push(
        s.mine.branch,
        commitOf(s.mine, 'modules/en/battery-charging.adoc'),
      );
      return undefined;
    });
    await expect(
      s.acquire.handle({
        actor: other,
        changeSetId: s.theirs.id,
        subject: charging,
      }),
    ).rejects.toMatchObject({ code: 'locked', meta: { hasChanges: true } });
  });

  it('says whether the holding change set has changes to the subject (#472)', async () => {
    const s = setUp();
    const { lock } = await s.acquire.handle({
      actor: author,
      changeSetId: s.mine.id,
      subject: charging,
    });
    const second = changeSet(author, { title: 'Another of mine' });
    s.changeSets.changeSets.push(second);
    const hasChanges = async () => {
      const error = await s.acquire
        .handle({ actor: author, changeSetId: second.id, subject: charging })
        .catch((e: unknown) => e as ConflictError);
      expect(error).toMatchObject({
        code: 'locked',
        meta: { lockId: lock.id, changeSetTitle: 'x', changeSetState: 'draft' },
      });
      return (error as ConflictError).meta?.['hasChanges'];
    };
    expect(await hasChanges()).toBe(false);
    // A commit changing another file: still none to this one.
    s.branches.push(s.mine.branch, commitOf(s.mine, 'modules/en/other.adoc'));
    expect(await hasChanges()).toBe(false);
    // Its translation record counts as the module's.
    const withRecord = setUp();
    await withRecord.acquire.handle({
      actor: author,
      changeSetId: withRecord.mine.id,
      subject: charging,
    });
    withRecord.branches.push(
      withRecord.mine.branch,
      commitOf(withRecord.mine, 'modules/en/battery-charging.translation.yaml'),
    );
    const refusal = await withRecord.acquire
      .handle({
        actor: other,
        changeSetId: withRecord.theirs.id,
        subject: charging,
      })
      .catch((e: unknown) => e as ConflictError);
    expect(refusal).toMatchObject({ meta: { hasChanges: true } });
    // A commit changing it.
    s.branches.push(
      s.mine.branch,
      commitOf(s.mine, 'modules/en/battery-charging.adoc'),
    );
    expect(await hasChanges()).toBe(true);
  });

  it('counts a working copy, and a branch it cannot compare, as changes', async () => {
    const s = setUp();
    await s.acquire.handle({
      actor: author,
      changeSetId: s.mine.id,
      subject: charging,
    });
    const refusal = () =>
      s.acquire
        .handle({ actor: other, changeSetId: s.theirs.id, subject: charging })
        .catch((e: unknown) => e as ConflictError);
    await saveCopy(s, s.mine, charging);
    expect(await refusal()).toMatchObject({ meta: { hasChanges: true } });
    s.copies.copies.clear();
    expect(await refusal()).toMatchObject({ meta: { hasChanges: false } });
    s.branches.heads.delete(s.mine.branch);
    expect(await refusal()).toMatchObject({ meta: { hasChanges: true } });
  });

  it('still refuses with the lock when what its change set did cannot be read (#472)', async () => {
    const s = setUp();
    const { lock } = await s.acquire.handle({
      actor: author,
      changeSetId: s.mine.id,
      subject: charging,
    });
    // A branch whose head cannot be read counts as changed.
    s.branches.head = () => Promise.reject(new Error('Git is busy'));
    expect(
      await s.acquire
        .handle({ actor: other, changeSetId: s.theirs.id, subject: charging })
        .catch((e: unknown) => e as ConflictError),
    ).toMatchObject({ meta: { hasChanges: true } });
    // Its working copies cannot be read: the refusal without what it did.
    s.copies.find = () => Promise.reject(new Error('The database is busy'));
    const error = await s.acquire
      .handle({ actor: other, changeSetId: s.theirs.id, subject: charging })
      .catch((e: unknown) => e as ConflictError);
    expect(error).toMatchObject({ code: 'locked', meta: { lockId: lock.id } });
    expect((error as ConflictError).meta).not.toHaveProperty('hasChanges');
  });

  it('names the holder only to an actor who may read locks', async () => {
    const s = setUp();
    await s.acquire.handle({
      actor: other,
      changeSetId: s.theirs.id,
      subject: charging,
    });
    const editorOnly: Actor = {
      ...actorWith(['content.read', 'content.edit']),
      id: author.id,
    };
    const refusal = await s.acquire
      .handle({ actor: editorOnly, changeSetId: s.mine.id, subject: charging })
      .catch((error: unknown) => error);
    expect(refusal).toMatchObject({ code: 'locked' });
    expect((refusal as ConflictError).meta).toBeUndefined();
    expect((refusal as ConflictError).message).not.toContain('sample-other');
  });

  it('takes no lock when the audit event cannot be recorded', async () => {
    const s = setUp();
    s.audit.record = () => Promise.reject(new Error('the database is down'));
    await expect(
      s.acquire.handle({
        actor: author,
        changeSetId: s.mine.id,
        subject: charging,
      }),
    ).rejects.toThrow('the database is down');
    expect(s.locks.locks).toEqual([]);
  });
});

describe('ReleaseLockAction and BreakLockAction', () => {
  async function locked() {
    const s = setUp();
    const { lock } = await s.acquire.handle({
      actor: author,
      changeSetId: s.mine.id,
      subject: charging,
    });
    return { ...s, lock };
  }

  it('lets the holder release a lock, audited', async () => {
    const s = await locked();
    await expect(
      s.release.handle({ actor: other, id: s.lock.id }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(await s.release.handle({ actor: author, id: s.lock.id })).toEqual(
      s.lock,
    );
    expect(s.locks.locks).toEqual([]);
    expect(s.audit.events.map((e) => [e.action, e.data])).toEqual([
      ['lock.acquire', { lockId: s.lock.id, changeSetId: s.mine.id }],
      ['lock.release', { lockId: s.lock.id, changeSetId: s.mine.id }],
    ]);
    await expect(
      s.release.handle({ actor: author, id: s.lock.id }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('releases one only while its change set has no changes to it, with ifUnchanged (#472)', async () => {
    const s = await locked();
    await saveCopy(s, s.mine, charging);
    await expect(
      s.release.handle({ actor: author, id: s.lock.id, ifUnchanged: true }),
    ).rejects.toMatchObject({
      constructor: ConflictError,
      code: 'has-changes',
      meta: { changeSetId: s.mine.id },
    });
    s.copies.copies.clear();
    s.branches.push(
      s.mine.branch,
      commitOf(s.mine, 'modules/en/battery-charging.adoc'),
    );
    await expect(
      s.release.handle({ actor: author, id: s.lock.id, ifUnchanged: true }),
    ).rejects.toMatchObject({ code: 'has-changes' });
    expect(s.locks.locks).toEqual([s.lock]);
    // Only the holder, as without it.
    await expect(
      s.release.handle({ actor: other, id: s.lock.id, ifUnchanged: true }),
    ).rejects.toBeInstanceOf(ForbiddenError);

    const t = await locked();
    t.branches.push(t.mine.branch, commitOf(t.mine, 'manuals/operating.yaml'));
    expect(
      await t.release.handle({
        actor: author,
        id: t.lock.id,
        ifUnchanged: true,
      }),
    ).toEqual(t.lock);
    expect(t.locks.locks).toEqual([]);
    expect(t.audit.events.at(-1)).toMatchObject({ action: 'lock.release' });
  });

  it('reads the changes again while it holds the lock (#472)', async () => {
    // A working copy saved after the first read: found inside the transaction.
    const s = await locked();
    const lockRow = s.locks.lock.bind(s.locks);
    s.locks.lock = async (tx, id) => {
      const held = await lockRow(tx, id);
      await saveCopy(s, s.mine, charging);
      return held;
    };
    await expect(
      s.release.handle({ actor: author, id: s.lock.id, ifUnchanged: true }),
    ).rejects.toMatchObject({ code: 'has-changes' });
    expect(s.locks.locks).toEqual([s.lock]);

    // A save point that landed after the first read moved the branch.
    const t = await locked();
    const lockRowT = t.locks.lock.bind(t.locks);
    t.locks.lock = async (tx, id) => {
      const held = await lockRowT(tx, id);
      t.branches.push(
        t.mine.branch,
        commitOf(t.mine, 'modules/en/battery-charging.adoc'),
      );
      return held;
    };
    await expect(
      t.release.handle({ actor: author, id: t.lock.id, ifUnchanged: true }),
    ).rejects.toMatchObject({ code: 'has-changes' });
    expect(t.locks.locks).toEqual([t.lock]);
  });

  it('releases without ifUnchanged whatever its change set changed, as before', async () => {
    const s = await locked();
    await saveCopy(s, s.mine, charging);
    await s.release.handle({ actor: author, id: s.lock.id });
    expect(s.locks.locks).toEqual([]);
  });

  it('lets an admin break a lock with a comment, audited with the holder', async () => {
    const s = await locked();
    await expect(
      s.break.handle({ actor: author, id: s.lock.id, comment: 'Mine now.' }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await s.break.handle({ actor: admin, id: s.lock.id, comment: 'Away.' });
    expect(s.locks.locks).toEqual([]);
    expect(s.audit.events.at(-1)).toMatchObject({
      action: 'lock.break',
      actor: { id: admin.id },
      subject: { type: 'module', id: 'en/battery-charging' },
      comment: 'Away.',
      data: {
        lockId: s.lock.id,
        changeSetId: s.mine.id,
        holder: { kind: 'user', id: 'sample-author' },
      },
    });
    // The holder is told (#252): one outbox row, keyed by the lock.
    expect(s.events.events).toEqual([
      {
        topic: 'lock.break',
        key: s.lock.id,
        payload: {
          changeSetId: s.mine.id,
          actor: { kind: 'user', id: admin.id },
          holder: { kind: 'user', id: 'sample-author' },
          subjects: ['module/en/battery-charging'],
          count: 1,
        },
      },
    ]);
    await expect(
      s.break.handle({ actor: admin, id: s.lock.id, comment: 'Again.' }),
    ).rejects.toBeInstanceOf(NotFoundError);
    // The subject is free again.
    const { created } = await s.acquire.handle({
      actor: other,
      changeSetId: s.theirs.id,
      subject: charging,
    });
    expect(created).toBe(true);
  });

  it('keeps the lock when the audit event cannot be recorded', async () => {
    const s = await locked();
    s.audit.record = () => Promise.reject(new Error('the database is down'));
    await expect(
      s.release.handle({ actor: author, id: s.lock.id }),
    ).rejects.toThrow('the database is down');
    await expect(
      s.break.handle({ actor: admin, id: s.lock.id, comment: 'x' }),
    ).rejects.toThrow('the database is down');
    expect(s.locks.locks).toEqual([s.lock]);
  });
});

describe('abandoning a change set', () => {
  it('releases its locks, each audited, and leaves others’ alone', async () => {
    const s = setUp();
    const mine = [];
    for (const subject of [charging, operating]) {
      mine.push(
        (
          await s.acquire.handle({
            actor: author,
            changeSetId: s.mine.id,
            subject,
          })
        ).lock,
      );
    }
    const { lock: theirs } = await s.acquire.handle({
      actor: other,
      changeSetId: s.theirs.id,
      subject: { type: 'module', lang: 'de', moduleId: 'battery-charging' },
    });
    await s.abandon.handle({ actor: author, id: s.mine.id });
    expect(s.locks.locks).toEqual([theirs]);
    expect(
      s.audit.events
        .filter((e) => e.action !== 'lock.acquire')
        .map((e) => [e.action, e.subject.id, e.data]),
    ).toEqual([
      ['change-set.abandon', s.mine.id, { from: 'draft', to: 'abandoned' }],
      ...mine.map((lock) => [
        'lock.release',
        subjectKey(lock.subject).id,
        {
          lockId: lock.id,
          changeSetId: s.mine.id,
          reason: 'change-set.abandon',
        },
      ]),
    ]);
  });
});

describe('ListLocksAction and GetLockAction', () => {
  it('list newest first, filtered, and read one', async () => {
    const s = setUp();
    const a = await s.acquire.handle({
      actor: author,
      changeSetId: s.mine.id,
      subject: charging,
    });
    const b = await s.acquire.handle({
      actor: other,
      changeSetId: s.theirs.id,
      subject: operating,
    });
    const page = { number: 1, size: 50 };
    const ids = async (filter: object) =>
      (await s.list.handle({ actor: author, filter, page })).items.map(
        (l) => l.id,
      );
    expect(await ids({})).toEqual([b.lock.id, a.lock.id]);
    expect(await ids({ holder: 'sample-other' })).toEqual([b.lock.id]);
    expect(await ids({ changeSetId: s.mine.id })).toEqual([a.lock.id]);
    expect(await ids({ subject: charging })).toEqual([a.lock.id]);
    expect(await s.get.handle({ actor: author, id: a.lock.id })).toEqual(
      a.lock,
    );
    await expect(
      s.get.handle({ actor: author, id: newLockId() }),
    ).rejects.toBeInstanceOf(NotFoundError);
    // Without content.read.draft: only one's own locks (#126); another's
    // is not found, like a missing one (#125).
    const own: Actor = {
      ...actorWith(['content.read', 'content.edit']),
      id: author.id,
    };
    const listed = async (actor: Actor, filter: object) => {
      const found = await s.list.handle({ actor, filter, page });
      return [found.total, found.items.map((l) => l.id)];
    };
    expect(await listed(own, {})).toEqual([1, [a.lock.id]]);
    expect(await listed(own, { holder: 'sample-other' })).toEqual([0, []]);
    expect(await listed(own, { subject: operating })).toEqual([0, []]);
    expect(await listed({ ...own, kind: 'service' }, {})).toEqual([0, []]);
    expect(await listed(actorWith(['content.read']), {})).toEqual([0, []]);
    expect(await s.get.handle({ actor: own, id: a.lock.id })).toEqual(a.lock);
    await expect(
      s.get.handle({ actor: own, id: b.lock.id }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('who learns what of change sets and locks (#121, #125)', () => {
  const audiences = ProjectConfig.parse({
    ...baseConfig,
    audiences: [
      { id: 'public', label: 'Public' },
      { id: 'internal', label: 'Internal' },
    ],
  });
  const secret = {
    ...module('battery-charging'),
    meta: { ...module('battery-charging').meta, type: 'secret' },
  };
  const internalManual = { ...manifest('operating', []), audience: 'internal' };
  /** Edits and reads drafts of concepts only. */
  const concepts = editor({ moduleTypes: ['concept'] });
  /** Edits and reads public content only. */
  const publicOnly = editor({ maxAudience: 'public' });
  const refusal = (promise: Promise<unknown>) =>
    promise.then(
      () => expect.unreachable('not refused'),
      (error: unknown) => error as Error,
    );

  it('locks a committed module only within the whole edit scope', async () => {
    const s = setUp({ modules: [secret] });
    const hidden = await refusal(
      s.acquire.handle({
        actor: concepts,
        changeSetId: s.mine.id,
        subject: charging,
      }),
    );
    expect(hidden).toBeInstanceOf(ForbiddenError);
    // A missing one, for an actor who does not edit all of the language,
    // answers exactly alike.
    const missing = await refusal(
      s.acquire.handle({
        actor: concepts,
        changeSetId: s.mine.id,
        subject: { ...charging, moduleId: 'no-such-module' },
      }),
    );
    expect([missing.constructor, missing.message]).toEqual([
      hidden.constructor,
      hidden.message,
    ]);
    // Read but not edited: roles never combine.
    const readsAll: Actor = {
      ...author,
      roles: [
        { ...actorWith(['content.read', 'content.read.draft']).roles[0]! },
        {
          ...actorWith(['content.edit'], { moduleTypes: ['concept'] })
            .roles[0]!,
          id: 'edit',
        },
      ],
    };
    const readOnly = await refusal(
      s.acquire.handle({
        actor: readsAll,
        changeSetId: s.mine.id,
        subject: charging,
      }),
    );
    expect(readOnly.message).toBe(hidden.message);
    // The author edits everything.
    const { created } = await s.acquire.handle({
      actor: author,
      changeSetId: s.mine.id,
      subject: charging,
    });
    expect(created).toBe(true);
    expect(s.audit.events).toHaveLength(1);
  });

  it('locks a manual only for an audience the actor edits and reads', async () => {
    const s = setUp({ config: audiences, manifests: [internalManual] });
    const above = await refusal(
      s.acquire.handle({
        actor: publicOnly,
        changeSetId: s.mine.id,
        subject: operating,
      }),
    );
    expect(above).toBeInstanceOf(ForbiddenError);
    // A new manual: only for one who edits every audience.
    const created = await refusal(
      s.acquire.handle({
        actor: publicOnly,
        changeSetId: s.mine.id,
        subject: { type: 'manual', manualId: 'new-manual' },
      }),
    );
    expect(created.message).toBe(above.message);
    // One naming a module the actor may not see.
    const h = setUp({
      modules: [secret],
      manifests: [manifest('operating', ['battery-charging'])],
    });
    const hiding = await refusal(
      h.acquire.handle({
        actor: concepts,
        changeSetId: h.mine.id,
        subject: operating,
      }),
    );
    expect(hiding.message).toBe(above.message);
    for (const [t, subject] of [
      [s, operating],
      [s, { type: 'manual', manualId: 'new-manual' }],
      [h, operating],
    ] as const) {
      const { created } = await t.acquire.handle({
        actor: author,
        changeSetId: t.mine.id,
        subject,
      });
      expect(created).toBe(true);
    }
  });

  it('names the holder of a lock only to an actor who may know of that lock', async () => {
    const s = setUp();
    await s.acquire.handle({
      actor: other,
      changeSetId: s.theirs.id,
      subject: charging,
    });
    // Edits and reads English, but reads drafts only in French: the lock
    // is not listed to them, so the refusal names nobody either.
    const frenchDrafts: Actor = {
      ...author,
      roles: [
        actorWith(['content.read', 'content.edit']).roles[0]!,
        {
          ...actorWith(['content.read.draft'], { languages: ['fr'] }).roles[0]!,
          id: 'drafts',
        },
      ],
    };
    const error = await refusal(
      s.acquire.handle({
        actor: frenchDrafts,
        changeSetId: s.mine.id,
        subject: charging,
      }),
    );
    expect(error).toMatchObject({ code: 'locked' });
    expect((error as ConflictError).meta).toBeUndefined();
    expect(error.message).not.toContain(other.id);
    expect(
      (
        await s.list.handle({
          actor: frenchDrafts,
          filter: {},
          page: { number: 1, size: 50 },
        })
      ).total,
    ).toBe(0);
  });

  it('answers another author’s change set as a missing one to an actor who may not read them', async () => {
    const s = setUp();
    const editorOnly: Actor = {
      ...actorWith(['content.read', 'content.edit']),
      id: other.id,
    };
    const missingId = newChangeSetId();
    const answers = async (actor: Actor, id: string) =>
      Promise.all([
        refusal(
          s.acquire.handle({ actor, changeSetId: id, subject: operating }),
        ),
        refusal(s.abandon.handle({ actor, id })),
      ]);
    const theirs = await answers(editorOnly, s.mine.id);
    const missing = await answers(editorOnly, missingId);
    for (const [i, error] of theirs.entries()) {
      expect(error).toBeInstanceOf(NotFoundError);
      expect(error.message.replace(s.mine.id, '<id>')).toBe(
        missing[i]!.message.replace(missingId, '<id>'),
      );
    }
    // A draft reader is told it is not theirs.
    for (const error of await answers(other, s.mine.id)) {
      expect(error).toBeInstanceOf(ForbiddenError);
    }
    expect(s.changeSets.changeSets[0]?.state).toBe('draft');
  });

  it('lists and reads only the locks within the reader’s scope, counted before paging', async () => {
    const s = setUp({ modules: [secret, module('visible')] });
    const take = async (subject: LockSubject) =>
      (
        await s.acquire.handle({
          actor: author,
          changeSetId: s.mine.id,
          subject,
        })
      ).lock;
    const hidden = await take(charging);
    const visible = await take({ ...charging, moduleId: 'visible' });
    const german = await take({ ...charging, lang: 'de' });
    const page = { number: 1, size: 1 };
    const listed = (actor: Actor) =>
      s.list.handle({ actor, filter: {}, page: { number: 1, size: 50 } });
    expect((await listed(author)).items).toEqual([german, visible, hidden]);
    // Concepts only: the secret module, and a new module in a language
    // they do not read wholly, are left out.
    expect(await listed(concepts)).toEqual({ total: 1, items: [visible] });
    expect(await s.list.handle({ actor: concepts, filter: {}, page })).toEqual({
      total: 1,
      items: [visible],
    });
    // English only: the German lock is left out without reading content.
    const english = editor({ languages: ['en'] });
    expect((await listed(english)).items).toEqual([visible, hidden]);
    // A lock outside the scope is not found, exactly like none.
    const missingId = newLockId();
    const outside = await refusal(
      s.get.handle({ actor: concepts, id: hidden.id }),
    );
    const none = await refusal(
      s.get.handle({ actor: concepts, id: missingId }),
    );
    expect(outside).toBeInstanceOf(NotFoundError);
    expect(outside.message.replace(hidden.id, '<id>')).toBe(
      none.message.replace(missingId, '<id>'),
    );
    expect(await s.get.handle({ actor: concepts, id: visible.id })).toEqual(
      visible,
    );
  });

  it('hides the locks of a branch the reader cannot open', async () => {
    const s = setUp({ modules: [module('visible')] });
    const { lock } = await s.acquire.handle({
      actor: author,
      changeSetId: s.mine.id,
      subject: { ...charging, moduleId: 'visible' },
    });
    // Reads drafts (scoped) but not released content: the branch, at
    // main's commit, does not open for them.
    const draftsOnly = {
      ...actorWith(['content.read.draft'], { moduleTypes: ['concept'] }),
      id: 'drafts-only',
    };
    expect(
      await s.list.handle({
        actor: draftsOnly,
        filter: {},
        page: { number: 1, size: 50 },
      }),
    ).toEqual({ total: 0, items: [] });
    await expect(
      s.get.handle({ actor: draftsOnly, id: lock.id }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('answers releasing someone’s lock as a missing one unless the actor may know of it', async () => {
    const s = setUp({ modules: [secret, module('visible')] });
    const take = async (subject: LockSubject) =>
      (
        await s.acquire.handle({
          actor: author,
          changeSetId: s.mine.id,
          subject,
        })
      ).lock;
    const hidden = await take(charging);
    const visible = await take({ ...charging, moduleId: 'visible' });
    const missingId = newLockId();
    const editorOnly: Actor = {
      ...actorWith(['content.read', 'content.edit']),
      id: other.id,
    };
    const narrow = editor({ moduleTypes: ['concept'] }, other.id);
    const none = await refusal(
      s.release.handle({ actor: editorOnly, id: missingId }),
    );
    for (const [actor, lock] of [
      [editorOnly, visible],
      [editorOnly, hidden],
      [narrow, hidden],
    ] as const) {
      const error = await refusal(s.release.handle({ actor, id: lock.id }));
      expect(error).toBeInstanceOf(NotFoundError);
      expect(error.message.replace(lock.id, '<id>')).toBe(
        none.message.replace(missingId, '<id>'),
      );
    }
    // Draft readers who may know of it are told it is not theirs.
    for (const actor of [other, narrow]) {
      await expect(
        s.release.handle({ actor, id: visible.id }),
      ).rejects.toBeInstanceOf(ForbiddenError);
    }
    expect(s.locks.locks).toEqual([hidden, visible]);
  });
});
