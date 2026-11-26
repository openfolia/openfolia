import { type Module } from '@openfolia/content-model';
import { sql } from 'drizzle-orm';
import type { Actor, Scope } from '../src/access/core/actor.js';
import type { Permission } from '../src/access/core/permissions.js';
import { Seed, seedAccess } from '../src/access/repos/seed.js';
import { ErrorDocument } from '../src/base/api/json-api.js';
import { ChangeSetDocument } from '../src/change-sets/api/change-set.resources.js';
import { LockDocument } from '../src/change-sets/api/lock.resources.js';
import { ModuleWorkingCopyDocument } from '../src/change-sets/api/working-copy.resources.js';
import { NotificationsConsumer } from '../src/notifications/api/notifications-consumer.js';
import { notificationEmails } from '../src/notifications/repos/notification-emails.tables.js';
import {
  MarkReadResultDocument,
  NotificationDocument,
  NotificationPageDocument,
  UnreadCountDocument,
} from '../src/notifications/api/notification.resources.js';
import { actorWith } from './fakes/actors.js';
import { createTestApp, type TestApp } from './test-app.js';

const READS: Permission[] = ['content.read', 'content.read.draft'];
const user = (
  id: string,
  permissions: Permission[],
  scope: Scope = {},
): Actor => ({ ...actorWith([...READS, ...permissions], scope), id });

const author = user('sample-author', ['content.edit']);
const reviewer = user('sample-reviewer', ['content.review'], {
  languages: ['en'],
});
const germanReviewer = user('german-reviewer', ['content.review'], {
  languages: ['de'],
});
const admin = user('sample-admin', ['admin.roles']);
const charging = { type: 'module', lang: 'en', moduleId: 'charging' } as const;

let t: TestApp;
const errors = (body: unknown) => ErrorDocument.parse(body).errors;

beforeAll(async () => {
  t = await createTestApp();
  await seedUsers(author, reviewer, germanReviewer, admin);
});
afterAll(() => t?.close());
afterEach(async () => {
  if (!t) return;
  t.actAs(undefined);
  await t.database.db.execute(sql`delete from locks`);
});

async function seedUsers(...actors: Actor[]) {
  const roleId = (a: Actor, r: { id: string }) => `${a.id}-${r.id}`;
  await seedAccess(
    t.database,
    Seed.parse({
      roles: actors.flatMap((a) =>
        a.roles.map((r) => ({ ...r, id: roleId(a, r) })),
      ),
      users: actors.map((a) => ({
        id: a.id,
        name: a.id,
        roles: a.roles.map((r) => roleId(a, r)),
      })),
    }),
  );
}

const deliver = () => t.app.get(NotificationsConsumer).runOnce();

/** A change set by `author` changing `charging` at a save point; its lock's ID. */
async function changed(title: string): Promise<{ id: string; lockId: string }> {
  t.actAs(author);
  const created = await t
    .post('/change-sets')
    .send(
      JSON.stringify({ data: { type: 'ChangeSet', attributes: { title } } }),
    );
  expect(created.status).toBe(201);
  const { id } = ChangeSetDocument.parse(created.body).data;
  const locked = await t.post(`/change-sets/${id}/locks`).send(
    JSON.stringify({
      data: { type: 'Lock', attributes: { subject: charging } },
    }),
  );
  expect(locked.status).toBe(201);
  const path = `/change-sets/${id}/modules/en/charging/working-copy`;
  const read = ModuleWorkingCopyDocument.parse((await t.get(path)).body).data
    .attributes;
  const content = read.content as Module;
  const saved = await t.put(path).send(
    JSON.stringify({
      data: {
        type: 'WorkingCopy',
        attributes: {
          content: {
            ...content,
            blocks: [
              {
                type: 'paragraph',
                id: 'typed',
                content: [{ type: 'text', text: `${title}.` }],
              },
            ],
          },
        },
      },
      meta: { version: read.version, baseCommit: read.baseCommit },
    }),
  );
  expect(saved.status).toBe(200);
  expect((await t.post(`/change-sets/${id}/commits`)).status).toBe(201);
  return { id, lockId: LockDocument.parse(locked.body).data.id };
}

const transition = (actor: Actor, id: string, name: string) => {
  t.actAs(actor);
  return t.post(`/change-sets/${id}/${name}`).send('');
};

async function inbox(actor: Actor, query = '') {
  t.actAs(actor);
  const res = await t.get(`/me/notifications${query}`);
  expect(res.status).toBe(200);
  return NotificationPageDocument.parse(res.body);
}

const ofChangeSet = (
  page: Awaited<ReturnType<typeof inbox>>,
  changeSetId: string,
) =>
  page.data
    .filter((n) => n.attributes.subject.id === changeSetId)
    .map((n) => n.attributes.kind);

describe('notifications', () => {
  it('tell exactly the reviewers whose scope covers a submitted change set, and not its author', async () => {
    const { id } = await changed('Clearer charging');
    expect((await transition(author, id, 'submit')).status).toBe(200);
    await deliver();
    const mine = await inbox(reviewer);
    expect(ofChangeSet(mine, id)).toEqual(['change-set.submit']);
    expect(mine.data[0]?.attributes).toMatchObject({
      subject: { type: 'change-set', id },
      payload: {
        changeSetId: id,
        title: 'Clearer charging',
        by: { kind: 'user', id: author.id },
        state: 'in-review',
      },
      readAt: null,
    });
    expect(ofChangeSet(await inbox(germanReviewer), id)).toEqual([]);
    expect(ofChangeSet(await inbox(author), id)).toEqual([]);
    // Email is not set up here (no `CCMS_MAIL_URL`): nothing is queued to go by email (#884).
    expect(await t.database.db.select().from(notificationEmails)).toEqual([]);
  });

  it('tell the author once of a return, even when the batch is read again', async () => {
    const { id } = await changed('Returned once');
    expect((await transition(author, id, 'submit')).status).toBe(200);
    expect((await transition(reviewer, id, 'return')).status).toBe(200);
    await deliver();
    // As after a restart mid-batch (or another server): the cursor back at
    // the start, every row read again.
    await t.database.db.execute(
      sql`update outbox_consumers set last_tx_id = '0'::xid8, last_outbox_id = 0`,
    );
    const again = await deliver();
    expect(again?.events).toBeGreaterThan(0);
    expect(again?.stored).toBe(0);
    expect(ofChangeSet(await inbox(author), id)).toEqual(['change-set.return']);
  });

  it('tell a lock’s holder an admin broke it', async () => {
    const { id, lockId } = await changed('Broken lock');
    t.actAs(admin);
    const broken = await t
      .post(`/locks/${lockId}/break`)
      .send(JSON.stringify({ meta: { comment: 'Away.' } }));
    expect(broken.status).toBe(204);
    await deliver();
    const mine = await inbox(author);
    const notification = mine.data.find((n) => n.attributes.subject.id === id);
    expect(notification?.attributes).toMatchObject({
      kind: 'lock.break',
      payload: {
        count: 1,
        subjects: ['module/en/charging'],
        title: 'Broken lock',
      },
    });
  });

  it('are never another person’s to read or mark: 404', async () => {
    const { id } = await changed('Not yours');
    expect((await transition(author, id, 'submit')).status).toBe(200);
    await deliver();
    const theirs = (await inbox(reviewer)).data.find(
      (n) => n.attributes.subject.id === id,
    );
    if (!theirs) throw new Error('not delivered');
    t.actAs(reviewer);
    const own = await t.get(`/me/notifications/${theirs.id}`);
    expect(own.status).toBe(200);
    expect(NotificationDocument.parse(own.body).data.id).toBe(theirs.id);

    for (const someone of [author, germanReviewer]) {
      t.actAs(someone);
      const read = await t.get(`/me/notifications/${theirs.id}`);
      expect(read.status).toBe(404);
      expect(errors(read.body)[0]?.code).toBe('not-found');
      const marked = await t
        .post('/me/notifications/read')
        .send(JSON.stringify({ meta: { ids: [theirs.id] } }));
      expect(marked.status).toBe(404);
      expect(errors(marked.body)[0]?.code).toBe('not-found');
    }
    // Malformed, or none at all: the same 404.
    for (const path of [
      '/me/notifications/nope',
      '/me/notifications/99999999',
    ]) {
      const res = await t.get(path);
      expect(res.status).toBe(404);
    }
    t.actAs(reviewer);
    expect((await t.get(`/me/notifications/${theirs.id}`)).body).toMatchObject({
      data: { attributes: { readAt: null } },
    });
  });

  it('count fewer unread after marking read, with an ETag for polling', async () => {
    const { id } = await changed('Count down');
    expect((await transition(author, id, 'submit')).status).toBe(200);
    expect((await transition(reviewer, id, 'return')).status).toBe(200);
    await deliver();
    t.actAs(author);
    const before = await t.get('/me/notifications/unread-count');
    expect(before.status).toBe(200);
    const count = UnreadCountDocument.parse(before.body).meta.unreadCount;
    expect(count).toBeGreaterThan(0);
    const etag = before.headers['etag'] as string;
    expect(before.headers['cache-control']).toBe('private, no-cache');
    const unchanged = await t
      .get('/me/notifications/unread-count')
      .set('If-None-Match', etag);
    expect(unchanged.status).toBe(304);
    // Another person's count is another answer.
    t.actAs(reviewer);
    const theirs = await t
      .get('/me/notifications/unread-count')
      .set('If-None-Match', etag);
    expect(theirs.status).toBe(200);

    const unread = await inbox(author, '?filter[unread]=true');
    expect(unread.meta.unreadCount).toBe(count);
    const first = unread.data[0];
    if (!first) throw new Error('none unread');
    t.actAs(author);
    const marked = await t
      .post('/me/notifications/read')
      .send(JSON.stringify({ meta: { ids: [first.id] } }));
    expect(marked.status).toBe(200);
    expect(MarkReadResultDocument.parse(marked.body).meta).toEqual({
      marked: 1,
      unreadCount: count - 1,
    });
    const after = await t
      .get('/me/notifications/unread-count')
      .set('If-None-Match', etag);
    expect(after.status).toBe(200);
    expect(UnreadCountDocument.parse(after.body).meta.unreadCount).toBe(
      count - 1,
    );
    expect(
      (await inbox(author, '?filter[unread]=false')).data.map((n) => n.id),
    ).toContain(first.id);

    const all = await t
      .post('/me/notifications/read')
      .send(JSON.stringify({ meta: { all: true } }));
    expect(MarkReadResultDocument.parse(all.body).meta.unreadCount).toBe(0);
    expect((await inbox(author)).meta.unreadCount).toBe(0);
  });

  it('are paged, and refuse what the routes do not take', async () => {
    const page = await inbox(reviewer, '?page[size]=1');
    expect(page.meta.page.perPage).toBe(1);
    expect(page.data.length).toBeLessThanOrEqual(1);
    t.actAs(reviewer);
    const bad = await t.get('/me/notifications?filter[unread]=maybe');
    expect(bad.status).toBe(400);
    const unknown = await t.get('/me/notifications?filter[kind]=x');
    expect(unknown.status).toBe(400);
    for (const body of [
      {},
      { meta: {} },
      { meta: { ids: [] } },
      { meta: { ids: ['x'] } },
      { meta: { all: false } },
      { meta: { all: true, ids: ['1'] } },
    ]) {
      const res = await t
        .post('/me/notifications/read')
        .send(JSON.stringify(body));
      expect([JSON.stringify(body), res.status]).toEqual([
        JSON.stringify(body),
        400,
      ]);
    }
  });

  it('give the API token’s service an empty inbox', async () => {
    t.actAs(undefined);
    const res = await t.get('/me/notifications');
    expect(res.status).toBe(200);
    expect(NotificationPageDocument.parse(res.body).meta.unreadCount).toBe(0);
  });
});
