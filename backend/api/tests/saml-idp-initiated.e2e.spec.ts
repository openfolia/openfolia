import {
  SESSION_COOKIE,
  SIGN_IN_COOKIE,
  SIGN_IN_SEAL_CONTEXT,
} from '../src/access/api/session-cookies.js';
import { SecretSealer } from '../src/base/core/secret-sealer.js';
import { type SamlSetup, setCookies, setUpSaml } from './saml/setup.js';

/** SAML sign-in begun at the identity provider (#376, `CCMS_SAML_IDP_INITIATED=true`). */
describe('sign-in with SAML 2.0, begun at the identity provider', () => {
  let s: SamlSetup;
  beforeAll(async () => {
    s = await setUpSaml({ CCMS_SAML_IDP_INITIATED: 'true' });
  });
  afterAll(async () => {
    await s?.close();
  });

  const post = (answer: string) =>
    s.t
      .anonymous()
      .post('/auth/saml/callback')
      .type('form')
      .send({ SAMLResponse: answer });

  it('signs in with an unsolicited answer, to the editor’s start', async () => {
    const res = await post(s.mock.answer({ login: 'pat' })).expect(303);
    expect(res.headers['location']).toBe(`${s.base}/`);
    expect(
      setCookies(res).some((line) =>
        line.startsWith(`${SESSION_COOKIE}=ccms_ses_`),
      ),
    ).toBe(true);
  });

  it('signs in also beside a sign-in cookie another provider left (#934)', async () => {
    // As `GET /auth/oidc/sign-in` keeps it: sealed for that provider, so it does not open here.
    const left = s.t.app.get(SecretSealer).seal(
      JSON.stringify({
        provider: 'oidc',
        pending: { state: 's1' },
        returnTo: '/manuals',
        until: Date.now() + 60_000,
      }),
      `${SIGN_IN_SEAL_CONTEXT}:oidc`,
    );
    const res = await post(s.mock.answer({ login: 'pat' }))
      .set('Cookie', `${SIGN_IN_COOKIE}=${left}`)
      .expect(303);
    // To the editor's start: nothing of the other provider's sign-in is taken.
    expect(res.headers['location']).toBe(`${s.base}/`);
    expect(setCookies(res)).toContain(
      `${SIGN_IN_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=None; Max-Age=0`,
    );
  });

  it('still refuses an answer naming a request this browser did not begin', async () => {
    const res = await post(
      s.mock.answer({ login: 'pat', inResponseTo: '_begun-elsewhere' }),
    ).expect(303);
    expect(res.headers['location']).toBe(
      `${s.base}/sign-in?error=sign-in-failed`,
    );
  });

  it('refuses an assertion naming another request even when the response no longer says so', async () => {
    // The Response is unsigned here, so its InResponseTo can be taken off; the signed assertion's stays.
    const res = await post(
      s.mock.answer({
        login: 'pat',
        inResponseTo: '_begun-elsewhere',
        stripResponseInResponseTo: true,
      }),
    ).expect(303);
    expect(res.headers['location']).toBe(
      `${s.base}/sign-in?error=sign-in-failed`,
    );
  });

  it('still refuses a replayed unsolicited answer', async () => {
    const answer = s.mock.answer({ login: 'pat' });
    const first = await post(answer).expect(303);
    expect(first.headers['location']).toBe(`${s.base}/`);
    const again = await post(answer).expect(303);
    expect(again.headers['location']).toBe(
      `${s.base}/sign-in?error=sign-in-failed`,
    );
  });
});
