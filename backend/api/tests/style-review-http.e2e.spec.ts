import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Logger } from '@nestjs/common';
import type { Actor } from '../src/access/core/actor.js';
import { AuditEventPageDocument } from '../src/audit/api/audit-event.resources.js';
import { ErrorDocument } from '../src/base/api/json-api.js';
import { ChangeSetDocument } from '../src/change-sets/api/change-set.resources.js';
import { StyleReviewDocument } from '../src/style-review/api/style-review.resources.js';
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

describe('style review over HTTP, configured by the environment', () => {
  const KEY = 'sk-e2e-secret-key-0123456789abcdef';
  let server: Server;
  let url: string;
  let respond: (req: IncomingMessage) => { status: number; body: string };
  const received: IncomingMessage['headers'][] = [];
  let t: TestApp;
  const output: string[] = [];
  let restore: (() => void) | undefined;

  beforeAll(async () => {
    server = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        received.push(req.headers);
        const { status, body } = respond(req);
        res.statusCode = status;
        res.setHeader('Content-Type', 'application/json');
        res.end(body);
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/chat/completions`;
    t = await createTestApp({
      CCMS_STYLE_REVIEW_URL: url,
      CCMS_STYLE_REVIEW_MODEL: 'some-model',
      CCMS_STYLE_REVIEW_API_KEY: KEY,
    });
    // Everything the app logs from here on.
    const spies = (
      ['log', 'warn', 'error', 'debug', 'verbose', 'fatal'] as const
    ).map((level) =>
      vi
        .spyOn(Logger.prototype, level)
        .mockImplementation((...args: unknown[]) => {
          output.push(
            args
              .map((a) =>
                a instanceof Error ? `${a.message} ${a.stack}` : String(a),
              )
              .join(' '),
          );
        }),
    );
    restore = () => spies.forEach((spy) => spy.mockRestore());
  });
  afterAll(async () => {
    restore?.();
    await t?.close();
    server?.closeAllConnections();
    await new Promise((resolve) => server?.close(resolve));
  });

  it('sends the key to the endpoint and returns what the model suggests', async () => {
    respond = () => ({
      status: 200,
      body: JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                suggestions: [
                  {
                    blockId: 'intro',
                    field: 'content',
                    original: 'charges automatically',
                    message: 'Say what the reader does.',
                    replacement: 'is charged',
                  },
                ],
              }),
            },
          },
        ],
      }),
    });
    const cs = await changeSet(t);
    t.actAs(author);
    const res = await t.post(reviewPath(cs));
    expect(res.status).toBe(200);
    const { data } = StyleReviewDocument.parse(res.body);
    expect(data.attributes.suggestions).toEqual([
      expect.objectContaining({
        original: 'charges automatically',
        range: { start: 19, end: 40 },
        replacement: 'is charged',
      }),
    ]);
    expect(received.at(-1)?.['authorization']).toBe(`Bearer ${KEY}`);
  });

  it('never shows the key in an error, the log or the audit log', async () => {
    respond = () => ({
      status: 401,
      body: JSON.stringify({ error: `invalid key ${KEY} for ${url}` }),
    });
    const cs = await changeSet(t);
    t.actAs(author);
    const res = await t.post(reviewPath(cs));
    expect(res.status).toBe(503);
    expect(only(res.body)).toMatchObject({ code: 'style-review-unavailable' });
    const events = await auditEvents(t);
    expect(events.length).toBeGreaterThan(0);
    for (const text of [
      JSON.stringify(res.body),
      JSON.stringify(res.headers),
      JSON.stringify(events),
      output.join(''),
    ]) {
      expect(text).not.toContain(KEY);
      expect(text).not.toContain(url);
    }
    // The failure was logged, by its status only.
    expect(output.join('')).toContain('answered 401');
  });
});
