import { inflateRawSync } from 'node:zlib';
import { FailedAuthentications } from '../src/access/api/failed-authentications.js';
import { SESSION_COOKIE } from '../src/access/api/session-cookies.js';
import { IdentityProviders } from '../src/access/core/identity-provider.js';
import type { SamlIdentityProvider } from '../src/access/repos/saml-identity-provider.js';
import { JSON_API } from '../src/base/api/json-api.js';
import type { AnswerOptions } from './saml/mock-idp.js';
import {
  cookiePair,
  type SamlSetup,
  setCookies,
  setUpSaml,
} from './saml/setup.js';

/** What a posted SAML answer may cost, and how many refused ones a client may send (#934). */
describe('SAML sign-in, its limits', () => {
  let s: SamlSetup;
  beforeAll(async () => {
    // Two certificates, the provider's own the second.
    s = await setUpSaml(
      { CCMS_AUTH_FAILURES_MAX: '3' },
      { secondCertificate: true },
    );
  });
  afterAll(async () => {
    await s?.close();
  });

  /** Begins a sign-in: its cookie, and an answer to it. */
  async function begin(shape: Partial<AnswerOptions> = {}) {
    const res = await s.t.anonymous().get('/auth/saml/sign-in').expect(303);
    const request = inflateRawSync(
      Buffer.from(
        new URL(res.headers['location'] as string).searchParams.get(
          'SAMLRequest',
        )!,
        'base64',
      ),
    ).toString('utf8');
    return {
      cookie: cookiePair(setCookies(res)[0]!),
      answer: s.mock.answer({
        login: 'pat',
        inResponseTo: /\sID="([^"]+)"/.exec(request)![1]!,
        ...shape,
      }),
    };
  }

  /** Posts an answer: where the browser is sent, and whether a session begins. */
  async function post(answer: string, cookie?: string) {
    const req = s.t
      .anonymous()
      .post('/auth/saml/callback')
      .type('form')
      .send({ SAMLResponse: answer });
    const res = await (
      cookie === undefined ? req : req.set('Cookie', cookie)
    ).expect(303);
    return {
      to: (res.headers['location'] as string).replace(s.base, ''),
      session: setCookies(res).some((line) =>
        line.startsWith(`${SESSION_COOKIE}=ccms_ses_`),
      ),
    };
  }
  async function signIn(shape: Partial<AnswerOptions> = {}) {
    const { answer, cookie } = await begin(shape);
    return post(answer, cookie);
  }
  const IN = { to: '/', session: true };
  const FAILED = { to: '/sign-in?error=sign-in-failed', session: false };
  const LIMITED = {
    to: '/sign-in?error=too-many-failed-attempts',
    session: false,
  };

  it('accepts an answer with 200 long group names, with two certificates to check', async () => {
    s.mock.accounts['pat'] = {
      ...s.mock.accounts['pat'],
      groups: Array.from(
        { length: 200 },
        (_, i) =>
          `CN=documentation-team-${i},OU=groups,OU=department,DC=example,DC=org`,
      ),
    };
    expect(await signIn()).toEqual(IN);
  });

  it('takes an answer only from a form', async () => {
    const { answer, cookie } = await begin();
    const res = await s.t
      .anonymous()
      .post('/auth/saml/callback')
      .set('Cookie', cookie)
      .set('Content-Type', JSON_API)
      .send(JSON.stringify({ SAMLResponse: answer }));
    expect(res.headers['location']).toBe(`${s.base}${FAILED.to}`);
    expect(setCookies(res).join()).not.toContain('ccms_ses_');
  });

  it('refuses an answer past its bounds before checking its signature', async () => {
    // Comments change nothing in what is signed, so the signature still holds.
    const commented = await signIn({
      tamper: (xml) =>
        xml.replace('</saml:Subject>', '<!-- --></saml:Subject>'),
    });
    expect(commented).toEqual(FAILED);
  });

  it('refuses a client after too many refused answers, a good one too, and counts nothing else', async () => {
    // A window of its own, after the tests above.
    s.t.app.get(FailedAuthentications).now = () => Date.now() + 120_000;
    // Neither sign-ins nor answers to no sign-in of this browser count.
    for (let i = 0; i < 4; i++) expect(await signIn()).toEqual(IN);
    for (let i = 0; i < 4; i++) {
      expect(await post((await begin()).answer)).toEqual({
        to: '/sign-in?error=sign-in-expired',
        session: false,
      });
    }
    // At once, and while the metadata is being read again: still no more than the limit.
    const provider = s.t.app
      .get(IdentityProviders)
      .find('saml') as SamlIdentityProvider;
    const begun = await Promise.all(
      Array.from({ length: 8 }, () => begin({ signWith: 'other' })),
    );
    provider.now = () => Date.now() + 25 * 3_600_000;
    const real = globalThis.fetch;
    const slow = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (...request) => {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        return real(...request);
      });
    const burst = await Promise.all(
      begun.map(({ answer, cookie }) => post(answer, cookie)),
    );
    expect(slow).toHaveBeenCalledOnce();
    slow.mockRestore();
    provider.now = Date.now;
    expect(burst.filter((r) => r.to === FAILED.to)).toHaveLength(3);
    expect(burst.filter((r) => r.to === LIMITED.to)).toHaveLength(5);
    expect(await signIn()).toEqual(LIMITED);

    // Counted apart: other ways of authenticating from that address go on.
    await s.t
      .anonymous()
      .get('/me')
      .set('Authorization', 'Bearer ccms_pat_wrong')
      .expect(401);
  });
});
