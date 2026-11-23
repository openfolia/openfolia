import type { Actor } from '../src/access/core/actor.js';
import { AuditEventPageDocument } from '../src/audit/api/audit-event.resources.js';
import { ErrorDocument, JSON_API } from '../src/base/api/json-api.js';
import { ChangeSetDocument } from '../src/change-sets/api/change-set.resources.js';
import {
  StyleReviewDocument,
  StyleReviewStatusDocument,
} from '../src/style-review/api/style-review.resources.js';
import { actorWith } from './fakes/actors.js';
import { FakeStyleReviewer } from './fakes/fake-style-reviewer.js';
import { createTestApp, type TestApp } from './test-app.js';

const author: Actor = {
  ...actorWith(['content.read', 'content.read.draft', 'content.edit']),
  id: 'sample-author',
};
const otherAuthor: Actor = { ...author, id: 'sample-other' };
/** Edits, but reads no drafts: another author's change set is 404 to them. */
const outsider: Actor = {
  ...actorWith(['content.read', 'content.edit']),
  id: 'sample-outsider',
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

const reviewPath = (cs: string, id = 'charging', lang = 'en') =>
  `/change-sets/${cs}/modules/${lang}/${id}/style-review`;

async function auditEvents(t: TestApp) {
  t.actAs(admin);
  const res = await t.get(
    '/audit-events?filter[action]=module.style-review&page[size]=200',
  );
  expect(res.status).toBe(200);
  return AuditEventPageDocument.parse(res.body).data;
}

// One app per file: the settings are read once per test file.
const reviewer = new FakeStyleReviewer();
let t: TestApp;
beforeAll(async () => {
  t = await createTestApp(
    { CCMS_STYLE_REVIEW_PER_MINUTE: '2', CCMS_STYLE_REVIEW_TIMEOUT_MS: '1000' },
    { styleReviewer: reviewer },
  );
});
afterAll(() => t?.close());
afterEach(() => {
  t?.actAs(undefined);
  reviewer.requests.length = 0;
  reviewer.answer = [];
  reviewer.hang = false;
});

describe('style review with a reviewer', () => {
  it('says it is set up, to those who may ask for a review', async () => {
    t.actAs(author);
    const res = await t.get('/style-review');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe(JSON_API);
    expect(StyleReviewStatusDocument.parse(res.body).data).toEqual({
      type: 'StyleReviewStatus',
      id: 'style-review',
      attributes: { configured: true },
    });
    t.actAs(actorWith(['content.read']));
    const refused = await t.get('/style-review');
    expect(refused.status).toBe(403);
    expect(only(refused.body)).toMatchObject({ code: 'forbidden' });
  });

  it('answers with suggestions inside the module’s text, and audits the review', async () => {
    const cs = await changeSet(t);
    reviewer.answer = [
      {
        blockId: 'intro',
        field: 'content',
        start: 0,
        end: 3,
        message: 'Start with the subject.',
        replacement: 'This',
      },
      // Over the attribute, and in a block that does not exist: dropped.
      { blockId: 'intro', field: 'content', start: 2, end: 8, message: 'x' },
      { blockId: 'nope', field: 'content', start: 0, end: 1, message: 'x' },
    ];
    t.actAs(author);
    const res = await t.post(reviewPath(cs));
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe(JSON_API);
    const { data } = StyleReviewDocument.parse(res.body);
    expect(data).toMatchObject({
      type: 'StyleReview',
      id: 'en/charging',
      attributes: {
        lang: 'en',
        moduleId: 'charging',
        suggestions: [
          {
            blockId: 'intro',
            field: 'content',
            range: { start: 0, end: 3 },
            original: 'The',
            message: 'Start with the subject.',
            replacement: 'This',
            rule: 'model',
          },
        ],
      },
      meta: { version: 0, baseCommit: t.commits.main, dropped: 2 },
    });
    // Only the module's text went out: no title, no keywords.
    const sent = JSON.stringify(reviewer.requests);
    expect(sent).toContain('The {product-name} charges automatically.');
    expect(sent).not.toContain('maintenance');
    expect(sent).not.toContain('"Charging"');

    const events = await auditEvents(t);
    expect(events).toHaveLength(1);
    expect(events[0]?.attributes).toMatchObject({
      actor: { kind: 'user', id: author.id },
      subject: { type: 'module', id: 'en/charging' },
      data: { changeSetId: cs, outcome: 'ok', suggestions: 1, dropped: 2 },
    });
    expect(JSON.stringify(events)).not.toContain('Start with the subject');
  });

  it('is only for the change set’s author: 403 for another draft reader, 404 for anyone else', async () => {
    const cs = await changeSet(t);
    t.actAs(otherAuthor);
    const forbidden = await t.post(reviewPath(cs));
    expect(forbidden.status).toBe(403);
    expect(only(forbidden.body)).toMatchObject({ code: 'forbidden' });
    t.actAs(outsider);
    const hidden = await t.post(reviewPath(cs));
    expect(hidden.status).toBe(404);
    expect(only(hidden.body)).toMatchObject({ code: 'not-found' });
    t.actAs(actorWith(['content.read', 'content.read.draft']));
    expect((await t.post(reviewPath(cs))).status).toBe(403);
    expect(reviewer.requests).toEqual([]);
  });

  it('is 404 for a module that does not exist, and refuses a body', async () => {
    const cs = await changeSet(t);
    t.actAs(author);
    const missing = await t.post(reviewPath(cs, 'nothing-here'));
    expect(missing.status).toBe(404);
    const body = await t
      .post(reviewPath(cs))
      .send(JSON.stringify({ data: { type: 'StyleReview' } }));
    expect(body.status).toBe(400);
    expect(reviewer.requests).toEqual([]);
  });
});

describe('style review limits', () => {
  it('answers 429 with Retry-After past the per-minute limit, per person', async () => {
    const rater: Actor = { ...author, id: 'sample-rater' };
    const cs = await changeSet(t, rater);
    t.actAs(rater);
    expect((await t.post(reviewPath(cs))).status).toBe(200);
    expect((await t.post(reviewPath(cs))).status).toBe(200);
    const refused = await t.post(reviewPath(cs));
    expect(refused.status).toBe(429);
    expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
    expect(only(refused.body)).toMatchObject({ code: 'rate-limited' });
    // Another person still may.
    const theirs = await changeSet(t, otherAuthor);
    t.actAs(otherAuthor);
    expect((await t.post(reviewPath(theirs))).status).toBe(200);
  });

  it('answers 503 with Retry-After when the model takes too long', async () => {
    const slow: Actor = { ...author, id: 'sample-slow' };
    reviewer.hang = true;
    const cs = await changeSet(t, slow);
    t.actAs(slow);
    const res = await t.post(reviewPath(cs));
    expect(res.status).toBe(503);
    expect(res.headers['retry-after']).toBe('1');
    expect(only(res.body)).toMatchObject({ code: 'style-review-timeout' });
    const events = await auditEvents(t);
    expect(
      events.find((e) => e.attributes.actor.id === slow.id)?.attributes.data,
    ).toMatchObject({ outcome: 'timeout' });
  });
});
