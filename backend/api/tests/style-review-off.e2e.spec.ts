import type { Actor } from '../src/access/core/actor.js';
import { AuditEventPageDocument } from '../src/audit/api/audit-event.resources.js';
import { ErrorDocument, JSON_API } from '../src/base/api/json-api.js';
import { ChangeSetDocument } from '../src/change-sets/api/change-set.resources.js';
import { StyleReviewStatusDocument } from '../src/style-review/api/style-review.resources.js';
import { actorWith } from './fakes/actors.js';
import { createTestApp, type TestApp } from './test-app.js';

const author: Actor = {
  ...actorWith(['content.read', 'content.read.draft', 'content.edit']),
  id: 'sample-author',
};
const admin = actorWith(['admin.roles']);

const only = (body: unknown) => {
  const [first, ...rest] = ErrorDocument.parse(body).errors;
  expect(rest).toEqual([]);
  return first;
};

async function changeSet(t: TestApp, as: Actor = author): Promise<string> {
  t.actAs(as);
  const res = await t.post('/change-sets').send(
    JSON.stringify({
      data: { type: 'ChangeSet', attributes: { title: 'Style review' } },
    }),
  );
  expect(res.status).toBe(201);
  return ChangeSetDocument.parse(res.body).data.id;
}

const reviewPath = (cs: string, id = 'charging', lang = 'en'): string =>
  `/change-sets/${cs}/modules/${lang}/${id}/style-review`;

async function auditEvents(t: TestApp) {
  t.actAs(admin);
  const res = await t.get(
    '/audit-events?filter[action]=module.style-review&page[size]=200',
  );
  expect(res.status).toBe(200);
  return AuditEventPageDocument.parse(res.body).data;
}

describe('style review, not configured (the default)', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t?.close());

  it('says it is not set up, so the editor does not offer it', async () => {
    t.actAs(author);
    const res = await t.get('/style-review');
    expect(res.status).toBe(200);
    expect(StyleReviewStatusDocument.parse(res.body).data.attributes).toEqual({
      configured: false,
    });
  });

  it('is 404 not-configured, and records nothing', async () => {
    const cs = await changeSet(t);
    t.actAs(author);
    const res = await t.post(reviewPath(cs));
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toBe(JSON_API);
    expect(only(res.body)).toMatchObject({ code: 'not-configured' });
    expect(await auditEvents(t)).toEqual([]);
  });
});
