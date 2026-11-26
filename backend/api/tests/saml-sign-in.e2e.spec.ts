import { inflateRawSync } from 'node:zlib';
import { Logger } from '@nestjs/common';
import { ActorDocument } from '../src/access/api/access.resources.js';
import {
  SECOND_FACTOR_COOKIE,
  SESSION_COOKIE,
  SIGN_IN_COOKIE,
  SIGN_IN_SEAL_CONTEXT,
} from '../src/access/api/session-cookies.js';
import { IdentityProviderPageDocument } from '../src/access/api/sign-in.resources.js';
import { AuditEventPageDocument } from '../src/audit/api/audit-event.resources.js';
import { mintPendingSignIn } from '../src/access/core/pending-sign-ins.js';
import { hashSessionToken } from '../src/access/core/sessions.js';
import { pendingSignIns } from '../src/access/repos/second-factors.tables.js';
import { JSON_API } from '../src/base/api/json-api.js';
import { SecretSealer } from '../src/base/core/secret-sealer.js';
import type { AnswerOptions } from './saml/mock-idp.js';
import {
  cookiePair,
  type SamlSetup,
  setCookies,
  setUpSaml,
} from './saml/setup.js';
import { usersAndIdentities } from './stored-sign-ins.js';

/**
 * Sign-in with SAML 2.0 (#376), end to end: the real app on a port, a local identity provider
 * (`saml/mock-idp.ts`) whose answers are real signed SAML, posted to the assertion consumer
 * service as a browser would.
 */
describe('sign-in with SAML 2.0', () => {
  let s: SamlSetup;
  beforeAll(async () => {
    // The provider vouches for its addresses here: linking by them is what some tests check.
    s = await setUpSaml({ CCMS_SAML_EMAIL_VERIFIED: 'true' });
  });
  afterAll(async () => {
    await s?.close();
  });

  /** Begins a sign-in (holding `session`, if any): the cookie the browser keeps and the request's ID. */
  async function begin(returnTo = '/manuals?x=1', session?: string) {
    const req = s.t
      .anonymous()
      .get(`/auth/saml/sign-in?returnTo=${encodeURIComponent(returnTo)}`);
    const res = await (
      session === undefined ? req : req.set('Cookie', session)
    ).expect(303);
    const location = new URL(res.headers['location'] as string);
    const request = inflateRawSync(
      Buffer.from(location.searchParams.get('SAMLRequest')!, 'base64'),
    ).toString('utf8');
    const requestId = /\sID="([^"]+)"/.exec(request)![1]!;
    const [line] = setCookies(res);
    return { res, location, request, requestId, cookie: cookiePair(line!) };
  }

  /** Posts an answer to the assertion consumer service, as the provider's page does. */
  function post(answer: string, cookie?: string) {
    const req = s.t
      .anonymous()
      .post('/auth/saml/callback')
      .type('form')
      .send({ SAMLResponse: answer });
    return cookie === undefined ? req : req.set('Cookie', cookie);
  }

  /** A whole sign-in as `login`, the answer shaped by `shape`; the final address and cookie. */
  async function signIn(
    login: string,
    shape: Partial<AnswerOptions> = {},
    returnTo?: string,
    held?: string,
  ) {
    const begun = await begin(returnTo, held);
    const answer = s.mock.answer({
      login,
      inResponseTo: begun.requestId,
      ...shape,
    });
    const res = await post(answer, begun.cookie).expect(303);
    const session = setCookies(res).find((line) =>
      line.startsWith(`${SESSION_COOKIE}=${'ccms_ses_'}`),
    );
    return {
      location: res.headers['location'] as string,
      cookie: session ? cookiePair(session) : undefined,
      answer,
      begun,
      res,
    };
  }

  const me = (cookie: string) =>
    s.t.anonymous().get('/me').set('Cookie', cookie);

  it('lists the provider, to anyone', async () => {
    const res = await s.t.anonymous().get('/auth/providers').expect(200);
    expect(IdentityProviderPageDocument.parse(res.body).data).toEqual([
      {
        type: 'IdentityProvider',
        id: 'saml',
        attributes: { name: 'Test SAML' },
        links: { signIn: 'auth/saml/sign-in' },
      },
    ]);
  });

  it('serves its metadata for the identity provider', async () => {
    const res = await s.t.anonymous().get('/auth/saml/metadata').expect(200);
    expect(res.headers['content-type']).toMatch(
      /^application\/samlmetadata\+xml/,
    );
    const xml = res.text;
    expect(xml).toContain(`entityID="${s.base}/api/auth/saml/metadata"`);
    expect(xml).toContain(`Location="${s.base}/api/auth/saml/callback"`);
    expect(xml).toContain('urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST');
    expect(xml).toContain('WantAssertionsSigned="true"');
  });

  it('sends the browser to the provider with a request, keeping it in a cross-site cookie', async () => {
    const { location, request, res } = await begin();
    expect(`${location.origin}${location.pathname}`).toBe(
      new URL('/sso', s.mock.metadataUrl).href,
    );
    expect(request).toContain(
      `AssertionConsumerServiceURL="${s.base}/api/auth/saml/callback"`,
    );
    expect(request).toContain(`${s.base}/api/auth/saml/metadata</saml:Issuer>`);
    expect(setCookies(res)[0]).toMatch(
      new RegExp(
        `^${SIGN_IN_COOKIE}=[^;]+; Path=/; Secure; HttpOnly; SameSite=None; Max-Age=600$`,
      ),
    );
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('signs a new person in through the provider’s pages: a user of their own, roles from their groups', async () => {
    const begun = await begin('/content');
    // The provider's sign-in page, then the page that posts the answer back.
    const login = await fetch(begun.location);
    expect(await login.text()).toContain('<h1>Mock SAML provider</h1>');
    const posted = await fetch(new URL('/sso/login', begun.location), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        requestId: begun.requestId,
        login: 'pat',
      }).toString(),
    });
    const page = await posted.text();
    expect(page).toContain(`action="${s.base}/api/auth/saml/callback"`);
    const answer = /name="SAMLResponse" value="([^"]+)"/.exec(page)![1]!;
    const res = await post(answer, begun.cookie).expect(303);
    expect(res.headers['location']).toBe(`${s.base}/content`);
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    const session = setCookies(res).find((line) =>
      line.startsWith(`${SESSION_COOKIE}=`),
    )!;
    expect(session).toMatch(/; SameSite=Lax; /);
    // The sign-in cookie is used once.
    expect(setCookies(res)).toContain(
      `${SIGN_IN_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=None; Max-Age=0`,
    );
    const actor = ActorDocument.parse(
      (await me(cookiePair(session)).expect(200)).body,
    ).data;
    expect(actor).toMatchObject({
      id: 'pat',
      attributes: {
        kind: 'user',
        name: 'Pat Example',
        roles: [{ id: 'author' }],
      },
      meta: { session: { provider: 'saml' } },
    });
  });

  it('links the first admin by their email address', async () => {
    const { cookie, location } = await signIn('root');
    expect(location).toBe(`${s.base}/manuals?x=1`);
    const actor = ActorDocument.parse(
      (await me(cookie!).expect(200)).body,
    ).data;
    expect(actor.id).toBe('first-admin');
    expect(actor.attributes.roles.map((r) => r.id)).toEqual(['admin']);
  });

  it('ends the session the browser held before, which the provider’s post never carries (#934)', async () => {
    const first = await signIn('pat');
    await me(first.cookie!).expect(200);
    // Begun with the session's cookie (a same-site navigation); answered without (a cross-site post).
    const second = await signIn('pat', {}, undefined, first.cookie);
    await me(second.cookie!).expect(200);
    await me(first.cookie!).expect(401);
    // What is kept for it: its hash, never the token.
    const token = first.cookie!.slice(SESSION_COOKIE.length + 1);
    const kept = s.t.app
      .get(SecretSealer)
      .open(
        second.begun.cookie.slice(SIGN_IN_COOKIE.length + 1),
        `${SIGN_IN_SEAL_CONTEXT}:saml`,
      );
    expect(JSON.parse(kept)).toMatchObject({
      previousSession: hashSessionToken(token),
    });
    expect(kept).not.toContain(token);
  });

  it('ends the second step the browser had open, the same way (#611)', async () => {
    const step = mintPendingSignIn();
    await s.t.database.db.insert(pendingSignIns).values({
      tokenHash: step.hash,
      userId: 'first-admin',
      step: 'set-up',
      provider: 'password',
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 600_000),
    });
    const open = () => s.t.database.db.select().from(pendingSignIns);
    const held = `${SECOND_FACTOR_COOKIE}=${step.token}`;
    const refused = await signIn('pat', { signWith: 'other' }, undefined, held);
    expect(refused.cookie).toBeUndefined();
    expect(await open()).toHaveLength(1);
    const done = await signIn('pat', {}, undefined, held);
    expect(done.cookie).toBeDefined();
    expect(await open()).toEqual([]);
    expect(setCookies(done.res)).toContain(
      `${SECOND_FACTOR_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`,
    );
  });

  it('keeps that session when the sign-in is refused (#934)', async () => {
    const first = await signIn('pat');
    const refused = await signIn(
      'pat',
      { signWith: 'other' },
      undefined,
      first.cookie,
    );
    expect(refused.cookie).toBeUndefined();
    await me(first.cookie!).expect(200);
  });

  it('keeps another browser’s session: only the one held when it began ends (#934)', async () => {
    const elsewhere = await signIn('pat');
    const first = await signIn('pat');
    await signIn('pat', {}, undefined, first.cookie);
    await me(first.cookie!).expect(401);
    await me(elsewhere.cookie!).expect(200);
  });

  it('applies the groups the provider sends at the next sign-in', async () => {
    const first = await signIn('pat');
    expect(
      ActorDocument.parse(
        (await me(first.cookie!).expect(200)).body,
      ).data.attributes.roles.map((r) => r.id),
    ).toEqual(['author']);
    s.mock.accounts['pat'] = {
      ...s.mock.accounts['pat'],
      groups: ['reviewers'],
    };
    try {
      const second = await signIn('pat');
      expect(
        ActorDocument.parse(
          (await me(second.cookie!).expect(200)).body,
        ).data.attributes.roles.map((r) => r.id),
      ).toEqual(['reviewer']);
    } finally {
      s.mock.accounts['pat'] = {
        ...s.mock.accounts['pat'],
        groups: ['writers'],
      };
    }
  });

  it('refuses a deactivated person the provider names differently now, making no user, until reactivated (#943)', async () => {
    s.mock.accounts['quinn'] = { name: 'Quinn', email: 'quinn@example.org' };
    await signIn('quinn');
    const { cookie: rootCookie } = await signIn('root');
    const admin = (action: string) =>
      s.t
        .anonymous()
        .post(`/users/quinn/${action}`)
        .set('Cookie', rootCookie!)
        .set('Content-Type', JSON_API)
        .set('Origin', s.base)
        .expect(200);
    await admin('deactivate');
    const before = await usersAndIdentities(s.t.database);
    // Another NameID for them now (made again at the provider), in the expected format (#946).
    const renamed = {
      nameId: {
        value: 'quinn-made-again',
        format: 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent',
      },
    };
    const refused = await signIn('quinn', renamed);
    expect(refused.location).toBe(`${s.base}/sign-in?error=user-deactivated`);
    expect(refused.cookie).toBeUndefined();
    expect(await usersAndIdentities(s.t.database)).toEqual(before);

    // Reactivated: as before, a user of its own (`quinn` signed in already), without the address.
    await admin('reactivate');
    const back = await signIn('quinn', renamed);
    const actor = ActorDocument.parse(
      (await me(back.cookie!).expect(200)).body,
    ).data;
    expect(actor.id).toBe('quinn-2');
  });

  it('audits the sign-in as with OpenID Connect', async () => {
    await signIn('pat');
    const { cookie } = await signIn('root');
    const res = await s.t
      .anonymous()
      .get('/audit-events?filter[action]=user.sign-in&page[size]=50')
      .set('Cookie', cookie!)
      .expect(200);
    const events = AuditEventPageDocument.parse(res.body).data;
    expect(
      events.some(
        (e) =>
          e.attributes.subject.id === 'pat' &&
          (e.attributes.data as { provider?: string }).provider === 'saml',
      ),
    ).toBe(true);
  });

  describe('refuses', () => {
    const PERSISTENT = 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent';
    const refused = async (
      shape: Partial<AnswerOptions>,
      code = 'sign-in-failed',
    ) => {
      const { location, cookie } = await signIn('pat', shape);
      expect(location).toBe(`${s.base}/sign-in?error=${code}`);
      expect(cookie).toBeUndefined();
    };

    it.each([
      ['email', 'root@example.org', 'CCMS_SAML_EMAIL_ATTRIBUTE'],
      ['name', 'Root', 'CCMS_SAML_NAME_ATTRIBUTE'],
      ['groups', 'admins', 'CCMS_SAML_GROUPS_ATTRIBUTE'],
    ])(
      'an assertion with the configured attribute "%s" twice, naming the setting in the log (#934)',
      async (name, value, setting) => {
        const warn = vi
          .spyOn(Logger.prototype, 'warn')
          .mockImplementation(() => undefined);
        try {
          await refused({ attributes: { [name]: value } });
          const lines = warn.mock.calls.map((call) => String(call[0]));
          expect(lines.some((line) => line.includes(setting))).toBe(true);
          expect(lines.join()).not.toContain(value);
        } finally {
          warn.mockRestore();
        }
      },
    );

    it('an unsigned assertion', () => refused({ signWith: 'none' }));

    it('an assertion signed with a key the metadata does not name', () =>
      refused({ signWith: 'other' }));

    it('an assertion changed after it was signed', () =>
      refused({
        tamper: (xml) => xml.replace('pat@example.org', 'root@example.org'),
      }));

    it('an assertion for another audience', () =>
      refused({ audience: 'https://elsewhere.example.org/sp' }));

    it('an assertion for another recipient', () =>
      refused({ recipient: 'https://elsewhere.example.org/acs' }));

    it('an expired assertion', () =>
      refused({
        issuedAt: new Date(Date.now() - 20 * 60_000),
        notOnOrAfter: new Date(Date.now() - 10 * 60_000),
      }));

    it('an answer to another request', () =>
      refused({ inResponseTo: '_not-the-request-begun' }));

    it('an assertion without a NameID, an attribute named nameID notwithstanding (#934)', () =>
      refused({ nameId: null, attributes: { nameID: 'id-root' } }));

    it('an assertion with an empty NameID, an attribute named nameID notwithstanding (#934)', () =>
      refused({
        nameId: { value: '', format: PERSISTENT },
        attributes: { nameID: 'id-root' },
      }));

    it('an assertion with a blank NameID, an attribute named nameID notwithstanding (#934)', () =>
      refused({
        nameId: { value: '  ', format: PERSISTENT },
        attributes: { nameID: 'id-root' },
      }));

    it('an assertion with a transient NameID', () =>
      refused({
        nameId: {
          value: '_t1',
          format: 'urn:oasis:names:tc:SAML:2.0:nameid-format:transient',
        },
        attributes: {
          nameIDFormat: 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent',
        },
      }));

    it('a replayed assertion, even with the browser’s cookie', async () => {
      const { answer, begun, cookie } = await signIn('pat');
      expect(cookie).toBeDefined();
      // The same request and cookie: only the ledger of seen assertions can refuse it.
      const again = await post(answer, begun.cookie).expect(303);
      expect(again.headers['location']).toBe(
        `${s.base}/sign-in?error=sign-in-failed`,
      );
    });

    it('an answer without a sign-in begun in this browser (IdP-initiated is off)', async () => {
      const res = await post(s.mock.answer({ login: 'pat' })).expect(303);
      expect(res.headers['location']).toBe(
        `${s.base}/sign-in?error=sign-in-expired`,
      );
    });

    it('an answer by redirect, and a posted answer for no such provider', async () => {
      await s.t
        .anonymous()
        .get('/auth/saml/callback?SAMLResponse=x')
        .expect(404);
      await s.t
        .anonymous()
        .post('/auth/oidc/callback')
        .type('form')
        .send({ SAMLResponse: 'x' })
        .expect(404);
    });

    it('clears the sign-in cookie also when it answers 404 (#934)', async () => {
      for (const [req, sameSite] of [
        [s.t.anonymous().get('/auth/saml/callback?SAMLResponse=x'), 'Lax'],
        [s.t.anonymous().get('/auth/none/callback?code=x'), 'Lax'],
        [
          s.t.anonymous().post('/auth/none/callback').type('form').send({}),
          'None',
        ],
      ] as const) {
        const res = await req.expect(404);
        expect(setCookies(res)).toEqual([
          `${SIGN_IN_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=${sameSite}; Max-Age=0`,
        ]);
        expect(res.headers['cache-control']).toBe('no-store');
        expect(res.headers['referrer-policy']).toBe('no-referrer');
      }
    });
  });
});
