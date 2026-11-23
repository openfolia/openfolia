import { ActorDocument } from '../src/access/api/access.resources.js';
import { ErrorDocument, JSON_API } from '../src/base/api/json-api.js';
import { PERMISSION_EXTENSION } from '../src/access/api/api-permission.decorator.js';
import { seedAccess } from '../src/access/repos/seed.js';
import { actorWith, NOBODY } from './fakes/actors.js';
import {
  ANY_ACTOR_ROUTES,
  ACTION_ANSWERS,
  DEMO_ONLY_ROUTES,
  fill,
  fillValid,
  ON_TOP_OF_DRAFT_READING,
  ON_TOP_OF_EDITING,
  ON_TOP_OF_READING,
  openApiPath,
  PUBLIC_ROUTES,
  routesOf,
  send,
} from './routes.js';
import { createTestApp, TOKEN, type TestApp } from './test-app.js';

/**
 * Token mode (the default). Demo mode, which needs other settings, is in
 * `demo.e2e.spec.ts`.
 */
let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t?.close());

const error = (body: unknown) => ErrorDocument.parse(body).errors[0];

describe('every route', () => {
  it('is public or needs the token and resolves an actor', async () => {
    const routes = routesOf(t.app);
    expect(routes).toEqual(expect.arrayContaining(PUBLIC_ROUTES));
    expect(routes).toEqual(expect.arrayContaining(ON_TOP_OF_READING));
    const guarded = routes.filter((r) => !PUBLIC_ROUTES.includes(r));
    expect(guarded.length).toBeGreaterThan(5);
    for (const route of guarded) {
      const [method = '', path = ''] = route.split(' ');
      // State-changing requests say JSON:API, or the cross-site guard
      // refuses them first (cross-site.e2e.spec.ts).
      const call = () => {
        const req = t
          .anonymous()
          [method.toLowerCase() as 'get'](fill(path))
          .set('Accept', '*/*');
        return method === 'GET' ? req : req.set('Content-Type', JSON_API);
      };
      const anonymous = await call();
      expect([route, anonymous.status]).toEqual([route, 401]);
      // Past the token, the actor is resolved: here refused, since the
      // header is not accepted outside demo mode.
      const withHeader = await call()
        .set('Authorization', `Bearer ${TOKEN}`)
        .set('X-Ccms-User', 'sample-admin');
      expect([route, withHeader.status]).toEqual([route, 400]);
      expect(error(withHeader.body)?.code).toBe('demo-mode-off');
    }
    for (const route of PUBLIC_ROUTES) {
      const res = await t.anonymous().get(route.split(' ')[1] ?? '');
      expect([route, res.status]).not.toEqual([route, 401]);
    }
  });
});

describe('every guarded route', () => {
  afterEach(() => t?.actAs(undefined));

  const guarded = () =>
    routesOf(t.app)
      .filter((r) => !PUBLIC_ROUTES.includes(r))
      .map((route) => {
        const [method = '', path = ''] = route.split(' ');
        return { route, method: method.toLowerCase() as 'get', path };
      });
  const call = (route: string, path: string) =>
    send(t.anonymous(), route, fill(path))
      .set('Accept', '*/*')
      .set('Authorization', `Bearer ${TOKEN}`);

  // Both below send a request per route: slow on a loaded machine.
  it('refuses an actor without a permission, unless open to any actor', async () => {
    t.actAs(NOBODY);
    for (const { route, path } of guarded()) {
      const res = await call(route, path);
      if (ANY_ACTOR_ROUTES.includes(route)) {
        // Answered: lists with 200; one by a placeholder ID is not found,
        // and a demo-only route is, outside demo mode.
        const expected =
          route.includes('/:') || DEMO_ONLY_ROUTES.includes(route) ? 404 : 200;
        expect([
          route,
          [expected, ...(ACTION_ANSWERS[route] ?? [])].includes(res.status),
        ]).toEqual([route, true]);
        continue;
      }
      expect([route, res.status]).toEqual([route, 403]);
      expect([route, error(res.body)?.code]).toEqual([route, 'forbidden']);
    }
  });

  it('documents the permission it needs, and lets its holder through', async () => {
    // Access changes check their actor in the database again (#39): the
    // admin.roles holder below exists there.
    const holder = actorWith(['admin.roles']);
    await seedAccess(t.database, {
      roles: [
        {
          id: 'route-walk-admin',
          name: 'Route walk admin',
          permissions: ['admin.roles'],
          scope: {},
        },
      ],
      users: [{ id: holder.id, name: 'Holder', roles: ['route-walk-admin'] }],
    });
    const doc = (await t.anonymous().get('/openapi.json')).body as {
      paths: Record<
        string,
        Record<string, Record<string, unknown> & { responses: object }>
      >;
    };
    for (const { route, method, path } of guarded()) {
      const operation = doc.paths[openApiPath(path)]?.[method];
      const permission = operation?.[PERMISSION_EXTENSION];
      if (ANY_ACTOR_ROUTES.includes(route)) {
        expect([route, permission]).toEqual([route, undefined]);
        continue;
      }
      expect([route, typeof permission]).toEqual([route, 'string']);
      expect([route, Object.keys(operation?.responses ?? {})]).toEqual([
        route,
        expect.arrayContaining(['403']),
      ]);
      // Only that permission (everywhere), with parameters that pass
      // validation: the action runs (found, or not found by it).
      if (ON_TOP_OF_READING.includes(route)) {
        // Reading alone is not enough: the documented permission is needed too.
        t.actAs(actorWith(['content.read']));
        const reader = await send(t.anonymous(), route, fillValid(path))
          .set('Authorization', `Bearer ${TOKEN}`)
          .set('Accept', '*/*');
        expect([route, reader.status, error(reader.body)?.code]).toEqual([
          route,
          403,
          'forbidden',
        ]);
      }
      t.actAs(
        actorWith([
          permission as never,
          ...(ON_TOP_OF_READING.includes(route)
            ? ['content.read' as const]
            : []),
          ...(ON_TOP_OF_DRAFT_READING.includes(route)
            ? ['content.read.draft' as const]
            : []),
          ...(ON_TOP_OF_EDITING.includes(route)
            ? ['content.edit' as const, 'content.read' as const]
            : []),
        ]),
      );
      const res = await send(t.anonymous(), route, fillValid(path))
        .set('Authorization', `Bearer ${TOKEN}`)
        .set('Accept', '*/*');
      expect([
        route,
        permission,
        [200, 201, 404, ...(ACTION_ANSWERS[route] ?? [])].includes(res.status),
      ]).toEqual([route, permission, true]);
    }
  });
});

describe('content reads', () => {
  afterEach(() => t?.actAs(undefined));

  it('checks the permission a route needs before answering 304 (#365)', async () => {
    // The commit ETag names no route: a reader's ETag from one route
    // matches on every other route at that commit. A route needing more
    // than reading still refuses a reader with it.
    const reader = actorWith(['content.read']);
    t.actAs(reader);
    // (`GET /manuals` is answer-hashed since #410: a manual's own route is not.)
    const etag = (await t.get('/manuals/operating')).headers['etag'] as string;
    expect(etag).toBeTruthy();
    // The ETag does match: a route needing only reading answers 304.
    expect((await t.get('/config').set('If-None-Match', etag)).status).toBe(
      304,
    );
    const doc = (await t.anonymous().get('/openapi.json')).body as {
      paths: Record<string, Record<string, Record<string, unknown>>>;
    };
    const routes = routesOf(t.app).filter(
      (r) =>
        r.startsWith('GET ') &&
        !PUBLIC_ROUTES.includes(r) &&
        !ANY_ACTOR_ROUTES.includes(r),
    );
    let checked = 0;
    for (const route of routes) {
      const path = route.slice('GET '.length);
      const permission =
        doc.paths[openApiPath(path)]?.['get']?.[PERMISSION_EXTENSION];
      if (permission === 'content.read') continue;
      checked++;
      const res = await t
        .get(fillValid(path))
        .set('Accept', '*/*')
        .set('If-None-Match', etag);
      expect([route, res.status, error(res.body)?.code]).toEqual([
        route,
        403,
        'forbidden',
      ]);
    }
    expect(checked).toBeGreaterThan(5);
  });

  it('refuses an actor who may not read before opening the ref', async () => {
    t.actAs(NOBODY);
    for (const path of ['/modules?ref=no-such-ref', '/config?ref=main']) {
      const res = await t.get(path);
      expect([path, res.status]).toEqual([path, 403]);
      expect(res.headers['x-ccms-commit']).toBeUndefined();
    }
  });

  it('does not find a module outside the reader’s scope', async () => {
    t.actAs(actorWith(['content.read'], { languages: ['de'] }));
    const outside = await t.get('/modules/en/charging');
    expect(outside.status).toBe(404);
    expect(error(outside.body)?.code).toBe('not-found');
    const missing = await t.get('/modules/en/nope');
    expect(error(missing.body)?.detail).toBe('No module "nope" in "en".');
    expect(error(outside.body)?.detail).toBe(
      error(missing.body)?.detail?.replace('nope', 'charging'),
    );
    t.actAs(actorWith(['content.read'], { languages: ['en'] }));
    expect((await t.get('/modules/en/charging')).status).toBe(200);
  });

  it('reports a broken module only to a reader of everything in its language', async () => {
    // On a draft branch: these readers also hold content.read.draft.
    const drafts = ['content.read', 'content.read.draft'] as const;
    t.actAs(actorWith([...drafts], { maxAudience: 'public' }));
    const scoped = await t.get('/modules/en/broken?ref=draft');
    const missing = await t.get('/modules/en/nope?ref=draft');
    expect(scoped.status).toBe(404);
    expect(error(scoped.body)).toEqual({
      ...error(missing.body),
      detail: 'No module "broken" in "en".',
    });
    t.actAs(actorWith([...drafts], { languages: ['en'] }));
    const reader = await t.get('/modules/en/broken?ref=draft');
    expect(reader.status).toBe(422);
    expect(error(reader.body)?.meta).toEqual({
      path: 'modules/en/broken.adoc',
    });
  });
});

describe('without demo mode', () => {
  it('acts as the read-only token service', async () => {
    const res = await t.get('/me');
    expect(res.status).toBe(200);
    expect(ActorDocument.parse(res.body)).toEqual({
      data: {
        type: 'Actor',
        id: 'service:api-token',
        attributes: {
          kind: 'service',
          name: 'API token',
          roles: [
            {
              id: 'api-token-reader',
              name: 'API token (read-only)',
              permissions: ['content.read', 'content.read.draft'],
              scope: {},
            },
          ],
        },
        meta: {
          permissions: [
            { permission: 'content.read', scopes: [{}] },
            { permission: 'content.read.draft', scopes: [{}] },
          ],
        },
      },
    });
  });

  it('ignores X-Ccms-User for authentication: no token is 401', async () => {
    const res = await t
      .anonymous()
      .get('/me')
      .set('X-Ccms-User', 'sample-admin');
    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toBe('Bearer');
    expect(error(res.body)?.code).toBe('unauthorized');
  });

  it('refuses X-Ccms-User with the token, rather than ignoring it', async () => {
    const res = await t.get('/config').set('X-Ccms-User', 'sample-admin');
    expect(res.status).toBe(400);
    expect(error(res.body)).toMatchObject({
      code: 'demo-mode-off',
      source: { header: 'X-Ccms-User' },
    });
  });

  it('does not let the token service list users', async () => {
    const res = await t.get('/users');
    expect(res.status).toBe(403);
    expect(error(res.body)?.code).toBe('forbidden');
  });
  it('has no demo user list outside demo mode: 404, as a client reads "demo mode is off"', async () => {
    const res = await t.get('/demo/users');
    expect(res.status).toBe(404);
    expect(error(res.body)?.code).toBe('not-found');
  });
});
