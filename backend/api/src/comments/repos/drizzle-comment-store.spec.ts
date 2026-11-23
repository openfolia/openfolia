import { sql } from 'drizzle-orm';
import {
  createTestDatabase,
  type PgliteDatabase,
} from '../../../tests/database.js';
import { DrizzleUnitOfWork } from '../../database/drizzle-unit-of-work.js';
import {
  type ChangeSet,
  changeSetBranch,
  newChangeSetId,
} from '../../change-sets/core/change-set.js';
import { DrizzleChangeSetStore } from '../../change-sets/repos/drizzle-change-set-store.js';
import {
  type Comment,
  type CommentSubject,
  type NewComment,
  newCommentId,
} from '../core/comment.js';
import { DrizzleCommentStore } from './drizzle-comment-store.js';

const charging: CommentSubject = {
  type: 'module',
  lang: 'en',
  moduleId: 'charging',
};
const storage: CommentSubject = { ...charging, moduleId: 'storage' };

function changeSet(): ChangeSet {
  const id = newChangeSetId();
  const now = new Date();
  return {
    id,
    title: 'x',
    description: null,
    author: { kind: 'user', id: 'sample-author' },
    baseRef: 'main',
    baseCommit: 'c'.repeat(40),
    baseReleased: true,
    branch: changeSetBranch(id),
    state: 'draft',
    createdAt: now,
    updatedAt: now,
  };
}

describe('DrizzleCommentStore', () => {
  let database: PgliteDatabase;
  let store: DrizzleCommentStore;
  let unit: DrizzleUnitOfWork;
  let mine: ChangeSet;
  let theirs: ChangeSet;
  const all = { number: 1, size: 50 };

  const thread = (over: Partial<NewComment> = {}): NewComment => {
    const id = newCommentId();
    return {
      id,
      changeSetId: mine.id,
      threadId: id,
      subject: charging,
      blockId: 'intro',
      commit: 'a'.repeat(40),
      author: { kind: 'user' as const, id: 'sample-reviewer' },
      body: 'Why?',
      ...over,
    };
  };
  const reply = (to: Comment, body = 'Because.') => ({
    ...thread({ body }),
    threadId: to.id,
    subject: to.subject,
    blockId: to.blockId,
  });
  const write = (comment: NewComment) =>
    unit.run((tx) => store.insert(tx, comment));
  const bodies = (page: { items: Comment[] }) => page.items.map((c) => c.body);

  beforeEach(async () => {
    database = await createTestDatabase();
    store = new DrizzleCommentStore(database);
    unit = new DrizzleUnitOfWork(database);
    const changeSets = new DrizzleChangeSetStore(database);
    mine = changeSet();
    theirs = changeSet();
    await unit.run(async (tx) => {
      await changeSets.insert(tx, mine);
      await changeSets.insert(tx, theirs);
    });
  });
  afterEach(() => database?.close());

  it('stores comments and reads them back exactly, stamped by the transaction', async () => {
    const written = await write(thread());
    expect(written.createdAt).toBeInstanceOf(Date);
    expect(written.resolution).toBeUndefined();
    expect(await store.find(written.id)).toEqual(written);
    expect(await store.find('not-a-uuid')).toBeUndefined();
  });

  it('lists in thread order, filtered, paged, with the total', async () => {
    const a = await write(thread({ body: 'A' }));
    const b = await write(
      thread({ body: 'B', subject: storage, blockId: 'x' }),
    );
    await write(reply(a, 'A1'));
    await write(reply(b, 'B1'));
    await write(reply(a, 'A2'));
    await write(thread({ changeSetId: theirs.id, body: 'Theirs' }));
    expect(bodies(await store.list(mine.id, {}, all))).toEqual([
      'A',
      'A1',
      'A2',
      'B',
      'B1',
    ]);
    const page = await store.list(mine.id, {}, { number: 2, size: 2 });
    expect(bodies(page)).toEqual(['A2', 'B']);
    expect(page.total).toBe(5);
    expect(bodies(await store.list(mine.id, { module: storage }, all))).toEqual(
      ['B', 'B1'],
    );
    expect(bodies(await store.list(mine.id, { blockId: 'x' }, all))).toEqual([
      'B',
      'B1',
    ]);
    expect(
      bodies(await store.list(mine.id, { modules: [charging] }, all)),
    ).toEqual(['A', 'A1', 'A2']);
    expect((await store.list(mine.id, { modules: [] }, all)).total).toBe(0);
    expect(await store.modules(mine.id)).toEqual([charging, storage]);
    expect((await store.list('nope', {}, all)).total).toBe(0);
  });

  it('resolves and reopens a thread, which its replies follow in the filter', async () => {
    const a = await write(thread({ body: 'A' }));
    await write(reply(a, 'A1'));
    await write(thread({ body: 'B', blockId: 'other' }));
    const resolved = await unit.run(async (tx) => {
      await store.lock(tx, a.id);
      return store.setResolution(tx, a.id, {
        kind: 'user',
        id: 'sample-author',
      });
    });
    expect(resolved.resolution).toMatchObject({
      by: { kind: 'user', id: 'sample-author' },
    });
    expect(resolved.resolution?.at).toBeInstanceOf(Date);
    expect(bodies(await store.list(mine.id, { resolved: true }, all))).toEqual([
      'A',
      'A1',
    ]);
    expect(bodies(await store.list(mine.id, { resolved: false }, all))).toEqual(
      ['B'],
    );
    const reopened = await unit.run((tx) =>
      store.setResolution(tx, a.id, null),
    );
    expect(reopened.resolution).toBeUndefined();
    expect((await store.list(mine.id, { resolved: false }, all)).total).toBe(3);
  });

  it('counts a change set’s comments inside a transaction', async () => {
    const a = await write(thread());
    await write(reply(a));
    expect(await unit.run((tx) => store.count(tx, mine.id))).toBe(2);
    expect(await unit.run((tx) => store.count(tx, theirs.id))).toBe(0);
  });

  it('moves a change set’s comments on a module to its new ID, replies with their threads (#265)', async () => {
    const a = await write(thread({ body: 'A' }));
    await write(reply(a, 'A1'));
    await write(thread({ body: 'B', subject: storage }));
    await write(thread({ changeSetId: theirs.id, body: 'Theirs' }));
    const renamed: CommentSubject = { ...charging, moduleId: 'charging-now' };
    const moved = await unit.run((tx) =>
      store.moveModule(tx, mine.id, charging, renamed),
    );
    expect(moved).toBe(2);
    expect(bodies(await store.list(mine.id, { module: renamed }, all))).toEqual(
      ['A', 'A1'],
    );
    expect((await store.list(mine.id, { module: charging }, all)).total).toBe(
      0,
    );
    expect(bodies(await store.list(mine.id, { module: storage }, all))).toEqual(
      ['B'],
    );
    expect(
      bodies(await store.list(theirs.id, { module: charging }, all)),
    ).toEqual(['Theirs']);
  });

  it('holds a reply to its thread’s change set and anchor, and a resolution to threads', async () => {
    const a = await write(thread());
    for (const off of [
      { ...reply(a), blockId: 'elsewhere' },
      { ...reply(a), subject: storage },
      { ...reply(a), changeSetId: theirs.id },
      { ...reply(a), threadId: newCommentId() },
    ]) {
      await expect(write(off)).rejects.toThrow();
    }
    const answer = await write(reply(a));
    await expect(
      database.db.execute(
        sql`update comments set resolved_at = now(), resolved_by_kind = 'user', resolved_by_id = 'x' where id = ${answer.id}`,
      ),
    ).rejects.toThrow();
    await expect(
      database.db.execute(
        sql`update comments set resolved_at = now() where id = ${a.id}`,
      ),
    ).rejects.toThrow();
  });

  it('edits a text, marked edited by the transaction', async () => {
    const a = await write(thread({ body: 'Teh' }));
    const edited = await unit.run(async (tx) => {
      await store.lock(tx, a.id);
      return store.edit(tx, a.id, 'The');
    });
    expect(edited).toMatchObject({ id: a.id, body: 'The' });
    expect(edited.editedAt).toBeInstanceOf(Date);
    expect(await store.find(a.id)).toEqual(edited);
  });

  it('keeps a deleted thread start for its replies, without its text, and removes the rest', async () => {
    const a = await write(thread({ body: 'A' }));
    const a1 = await write(reply(a, 'A1'));
    const lone = await write(thread({ body: 'Lone', blockId: 'other' }));
    expect(await unit.run((tx) => store.replies(tx, a.id))).toBe(1);
    expect(await unit.run((tx) => store.replies(tx, lone.id))).toBe(0);
    // The replies' foreign key holds a thread start with replies.
    await expect(unit.run((tx) => store.remove(tx, a.id))).rejects.toThrow();
    const kept = await unit.run((tx) => store.markDeleted(tx, a.id));
    expect(kept).toMatchObject({ id: a.id, body: null });
    expect(kept.deletedAt).toBeInstanceOf(Date);
    expect(bodies(await store.list(mine.id, {}, all))).toEqual([
      null,
      'A1',
      'Lone',
    ]);
    // Deleted already: not edited, nor deleted again.
    await expect(unit.run((tx) => store.edit(tx, a.id, 'x'))).rejects.toThrow();
    await expect(
      unit.run((tx) => store.markDeleted(tx, a.id)),
    ).rejects.toThrow();
    await unit.run(async (tx) => {
      await store.remove(tx, a1.id);
      await store.remove(tx, a.id);
    });
    await unit.run((tx) => store.remove(tx, lone.id));
    expect((await store.list(mine.id, {}, all)).total).toBe(0);
    await expect(unit.run((tx) => store.remove(tx, lone.id))).rejects.toThrow();
  });

  it('holds a text to comments not deleted, and deleted ones to thread starts', async () => {
    const a = await write(thread());
    const answer = await write(reply(a));
    for (const statement of [
      sql`update comments set body = null where id = ${a.id}`,
      sql`update comments set deleted_at = now() where id = ${a.id}`,
      sql`update comments set deleted_at = now(), body = null where id = ${answer.id}`,
    ]) {
      await expect(database.db.execute(statement)).rejects.toThrow();
    }
  });

  it('refuses malformed values in the database too', async () => {
    for (const bad of [
      thread({ blockId: 'Not An ID' }),
      thread({ body: '' }),
      thread({ commit: 'nope' }),
      thread({ subject: { ...charging, moduleId: 'Bad Id' } }),
    ]) {
      await expect(write(bad)).rejects.toThrow();
    }
  });
});
