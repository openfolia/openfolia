import { createServer, type AddressInfo } from 'node:net';
import {
  ActorDocument,
  UserDocument,
} from '../src/access/api/access.resources.js';
import {
  SESSION_COOKIE,
  SIGN_IN_COOKIE,
} from '../src/access/api/session-cookies.js';
import { SESSION_TOKEN_PREFIX } from '../src/access/core/sessions.js';
import {
  GroupMappingDocument,
  GroupMappingPageDocument,
  IdentityProviderPageDocument,
  SignedOutDocument,
} from '../src/access/api/sign-in.resources.js';
import { Seed, seedAccess } from '../src/access/repos/seed.js';
import { AuditEventPageDocument } from '../src/audit/api/audit-event.resources.js';
import { ErrorDocument, JSON_API } from '../src/base/api/json-api.js';
import { startMockProvider, type MockProvider } from './oidc/mock-provider.js';
import { signInThroughMock } from './oidc/sign-in-driver.js';
import { createTestApp, TOKEN, type TestApp } from './test-app.js';

/**
 * Sign-in with OpenID Connect (#37), end to end: the real app on a port, a
 * real (local) provider, and the browser's redirects followed by a driver.
 */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

let t: TestApp;
let mock: MockProvider;
let base: string;

beforeAll(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  mock = await startMockProvider({
    clientId: 'openfolia-test',
    clientSecret: 'test-client-secret-0123456789',
    redirectUris: [`${base}/auth/oidc/callback`],
    postLogoutRedirectUris: [`${base}/sign-in`],
    accounts: {
      pat: {
        name: 'Pat Example',
        email: 'pat@example.org',
        groups: ['writers'],
      },
      root: { name: 'Root', email: 'root@example.org', groups: ['admins'] },
      lee: { name: 'Lee', email: 'lee@example.org', emailVerified: false },
    },
  });
  t = await createTestApp({
    CCMS_OIDC_ISSUER: mock.issuer,
    CCMS_OIDC_CLIENT_ID: 'openfolia-test',
    CCMS_OIDC_CLIENT_SECRET: 'test-client-secret-0123456789',
    CCMS_OIDC_REDIRECT_URL: `${base}/auth/oidc/callback`,
    CCMS_OIDC_NAME: 'Test provider',
  });
  await seedAccess(
    t.database,
    Seed.parse({
      roles: [
        {
          id: 'admin',
          name: 'Admin',
          permissions: ['admin.roles', 'content.read'],
          scope: {},
        },
        {
          id: 'author',
          name: 'Author',
          permissions: ['content.read', 'content.edit'],
          scope: {},
        },
      ],
      users: [
        // The first admin: linked at their first sign-in by the verified address.
        {
          id: 'first-admin',
          name: 'First admin',
          email: 'root@example.org',
          roles: ['admin'],
        },
        // An address the provider does not vouch for: never linked.
        {
          id: 'lee-direct',
          name: 'Lee',
          email: 'lee@example.org',
          roles: ['admin'],
        },
      ],
      groupMappings: [{ group: 'writers', role: 'author' }],
    }),
  );
  await t.app.listen(port, '127.0.0.1');
});
afterAll(async () => {
  await t?.close();
  await mock?.close();
});

const error = (body: unknown) => ErrorDocument.parse(body).errors[0];

async function signIn(login: string, returnTo = '/manuals?x=1') {
  const result = await signInThroughMock({
    signInUrl: `${base}/auth/oidc/sign-in?returnTo=${encodeURIComponent(returnTo)}`,
    login,
  });
  return { ...result, cookie: result.cookieHeader(base) };
}

const me = (cookie: string) => t.anonymous().get('/me').set('Cookie', cookie);

describe('sign-in with OpenID Connect', () => {
  it('lists the provider, to anyone', async () => {
    const res = await t.anonymous().get('/auth/providers').expect(200);
    expect(IdentityProviderPageDocument.parse(res.body).data).toEqual([
      {
        type: 'IdentityProvider',
        id: 'oidc',
        attributes: { name: 'Test provider' },
        links: { signIn: 'auth/oidc/sign-in' },
      },
    ]);
  });

  it('signs a new person in: a user of their own, roles from their groups', async () => {
    const { finalUrl, cookie } = await signIn('pat');
    expect(finalUrl).toBe(`${base}/manuals?x=1`);
    expect(cookie).toMatch(
      new RegExp(`${SESSION_COOKIE}=${SESSION_TOKEN_PREFIX}[0-9a-f]{64}`),
    );
    const res = await me(cookie).expect(200);
    const actor = ActorDocument.parse(res.body).data;
    expect(actor).toMatchObject({
      id: 'pat',
      attributes: {
        kind: 'user',
        name: 'Pat Example',
        roles: [{ id: 'author' }],
      },
      meta: { session: { provider: 'oidc' } },
    });
    const { cookie: rootCookie } = await signIn('root');
    const user = UserDocument.parse(
      (
        await t
          .anonymous()
          .get('/users/pat')
          .set('Cookie', rootCookie)
          .expect(200)
      ).body,
    ).data;
    expect(user.meta.groupRoleIds).toEqual(['author']);
  });

  it('sets the session cookie as only the browser may hold it', async () => {
    const start = await t.anonymous().get('/auth/oidc/sign-in').expect(303);
    expect(start.headers['location']).toMatch(
      new RegExp(`^${mock.issuer}/auth\\?`),
    );
    const location = new URL(start.headers['location'] as string);
    expect(location.searchParams.get('code_challenge_method')).toBe('S256');
    expect(location.searchParams.get('state')).toBeTruthy();
    expect(location.searchParams.get('nonce')).toBeTruthy();
    const cookies = start.headers['set-cookie'] as unknown as string[];
    expect(cookies[0]).toMatch(
      new RegExp(
        `^${SIGN_IN_COOKIE}=[^;]+; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=600$`,
      ),
    );
    expect(start.headers['cache-control']).toBe('no-store');
  });

  it('links the first admin by their verified email address', async () => {
    const { cookie } = await signIn('root');
    const actor = ActorDocument.parse((await me(cookie).expect(200)).body).data;
    expect(actor.id).toBe('first-admin');
    expect(actor.attributes.roles.map((r) => r.id)).toEqual(['admin']);
  });

  it('never links by an address the provider does not vouch for', async () => {
    const { cookie } = await signIn('lee');
    const actor = ActorDocument.parse((await me(cookie).expect(200)).body).data;
    expect(actor.id).toBe('lee');
    expect(actor.attributes.roles).toEqual([]);
  });

  it('applies a role change from the next request', async () => {
    const { cookie } = await signIn('pat');
    const { cookie: rootCookie } = await signIn('root');
    const mapped = await t
      .anonymous()
      .post('/group-mappings')
      .set('Cookie', rootCookie)
      .set('Content-Type', JSON_API)
      .set('Origin', base)
      .send({
        data: {
          type: 'GroupMapping',
          attributes: { group: 'writers' },
          relationships: { role: { data: { type: 'Role', id: 'admin' } } },
        },
      })
      .expect(201);
    const mapping = GroupMappingDocument.parse(mapped.body).data;
    let actor = ActorDocument.parse((await me(cookie).expect(200)).body).data;
    expect(actor.attributes.roles.map((r) => r.id)).toEqual([
      'admin',
      'author',
    ]);

    const listed = await t
      .anonymous()
      .get('/group-mappings?filter[group]=writers')
      .set('Cookie', rootCookie)
      .expect(200);
    expect(
      GroupMappingPageDocument.parse(listed.body).data.map(
        (m) => m.relationships.role.data.id,
      ),
    ).toEqual(['admin', 'author']);

    await t
      .anonymous()
      .delete(`/group-mappings/${mapping.id}`)
      .set('Cookie', rootCookie)
      .set('Content-Type', JSON_API)
      .set('Origin', base)
      .expect(204);
    actor = ActorDocument.parse((await me(cookie).expect(200)).body).data;
    expect(actor.attributes.roles.map((r) => r.id)).toEqual(['author']);
  });

  it('refuses a change from another origin with a session', async () => {
    const { cookie } = await signIn('root');
    const res = await t
      .anonymous()
      .delete('/group-mappings/00000000-0000-4000-8000-000000000000')
      .set('Cookie', cookie)
      .set('Content-Type', JSON_API)
      .set('Origin', 'https://attacker.example')
      .expect(403);
    expect(error(res.body)?.code).toBe('cross-origin-request');
  });

  it('refuses X-Ccms-User with a session, and ignores a token beside it', async () => {
    const { cookie } = await signIn('pat');
    const refused = await me(cookie)
      .set('X-Ccms-User', 'first-admin')
      .expect(400);
    expect(error(refused.body)?.code).toBe('user-header-not-accepted');
    const both = await me(cookie)
      .set('Authorization', `Bearer ${TOKEN}`)
      .expect(200);
    expect(ActorDocument.parse(both.body).data.id).toBe('pat');
  });

  it('signs out: the session ends, here and at the provider', async () => {
    const { cookie } = await signIn('pat');
    const res = await t
      .anonymous()
      .post('/auth/sign-out')
      .set('Cookie', cookie)
      .set('Content-Type', JSON_API)
      .expect(200);
    const url = SignedOutDocument.parse(res.body).meta.signOutUrl;
    expect(url).toMatch(new RegExp(`^${mock.issuer}/session/end\\?`));
    expect(new URL(url!).searchParams.get('post_logout_redirect_uri')).toBe(
      `${base}/sign-in`,
    );
    expect(res.headers['set-cookie']).toEqual([
      `${SESSION_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`,
    ]);
    const after = await me(cookie).expect(401);
    expect(error(after.body)?.code).toBe('unauthorized');
    const { cookie: rootCookie } = await signIn('root');
    const audit = await t
      .anonymous()
      .get('/audit-events?filter[action]=user.sign-out')
      .set('Cookie', rootCookie)
      .expect(200);
    expect(
      AuditEventPageDocument.parse(audit.body).data.some(
        (e) => e.attributes.subject.id === 'pat',
      ),
    ).toBe(true);
  });

  it('refuses a deactivated user at sign-in, and their sessions at once', async () => {
    const { cookie } = await signIn('lee');
    const { cookie: rootCookie } = await signIn('root');
    await t
      .anonymous()
      .post('/users/lee/deactivate')
      .set('Cookie', rootCookie)
      .set('Content-Type', JSON_API)
      .set('Origin', base)
      .expect(200);
    const refused = await me(cookie).expect(401);
    expect(error(refused.body)?.code).toBe('unauthorized');
    const again = await signIn('lee');
    expect(again.finalUrl).toBe(`${base}/sign-in?error=user-deactivated`);
    expect(again.cookie).not.toContain(SESSION_COOKIE);
  });

  it('refuses a callback without the sign-in it answers', async () => {
    const res = await t
      .anonymous()
      .get('/auth/oidc/callback?code=abc&state=forged')
      .expect(303);
    expect(res.headers['location']).toBe(
      `${base}/sign-in?error=sign-in-expired`,
    );
    expect(res.headers['referrer-policy']).toBe('no-referrer');
  });

  it('refuses a callback whose state is not the sign-in’s', async () => {
    const start = await t.anonymous().get('/auth/oidc/sign-in').expect(303);
    const cookie = (
      start.headers['set-cookie'] as unknown as string[]
    )[0]!.split(';')[0]!;
    const res = await t
      .anonymous()
      .get('/auth/oidc/callback?code=abc&state=forged')
      .set('Cookie', cookie)
      .expect(303);
    expect(res.headers['location']).toBe(
      `${base}/sign-in?error=sign-in-failed`,
    );
  });

  it('never sends the browser away from the editor', async () => {
    const { finalUrl } = await signIn('pat', '//attacker.example/x');
    expect(finalUrl).toBe(`${base}/`);
    const second = await signIn('pat', '/https://attacker.example/');
    expect(new URL(second.finalUrl).origin).toBe(base);
  });

  it('opens a signed-in address with a valid session, as its person', async () => {
    // The default access, `signed-in`: 401 for anyone, the editor's QR codes with a session.
    const path = '/d/north/operating/model=large/en/qr.svg';
    const anonymous = await t.anonymous().get(path).expect(401);
    expect(error(anonymous.body)?.code).toBeDefined();
    const { cookie } = await signIn('root');
    const signedIn = await t.anonymous().get(path).set('Cookie', cookie);
    const token = await t
      .anonymous()
      .get(path)
      .set('Authorization', `Bearer ${TOKEN}`);
    // Past the sign-in check: nothing released in this app yet, so the reader's 404.
    expect(signedIn.status).toBe(404);
    expect(error(signedIn.body)?.code).toBe('not-found');
    expect(token.status).toBe(404);
    expect(signedIn.headers['vary']).toMatch(/Cookie/);
  });

  it('ignores a session that cannot act on the stable addresses: it reads as anyone', async () => {
    const path = '/d/north/nope/x/en/pdf';
    const anonymous = await t.anonymous().get(path);
    const ended = await t
      .anonymous()
      .get(path)
      .set(
        'Cookie',
        `${SESSION_COOKIE}=${SESSION_TOKEN_PREFIX}${'0'.repeat(64)}`,
      );
    expect(ended.status).toBe(anonymous.status);
    expect(ended.body).toEqual(anonymous.body);
  });

  it('says 404 for a provider that is not offered', async () => {
    await t.anonymous().get('/auth/saml/sign-in').expect(404);
  });
});
