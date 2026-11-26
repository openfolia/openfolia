import { inflateRawSync } from 'node:zlib';
import { ActorDocument } from '../src/access/api/access.resources.js';
import { SESSION_COOKIE } from '../src/access/api/session-cookies.js';
import { JSON_API } from '../src/base/api/json-api.js';
import { startMockProvider, type MockProvider } from './oidc/mock-provider.js';
import { signInThroughMock } from './oidc/sign-in-driver.js';
import {
  cookiePair,
  type SamlSetup,
  setCookies,
  setUpSaml,
} from './saml/setup.js';
import { usersAndIdentities } from './stored-sign-ins.js';

/**
 * OpenID Connect and SAML on at once, end to end: a person known through one provider who signs
 * in through the other comes with an identity unknown here, and only the address both vouch for.
 */
describe('sign-in with OpenID Connect and SAML both on', () => {
  let s: SamlSetup;
  let oidc: MockProvider;
  beforeAll(async () => {
    s = await setUpSaml(async (base) => {
      oidc = await startMockProvider({
        clientId: 'openfolia-test',
        clientSecret: 'test-client-secret-0123456789',
        redirectUris: [`${base}/auth/oidc/callback`],
        postLogoutRedirectUris: [`${base}/sign-in`],
        accounts: {
          root: { name: 'Root', email: 'root@example.org' },
          rae: { name: 'Rae', email: 'rae@example.org' },
        },
      });
      return {
        CCMS_SAML_EMAIL_VERIFIED: 'true',
        CCMS_OIDC_ISSUER: oidc.issuer,
        CCMS_OIDC_CLIENT_ID: 'openfolia-test',
        CCMS_OIDC_CLIENT_SECRET: 'test-client-secret-0123456789',
        CCMS_OIDC_REDIRECT_URL: `${base}/auth/oidc/callback`,
        CCMS_OIDC_NAME: 'Test provider',
      };
    });
  });
  afterAll(async () => {
    await s?.close();
    await oidc?.close();
  });

  async function oidcSignIn(login: string) {
    const result = await signInThroughMock({
      signInUrl: `${s.base}/auth/oidc/sign-in?returnTo=%2F`,
      login,
    });
    return { finalUrl: result.finalUrl, cookie: result.cookieHeader(s.base) };
  }

  async function samlSignIn(login: string) {
    const begun = await s.t.anonymous().get('/auth/saml/sign-in').expect(303);
    const request = new URL(begun.headers['location'] as string);
    const xml = inflateRawSync(
      Buffer.from(request.searchParams.get('SAMLRequest')!, 'base64'),
    ).toString('utf8');
    const res = await s.t
      .anonymous()
      .post('/auth/saml/callback')
      .type('form')
      .send({
        SAMLResponse: s.mock.answer({
          login,
          inResponseTo: /\sID="([^"]+)"/.exec(xml)![1]!,
        }),
      })
      .set('Cookie', cookiePair(setCookies(begun)[0]!))
      .expect(303);
    const session = setCookies(res).find((line) =>
      line.startsWith(`${SESSION_COOKIE}=`),
    );
    return {
      location: res.headers['location'] as string,
      cookie: session ? cookiePair(session) : undefined,
    };
  }

  it('refuses a deactivated person who comes through the other provider, making no user, until reactivated (#943)', async () => {
    await oidcSignIn('rae');
    const { cookie: rootCookie } = await oidcSignIn('root');
    const admin = (action: string) =>
      s.t
        .anonymous()
        .post(`/users/rae/${action}`)
        .set('Cookie', rootCookie)
        .set('Content-Type', JSON_API)
        .set('Origin', s.base)
        .expect(200);
    await admin('deactivate');
    s.mock.accounts['rae'] = { name: 'Rae', email: 'rae@example.org' };
    const before = await usersAndIdentities(s.t.database);
    const refused = await samlSignIn('rae');
    expect(refused.location).toBe(`${s.base}/sign-in?error=user-deactivated`);
    expect(refused.cookie).toBeUndefined();
    expect(await usersAndIdentities(s.t.database)).toEqual(before);

    // Reactivated: as before, a user of its own (`rae` signed in already), without the address.
    await admin('reactivate');
    const back = await samlSignIn('rae');
    const actor = ActorDocument.parse(
      (await s.t.anonymous().get('/me').set('Cookie', back.cookie!).expect(200))
        .body,
    ).data;
    expect(actor.id).toBe('rae-2');
  });
});
