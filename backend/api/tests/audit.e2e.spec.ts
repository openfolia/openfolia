import type { Actor } from '../src/access/core/actor.js';
import { AuditEventPageDocument } from '../src/audit/api/audit-event.resources.js';
import { AuditLog } from '../src/audit/core/audit-log.js';
import { ErrorDocument, JSON_API } from '../src/base/api/json-api.js';
import { UnitOfWork } from '../src/base/core/unit-of-work.js';
import { createTestApp, type TestApp, TOKEN } from './test-app.js';

const role = (permissions: Actor['roles'][number]['permissions']) => ({
  id: 'role',
  name: 'Role',
  permissions,
  scope: {},
});
const admin: Actor = {
  kind: 'user',
  id: 'sample-admin',
  roles: [role(['admin.roles'])],
};
const author: Actor = {
  kind: 'user',
  id: 'sample-author',
  roles: [role(['content.read', 'content.edit'])],
};
const importer: Actor = { kind: 'service', id: 'importer', roles: [] };

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
  const log = t.app.get(AuditLog);
  await t.app.get(UnitOfWork).run(async (tx) => {
    await log.record(tx, admin, {
      action: 'role.assign',
      subject: { type: 'user', id: 'sample-author' },
      comment: 'Writes the safety chapters.',
      data: { role: 'author' },
    });
    await log.record(tx, author, {
      action: 'module.write',
      subject: { type: 'module', id: 'en/battery-charging' },
    });
    await log.record(tx, importer, {
      action: 'module.write',
      subject: { type: 'module', id: 'de/battery-charging' },
    });
  });
});
afterAll(() => t?.close());
afterEach(() => t?.actAs(undefined));

const page = (body: unknown) => AuditEventPageDocument.parse(body);
const only = (body: unknown) => {
  const [first, ...rest] = ErrorDocument.parse(body).errors;
  expect(rest).toEqual([]);
  return first;
};

describe('GET /audit-events', () => {
  it('lists the log newest first, as JSON:API matching its schema', async () => {
    t.actAs(admin);
    const res = await t.get('/audit-events');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe(JSON_API);
    const doc = page(res.body);
    expect(doc.data.map((e) => e.attributes.action)).toEqual([
      'module.write',
      'module.write',
      'role.assign',
    ]);
    expect(doc.data[2]).toEqual({
      type: 'AuditEvent',
      id: expect.stringMatching(/^\d+$/),
      attributes: {
        at: expect.any(String),
        actor: { kind: 'user', id: 'sample-admin' },
        action: 'role.assign',
        subject: { type: 'user', id: 'sample-author' },
        comment: 'Writes the safety chapters.',
        data: { role: 'author' },
      },
    });
    expect(doc.meta.page).toEqual({
      currentPage: 1,
      lastPage: 1,
      perPage: 50,
      total: 3,
    });
  });

  it('pages', async () => {
    t.actAs(admin);
    const res = await t.get('/audit-events?page[number]=2&page[size]=2');
    const doc = page(res.body);
    expect(doc.data.map((e) => e.attributes.action)).toEqual(['role.assign']);
    expect(doc.meta.page).toMatchObject({ currentPage: 2, lastPage: 2 });
    expect(decodeURIComponent(doc.links.prev ?? '')).toBe(
      '/audit-events?page[number]=1&page[size]=2',
    );
    expect(doc.links.next).toBeNull();
  });

  it('filters by subject, actor and action', async () => {
    t.actAs(admin);
    const subjects = async (query: string) => {
      const res = await t.get(`/audit-events?${query}`);
      expect(res.status).toBe(200);
      return page(res.body).data.map(
        (e) => `${e.attributes.subject.type}/${e.attributes.subject.id}`,
      );
    };
    expect(await subjects('filter[subject]=module')).toEqual([
      'module/de/battery-charging',
      'module/en/battery-charging',
    ]);
    expect(
      await subjects(
        `filter[subject]=${encodeURIComponent('module/en/battery-charging')}`,
      ),
    ).toEqual(['module/en/battery-charging']);
    expect(await subjects('filter[actor]=service')).toEqual([
      'module/de/battery-charging',
    ]);
    expect(await subjects('filter[actor]=user/sample-admin')).toEqual([
      'user/sample-author',
    ]);
    expect(
      await subjects('filter[action]=module.write&filter[actor]=user'),
    ).toEqual(['module/en/battery-charging']);
    expect(await subjects('filter[action]=release.publish')).toEqual([]);
  });

  it('names a malformed filter', async () => {
    t.actAs(admin);
    for (const [query, parameter] of [
      ['filter[subject]=Module', 'filter[subject]'],
      ['filter[subject]=module/', 'filter[subject]'],
      ['filter[actor]=robot/x', 'filter[actor]'],
      ['filter[subject]=role/a%00', 'filter[subject]'],
      ['filter[actor]=user/a%00', 'filter[actor]'],
      ['filter[action]=edit', 'filter[action]'],
    ] as const) {
      const res = await t.get(`/audit-events?${query}`);
      expect(res.status).toBe(400);
      expect(only(res.body)).toMatchObject({
        code: 'invalid-parameter',
        source: { parameter },
      });
    }
    const unsupported = await t.get('/audit-events?filter[comment]=x');
    expect(unsupported.status).toBe(400);
  });

  it('needs admin.roles (403)', async () => {
    for (const actor of [author, importer]) {
      t.actAs(actor);
      const res = await t.get('/audit-events');
      expect(res.status).toBe(403);
      expect(only(res.body)).toMatchObject({
        status: '403',
        code: 'forbidden',
      });
    }
  });

  it('needs the token (401), and the token alone is no admin (403)', async () => {
    t.actAs(admin);
    const anonymous = await t.anonymous().get('/audit-events');
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers['www-authenticate']).toBe('Bearer');
    expect(only(anonymous.body)).toMatchObject({ code: 'unauthorized' });
    t.actAs(undefined);
    // Resolved as the app does: the token's read-only service.
    const service = await t.get('/audit-events');
    expect(service.status).toBe(403);
    expect(only(service.body)).toMatchObject({ code: 'forbidden' });
  });
});

/** The body as text, whatever its type (supertest leaves `application/jsonl` unparsed). */
const asText = (path: string) =>
  t
    .get(path)
    .buffer(true)
    .parse((res, done) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (text += chunk));
      res.on('end', () => done(null, text));
    });

/** The CSV's rows (after its header) as their first cell, the ID; no cell here spans lines. */
const csvIds = (text: string) =>
  text
    .split('\r\n')
    .slice(1, -1)
    .map((row) => row.split(',')[0]);

const listed = async (query: string) => {
  const res = await t.get(`/audit-events?page[size]=200&${query}`);
  expect(res.status).toBe(200);
  return page(res.body).data;
};
const listedIds = async (query: string) =>
  (await listed(query)).map((e) => e.id);

describe('GET /audit-events/export', () => {
  const queries = [
    '',
    'filter[subject]=module',
    `filter[subject]=${encodeURIComponent('module/en/battery-charging')}`,
    'filter[actor]=service',
    'filter[action]=module.write&filter[actor]=user',
    `filter[from]=${encodeURIComponent('2000-01-01T00:00:00Z')}&filter[to]=${encodeURIComponent('2999-01-01T00:00:00+01:00')}`,
    `filter[to]=${encodeURIComponent('2000-01-01T00:00:00Z')}`,
  ];

  it('downloads as CSV exactly what the list pages through, for the same filters', async () => {
    t.actAs(admin);
    for (const query of queries) {
      const res = await asText(`/audit-events/export?format=csv&${query}`);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe(
        'text/csv; charset=utf-8; header=present',
      );
      expect(res.headers['content-disposition']).toMatch(
        /^attachment; filename="audit-log-\d{8}T\d{6}Z\.csv"/,
      );
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['cache-control']).toBe('no-store');
      const text = res.body as string;
      expect(text.startsWith('id,at,actor kind,actor id,action,')).toBe(true);
      expect(csvIds(text)).toEqual(await listedIds(query));
    }
  });

  it('downloads as JSON Lines exactly what the list pages through, member for member', async () => {
    t.actAs(admin);
    for (const query of queries) {
      const res = await asText(`/audit-events/export?format=jsonl&${query}`);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe(
        'application/jsonl; charset=utf-8',
      );
      const lines = (res.body as string)
        .split('\n')
        .filter((l) => l !== '')
        .map((l) => JSON.parse(l) as unknown);
      expect(lines).toEqual(
        (await listed(query)).map((e) => ({ id: e.id, ...e.attributes })),
      );
    }
  });

  it('records each export, by whom, with the format and the filters', async () => {
    t.actAs(admin);
    await asText(
      '/audit-events/export?format=jsonl&filter[subject]=role&filter[actor]=user/sample-admin',
    );
    const [latest] = await listed('filter[action]=audit-log.export');
    expect(latest?.attributes).toMatchObject({
      actor: { kind: 'user', id: 'sample-admin' },
      action: 'audit-log.export',
      subject: { type: 'audit-log', id: 'audit-events' },
      data: {
        format: 'jsonl',
        filter: { subject: 'role', actor: 'user/sample-admin' },
      },
    });
  });

  it('quotes values a spreadsheet would run as formulas', async () => {
    t.actAs(admin);
    await t.app.get(UnitOfWork).run((tx) =>
      t.app.get(AuditLog).record(tx, admin, {
        action: 'role.assign',
        subject: { type: 'user', id: '=cmd' },
        comment: '@SUM(1)',
      }),
    );
    const res = await asText(
      `/audit-events/export?format=csv&filter[subject]=${encodeURIComponent('user/=cmd')}`,
    );
    const [row] = (res.body as string).split('\r\n').slice(1, 2);
    expect(row).toContain(",'=cmd,'@SUM(1),");
  });

  it('refuses a missing or unknown format, a malformed filter and any other parameter (400)', async () => {
    t.actAs(admin);
    for (const [query, code, parameter] of [
      ['', 'invalid-parameter', 'format'],
      ['format=xml', 'invalid-parameter', 'format'],
      [
        'format=csv&filter[from]=yesterday',
        'invalid-parameter',
        'filter[from]',
      ],
      ['format=csv&filter[to]=2026-01-01', 'invalid-parameter', 'filter[to]'],
      [
        'format=csv&filter[from]=0000-01-01T00:00:00Z',
        'invalid-parameter',
        'filter[from]',
      ],
      [
        'format=csv&filter[to]=2026-01-01T00:00:00.0005Z',
        'invalid-parameter',
        'filter[to]',
      ],
      ['format=csv&filter[actor]=robot', 'invalid-parameter', 'filter[actor]'],
      ['format=csv&page[size]=2', 'unsupported-parameter', 'page[size]'],
    ] as const) {
      const res = await t.get(`/audit-events/export?${query}`);
      expect(res.status).toBe(400);
      expect(only(res.body)).toMatchObject({ code, source: { parameter } });
    }
  });

  it('needs admin.roles (403), and records nothing then', async () => {
    t.actAs(admin);
    const before = await listedIds('filter[action]=audit-log.export');
    for (const actor of [author, importer]) {
      t.actAs(actor);
      const res = await t.get('/audit-events/export?format=csv');
      expect(res.status).toBe(403);
      expect(only(res.body)).toMatchObject({ code: 'forbidden' });
    }
    expect(
      (await t.anonymous().get('/audit-events/export?format=csv')).status,
    ).toBe(401);
    t.actAs(admin);
    expect(await listedIds('filter[action]=audit-log.export')).toEqual(before);
  });

  it('answers a failure of the first read as a JSON:API error, the export still recorded', async () => {
    t.actAs(admin);
    const log = t.app.get(AuditLog);
    const before = await listedIds('filter[action]=audit-log.export');
    const spy = vi.spyOn(log, 'stream').mockImplementation(async function* () {
      yield* [];
      throw new Error('the database is gone');
    });
    try {
      const res = await t.get('/audit-events/export?format=csv');
      expect(res.status).toBe(500);
      expect(res.headers['content-type']).toBe(JSON_API);
      expect(res.headers['content-disposition']).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
    expect((await listedIds('filter[action]=audit-log.export')).length).toBe(
      before.length + 1,
    );
  });

  it('cuts the connection when a later read fails, so the file never looks complete', async () => {
    t.actAs(admin);
    const log = t.app.get(AuditLog);
    const [one] = await listed('');
    const spy = vi.spyOn(log, 'stream').mockImplementation(async function* () {
      yield {
        id: one!.id,
        at: new Date(one!.attributes.at),
        actor: one!.attributes.actor,
        action: one!.attributes.action,
        subject: one!.attributes.subject,
        comment: one!.attributes.comment,
        data: one!.attributes.data,
      };
      await new Promise((r) => setTimeout(r, 50));
      throw new Error('the database is gone');
    });
    try {
      await expect(
        asText('/audit-events/export?format=jsonl'),
      ).rejects.toThrow();
    } finally {
      spy.mockRestore();
    }
  });

  it('refuses HEAD (405), which would record an export nobody received', async () => {
    t.actAs(admin);
    const before = await listedIds('filter[action]=audit-log.export');
    const head = await t
      .anonymous()
      .head('/audit-events/export?format=csv')
      .set('Authorization', `Bearer ${TOKEN}`);
    expect(head.status).toBe(405);
    expect(await listedIds('filter[action]=audit-log.export')).toEqual(before);
  });

  it('takes the date range on the list too, and names a malformed one', async () => {
    t.actAs(admin);
    expect(
      await listedIds(
        `filter[to]=${encodeURIComponent('2000-01-01T00:00:00Z')}`,
      ),
    ).toEqual([]);
    const res = await t.get('/audit-events?filter[from]=soon');
    expect(res.status).toBe(400);
    expect(only(res.body)).toMatchObject({
      code: 'invalid-parameter',
      source: { parameter: 'filter[from]' },
    });
  });
});
