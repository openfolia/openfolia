import {
  ErrorDocument,
  JSON_API,
  REQUEST_HEADER,
} from '../src/base/api/json-api.js';
import { actorWith } from './fakes/actors.js';
import { fill, fillValid, routesOf } from './routes.js';
import { createTestApp, TOKEN, type TestApp } from './test-app.js';

/**
 * Cross-site request forgery (`CrossSiteRequestGuard`): a state-changing
 * request must carry what a cross-site HTML form cannot send, on every route.
 */
let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t?.close());
afterEach(() => t?.actAs(undefined));

const error = (body: unknown) => ErrorDocument.parse(body).errors[0];
const codeOf = (body: unknown) =>
  ErrorDocument.safeParse(body).data?.errors[0]?.code ?? '';
const GUARD_CODES = [
  'content-type-required',
  'unsupported-media-type',
  'request-header-required',
];

/** The routes that may change state: every method but GET (Express adds HEAD to GET). */
const stateChanging = () =>
  routesOf(t.app)
    .filter((route) => !route.startsWith('GET '))
    .map((route) => {
      const [method = '', path = ''] = route.split(' ');
      return { route, method: method.toLowerCase() as 'post', path };
    });

/** What the sending route takes besides JSON:API (`@AcceptsBodyOf`). */
const MULTIPART_ROUTES = [
  'POST /branding/images',
  'POST /change-sets/:changeSetId/assets',
  'POST /imports',
  'POST /translations/imports',
];

const call = (method: 'post', path: string) =>
  t
    .anonymous()
    [method](path)
    .set('Authorization', `Bearer ${TOKEN}`)
    .set('Accept', '*/*');

describe('every state-changing route', () => {
  it('is covered: POST, PUT, PATCH and DELETE routes exist', () => {
    const methods = new Set(
      stateChanging().map(({ route }) => route.split(' ')[0]),
    );
    expect(methods).toEqual(new Set(['POST', 'PUT', 'PATCH', 'DELETE']));
    expect(stateChanging().length).toBeGreaterThan(10);
  });

  it('refuses a body-less request without a Content-Type: 415 content-type-required', async () => {
    t.actAs(actorWith(['content.edit', 'content.read.draft']));
    for (const { route, method, path } of stateChanging()) {
      const res = await call(method, fillValid(path));
      expect([route, res.status]).toEqual([route, 415]);
      expect([route, error(res.body)?.code]).toEqual([
        route,
        'content-type-required',
      ]);
    }
  });

  it('refuses what a cross-site form sends: 415, or 403 without X-Ccms-Request on an upload', async () => {
    t.actAs(actorWith(['content.edit', 'content.read.draft']));
    const forms = [
      ['text/plain', 'a=b'],
      ['application/x-www-form-urlencoded', 'a=b'],
      ['multipart/form-data; boundary=x', '--x--\r\n'],
    ] as const;
    for (const { route, method, path } of stateChanging()) {
      for (const [type, body] of forms) {
        // Without the token: only a guard that runs before it answers 415
        // or 403 (JsonApiInterceptor, which also refuses such bodies, runs
        // after the token check, which would answer 401).
        const res = await t
          .anonymous()
          [method](fillValid(path))
          .set('Accept', '*/*')
          .set('Content-Type', type)
          .send(body);
        const expected =
          MULTIPART_ROUTES.includes(route) && type.startsWith('multipart/')
            ? [403, 'request-header-required']
            : [415, 'unsupported-media-type'];
        expect([route, type, res.status, error(res.body)?.code]).toEqual([
          route,
          type,
          ...expected,
        ]);
      }
    }
  });

  it('takes the media type in any case, but no extension', async () => {
    t.actAs(actorWith(['content.edit', 'content.read.draft']));
    const path = fillValid('/change-sets/:changeSetId/abandon');
    const mixed = await call('post', path).set(
      'Content-Type',
      'Application/Vnd.Api+Json',
    );
    expect(GUARD_CODES.includes(codeOf(mixed.body))).toBe(false);
    const extension = await call('post', path).set(
      'Content-Type',
      `${JSON_API}; ext="https://example.com/ext"`,
    );
    expect(extension.status).toBe(415);
    expect(error(extension.body)?.code).toBe('unsupported-media-type');
  });

  it('refuses an empty X-Ccms-Request on an upload', async () => {
    const res = await call(
      'post',
      fillValid(MULTIPART_ROUTES[0]!.split(' ')[1]!),
    )
      .set(REQUEST_HEADER, ' ')
      .set('Content-Type', 'multipart/form-data; boundary=x')
      .send('--x--\r\n');
    expect(res.status).toBe(403);
    expect(error(res.body)?.code).toBe('request-header-required');
  });

  it('refuses it before the token is checked, and whatever the token says', async () => {
    for (const { route, method, path } of stateChanging()) {
      const res = await t.anonymous()[method](fill(path)).set('Accept', '*/*');
      expect([route, res.status]).toEqual([route, 415]);
    }
  });

  it('lets a body-less request through with the JSON:API media type', async () => {
    t.actAs(actorWith(['content.edit', 'content.read.draft']));
    for (const { route, method, path } of stateChanging()) {
      const res = await call(method, fillValid(path)).set(
        'Content-Type',
        JSON_API,
      );
      // Past the guard: the route answers (a missing change set, a body it
      // needs, a permission), never with one of the guard's refusals.
      expect([route, GUARD_CODES.includes(codeOf(res.body))]).toEqual([
        route,
        false,
      ]);
    }
  });

  it('lets a multipart upload through with X-Ccms-Request', async () => {
    t.actAs(actorWith(['content.edit', 'content.read.draft']));
    for (const route of MULTIPART_ROUTES) {
      const [method = '', path = ''] = route.split(' ');
      const res = await call(method.toLowerCase() as 'post', fillValid(path))
        .set(REQUEST_HEADER, '1')
        .set('Content-Type', 'multipart/form-data; boundary=x')
        .send('--x--\r\n');
      // A malformed form for a missing change set: past the guard.
      expect([route, GUARD_CODES.includes(codeOf(res.body))]).toEqual([
        route,
        false,
      ]);
    }
  });
});
