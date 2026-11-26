import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { Logger } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { ActorDocument } from '../../src/access/api/access.resources.js';
import { SESSION_COOKIE } from '../../src/access/api/session-cookies.js';
import { users } from '../../src/access/repos/access.tables.js';
import {
  sessions,
  userIdentities,
} from '../../src/access/repos/sign-in.tables.js';
import type { AnswerOptions } from './mock-idp.js';
import { cookiePair, type SamlSetup, setCookies, setUpSaml } from './setup.js';

const FORMATS = {
  persistent: 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent',
  emailAddress: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
  unspecified: 'urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified',
} as const;
const TRANSIENT = 'urn:oasis:names:tc:SAML:2.0:nameid-format:transient';
const CUSTOM = 'urn:example:nameid-format:staff-number';
export type Expected = keyof typeof FORMATS;
type NameId = NonNullable<AnswerOptions['nameId']>;

/**
 * One name ID Format per installation (#946): asked for in the request and required of the
 * answer, its qualifiers absent or the ones that name this server and the provider. With sign-in
 * begun at the provider on, so every answer is tried both ways. One spec file per Format runs it,
 * as an app reads its settings once per file.
 */
export function describeNameIds(expected: Expected): void {
  describe(`SAML sign-in, name IDs in the Format ${expected}`, () => {
    let s: SamlSetup;
    beforeAll(async () => {
      s = await setUpSaml({
        CCMS_SAML_IDP_INITIATED: 'true',
        // Persistent is the default.
        ...(expected !== 'persistent' && {
          CCMS_SAML_NAME_ID_FORMAT: expected,
        }),
        CCMS_SAML_EMAIL_VERIFIED: 'true',
        // One of them under an entity ID of its own.
        ...(expected === 'emailAddress' && {
          CCMS_SAML_SP_ENTITY_ID: 'urn:example:docs',
        }),
      });
      s.mock.accounts['someone'] = { name: 'Someone' };
    });
    afterAll(async () => {
      await s?.close();
    });

    /** What the provider sends for pat, as a whole. */
    const PAT: NameId = {
      value: {
        persistent: 'id-pat',
        emailAddress: 'pat@example.org',
        unspecified: 'pat',
      }[expected],
      format: FORMATS[expected],
    };
    /** This server's entity ID. */
    const here = () =>
      expected === 'emailAddress'
        ? 'urn:example:docs'
        : `${s.base}/api/auth/saml/metadata`;
    const inflate = (value: string) =>
      inflateRawSync(Buffer.from(value, 'base64')).toString('utf8');

    async function begin() {
      const res = await s.t.anonymous().get('/auth/saml/sign-in').expect(303);
      const location = new URL(res.headers['location'] as string);
      const request = inflate(location.searchParams.get('SAMLRequest')!);
      return {
        location,
        request,
        requestId: /\sID="([^"]+)"/.exec(request)![1]!,
        cookie: cookiePair(setCookies(res)[0]!),
      };
    }

    /** Posts an answer: where the browser is sent, and its session, if one begins. */
    async function post(answer: string, cookie?: string) {
      const req = s.t
        .anonymous()
        .post('/auth/saml/callback')
        .type('form')
        .send({ SAMLResponse: answer });
      const res = await (
        cookie === undefined ? req : req.set('Cookie', cookie)
      ).expect(303);
      const session = setCookies(res).find((line) =>
        line.startsWith(`${SESSION_COOKIE}=ccms_ses_`),
      );
      return {
        to: res.headers['location'] as string,
        session: session && cookiePair(session),
      };
    }

    /** An answer with this NameID, to a sign-in begun here or to none. */
    async function answer(
      way: 'requested' | 'unsolicited',
      nameId: NameId,
      moreSubject = '',
    ) {
      const reshape = (assertion: string) =>
        assertion.replace('<saml:SubjectConfirmation ', `${moreSubject}$&`);
      if (way === 'unsolicited') {
        return post(s.mock.answer({ login: 'pat', nameId, reshape }));
      }
      const { requestId, cookie } = await begin();
      return post(
        s.mock.answer({
          login: 'pat',
          inResponseTo: requestId,
          nameId,
          reshape,
        }),
        cookie,
      );
    }

    /** Through the provider's pages, asking for something else with `change`. */
    async function signIn(change: (request: string) => string = (xml) => xml) {
      const { location, request, cookie } = await begin();
      location.searchParams.set(
        'SAMLRequest',
        deflateRawSync(change(request)).toString('base64'),
      );
      const page = await (await fetch(location)).text();
      const form = new URLSearchParams(
        [...page.matchAll(/type="hidden" name="([^"]+)" value="([^"]*)"/g)].map(
          ([, name, value]) => [name!, value!],
        ),
      );
      form.set('login', 'pat');
      const posted = await fetch(new URL('/sso/login', location), {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
      });
      return post(
        /name="SAMLResponse" value="([^"]+)"/.exec(await posted.text())![1]!,
        cookie,
      );
    }

    /** The request with `policy` as its NameIDPolicy's attributes, whatever it had. */
    const withPolicy = (policy: string) => (request: string) => {
      const changed = request
        .replace(/<samlp:NameIDPolicy\b[^>]*\/>/, '')
        .replace(
          '</samlp:AuthnRequest>',
          `<samlp:NameIDPolicy ${policy}/></samlp:AuthnRequest>`,
        );
      expect(changed).not.toBe(request);
      return changed;
    };

    const userOf = async (session: string | undefined) => {
      const res = await s.t
        .anonymous()
        .get('/me')
        .set('Cookie', session ?? '')
        .expect(200);
      return ActorDocument.parse(res.body).data.id;
    };
    /** Everyone and everything a sign-in makes. */
    const made = async () => {
      const { db } = s.t.database;
      return {
        users: (await db.select().from(users)).length,
        identities: (await db.select().from(userIdentities)).length,
        sessions: (await db.select().from(sessions)).length,
      };
    };
    const FAILED = () => ({
      to: `${s.base}/sign-in?error=sign-in-failed`,
      session: undefined,
    });

    it('asks for it, in the request and in the metadata', async () => {
      const { request } = await begin();
      expect(request).toMatch(
        new RegExp(`<samlp:NameIDPolicy\\b[^>]* Format="${FORMATS[expected]}"`),
      );
      const metadata = await s.t.anonymous().get('/auth/saml/metadata');
      expect(metadata.text).toContain(
        `<NameIDFormat>${FORMATS[expected]}</NameIDFormat>`,
      );
    });

    it('signs a person in through the provider’s pages, each time as the same user', async () => {
      const user = await userOf((await signIn()).session);
      const before = await made();
      expect(await userOf((await signIn()).session)).toBe(user);
      expect(await userOf((await answer('unsolicited', PAT)).session)).toBe(
        user,
      );
      expect(await made()).toEqual({
        ...before,
        sessions: before.sessions + 2,
      });
    });

    it('is the same user with the qualifiers that name this server and the provider, or none', async () => {
      const user = await userOf((await answer('requested', PAT)).session);
      const nameQualifier = s.mock.entityId;
      const spNameQualifier = here();
      for (const way of ['requested', 'unsolicited'] as const) {
        for (const qualifiers of [
          { nameQualifier },
          { spNameQualifier },
          { nameQualifier, spNameQualifier },
        ]) {
          const { session } = await answer(way, { ...PAT, ...qualifiers });
          expect(await userOf(session)).toBe(user);
        }
      }
    });

    if (expected === 'unspecified') {
      it('takes no Format as this one', async () => {
        const user = await userOf((await answer('requested', PAT)).session);
        for (const way of ['requested', 'unsolicited'] as const) {
          const { session } = await answer(way, { value: PAT.value });
          expect(await userOf(session)).toBe(user);
        }
        // Neither is a Format of the NameID.
        for (const attributes of [
          ` format="${TRANSIENT}"`,
          ` o:Format="${TRANSIENT}" xmlns:o="urn:o"`,
        ]) {
          const { session } = await post(
            s.mock.answer({
              login: 'pat',
              nameId: { value: PAT.value },
              reshape: (xml) => xml.replace('<saml:NameID', `$&${attributes}`),
            }),
          );
          expect(await userOf(session)).toBe(user);
        }
      });
    }

    const refused: [string, NameId][] = [
      ...Object.entries({ ...FORMATS, transient: TRANSIENT, custom: CUSTOM })
        .filter(([name]) => name !== expected)
        .map(([name, format]): [string, NameId] => [
          `the Format ${name}`,
          { ...PAT, format },
        ]),
      [
        'another case of the Format',
        {
          ...PAT,
          format: FORMATS[expected].toUpperCase(),
        },
      ],
      ['an empty Format', { ...PAT, format: '' }],
      ...(expected === 'unspecified'
        ? []
        : [['no Format', { value: PAT.value }] as [string, NameId]]),
      ['another NameQualifier', { ...PAT, nameQualifier: 'elsewhere' }],
      ['another SPNameQualifier', { ...PAT, spNameQualifier: 'elsewhere' }],
      ['an empty NameQualifier', { ...PAT, nameQualifier: '' }],
      ['an empty SPNameQualifier', { ...PAT, spNameQualifier: '' }],
      ['a text longer than 256 characters', { ...PAT, value: 'x'.repeat(257) }],
      ['an empty text', { ...PAT, value: '' }],
      ['a blank text', { ...PAT, value: '  ' }],
      ['a space around the text', { ...PAT, value: ` ${PAT.value}` }],
      ['a line break around the text', { ...PAT, value: `${PAT.value}\n` }],
    ];
    describe.each(['requested', 'unsolicited'] as const)('%s', (way) => {
      it.each(refused)('refuses %s, and makes nothing', async (_, nameId) => {
        const before = await made();
        expect(await answer(way, nameId)).toEqual(FAILED());
        expect(await made()).toEqual(before);
      });
    });

    it('refuses the qualifiers that name each other', async () => {
      const before = await made();
      expect(
        await answer('requested', {
          ...PAT,
          nameQualifier: here(),
        }),
      ).toEqual(FAILED());
      expect(
        await answer('requested', { ...PAT, spNameQualifier: s.mock.entityId }),
      ).toEqual(FAILED());
      expect(await made()).toEqual(before);
    });

    it.each([
      ['a second one', '<saml:NameID>other</saml:NameID>'],
      [
        'one of another namespace',
        '<o:NameID xmlns:o="urn:o">other</o:NameID>',
      ],
    ])('refuses a NameID beside %s', async (_, more) => {
      const before = await made();
      expect(await answer('requested', PAT, more)).toEqual(FAILED());
      expect(await made()).toEqual(before);
    });

    it('refuses a second Subject', async () => {
      const before = await made();
      const until = new Date(Date.now() + 60_000).toISOString();
      // The first one whole, with a confirmation of its own.
      const more = `<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData NotOnOrAfter="${until}" Recipient="${s.base}/api/auth/saml/callback"/></saml:SubjectConfirmation></saml:Subject><saml:Subject>`;
      expect(await answer('unsolicited', PAT, more)).toEqual(FAILED());
      expect(await made()).toEqual(before);
    });

    it('says in the log what came and what was expected, on one printable line', async () => {
      const warn = vi
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      try {
        const lines = () => warn.mock.calls.map((call) => String(call[0]));
        const value = 'never-in-the-log';
        const sent = { ...PAT, value };
        await answer('requested', { ...sent, format: `${CUSTOM}é"` });
        await answer('requested', { ...sent, spNameQualifier: 'elsewhere' });
        await answer('requested', { ...sent, value: `${value} ` });
        await answer('requested', sent, `<saml:NameID>${value}</saml:NameID>`);
        expect(lines()).toHaveLength(4);
        // Nothing in what came ends its quotes.
        expect(lines()[0]).toContain(`"${CUSTOM}??"`);
        expect(lines()[0]).toContain(FORMATS[expected]);
        expect(lines()[0]).toContain('CCMS_SAML_NAME_ID_FORMAT');
        expect(lines()[1]).toContain('SPNameQualifier');
        expect(lines()[1]).toContain('elsewhere');
        expect(lines()[1]).toContain(here());
        for (const line of lines()) {
          expect(line).toMatch(/^[\x20-\x7e]+$/);
          expect(line).not.toContain(value);
        }
      } finally {
        warn.mockRestore();
      }
    });

    const changes = [
      ...Object.values(FORMATS)
        .filter((format) => format !== FORMATS[expected])
        .map((format) => `Format="${format}"`),
      `Format="${TRANSIENT}"`,
      `Format="${CUSTOM}"`,
      `Format="${FORMATS[expected]}" SPNameQualifier="elsewhere"`,
    ];
    it.each(
      changes.flatMap((policy) => [
        [policy, 'active'] as const,
        [policy, 'deactivated'] as const,
      ]),
    )(
      'refuses what the provider answers when asked for %s instead, whoever asks (a user who is %s)',
      async (policy, state) => {
        const user = await userOf((await signIn()).session);
        const { db } = s.t.database;
        const set = (deactivatedAt: Date | null) =>
          db.update(users).set({ deactivatedAt }).where(eq(users.id, user));
        if (state === 'deactivated') await set(new Date());
        try {
          const before = await made();
          expect(await signIn(withPolicy(policy))).toEqual(FAILED());
          expect(await made()).toEqual(before);
          const own = await signIn();
          if (state === 'deactivated') {
            expect(own.to).toBe(`${s.base}/sign-in?error=user-deactivated`);
          } else {
            expect(await userOf(own.session)).toBe(user);
          }
        } finally {
          await set(null);
        }
      },
    );

    describe('the text', () => {
      /** The user a name ID with this text signs in, and their email address as stored. */
      async function userWith(value: string) {
        const res = await s.t
          .anonymous()
          .post('/auth/saml/callback')
          .type('form')
          .send({
            SAMLResponse: s.mock.answer({
              login: 'someone',
              nameId: { value, format: FORMATS[expected] },
              // Never taken for the NameID's Format.
              attributes: { nameIDFormat: FORMATS.emailAddress },
            }),
          })
          .expect('location', `${s.base}/`);
        const session = setCookies(res).find((line) =>
          line.startsWith(`${SESSION_COOKIE}=ccms_ses_`),
        );
        const me = await s.t
          .anonymous()
          .get('/me')
          .set('Cookie', cookiePair(session!));
        const { id } = ActorDocument.parse(me.body).data;
        const [row] = await s.t.database.db
          .select({ email: users.email })
          .from(users)
          .where(eq(users.id, id));
        return { id, email: row!.email };
      }

      const email = expected === 'emailAddress';
      it('is the email address only when the Format says it is one', async () => {
        expect((await userWith('nina@example.org')).email).toBe(
          email ? 'nina@example.org' : null,
        );
      });

      it('counts without regard to case only as an email address, and only in ASCII', async () => {
        const anna = await userWith('Anna@Example.org');
        const lower = await userWith('anna@example.org');
        expect(lower.id === anna.id).toBe(email);
        // A Kelvin sign, which Unicode lower-cases to a k.
        const kelvin = await userWith('\u212aate@example.org');
        expect((await userWith('kate@example.org')).id).not.toBe(kelvin.id);
      });

      it('is taken as it is otherwise, up to 256 characters', async () => {
        const long = 'x'.repeat(256);
        expect((await userWith(long)).id).not.toBe(
          (await userWith(`${long.slice(1)}y`)).id,
        );
        expect((await userWith('a b')).id).not.toBe(
          (await userWith('a  b')).id,
        );
      });
    });
  });
}
