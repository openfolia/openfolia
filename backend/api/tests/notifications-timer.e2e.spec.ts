import { sql } from 'drizzle-orm';
import { ChangeSetDocument } from '../src/change-sets/api/change-set.resources.js';
import { NotificationPageDocument } from '../src/notifications/api/notification.resources.js';
import { actorWith } from './fakes/actors.js';
import { createTestApp, type TestApp } from './test-app.js';

const author = {
  ...actorWith(['content.read', 'content.read.draft', 'content.edit']),
  id: 'sample-author',
};

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp({ CCMS_NOTIFICATIONS_POLL_MS: '50' });
});
afterAll(() => t?.close());

describe('the notifications’ consumer on its timer', () => {
  it('delivers what the outbox gets without being asked', async () => {
    t.actAs(author);
    const created = await t.post('/change-sets').send(
      JSON.stringify({
        data: { type: 'ChangeSet', attributes: { title: 'On a timer' } },
      }),
    );
    expect(created.status).toBe(201);
    const { id } = ChangeSetDocument.parse(created.body).data;
    // As a reviewer's return writes it.
    await t.database.db.execute(sql`
      insert into outbox (topic, key, payload) values (
        'change-set.return', ${`${id}/timer`},
        ${JSON.stringify({
          changeSetId: id,
          actor: { kind: 'user', id: 'sample-reviewer' },
          from: 'in-review',
          to: 'draft',
        })}::jsonb)`);
    let kinds: string[] = [];
    for (let i = 0; i < 200 && kinds.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      const res = await t.get('/me/notifications');
      kinds = NotificationPageDocument.parse(res.body).data.map(
        (n) => n.attributes.kind,
      );
    }
    expect(kinds).toEqual(['change-set.return']);
  });
});
