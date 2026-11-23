import { FakeChangeSetEvents } from '../../../../tests/fakes/fake-change-set-events.js';
import { actorWith } from '../../../../tests/fakes/actors.js';
import { FakeAuditLog } from '../../../../tests/fakes/fake-audit-log.js';
import { FakeChangeSetBranches } from '../../../../tests/fakes/fake-change-set-branches.js';
import { FakeChangeSetStore } from '../../../../tests/fakes/fake-change-set-store.js';
import { FakeWorkingCopyStore } from '../../../../tests/fakes/fake-working-copy-store.js';
import { FakeLockStore } from '../../../../tests/fakes/fake-lock-store.js';
import { FakeUnitOfWork } from '../../../../tests/fakes/fake-unit-of-work.js';
import { FakeMaintenanceLineStore } from '../../../../tests/fakes/fake-maintenance-lines.js';
import type { MaintenanceLine } from '../../../releases/core/maintenance-line.js';
import type { Actor } from '../../../access/core/actor.js';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnprocessableError,
} from '../../../base/core/errors.js';
import {
  ContentRepository,
  type ContentSnapshot,
  type RefInfo,
} from '../../../content/core/content.repository.js';
import { ReadableRefs } from '../../../content/core/readable-refs.js';
import {
  type ChangeSet,
  changeSetBranch,
  createdAtOf,
  hasControl,
  idOfBranch,
  isChangeSetId,
  newChangeSetId,
} from '../change-set.js';
import { ChangeSetBranchPresence } from '../change-set-branch-presence.js';
import { FindMissingChangeSetBranchesAction } from './find-missing-change-set-branches.action.js';
import { AbandonChangeSetAction } from './abandon-change-set.action.js';
import { CreateChangeSetAction } from './create-change-set.action.js';
import { EditChangeSetAction } from './edit-change-set.action.js';
import { GetChangeSetAction } from './get-change-set.action.js';
import { ListChangeSetsAction } from './list-change-sets.action.js';
import {
  MAX_ORPHANS_PER_RUN,
  ORPHAN_GRACE_MS,
  ReconcileChangeSetBranchesAction,
} from './reconcile-change-set-branches.action.js';

const MAIN = 'a'.repeat(40);
const RELEASE = 'b'.repeat(40);

class FakeRefs extends ContentRepository {
  branches: RefInfo[] = [
    { name: 'main', commit: MAIN },
    { name: 'maintenance/2', commit: RELEASE },
  ];
  async at(): Promise<ContentSnapshot | undefined> {
    throw new Error('not read by change sets');
  }
  async refs() {
    return { branches: this.branches, tags: [{ name: 'v1', commit: MAIN }] };
  }
}

const author = actorWith(['content.edit', 'content.read.draft']);
const other: Actor = { ...author, id: 'someone-else' };

function setUp() {
  const refs = new FakeRefs();
  const branches = new FakeChangeSetBranches();
  const store = new FakeChangeSetStore();
  const audit = new FakeAuditLog();
  const unit = new FakeUnitOfWork();
  const locks = new FakeLockStore();
  const events = new FakeChangeSetEvents();
  const lines = new FakeMaintenanceLineStore();
  return {
    lines,
    refs,
    branches,
    store,
    locks,
    audit,
    events,
    unit,
    create: new CreateChangeSetAction(
      new ReadableRefs(refs),
      branches,
      store,
      audit,
      unit,
      lines,
    ),
    abandon: new AbandonChangeSetAction(
      store,
      locks,
      new FakeWorkingCopyStore(),
      audit,
      events,
      unit,
      undefined,
      branches,
    ),
    presence: new ChangeSetBranchPresence(branches),
    edit: new EditChangeSetAction(store, audit, unit),
    list: new ListChangeSetsAction(store),
    get: new GetChangeSetAction(store),
    reconcile: new ReconcileChangeSetBranchesAction(branches, store),
  };
}

describe('hasControl', () => {
  it('finds control, separator and bidi characters', () => {
    for (const bad of [
      'a\u0000',
      'a\n',
      'a\u0085',
      'a\u2028',
      'a\u202e',
      'a\u2066',
    ]) {
      expect([bad, hasControl(bad)]).toEqual([bad, true]);
    }
    expect(hasControl('Ladegerät – neu')).toBe(false);
    expect(hasControl('a\nb\tc', '\t\n\r')).toBe(false);
  });
});

describe('change-set IDs', () => {
  it('are UUIDs version 7 carrying their creation time', () => {
    const at = Date.UTC(2026, 10, 17, 12, 0, 0, 123);
    const id = newChangeSetId(at);
    expect(isChangeSetId(id)).toBe(true);
    expect(createdAtOf(id)).toBe(at);
    expect(newChangeSetId(at)).not.toBe(id);
    expect(newChangeSetId(0, new Uint8Array(10))).toBe(
      '00000000-0000-7000-8000-000000000000',
    );
    expect(newChangeSetId(2 ** 48 - 1, new Uint8Array(10).fill(255))).toBe(
      'ffffffff-ffff-7fff-bfff-ffffffffffff',
    );
    expect(() => newChangeSetId(-1)).toThrow(RangeError);
    expect(() => newChangeSetId(2 ** 48)).toThrow(RangeError);
  });

  it('name their branch, and only a well-formed ID does', () => {
    const id = newChangeSetId();
    expect(changeSetBranch(id)).toBe(`change-sets/${id}`);
    expect(idOfBranch(changeSetBranch(id))).toBe(id);
    for (const name of [
      'main',
      `change-sets/${id.toUpperCase()}`,
      `change-sets/${id}/x`,
      'change-sets/123e4567-e89b-42d3-a456-426614174000', // version 4
      `x/change-sets/${id}`,
    ]) {
      expect([name, idOfBranch(name)]).toEqual([name, undefined]);
    }
    expect(createdAtOf('nope')).toBeUndefined();
  });
});

describe('CreateChangeSetAction', () => {
  it('creates the branch at the base, then the change set and its audit event', async () => {
    const { create, branches, store, audit } = setUp();
    const changeSet = await create.handle({
      actor: author,
      title: 'Explain charging',
      description: 'For the new charger.',
      baseRef: 'main',
    });
    expect(changeSet).toEqual({
      id: expect.any(String),
      title: 'Explain charging',
      description: 'For the new charger.',
      author: { kind: 'user', id: author.id },
      baseRef: 'main',
      baseCommit: MAIN,
      baseReleased: true,
      branch: `change-sets/${changeSet.id}`,
      state: 'draft',
      createdAt: expect.any(Date),
      updatedAt: changeSet.createdAt,
    });
    expect(isChangeSetId(changeSet.id)).toBe(true);
    expect(branches.heads).toEqual(new Map([[changeSet.branch, MAIN]]));
    expect(store.changeSets).toEqual([changeSet]);
    expect(audit.events).toEqual([
      expect.objectContaining({
        actor: { kind: 'user', id: author.id },
        action: 'change-set.create',
        subject: { type: 'change-set', id: changeSet.id },
        data: {
          title: 'Explain charging',
          baseRef: 'main',
          baseCommit: MAIN,
          baseReleased: true,
          branch: changeSet.branch,
        },
      }),
    ]);
  });

  it('starts from any branch but a change set’s, never a tag or commit', async () => {
    const { create, branches, refs, store } = setUp();
    const maintenance = await create.handle({
      actor: author,
      title: 'Fix',
      baseRef: 'maintenance/2',
    });
    expect(maintenance).toMatchObject({
      baseCommit: RELEASE,
      description: null,
    });
    refs.branches.push({ name: maintenance.branch, commit: RELEASE });
    for (const baseRef of ['v1', MAIN, 'nope', maintenance.branch, 'MAIN']) {
      await expect(
        create.handle({ actor: author, title: 'x', baseRef }),
      ).rejects.toThrow(UnprocessableError);
    }
    expect(branches.heads.size).toBe(1);
    expect(store.changeSets).toHaveLength(1);
  });

  it('starts from the server’s default branch when given none', async () => {
    const { create, branches } = setUp();
    expect(await create.handle({ actor: author, title: 'x' })).toMatchObject({
      baseRef: 'main',
      baseCommit: MAIN,
    });
    branches.base = 'maintenance/2';
    expect(await create.handle({ actor: author, title: 'x' })).toMatchObject({
      baseRef: 'maintenance/2',
      baseCommit: RELEASE,
    });
    branches.base = 'v1';
    await expect(create.handle({ actor: author, title: 'x' })).rejects.toThrow(
      '(CCMS_DEFAULT_REF) names no branch to start from; give baseRef.',
    );
    branches.base = undefined;
    await expect(
      create.handle({ actor: author, title: 'x' }),
    ).rejects.toMatchObject({ code: 'invalid-base' });
  });

  it('hides a draft base from an editor without content.read.draft', async () => {
    const { create, branches, refs } = setUp();
    const editor = actorWith(['content.edit']);
    const refusal = (baseRef: string) =>
      create.handle({ actor: editor, title: 'x', baseRef }).then(
        () => undefined,
        (error: unknown) => error,
      );
    // A draft branch and a missing one: the same refusal, but for the name.
    const draft = await refusal('maintenance/2');
    const missing = await refusal('nope');
    expect(draft).toBeInstanceOf(UnprocessableError);
    expect(draft).toMatchObject({
      code: 'invalid-base',
      message: 'There is no branch "maintenance/2" to start from.',
    });
    expect(missing).toMatchObject({
      code: 'invalid-base',
      message: 'There is no branch "nope" to start from.',
    });
    // So is the server's default, when it is a draft, without naming it.
    branches.base = 'maintenance/2';
    const hiddenDefault = await create
      .handle({ actor: editor, title: 'x' })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    branches.base = 'nope';
    const missingDefault = await create
      .handle({ actor: editor, title: 'x' })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(hiddenDefault).toEqual(missingDefault);
    expect(hiddenDefault).toMatchObject({
      code: 'invalid-base',
      message:
        'The server’s default ref (CCMS_DEFAULT_REF) names no branch to start from; give baseRef.',
    });
    expect(branches.heads.size).toBe(0);

    // Released: `main`, and a branch at a released commit.
    refs.branches.push({ name: 'hotfix', commit: MAIN });
    for (const baseRef of ['main', 'hotfix']) {
      expect(
        await create.handle({ actor: editor, title: 'x', baseRef }),
      ).toMatchObject({ baseRef, baseCommit: MAIN, baseReleased: true });
    }
    // A draft base (for one who reads drafts) is recorded as one (#126).
    expect(
      await create.handle({
        actor: author,
        title: 'x',
        baseRef: 'maintenance/2',
      }),
    ).toMatchObject({ baseCommit: RELEASE, baseReleased: false });
  });

  it('needs content.edit', async () => {
    const { create, branches } = setUp();
    await expect(
      create.handle({
        actor: actorWith(['content.read', 'content.read.draft']),
        title: 'x',
        baseRef: 'main',
      }),
    ).rejects.toThrow(ForbiddenError);
    expect(branches.heads.size).toBe(0);
  });

  it('leaves the branch for the reconciler when the database fails', async () => {
    const { create, branches, store, audit, reconcile } = setUp();
    store.failNextInsert = true;
    await expect(
      create.handle({ actor: author, title: 'x', baseRef: 'main' }),
    ).rejects.toThrow('the database is down');
    expect(store.changeSets).toEqual([]);
    expect(audit.events).toEqual([]);
    const [orphan] = [...branches.heads.keys()];
    expect(orphan).toMatch(/^change-sets\//);
    // Too young for the reconciler: a transaction may still be recording it.
    expect((await reconcile.handle({ now: Date.now() })).removed).toEqual([]);
    const later = Date.now() + ORPHAN_GRACE_MS;
    expect((await reconcile.handle({ now: later })).removed).toEqual([orphan]);
    expect(branches.heads.size).toBe(0);
  });

  describe('on a maintenance line (#60)', () => {
    const line: MaintenanceLine = {
      id: newChangeSetId(),
      product: 'tuggers',
      revision: '2',
      baseRelease: newChangeSetId(),
      baseCommit: RELEASE,
      branch: 'maintenance/2',
      createdBy: { kind: 'user', id: 'sample-publisher' },
      createdAt: new Date(),
      closedAt: null,
      closedBy: null,
    };

    it('starts from the line’s branch, holding the line, and audits the line', async () => {
      const t = setUp();
      t.lines.rows.push(line);
      const changeSet = await t.create.handle({
        actor: author,
        title: 'Fix a typo',
        maintenanceLine: line.id,
      });
      expect(changeSet).toMatchObject({
        baseRef: 'maintenance/2',
        baseCommit: RELEASE,
      });
      expect(t.lines.locked).toEqual([{ id: line.id, mode: 'share' }]);
      expect(t.audit.events[0]?.data).toMatchObject({
        baseRef: 'maintenance/2',
        maintenanceLine: line.id,
      });
    });

    it('takes the line’s branch named as baseRef as the line', async () => {
      const t = setUp();
      t.lines.rows.push({
        ...line,
        closedAt: new Date(),
        closedBy: line.createdBy,
      });
      await expect(
        t.create.handle({
          actor: author,
          title: 'x',
          baseRef: 'maintenance/2',
        }),
      ).rejects.toMatchObject({
        code: 'invalid-state',
        meta: { state: 'closed' },
      });
      expect(t.branches.heads.size).toBe(0);
    });

    it('refuses a closed line, an unknown one, and both a line and a baseRef', async () => {
      const t = setUp();
      t.lines.rows.push({
        ...line,
        closedAt: new Date(),
        closedBy: line.createdBy,
      });
      await expect(
        t.create.handle({
          actor: author,
          title: 'x',
          maintenanceLine: line.id,
        }),
      ).rejects.toMatchObject({ code: 'invalid-state' });
      await expect(
        t.create.handle({
          actor: author,
          title: 'x',
          maintenanceLine: newChangeSetId(),
        }),
      ).rejects.toMatchObject({ code: 'invalid-base' });
      await expect(
        t.create.handle({
          actor: author,
          title: 'x',
          maintenanceLine: line.id,
          baseRef: 'main',
        }),
      ).rejects.toMatchObject({ code: 'invalid-base' });
      expect(t.store.changeSets).toEqual([]);
    });

    it('refuses a line closed while the branch was made (held in the transaction)', async () => {
      const t = setUp();
      t.lines.rows.push(line);
      const create = t.branches.create.bind(t.branches);
      t.branches.create = async (name, commit) => {
        await create(name, commit);
        t.lines.rows[0] = {
          ...line,
          closedAt: new Date(),
          closedBy: line.createdBy,
        };
      };
      await expect(
        t.create.handle({
          actor: author,
          title: 'x',
          maintenanceLine: line.id,
        }),
      ).rejects.toMatchObject({ code: 'invalid-state' });
      expect(t.store.changeSets).toEqual([]);
      expect(t.audit.events).toEqual([]);
    });
  });

  it('records nothing when the branch cannot be created', async () => {
    const { create, branches, store, audit } = setUp();
    branches.create = () =>
      Promise.reject(new ConflictError('branch-exists', 'exists'));
    await expect(
      create.handle({ actor: author, title: 'x', baseRef: 'main' }),
    ).rejects.toThrow(ConflictError);
    expect(store.changeSets).toEqual([]);
    expect(audit.events).toEqual([]);
  });
});

describe('ListChangeSetsAction and GetChangeSetAction', () => {
  it('list newest first, filtered, and read one, every one with content.read.draft', async () => {
    const { create, abandon, list, get } = setUp();
    const first = await create.handle({
      actor: author,
      title: 'First',
      baseRef: 'main',
    });
    const second = await create.handle({
      actor: other,
      title: 'Second',
      baseRef: 'main',
    });
    await abandon.handle({ actor: author, id: first.id });
    const page = { number: 1, size: 50 };
    const titles = async (filter: object) =>
      (await list.handle({ actor: author, filter, page })).items.map(
        (c) => c.title,
      );
    expect(await titles({})).toEqual(['Second', 'First']);
    expect(await titles({ state: 'draft' })).toEqual(['Second']);
    expect(await titles({ state: 'abandoned' })).toEqual(['First']);
    expect(await titles({ author: other.id })).toEqual(['Second']);
    // The counts per state leave the state filter out (#481).
    const counted = await list.handle({
      actor: author,
      filter: { state: 'draft' },
      page,
    });
    expect(counted.counts).toEqual({
      draft: 1,
      'in-review': 0,
      approved: 0,
      merged: 0,
      abandoned: 1,
    });
    expect(
      (await list.handle({ actor: author, filter: { author: other.id }, page }))
        .counts.abandoned,
    ).toBe(0);
    expect(await get.handle({ actor: author, id: second.id })).toEqual(second);
    await expect(get.handle({ actor: author, id: 'nope' })).rejects.toThrow(
      NotFoundError,
    );
  });

  it('without content.read.draft, list and read only the actor’s own, another’s not found like a missing one (#126, #125)', async () => {
    const { create, list, get } = setUp();
    const editor: Actor = {
      ...actorWith(['content.edit', 'content.read']),
      id: 'plain-editor',
    };
    const mine = await create.handle({
      actor: editor,
      title: 'Mine',
      baseRef: 'main',
    });
    const theirs = await create.handle({
      actor: author,
      title: 'Theirs',
      baseRef: 'main',
    });
    // A service of the same ID is someone else.
    const service: Actor = { ...editor, kind: 'service' };
    const page = { number: 1, size: 50 };
    const listed = async (actor: Actor, filter: object) => {
      const found = await list.handle({ actor, filter, page });
      return { total: found.total, titles: found.items.map((c) => c.title) };
    };
    expect(await listed(editor, {})).toEqual({ total: 1, titles: ['Mine'] });
    expect(await listed(editor, { author: editor.id })).toEqual({
      total: 1,
      titles: ['Mine'],
    });
    expect(await listed(editor, { author: author.id })).toEqual({
      total: 0,
      titles: [],
    });
    expect(await listed(service, {})).toEqual({ total: 0, titles: [] });
    // The counts too are of the actor's own only.
    expect(
      (await list.handle({ actor: editor, filter: {}, page })).counts,
    ).toMatchObject({ draft: 1 });
    expect(
      (
        await list.handle({
          actor: editor,
          filter: { author: author.id },
          page,
        })
      ).counts.draft,
    ).toBe(0);
    expect(await get.handle({ actor: editor, id: mine.id })).toEqual(mine);
    const missing = await get
      .handle({ actor: editor, id: '01900000-0000-7000-8000-000000000000' })
      .catch((e: unknown) => e);
    const hidden = await get
      .handle({ actor: editor, id: theirs.id })
      .catch((e: unknown) => e);
    expect(hidden).toBeInstanceOf(NotFoundError);
    expect(missing).toBeInstanceOf(NotFoundError);
    expect((hidden as Error).message).toBe(`No change set "${theirs.id}".`);
    await expect(get.handle({ actor: service, id: mine.id })).rejects.toThrow(
      NotFoundError,
    );
    // An actor holding nothing may ask; they have no change set.
    expect(await listed(actorWith([]), {})).toEqual({ total: 0, titles: [] });
  });
});

describe('EditChangeSetAction', () => {
  async function started() {
    const s = setUp();
    const changeSet = await s.create.handle({
      actor: author,
      title: 'Charging',
      description: 'First pass.',
      baseRef: 'main',
    });
    s.audit.events.length = 0;
    return { ...s, changeSet };
  }

  it('renames it and corrects its description, auditing the old and new values', async () => {
    const { edit, store, audit, changeSet } = await started();
    const edited = await edit.handle({
      actor: author,
      id: changeSet.id,
      title: 'Charging, reworded',
      description: null,
    });
    expect(edited).toMatchObject({
      id: changeSet.id,
      title: 'Charging, reworded',
      description: null,
      state: 'draft',
    });
    expect(store.changeSets[0]).toMatchObject({
      title: 'Charging, reworded',
      description: null,
    });
    expect(audit.events).toMatchObject([
      {
        action: 'change-set.edit',
        subject: { type: 'change-set', id: changeSet.id },
        data: {
          from: { title: 'Charging' },
          to: { title: 'Charging, reworded' },
          descriptionChanged: true,
        },
      },
    ]);
  });

  it('changes and audits only what differs, and nothing when nothing does', async () => {
    const { edit, audit, changeSet } = await started();
    await edit.handle({
      actor: author,
      id: changeSet.id,
      title: 'Charging',
      description: 'Second pass.',
    });
    expect(audit.events.map((e) => e.data)).toEqual([
      { from: {}, to: {}, descriptionChanged: true },
    ]);
    const same = await edit.handle({
      actor: author,
      id: changeSet.id,
      title: 'Charging',
    });
    expect(same.description).toBe('Second pass.');
    expect(audit.events).toHaveLength(1);
  });

  it('edits an open change set only, the author’s alone, named by its own ID', async () => {
    const { edit, store, changeSet } = await started();
    await expect(
      edit.handle({ actor: other, id: changeSet.id, title: 'Mine now' }),
    ).rejects.toThrow(ForbiddenError);
    const plain: Actor = {
      ...actorWith(['content.edit']),
      id: 'someone-without-drafts',
    };
    await expect(
      edit.handle({ actor: plain, id: changeSet.id, title: 'Mine now' }),
    ).rejects.toThrow(NotFoundError);
    await expect(
      edit.handle({
        actor: author,
        id: changeSet.id,
        resourceId: newChangeSetId(),
        title: 'Elsewhere',
      }),
    ).rejects.toMatchObject({ code: 'id-mismatch' });
    store.changeSets[0] = {
      ...(store.changeSets[0] as ChangeSet),
      state: 'in-review',
    };
    await expect(
      edit.handle({ actor: author, id: changeSet.id, title: 'In review' }),
    ).resolves.toMatchObject({ title: 'In review' });
    store.changeSets[0] = {
      ...(store.changeSets[0] as ChangeSet),
      state: 'merged',
    };
    await expect(
      edit.handle({ actor: author, id: changeSet.id, title: 'Too late' }),
    ).rejects.toMatchObject({
      code: 'invalid-state',
      meta: { state: 'merged' },
    });
  });
});

describe('AbandonChangeSetAction', () => {
  async function started() {
    const s = setUp();
    const changeSet = await s.create.handle({
      actor: author,
      title: 'x',
      baseRef: 'main',
    });
    return { ...s, changeSet };
  }

  it('marks it abandoned, audits it with the comment and writes its outbox row; Git is left alone', async () => {
    const { abandon, store, audit, events, branches, changeSet } =
      await started();
    const abandoned = await abandon.handle({
      actor: author,
      id: changeSet.id,
      comment: 'Superseded.',
    });
    expect(abandoned).toMatchObject({ id: changeSet.id, state: 'abandoned' });
    expect(store.changeSets[0]?.state).toBe('abandoned');
    expect(branches.heads.get(changeSet.branch)).toBe(MAIN);
    expect(audit.events.at(-1)).toMatchObject({
      action: 'change-set.abandon',
      subject: { type: 'change-set', id: changeSet.id },
      comment: 'Superseded.',
      data: { from: 'draft', to: 'abandoned' },
    });
    expect(events.events).toEqual([
      {
        topic: 'change-set.abandon',
        key: changeSet.id,
        payload: {
          changeSetId: changeSet.id,
          actor: { kind: 'user', id: author.id },
          comment: 'Superseded.',
          from: 'draft',
          to: 'abandoned',
        },
      },
    ]);
  });

  it('refuses one that is not open, anyone but its author, and an unknown ID', async () => {
    const { abandon, audit, store, changeSet } = await started();
    await expect(
      abandon.handle({ actor: other, id: changeSet.id }),
    ).rejects.toThrow(ForbiddenError);
    await expect(
      abandon.handle({
        actor: { ...author, kind: 'service' },
        id: changeSet.id,
      }),
    ).rejects.toThrow(ForbiddenError);
    await expect(
      abandon.handle({ actor: author, id: newChangeSetId() }),
    ).rejects.toThrow(NotFoundError);
    await abandon.handle({ actor: author, id: changeSet.id });
    const again = abandon.handle({ actor: author, id: changeSet.id });
    await expect(again).rejects.toThrow(ConflictError);
    await expect(again).rejects.toMatchObject({
      code: 'invalid-state',
      meta: { state: 'abandoned' },
    });
    store.changeSets[0] = {
      ...store.changeSets[0],
      state: 'merged',
    } as ChangeSet;
    await expect(
      abandon.handle({ actor: author, id: changeSet.id }),
    ).rejects.toMatchObject({
      code: 'invalid-state',
      meta: { state: 'merged' },
    });
    expect(audit.events.map((e) => e.action)).toEqual([
      'change-set.create',
      'change-set.abandon',
    ]);
  });

  it('lets an admin abandon another author’s change set only once its branch is gone (#317)', async () => {
    const { abandon, audit, branches, changeSet } = await started();
    const admin: Actor = {
      ...actorWith(['content.edit', 'content.read.draft', 'admin.roles']),
      id: 'an-admin',
    };
    // Its branch is there: still only its author's to abandon.
    await expect(
      abandon.handle({ actor: admin, id: changeSet.id }),
    ).rejects.toThrow(ForbiddenError);
    branches.heads.delete(changeSet.branch);
    // Without admin.roles, or without reading change sets: as before.
    await expect(
      abandon.handle({ actor: other, id: changeSet.id }),
    ).rejects.toThrow(ForbiddenError);
    await expect(
      abandon.handle({
        actor: {
          ...actorWith(['content.edit', 'admin.roles']),
          id: 'blind-admin',
        },
        id: changeSet.id,
      }),
    ).rejects.toThrow(NotFoundError);
    const abandoned = await abandon.handle({
      actor: admin,
      id: changeSet.id,
      comment: 'Its branch is gone.',
    });
    expect(abandoned.state).toBe('abandoned');
    expect(audit.events.at(-1)).toMatchObject({
      action: 'change-set.abandon',
      actor: { kind: 'user', id: 'an-admin' },
      data: { from: 'draft', to: 'abandoned', branchMissing: true },
    });
    // Nothing is recreated.
    expect(branches.heads.has(changeSet.branch)).toBe(false);
  });

  it('keeps it open when the audit event cannot be recorded', async () => {
    const { audit, store, locks, unit, changeSet } = await started();
    const failing = new AbandonChangeSetAction(
      store,
      locks,
      new FakeWorkingCopyStore(),
      audit,
      new FakeChangeSetEvents(),
      unit,
    );
    audit.record = () => Promise.reject(new Error('the database is down'));
    await expect(
      failing.handle({ actor: author, id: changeSet.id }),
    ).rejects.toThrow('the database is down');
    expect(store.changeSets[0]?.state).toBe('draft');
  });
});

describe('ChangeSetBranchPresence', () => {
  it('names the change sets whose branch is gone, one or many', async () => {
    const { create, presence, branches } = setUp();
    const kept = await create.handle({ actor: author, title: 'a' });
    const lost = await create.handle({ actor: author, title: 'b' });
    expect(await presence.missing([])).toEqual(new Set());
    expect(await presence.missing([kept, lost])).toEqual(new Set());
    branches.heads.delete(lost.branch);
    expect(await presence.missing([kept, lost])).toEqual(new Set([lost.id]));
    expect(await presence.missing([lost])).toEqual(new Set([lost.id]));
    expect(await presence.missing([kept])).toEqual(new Set());
  });
});

describe('FindMissingChangeSetBranchesAction', () => {
  it('finds the open change sets whose branch is gone, and changes nothing', async () => {
    const { create, abandon, branches, store } = setUp();
    const find = new FindMissingChangeSetBranchesAction(store, branches);
    const kept = await create.handle({ actor: author, title: 'kept' });
    const lost = await create.handle({ actor: author, title: 'lost' });
    const done = await create.handle({ actor: author, title: 'done' });
    await abandon.handle({ actor: author, id: done.id });
    expect(await find.handle()).toEqual({ missing: [], complete: true });
    branches.heads.delete(lost.branch);
    branches.heads.delete(done.branch);
    // An abandoned one is done with: not reported.
    expect(await find.handle()).toEqual({
      missing: [{ changeSetId: lost.id, branch: lost.branch, state: 'draft' }],
      complete: true,
    });
    expect(branches.heads.has(lost.branch)).toBe(false);
    expect(store.changeSets.find((c) => c.id === kept.id)?.state).toBe('draft');
    // Past its deadline it stops, and says so.
    expect(await find.handle({ deadline: 0, now: () => 1 })).toEqual({
      missing: [],
      complete: false,
    });
  });
});

describe('ReconcileChangeSetBranchesAction', () => {
  const longAgo = (offset = 0) =>
    newChangeSetId(Date.now() - ORPHAN_GRACE_MS - 1000 - offset);

  it('removes old orphans only, and only those without commits of their own', async () => {
    const { reconcile, branches, store, create } = setUp();
    const recorded = await create.handle({
      actor: author,
      title: 'x',
      baseRef: 'main',
    });
    // Recorded long ago: its time is in its ID, so backdate both.
    const oldRecorded = longAgo();
    store.changeSets.push({
      ...recorded,
      id: oldRecorded,
      branch: changeSetBranch(oldRecorded),
    });
    branches.heads.set(changeSetBranch(oldRecorded), MAIN);
    const orphan = changeSetBranch(longAgo());
    const withCommits = changeSetBranch(longAgo());
    const young = changeSetBranch(newChangeSetId());
    for (const name of [orphan, withCommits, young]) {
      branches.heads.set(name, MAIN);
    }
    branches.ownCommits.add(withCommits);
    branches.heads.set('change-sets/hand-made', MAIN);

    const report = await reconcile.handle({ now: Date.now() });
    expect(report).toEqual({
      removed: [orphan],
      withCommits: [withCommits],
      foreign: ['change-sets/hand-made'],
      deferred: [],
    });
    expect([...branches.heads.keys()].sort()).toEqual(
      [
        recorded.branch,
        changeSetBranch(oldRecorded),
        withCommits,
        young,
        'change-sets/hand-made',
      ].sort(),
    );
  });

  it('defers a branch that moved, and stops at the run’s limit', async () => {
    const { reconcile, branches } = setUp();
    const moved = changeSetBranch(longAgo());
    branches.heads.set(moved, MAIN);
    branches.deleteIfAt = () => Promise.resolve(false);
    expect(await reconcile.handle({ now: Date.now() })).toMatchObject({
      removed: [],
      deferred: [moved],
    });

    const many = setUp();
    for (let i = 0; i < MAX_ORPHANS_PER_RUN + 5; i++) {
      many.branches.heads.set(changeSetBranch(longAgo(i)), MAIN);
    }
    const report = await many.reconcile.handle({ now: Date.now() });
    expect(report.removed).toHaveLength(MAX_ORPHANS_PER_RUN);
    expect(report.deferred).toHaveLength(5);
    expect(many.branches.heads.size).toBe(5);
  });

  it('counts orphans with commits of their own against the run’s limit', async () => {
    const { reconcile, branches } = setUp();
    for (let i = 0; i < MAX_ORPHANS_PER_RUN + 3; i++) {
      const name = changeSetBranch(longAgo(i));
      branches.heads.set(name, MAIN);
      branches.ownCommits.add(name);
    }
    let walks = 0;
    const has = branches.hasOwnCommits.bind(branches);
    branches.hasOwnCommits = (name: string) => {
      walks++;
      return has(name);
    };
    const report = await reconcile.handle({ now: Date.now() });
    expect(walks).toBe(MAX_ORPHANS_PER_RUN);
    expect(report.withCommits).toHaveLength(MAX_ORPHANS_PER_RUN);
    expect(report.deferred).toHaveLength(3);
  });

  it('keeps a branch whose change set was recorded since the first look', async () => {
    const { reconcile, branches, store } = setUp();
    const id = longAgo();
    branches.heads.set(changeSetBranch(id), MAIN);
    let asked = 0;
    store.existing = async (ids) => {
      asked++;
      // Not there at the first look, there right before the delete.
      return new Set(asked > 1 ? ids : []);
    };
    expect(await reconcile.handle({ now: Date.now() })).toMatchObject({
      removed: [],
    });
    expect(branches.heads.has(changeSetBranch(id))).toBe(true);
  });

  it('asks the database nothing when no branch is old enough', async () => {
    const { reconcile, branches, store } = setUp();
    branches.heads.set(changeSetBranch(newChangeSetId()), MAIN);
    store.existing = () => Promise.reject(new Error('not asked'));
    expect((await reconcile.handle({ now: Date.now() })).removed).toEqual([]);
  });
});
