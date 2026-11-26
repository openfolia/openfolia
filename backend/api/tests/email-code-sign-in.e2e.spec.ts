import { eq } from 'drizzle-orm';
import { EmailCodeRequestedDocument } from '../src/access/api/email-code.resources.js';
import {
  SignedInDocument,
  SignInOptionsDocument,
} from '../src/access/api/password.resources.js';
import { SESSION_COOKIE } from '../src/access/api/session-cookies.js';
import type { Actor } from '../src/access/core/actor.js';
import { users } from '../src/access/repos/access.tables.js';
import { Seed, seedAccess } from '../src/access/repos/seed.js';
import { emailSignInCodes } from '../src/access/repos/email-codes.tables.js';
import { auditEvents } from '../src/audit/repos/audit.tables.js';
import { ErrorDocument, JSON_API } from '../src/base/api/json-api.js';
import { actorWith } from './fakes/actors.js';
import { startMailServer, type TestMailServer } from './mail-server.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * Signing in with a one-time code by email (#634), end to end: the email read from an SMTP
 * server, the code and the link, the same answer for any address, and 429 once the wrong codes
 * used up the address's tries (`CCMS_PASSWORD_FAILURES_MAX`, 3 here), which revokes the code.
 */
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const ORIGIN = 'https://docs.example.com';
const MAX = 3;
const admin: Actor = { ...actorWith(['admin.roles']), id: 'code-admin' };
const GOOD = 'a long and quiet river';
const NEWER = 'another long sentence here';

let server: TestMailServer;
let t: TestApp;

beforeAll(async () => {
  server = await startMailServer();
  t = await createTestApp({
    CCMS_PASSWORD_SIGN_IN: 'on',
    CCMS_PASSWORD_FAILURES_MAX: String(MAX),
    CCMS_MAIL_URL: `smtp://localhost:${server.port}`,
    CCMS_MAIL_FROM: 'docs@example.com',
    CCMS_MAIL_CA_FILE: server.caFile,
    CCMS_PUBLIC_URL: `${ORIGIN}/`,
  });
  await seedAccess(
    t.database,
    Seed.parse({
      roles: [...admin.roles],
      users: [
        {
          id: admin.id,
          name: 'Code Admin',
          roles: admin.roles.map((r) => r.id),
        },
        { id: 'pat', name: 'Pat Example', email: 'pat@example.org', roles: [] },
        { id: 'lee', name: 'Lee Example', email: 'lee@example.org', roles: [] },
        { id: 'sam', name: 'Sam Example', email: 'sam@example.org', roles: [] },
        { id: 'kim', name: 'Kim Example', email: 'kim@example.org', roles: [] },
        { id: 'ray', name: 'Ray Example', email: 'ray@example.org', roles: [] },
        { id: 'jo', name: 'Jo Example', email: 'jo@example.org', roles: [] },
        { id: 'max', name: 'Max Example', email: 'max@example.org', roles: [] },
      ],
    }),
  );
});
afterAll(async () => {
  await t?.close();
  await server?.close();
});
afterEach(() => t?.actAs(undefined));

const error = (body: unknown) => ErrorDocument.parse(body).errors[0];

/** A public POST from the editor's origin, with the browser's cookie when given. */
const post = (path: string, body: unknown, origin = ORIGIN) =>
  t
    .anonymous()
    .post(path)
    .set('Content-Type', JSON_API)
    .set('Origin', origin)
    .send(JSON.stringify(body));

const ask = (email: string, language?: string) =>
  post('/auth/email-code/request', {
    data: {
      type: 'EmailCodeRequest',
      attributes: { email, ...(language && { language }) },
    },
  });

const enter = (email: string, code: string) =>
  post('/auth/email-code/sign-in', {
    data: { type: 'EmailCodeSignIn', attributes: { email, code } },
  });

const follow = (token: string) =>
  post('/auth/email-code/link', {
    data: { type: 'EmailCodeLink', attributes: { token } },
  });

const cookieOf = (res: { headers: Record<string, unknown> }) => {
  const set = res.headers['set-cookie'] as string[] | undefined;
  const session = set?.find((c) => c.startsWith(`${SESSION_COOKIE}=`));
  return session?.split(';', 1)[0];
};

const me = (cookie: string) => t.anonymous().get('/me').set('Cookie', cookie);

/** Runs the queued jobs until the mail server has `count` messages, or gives up. */
async function mailArrives(count: number): Promise<void> {
  for (let i = 0; i < 100 && server.received.length < count; i++) {
    await t.runJobs();
    if (server.received.length < count) {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  expect(server.received.length).toBeGreaterThanOrEqual(count);
}

/** A message's text, quoted-printable soft breaks undone. */
function plain(raw: string): string {
  return raw
    .replace(/=\r?\n/g, '')
    .replace(/=([0-9A-F]{2})/g, (_, hex: string) =>
      String.fromCharCode(parseInt(hex, 16)),
    );
}

/** The code and the link's token in the newest message to `to`. */
async function codeFor(
  to: string,
): Promise<{ code: string; token: string; text: string }> {
  await mailArrives(server.received.length + 1);
  const mail = server.received.at(-1)!;
  expect(mail.to).toEqual([to]);
  const text = plain(mail.raw);
  const code = /^([0-9]{6})\r?$/m.exec(text)?.[1];
  const token = /sign-in-code#(ccms_ecl_[0-9a-f]{64})/.exec(text)?.[1];
  expect(code).toBeDefined();
  expect(token).toBeDefined();
  return { code: code!, token: token!, text };
}

describe('sign-in with a code by email (#634)', () => {
  it('offers "Email me a code" beside the password form', async () => {
    const res = await t.anonymous().get('/auth/options').expect(200);
    expect(SignInOptionsDocument.parse(res.body).data.attributes).toEqual({
      password: true,
      passwordReset: true,
      emailCode: true,
      providers: 0,
      singleSignOn: false,
      emergencySignIn: false,
    });
  });

  it('emails a code that signs in once, in the page’s language, and answers the same for any address', async () => {
    const known = await ask('pat@example.org', 'de').expect(202);
    expect(known.headers['cache-control']).toBe('no-store');
    const { code, text } = await codeFor('pat@example.org');
    expect(text).toContain('<html lang="de">');
    expect(text).toContain('Ihr Anmeldecode');
    const unknown = await ask('nobody@example.org').expect(202);
    expect(EmailCodeRequestedDocument.parse(known.body)).toEqual(
      EmailCodeRequestedDocument.parse(unknown.body),
    );
    // Only the hashes are stored.
    const [row] = await t.database.db.select().from(emailSignInCodes);
    expect(JSON.stringify(row)).not.toContain(code);

    const wrong = code === '000001' ? '000002' : '000001';
    const refused = await enter('pat@example.org', wrong);
    expect([refused.status, error(refused.body)?.code]).toEqual([
      401,
      'invalid-code',
    ]);
    const nobody = await enter('nobody@example.org', code);
    expect([nobody.status, error(nobody.body)?.code]).toEqual([
      401,
      'invalid-code',
    ]);

    const signedIn = await enter(
      'PAT@example.org',
      `${code.slice(0, 3)} ${code.slice(3)}`,
    ).expect(200);
    expect(SignedInDocument.parse(signedIn.body).meta.userId).toBe('pat');
    const cookie = cookieOf(signedIn)!;
    expect(cookie).toBeDefined();
    await me(cookie).expect(200);
    // Once only.
    expect((await enter('pat@example.org', code)).status).toBe(401);

    // Signed out like any session.
    await t
      .anonymous()
      .post('/auth/sign-out')
      .set('Origin', ORIGIN)
      .set('Cookie', cookie)
      .set('Content-Type', JSON_API)
      .expect(200);
    expect((await me(cookie)).status).toBe(401);

    const events = await t.database.db.select().from(auditEvents);
    const actions = events.map((e) => e.action);
    expect(actions).toContain('user.email-code-requested');
    const signIn = events.find(
      (e) => e.action === 'user.sign-in' && e.subjectId === 'pat',
    );
    expect(signIn?.data).toMatchObject({ method: 'email-code', via: 'code' });
    expect(JSON.stringify(events.map((e) => e.data))).not.toContain(code);
  });

  it('signs in with the link, which uses the code too; a new code revokes the earlier one', async () => {
    await ask('lee@example.org').expect(202);
    const first = await codeFor('lee@example.org');
    await ask('lee@example.org').expect(202);
    const second = await codeFor('lee@example.org');
    const old = await follow(first.token);
    expect([old.status, error(old.body)?.code]).toEqual([404, 'link-invalid']);

    const res = await follow(second.token).expect(200);
    await me(cookieOf(res)!).expect(200);
    expect((await follow(second.token)).status).toBe(404);
    expect((await enter('lee@example.org', second.code)).status).toBe(401);
  });

  it('answers 429 once the wrong codes used up the tries, and the code is revoked', async () => {
    await ask('sam@example.org').expect(202);
    const { code } = await codeFor('sam@example.org');
    const wrong = code === '000001' ? '000002' : '000001';
    for (let i = 0; i < MAX; i++) {
      expect((await enter('sam@example.org', wrong)).status).toBe(401);
    }
    const res = await enter('sam@example.org', code);
    expect([res.status, error(res.body)?.code]).toEqual([
      429,
      'too-many-failed-attempts',
    ]);
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    const rows = await t.database.db.select().from(emailSignInCodes);
    expect(rows.map((r) => r.userId)).not.toContain('sam');
    // The tries are the code's own budget: a password sign-in is still checked.
    const password = await post('/auth/password/sign-in', {
      data: {
        type: 'PasswordSignIn',
        attributes: { email: 'sam@example.org', password: 'not the password' },
      },
    });
    expect([password.status, error(password.body)?.code]).toEqual([
      401,
      'invalid-credentials',
    ]);
    // And a new code can still be asked for.
    await ask('sam@example.org').expect(202);
  });

  it('refuses another site', async () => {
    const res = await post(
      '/auth/email-code/request',
      {
        data: {
          type: 'EmailCodeRequest',
          attributes: { email: 'pat@example.org' },
        },
      },
      'https://elsewhere.example.net',
    );
    expect([res.status, error(res.body)?.code]).toEqual([
      403,
      'cross-origin-request',
    ]);
  });
});

describe('a code ends with the credentials it was asked under (#645)', () => {
  /** Invites `userId` as the admin and returns the link's token, its email delivered. */
  async function invite(userId: string): Promise<string> {
    const before = server.received.length;
    t.actAs(admin);
    const res = await t.post(`/users/${userId}/invite`).expect(201);
    t.actAs(undefined);
    await mailArrives(before + 1);
    return (res.body as { meta: { token: string } }).meta.token;
  }

  const setPassword = (token: string, password: string) =>
    post('/auth/password/set', {
      data: { type: 'PasswordSet', attributes: { token, password } },
    });

  /** Answers like a wrong code: nothing says the code ever was. */
  async function refusedLikeAWrongOne(email: string, code: string) {
    const res = await enter(email, code);
    expect([res.status, error(res.body)?.code]).toEqual([401, 'invalid-code']);
  }

  it('ends an open code when the password is set through a link, and when it is changed', async () => {
    const link = await invite('kim');
    await ask('kim@example.org').expect(202);
    const before = await codeFor('kim@example.org');
    const set = await setPassword(link, GOOD).expect(200);
    await refusedLikeAWrongOne('kim@example.org', before.code);
    expect((await follow(before.token)).status).toBe(404);

    await ask('kim@example.org').expect(202);
    const open = await codeFor('kim@example.org');
    await post('/me/password', {
      data: {
        type: 'PasswordChange',
        attributes: { currentPassword: GOOD, newPassword: NEWER },
      },
    })
      .set('Cookie', cookieOf(set)!)
      .expect(200);
    await refusedLikeAWrongOne('kim@example.org', open.code);
    expect((await follow(open.token)).status).toBe(404);
  });

  it('ends an open code when the account is deactivated', async () => {
    await ask('ray@example.org').expect(202);
    const { code } = await codeFor('ray@example.org');
    t.actAs(admin);
    await t.post('/users/ray/deactivate').expect(200);
    t.actAs(undefined);
    await refusedLikeAWrongOne('ray@example.org', code);
    const rows = await t.database.db.select().from(emailSignInCodes);
    expect(rows.map((r) => r.userId)).not.toContain('ray');
  });

  it('ends an open code when the address changes, for the old address and the new one', async () => {
    await ask('jo@example.org').expect(202);
    const { code, token } = await codeFor('jo@example.org');
    t.actAs(admin);
    await t
      .patch('/users/jo')
      .send(
        JSON.stringify({
          data: {
            type: 'User',
            id: 'jo',
            attributes: { email: 'jo.new@example.org' },
          },
        }),
      )
      .expect(200);
    t.actAs(undefined);
    await refusedLikeAWrongOne('jo@example.org', code);
    await refusedLikeAWrongOne('jo.new@example.org', code);
    expect((await follow(token)).status).toBe(404);
  });

  it('refuses a code stored for the old address while the address changed (#646)', async () => {
    await ask('max@example.org').expect(202);
    const { code, token } = await codeFor('max@example.org');
    // Where the race leaves it: the request read Max under the old address and stored its code
    // after the address change had ended the open one, so the change never saw this code.
    await t.database.db
      .update(users)
      .set({ email: 'max.new@example.org' })
      .where(eq(users.id, 'max'));
    await refusedLikeAWrongOne('max.new@example.org', code);
    await refusedLikeAWrongOne('max@example.org', code);
    expect((await follow(token)).status).toBe(404);
  });
});
