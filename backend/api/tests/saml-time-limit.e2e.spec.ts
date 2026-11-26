import { inflateRawSync } from 'node:zlib';
import { FailedAuthentications } from '../src/access/api/failed-authentications.js';
import { SESSION_COOKIE } from '../src/access/api/session-cookies.js';
import { IdentityProviders } from '../src/access/core/identity-provider.js';
import { SeenAssertions } from '../src/access/core/seen-assertions.js';
import { ANSWER_LIMIT_MS } from '../src/access/repos/saml-answer-workers.js';
import type { SamlIdentityProvider } from '../src/access/repos/saml-identity-provider.js';
import type { AnswerOptions } from './saml/mock-idp.js';
import {
  cookiePair,
  type SamlSetup,
  setCookies,
  setUpSaml,
} from './saml/setup.js';

/**
 * An answer checked for longer than its time limit (#951): refused, counted against the client's
 * address like any refusal, and the next sign-in checked by a new worker.
 */
describe('SAML sign-in, the time limit of an answer', () => {
  let s: SamlSetup;
  let provider: SamlIdentityProvider;
  beforeAll(async () => {
    s = await setUpSaml({ CCMS_AUTH_FAILURES_MAX: '2' });
    provider = s.t.app
      .get(IdentityProviders)
      .find('saml') as SamlIdentityProvider;
  });
  afterAll(async () => {
    await s?.close();
  });
  afterEach(() => {
    provider.answers.limitMs = ANSWER_LIMIT_MS;
  });

  async function signIn(shape: Partial<AnswerOptions> = {}) {
    const begun = await s.t.anonymous().get('/auth/saml/sign-in').expect(303);
    const request = inflateRawSync(
      Buffer.from(
        new URL(begun.headers['location'] as string).searchParams.get(
          'SAMLRequest',
        )!,
        'base64',
      ),
    ).toString('utf8');
    const answer = s.mock.answer({
      login: 'pat',
      inResponseTo: /\sID="([^"]+)"/.exec(request)![1]!,
      ...shape,
    });
    const start = performance.now();
    const res = await s.t
      .anonymous()
      .post('/auth/saml/callback')
      .set('Cookie', cookiePair(setCookies(begun)[0]!))
      .type('form')
      .send({ SAMLResponse: answer })
      .expect(303);
    return {
      to: (res.headers['location'] as string).replace(s.base, ''),
      session: setCookies(res).some((line) =>
        line.startsWith(`${SESSION_COOKIE}=ccms_ses_`),
      ),
      ms: performance.now() - start,
    };
  }

  /**
   * One of the slowest answers `checkAnswer` takes (`saml-answer-cost.perf.spec.ts`): a thousand
   * names, each looked for through the whole answer, then a long text, outside what is signed.
   * Within its time it is accepted.
   */
  const slow = {
    tamper: (xml: string) =>
      xml.replace(
        '<samlp:Status>',
        `${Array.from({ length: 1000 }, (_, i) => `<e${i}></e${i}>`).join('')}<samlp:E>${'&amp;'.repeat(1600)}</samlp:E>$&`,
      ),
  };
  const IN = { to: '/', session: true };
  const FAILED = { to: '/sign-in?error=sign-in-failed', session: false };

  it('accepts the slow answer within the limit', async () => {
    expect(await signIn(slow)).toMatchObject(IN);
  });

  it('refuses it past the limit, in about the limit, counts it, and the next sign-in works', async () => {
    // A window of its own for the failures.
    s.t.app.get(FailedAuthentications).now = () => Date.now() + 120_000;
    provider.answers.limitMs = 5;
    const refused = await signIn(slow);
    expect(refused).toMatchObject(FAILED);
    // Refused for its time (within 2 s it is accepted, above); a bound far below 2 s that holds
    // on a loaded machine. That it is refused in about the limit is the unit spec's.
    expect(refused.ms).toBeLessThan(1_000);
    provider.answers.limitMs = ANSWER_LIMIT_MS;
    expect(await signIn()).toMatchObject(IN);

    // Counted like any refusal: the second reaches the limit (2).
    provider.answers.limitMs = 5;
    expect(await signIn(slow)).toMatchObject(FAILED);
    provider.answers.limitMs = ANSWER_LIMIT_MS;
    expect(await signIn()).toMatchObject({
      to: '/sign-in?error=too-many-failed-attempts',
      session: false,
    });
    s.t.app.get(FailedAuthentications).now = () => Date.now() + 240_000;
    expect(await signIn()).toMatchObject(IN);
  });

  it('fails a sign-in whose assertion the database cannot record, through the worker, without counting it', async () => {
    s.t.app.get(FailedAuthentications).now = () => Date.now() + 360_000;
    const down = vi
      .spyOn(s.t.app.get(SeenAssertions), 'recordOnce')
      .mockRejectedValue(new Error('The database is down.'));
    for (let i = 0; i < 3; i++) expect(await signIn()).toMatchObject(FAILED);
    expect(down).toHaveBeenCalledTimes(3);
    down.mockRestore();
    // Not counted: past the limit (2), the next sign-in still works.
    expect(await signIn()).toMatchObject(IN);
  });
});
