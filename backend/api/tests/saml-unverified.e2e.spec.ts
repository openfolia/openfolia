import { inflateRawSync } from 'node:zlib';
import { ActorDocument } from '../src/access/api/access.resources.js';
import { SESSION_COOKIE } from '../src/access/api/session-cookies.js';
import {
  cookiePair,
  type SamlSetup,
  setCookies,
  setUpSaml,
} from './saml/setup.js';

/**
 * SAML sign-in with `CCMS_SAML_EMAIL_VERIFIED` left at its default (false, #376): an address the
 * identity provider sends never joins an existing user, so nobody claims the first admin (or any
 * other account) by typing its address in at the provider.
 */
describe('sign-in with SAML 2.0, addresses not vouched for (the default)', () => {
  let s: SamlSetup;
  beforeAll(async () => {
    s = await setUpSaml();
  });
  afterAll(async () => {
    await s?.close();
  });

  /** A whole sign-in as `login`: the session cookie it ends with. */
  async function signIn(login: string): Promise<string> {
    const begun = await s.t.anonymous().get('/auth/saml/sign-in').expect(303);
    const request = inflateRawSync(
      Buffer.from(
        new URL(begun.headers['location'] as string).searchParams.get(
          'SAMLRequest',
        )!,
        'base64',
      ),
    ).toString('utf8');
    const requestId = /\sID="([^"]+)"/.exec(request)![1]!;
    const res = await s.t
      .anonymous()
      .post('/auth/saml/callback')
      .set('Cookie', cookiePair(setCookies(begun)[0]!))
      .type('form')
      .send({
        SAMLResponse: s.mock.answer({ login, inResponseTo: requestId }),
      })
      .expect(303);
    expect(res.headers['location']).toBe(`${s.base}/`);
    const session = setCookies(res).find((line) =>
      line.startsWith(`${SESSION_COOKIE}=`),
    );
    expect(session).toBeDefined();
    return cookiePair(session!);
  }

  it('makes a new user for the first admin’s address instead of taking over that account', async () => {
    const cookie = await signIn('root');
    const actor = ActorDocument.parse(
      (await s.t.anonymous().get('/me').set('Cookie', cookie).expect(200)).body,
    ).data;
    expect(actor.id).not.toBe('first-admin');
    expect(actor.attributes.roles).toEqual([]);

    // And stays apart from it: the next sign-in is that same new user, never the first admin.
    const again = await signIn('root');
    expect(
      ActorDocument.parse(
        (await s.t.anonymous().get('/me').set('Cookie', again).expect(200))
          .body,
      ).data.id,
    ).toBe(actor.id);
  });
});
