import type { Actor } from '../src/access/core/actor.js';
import { AuditEventPageDocument } from '../src/audit/api/audit-event.resources.js';
import { ErrorDocument, JSON_API } from '../src/base/api/json-api.js';
import { ChangeSetDocument } from '../src/change-sets/api/change-set.resources.js';
import {
  LockDocument,
  LockPageDocument,
  BreakLocksResultDocument,
} from '../src/change-sets/api/lock.resources.js';
import { newChangeSetId } from '../src/change-sets/core/change-set.js';
import { newLockId } from '../src/change-sets/core/lock.js';
import { actorWith } from './fakes/actors.js';
import { createTestApp, type TestApp } from './test-app.js';

const author: Actor = {
  ...actorWith(['content.read', 'content.read.draft', 'content.edit']),
  id: 'sample-author',
};
const otherAuthor: Actor = { ...author, id: 'sample-other' };
const reader = actorWith(['content.read', 'content.read.draft']);
const admin = actorWith(['admin.roles']);

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t?.close());
afterEach(() => t?.actAs(undefined));

const only = (body: unknown) => {
  const [first, ...rest] = ErrorDocument.parse(body).errors;
  expect(rest).toEqual([]);
  return first;
};

async function changeSet(as: Actor): Promise<string> {
  t.actAs(as);
  const res = await t.post('/change-sets').send(
    JSON.stringify({
      data: { type: 'ChangeSet', attributes: { title: 'Locks' } },
    }),
  );
  expect(res.status).toBe(201);
  return ChangeSetDocument.parse(res.body).data.id;
}

const acquire = (changeSetId: string, subject: unknown) =>
  t
    .post(`/change-sets/${changeSetId}/locks`)
    .send(JSON.stringify({ data: { type: 'Lock', attributes: { subject } } }));

const events = async (subject: string) => {
  t.actAs(admin);
  const res = await t.get(
    `/audit-events?filter[subject]=${encodeURIComponent(subject)}`,
  );
  return AuditEventPageDocument.parse(res.body).data.map((e) => e.attributes);
};

describe('locks', () => {
  it('takes a lock for a change set, and the second comes away knowing who holds it', async () => {
    const mine = await changeSet(author);
    const theirs = await changeSet(otherAuthor);
    const subject = { type: 'module', lang: 'EN', moduleId: 'take-me' };

    t.actAs(author);
    const res = await acquire(mine, subject);
    expect(res.status).toBe(201);
    expect(res.headers['content-type']).toBe(JSON_API);
    const lock = LockDocument.parse(res.body).data;
    expect(res.headers['location']).toBe(`/locks/${lock.id}`);
    expect(lock).toEqual({
      type: 'Lock',
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      attributes: {
        // The language in its canonical case: one lock per subject.
        subject: { type: 'module', lang: 'en', moduleId: 'take-me' },
        holder: { kind: 'user', id: 'sample-author' },
        since: expect.any(String),
      },
      relationships: { changeSet: { data: { type: 'ChangeSet', id: mine } } },
    });

    // Again: the same lock, nothing new.
    const again = await acquire(mine, subject);
    expect(again.status).toBe(200);
    expect(LockDocument.parse(again.body).data).toEqual(lock);

    t.actAs(otherAuthor);
    const refused = await acquire(theirs, {
      type: 'module',
      lang: 'en',
      moduleId: 'take-me',
    });
    expect(refused.status).toBe(409);
    expect(only(refused.body)).toMatchObject({
      code: 'locked',
      meta: {
        lockId: lock.id,
        holder: { kind: 'user', id: 'sample-author' },
        changeSetId: mine,
        since: lock.attributes.since,
      },
    });

    t.actAs(reader);
    const read = await t.get(`/locks/${lock.id}`);
    expect(read.status).toBe(200);
    expect(LockDocument.parse(read.body).data).toEqual(lock);

    expect(
      (await events('module/en/take-me')).map((e) => [e.action, e.actor.id]),
    ).toEqual([['lock.acquire', 'sample-author']]);
  });

  it('is released by its holder only, and broken by an admin with a comment', async () => {
    const mine = await changeSet(author);
    const theirs = await changeSet(otherAuthor);
    t.actAs(author);
    const first = LockDocument.parse(
      (await acquire(mine, { type: 'manual', manualId: 'release-me' })).body,
    ).data;

    t.actAs(otherAuthor);
    const notYours = await t.delete(`/locks/${first.id}`);
    expect(notYours.status).toBe(403);
    expect(only(notYours.body)?.code).toBe('forbidden');

    t.actAs(author);
    const released = await t.delete(`/locks/${first.id}`);
    expect(released.status).toBe(204);
    expect(released.text).toBe('');
    expect((await t.delete(`/locks/${first.id}`)).status).toBe(404);

    // Free again: the other change set takes it; an admin breaks that.
    t.actAs(otherAuthor);
    const second = LockDocument.parse(
      (await acquire(theirs, { type: 'manual', manualId: 'release-me' })).body,
    ).data;
    t.actAs(author);
    const notAdmin = await t
      .post(`/locks/${second.id}/break`)
      .send(JSON.stringify({ meta: { comment: 'Mine.' } }));
    expect(notAdmin.status).toBe(403);
    t.actAs(admin);
    const noComment = await t
      .post(`/locks/${second.id}/break`)
      .send(JSON.stringify({ meta: {} }));
    expect(noComment.status).toBe(400);
    expect(only(noComment.body)).toMatchObject({
      code: 'invalid-body',
      source: { pointer: '/meta/comment' },
    });
    const broken = await t
      .post(`/locks/${second.id}/break`)
      .send(JSON.stringify({ meta: { comment: 'Away for a month.' } }));
    expect(broken.status).toBe(204);
    t.actAs(reader);
    expect((await t.get(`/locks/${second.id}`)).status).toBe(404);

    expect(
      (await events('manual/release-me')).map((e) => [
        e.action,
        e.actor.id,
        e.comment,
      ]),
    ).toEqual([
      ['lock.break', admin.id, 'Away for a month.'],
      ['lock.acquire', 'sample-other', null],
      ['lock.release', 'sample-author', null],
      ['lock.acquire', 'sample-author', null],
    ]);
  });

  it('tells its holder, from another of their change sets, which one holds it and whether it changed it; released there only unchanged (#472)', async () => {
    const there = await changeSet(author);
    const here = await changeSet(author);
    const subject = { type: 'module', lang: 'en', moduleId: 'own-lock' };
    t.actAs(author);
    const lock = LockDocument.parse((await acquire(there, subject)).body).data;
    const refusal = async () => {
      t.actAs(author);
      const res = await acquire(here, subject);
      expect(res.status).toBe(409);
      return only(res.body);
    };
    expect(await refusal()).toMatchObject({
      code: 'locked',
      meta: {
        lockId: lock.id,
        changeSetId: there,
        changeSetTitle: 'Locks',
        changeSetState: 'draft',
        hasChanges: false,
      },
    });
    // Anything but true or false is refused, before anything is read.
    const bad = await t.delete(`/locks/${lock.id}?ifUnchanged=yes`);
    expect(bad.status).toBe(400);
    expect(only(bad.body)).toMatchObject({
      code: 'invalid-parameter',
      source: { parameter: 'ifUnchanged' },
    });

    // A working copy there: it has changes, and the lock stays.
    const saved = await t
      .put(`/change-sets/${there}/modules/en/own-lock/working-copy`)
      .send(
        JSON.stringify({
          data: {
            type: 'WorkingCopy',
            attributes: {
              content: {
                schemaVersion: 1,
                id: 'own-lock',
                meta: {
                  title: 'Own lock',
                  type: 'concept',
                  lang: 'en',
                  facets: {},
                },
                blocks: [
                  {
                    type: 'paragraph',
                    id: 'p1',
                    content: [{ type: 'text', text: 'Started there.' }],
                  },
                ],
              },
            },
          },
          meta: { version: 0, baseCommit: t.commits.main },
        }),
      );
    expect(saved.status).toBe(200);
    expect((await refusal())?.meta).toMatchObject({ hasChanges: true });
    const kept = await t.delete(`/locks/${lock.id}?ifUnchanged=true`);
    expect(kept.status).toBe(409);
    expect(only(kept.body)).toMatchObject({
      code: 'has-changes',
      meta: { changeSetId: there },
    });
    expect((await t.get(`/locks/${lock.id}`)).status).toBe(200);

    // Committed (a save point drops the working copy): changes all the same.
    expect((await t.post(`/change-sets/${there}/commits`)).status).toBe(201);
    expect((await refusal())?.meta).toMatchObject({ hasChanges: true });
    expect((await t.delete(`/locks/${lock.id}?ifUnchanged=true`)).status).toBe(
      409,
    );

    // Another subject it never changed: released there, and taken here.
    const free = { type: 'manual', manualId: 'own-lock-free' };
    const freeLock = LockDocument.parse((await acquire(there, free)).body).data;
    const released = await t.delete(`/locks/${freeLock.id}?ifUnchanged=true`);
    expect(released.status).toBe(204);
    expect((await acquire(here, free)).status).toBe(201);
  });

  it('breaks all locks of a change set or a holder at once, with a count', async () => {
    const mine = await changeSet(author);
    const theirs = await changeSet(otherAuthor);
    t.actAs(author);
    for (const manualId of ['bulk-a', 'bulk-b']) {
      expect((await acquire(mine, { type: 'manual', manualId })).status).toBe(
        201,
      );
    }
    t.actAs(otherAuthor);
    expect(
      (await acquire(theirs, { type: 'manual', manualId: 'bulk-c' })).status,
    ).toBe(201);
    const breakAll = (meta: unknown) =>
      t.post('/locks/break').send(JSON.stringify({ meta }));

    t.actAs(author);
    expect((await breakAll({ comment: 'x', changeSet: mine })).status).toBe(
      403,
    );
    t.actAs(admin);
    for (const meta of [
      { changeSet: mine },
      { comment: 'x' },
      { comment: 'x', changeSet: mine, holder: { kind: 'user', id: 'a' } },
      { comment: 'x', changeSet: 'nope' },
      { comment: 'x', holder: { kind: 'robot', id: 'a' } },
    ]) {
      const res = await breakAll(meta);
      expect([meta, res.status]).toEqual([meta, 400]);
    }
    expect(
      (await breakAll({ comment: 'x', changeSet: newLockId() })).status,
    ).toBe(404);

    const byChangeSet = await breakAll({ comment: 'Gone.', changeSet: mine });
    expect(byChangeSet.status).toBe(200);
    expect(byChangeSet.headers['content-type']).toBe(JSON_API);
    expect(BreakLocksResultDocument.parse(byChangeSet.body)).toEqual({
      meta: { count: 2 },
    });
    expect(
      (await events('manual/bulk-a')).map((e) => [e.action, e.comment]),
    ).toEqual([
      ['lock.break', 'Gone.'],
      ['lock.acquire', null],
    ]);

    const byHolder = await breakAll({
      comment: 'Left.',
      holder: { kind: 'user', id: 'sample-other' },
    });
    expect(BreakLocksResultDocument.parse(byHolder.body).meta.count).toBe(1);
    const none = await breakAll({
      comment: 'Left.',
      holder: { kind: 'user', id: 'sample-other' },
    });
    expect(BreakLocksResultDocument.parse(none.body).meta.count).toBe(0);
  });

  it('is released when its change set is abandoned, and none is taken for a closed one', async () => {
    const mine = await changeSet(author);
    t.actAs(author);
    const lock = LockDocument.parse(
      (await acquire(mine, { type: 'manual', manualId: 'abandon-me' })).body,
    ).data;
    expect((await t.post(`/change-sets/${mine}/abandon`)).status).toBe(200);

    t.actAs(reader);
    expect((await t.get(`/locks/${lock.id}`)).status).toBe(404);
    t.actAs(author);
    const closed = await acquire(mine, {
      type: 'manual',
      manualId: 'abandon-me',
    });
    expect(closed.status).toBe(409);
    expect(only(closed.body)).toMatchObject({
      code: 'invalid-state',
      meta: { state: 'abandoned' },
    });
    expect(
      (await events('manual/abandon-me')).map((e) => [e.action, e.data]),
    ).toEqual([
      [
        'lock.release',
        { lockId: lock.id, changeSetId: mine, reason: 'change-set.abandon' },
      ],
      ['lock.acquire', { lockId: lock.id, changeSetId: mine }],
    ]);
  });

  it('is taken only by the change set’s author, for a change set that exists', async () => {
    const mine = await changeSet(author);
    t.actAs(otherAuthor);
    const notYours = await acquire(mine, { type: 'manual', manualId: 'x' });
    expect(notYours.status).toBe(403);
    t.actAs(author);
    for (const id of [newChangeSetId(), 'nope']) {
      const res = await acquire(id, { type: 'manual', manualId: 'x' });
      expect([id, res.status]).toEqual([id, 404]);
    }
    t.actAs(reader);
    expect(
      (await acquire(mine, { type: 'manual', manualId: 'x' })).status,
    ).toBe(403);
    // A module only in a language the author edits.
    t.actAs({
      ...actorWith(['content.read', 'content.read.draft', 'content.edit'], {
        languages: ['de'],
      }),
      id: author.id,
    });
    const english = await acquire(mine, {
      type: 'module',
      lang: 'en',
      moduleId: 'scoped',
    });
    expect(english.status).toBe(403);
    expect(only(english.body)?.code).toBe('forbidden');
    const german = await acquire(mine, {
      type: 'module',
      lang: 'de',
      moduleId: 'scoped',
    });
    expect(german.status).toBe(201);
  });

  it('refuses a malformed subject, naming the member at fault', async () => {
    const mine = await changeSet(author);
    t.actAs(author);
    const cases: [unknown, string][] = [
      [{ type: 'module', lang: 'en' }, '/data/attributes/subject/moduleId'],
      [
        { type: 'module', lang: 'en', moduleId: 'Bad Id' },
        '/data/attributes/subject/moduleId',
      ],
      [
        { type: 'module', lang: 'not a tag', moduleId: 'x' },
        '/data/attributes/subject/lang',
      ],
      [
        { type: 'manual', manualId: '../x' },
        '/data/attributes/subject/manualId',
      ],
      [{ type: 'role', id: 'admin' }, '/data/attributes/subject/type'],
      [
        { type: 'module', lang: `en${'-abcdefgh'.repeat(20)}`, moduleId: 'x' },
        '/data/attributes/subject/lang',
      ],
      [
        { type: 'module', lang: 'en-US-POSIX', moduleId: 'x' },
        '/data/attributes/subject/lang',
      ],
      [{ type: 'manual', manualId: 'x', extra: 1 }, '/data/attributes/subject'],
    ];
    for (const [subject, pointer] of cases) {
      const res = await acquire(mine, subject);
      expect([pointer, res.status]).toEqual([pointer, 400]);
      // A bad tag breaks two rules of it: each is named.
      expect(ErrorDocument.parse(res.body).errors[0]).toMatchObject({
        code: 'invalid-body',
        source: { pointer },
      });
    }
  });

  it('lists newest first, paged and filtered, as JSON:API matching its schema', async () => {
    const mine = await changeSet(author);
    const theirs = await changeSet(otherAuthor);
    t.actAs(author);
    const a = LockDocument.parse(
      (await acquire(mine, { type: 'module', lang: 'de', moduleId: 'list' }))
        .body,
    ).data;
    t.actAs(otherAuthor);
    const b = LockDocument.parse(
      (await acquire(theirs, { type: 'manual', manualId: 'list' })).body,
    ).data;

    t.actAs(reader);
    const res = await t.get('/locks?page[size]=1');
    expect(res.status).toBe(200);
    const page = LockPageDocument.parse(res.body);
    expect(page.data.map((l) => l.id)).toEqual([b.id]);
    expect(page.links.next).toContain('page%5Bnumber%5D=2');

    const ids = async (query: string) =>
      LockPageDocument.parse((await t.get(`/locks?${query}`)).body).data.map(
        (l) => l.id,
      );
    expect(await ids(`filter[changeSet]=${mine}`)).toEqual([a.id]);
    expect(await ids('filter[holder]=sample-other')).toContain(b.id);
    expect(await ids('filter[holder]=sample-other')).not.toContain(a.id);
    expect(await ids('filter[subject]=module/de/list')).toEqual([a.id]);
    expect(await ids('filter[subject]=manual/list')).toEqual([b.id]);
    expect(await ids(`filter[changeSet]=${newChangeSetId()}`)).toEqual([]);

    for (const [query, parameter] of [
      ['filter[subject]=module/list', 'filter[subject]'],
      ['filter[subject]=role/admin', 'filter[subject]'],
      ['filter[changeSet]=nope', 'filter[changeSet]'],
      ['filter[holder]=', 'filter[holder]'],
    ]) {
      const bad = await t.get(`/locks?${query}`);
      expect([query, bad.status]).toEqual([query, 400]);
      expect(only(bad.body)?.source?.parameter).toBe(parameter);
    }
    const unknown = await t.get('/locks?filter[lang]=en');
    expect(only(unknown.body)?.code).toBe('unsupported-parameter');
  });

  it('lists only one’s own locks without content.read.draft, and finds no lock an ID names not', async () => {
    t.actAs(actorWith(['content.read', 'content.edit']));
    const own = await t.get('/locks');
    expect(own.status).toBe(200);
    expect((own.body as { data: unknown[] }).data).toEqual([]);
    t.actAs(reader);
    for (const id of [newLockId(), 'nope']) {
      const res = await t.get(`/locks/${id}`);
      expect([id, res.status]).toEqual([id, 404]);
      expect(only(res.body)?.code).toBe('not-found');
    }
    t.actAs(admin);
    const res = await t
      .post(`/locks/${newLockId()}/break`)
      .send(JSON.stringify({ meta: { comment: 'x' } }));
    expect(res.status).toBe(404);
  });
});

describe('what a refusal tells (#121, #125)', () => {
  /** Edits content but may not read change sets or locks. */
  const editorOnly: Actor = {
    ...actorWith(['content.read', 'content.edit']),
    id: 'sample-editor-only',
  };
  /** Edits and reads drafts of public content only. */
  const publicEditor: Actor = {
    ...actorWith(['content.read', 'content.read.draft', 'content.edit'], {
      maxAudience: 'public',
    }),
    id: 'sample-public-editor',
  };

  /** Status, content type and body, with `id` written as `<id>`. */
  const answer = (res: Awaited<ReturnType<typeof acquire>>, id?: string) => ({
    status: res.status,
    type: res.headers['content-type'],
    body: id === undefined ? res.text : res.text.replaceAll(id, '<id>'),
  });

  it('answers another author’s change set exactly as a missing one to an actor who may not read them', async () => {
    const theirs = await changeSet(author);
    const missing = newChangeSetId();
    t.actAs(editorOnly);
    const subject = { type: 'manual', manualId: 'not-yours' };
    for (const call of [
      (id: string) => acquire(id, subject),
      (id: string) => t.post(`/change-sets/${id}/abandon`),
    ]) {
      const notYours = answer(await call(theirs), theirs);
      expect(notYours.status).toBe(404);
      expect(notYours).toEqual(answer(await call(missing), missing));
    }
    // A draft reader is told it is not theirs.
    t.actAs(otherAuthor);
    for (const res of [
      await acquire(theirs, subject),
      await t.post(`/change-sets/${theirs}/abandon`),
    ]) {
      expect(res.status).toBe(403);
      expect(only(res.body)?.code).toBe('forbidden');
    }
    t.actAs(reader);
    const state = ChangeSetDocument.parse(
      (await t.get(`/change-sets/${theirs}`)).body,
    ).data.attributes.state;
    expect(state).toBe('draft');
  });

  it('answers releasing someone’s lock exactly as a missing one to an actor who may not know of it', async () => {
    const mine = await changeSet(author);
    t.actAs(author);
    const lock = LockDocument.parse(
      (await acquire(mine, { type: 'manual', manualId: 'held-for-you' })).body,
    ).data;
    const missing = newLockId();
    t.actAs(editorOnly);
    const notYours = answer(await t.delete(`/locks/${lock.id}`), lock.id);
    expect(notYours.status).toBe(404);
    expect(notYours).toEqual(
      answer(await t.delete(`/locks/${missing}`), missing),
    );
    t.actAs(otherAuthor);
    const told = await t.delete(`/locks/${lock.id}`);
    expect(told.status).toBe(403);
    expect(only(told.body)?.code).toBe('forbidden');
    t.actAs(reader);
    expect((await t.get(`/locks/${lock.id}`)).status).toBe(200);
  });

  it('answers locking a hidden module exactly as a missing one', async () => {
    const mine = await changeSet(publicEditor);
    t.actAs(publicEditor);
    const refusal = async (moduleId: string) =>
      answer(await acquire(mine, { type: 'module', lang: 'en', moduleId }));
    // `en/internals` is internal: above their audience, so hidden.
    const hidden = await refusal('internals');
    expect(hidden.status).toBe(403);
    expect(JSON.parse(hidden.body).errors[0].code).toBe('forbidden');
    expect(await refusal('no-such-module')).toEqual(hidden);
    // A manual naming it is refused alike; a public module is locked.
    const manual = await acquire(mine, {
      type: 'manual',
      manualId: 'operating',
    });
    expect(manual.status).toBe(403);
    expect(only(manual.body)?.code).toBe('forbidden');
    expect(
      (
        await acquire(mine, {
          type: 'module',
          lang: 'en',
          moduleId: 'charging',
        })
      ).status,
    ).toBe(201);
  });

  it('lists and reads only the locks within the reader’s scope, counted before paging', async () => {
    const mine = await changeSet(author);
    t.actAs(author);
    const take = async (subject: unknown) =>
      LockDocument.parse((await acquire(mine, subject)).body).data;
    const internals = await take({
      type: 'module',
      lang: 'en',
      moduleId: 'internals',
    });
    const charging = await take({
      type: 'module',
      lang: 'de',
      moduleId: 'charging',
    });
    const page = async (query = '') => {
      const res = await t.get(`/locks?filter[changeSet]=${mine}${query}`);
      expect(res.status).toBe(200);
      const document = LockPageDocument.parse(res.body);
      return {
        ids: document.data.map((l) => l.id),
        total: document.meta.page.total,
      };
    };
    t.actAs(reader);
    expect(await page()).toEqual({
      ids: [charging.id, internals.id],
      total: 2,
    });
    t.actAs(publicEditor);
    expect(await page()).toEqual({ ids: [charging.id], total: 1 });
    expect(await page('&page[size]=1')).toEqual({
      ids: [charging.id],
      total: 1,
    });
    // A lock on a hidden subject is not found, exactly like none.
    const missing = newLockId();
    const outside = answer(await t.get(`/locks/${internals.id}`), internals.id);
    expect(outside.status).toBe(404);
    expect(outside).toEqual(answer(await t.get(`/locks/${missing}`), missing));
    // Releasing it too: they may not know of it.
    const release = answer(
      await t.delete(`/locks/${internals.id}`),
      internals.id,
    );
    expect(release).toEqual(
      answer(await t.delete(`/locks/${missing}`), missing),
    );
    expect((await t.get(`/locks/${charging.id}`)).status).toBe(200);
  });
});
