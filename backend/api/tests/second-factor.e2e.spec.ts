import { eq } from 'drizzle-orm';
import { UserPageDocument } from '../src/access/api/access.resources.js';
import {
  SignedInDocument,
  SignInLinkMadeDocument,
} from '../src/access/api/password.resources.js';
import {
  RecoveryCodesDocument,
  SecondFactorDocument,
  SecondFactorOnDocument,
  SecondFactorSetUpDocument,
  SecondStepDocument,
  SecondStepDoneDocument,
  SecondStepSetUpDoneDocument,
} from '../src/access/api/second-factor.resources.js';
import {
  SECOND_FACTOR_COOKIE,
  SESSION_COOKIE,
} from '../src/access/api/session-cookies.js';
import {
  SignInWithEmailCodeAction,
  SignInWithEmailLinkAction,
} from '../src/access/core/actions/email-code.action.js';
import { PasswordSignInAction } from '../src/access/core/actions/password-sign-in.action.js';
import { SetPasswordWithLinkAction } from '../src/access/core/actions/sign-in-links.action.js';
import {
  BeginRequiredSetUpAction,
  ConfirmRequiredSetUpAction,
  ReadSecondStepAction,
  VerifySecondStepAction,
} from '../src/access/core/actions/second-factor-sign-in.action.js';
import {
  BeginSetUpAction,
  ConfirmSetUpAction,
  ProvenChange,
} from '../src/access/core/actions/second-factor.action.js';
import type { Actor } from '../src/access/core/actor.js';
import {
  EmailCodeHasher,
  EmailCodes,
  mintEmailCode,
} from '../src/access/core/email-codes.js';
import { PasswordHasher, PasswordStore } from '../src/access/core/passwords.js';
import { totpCode, totpStep } from '../src/access/core/totp.js';
import {
  pendingSignIns,
  secondFactorRecoveryCodes,
  secondFactors,
} from '../src/access/repos/second-factors.tables.js';
import { Seed, seedAccess } from '../src/access/repos/seed.js';
import { sessions } from '../src/access/repos/sign-in.tables.js';
import { auditEvents } from '../src/audit/repos/audit.tables.js';
import { ErrorDocument, JSON_API } from '../src/base/api/json-api.js';
import { UnitOfWork } from '../src/base/core/unit-of-work.js';
import { createTestDatabase, type PgliteDatabase } from './database.js';
import { actorWith } from './fakes/actors.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * Two-factor sign-in (#611), end to end: no session and no API access before the second step,
 * whichever first factor was given; the cookie that binds it to the browser; the lockout, across
 * a restart and whatever limit the settings have (`CCMS_PASSWORD_FAILURES_MAX=50`); the required
 * set-up; an admin's reset.
 */
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const ORIGIN = 'https://docs.example.com';
const PASSWORD = 'a long and quiet river';
const admin: Actor = { ...actorWith(['admin.roles']), id: 'two-admin' };
const ENV = {
  CCMS_PASSWORD_SIGN_IN: 'on',
  CCMS_AUTH_FAILURES_MAX: '0',
  // Above a second factor's own limit, which holds.
  CCMS_PASSWORD_FAILURES_MAX: '50',
  // Codes by email offered (nothing is sent: the jobs never run here).
  CCMS_MAIL_URL: 'smtp://127.0.0.1:2525',
  CCMS_MAIL_FROM: 'docs@example.com',
  CCMS_PUBLIC_URL: `${ORIGIN}/`,
};
const PEOPLE = [
  'ann',
  'bea',
  'cem',
  'dan',
  'eva',
  'fay',
  'gil',
  'hal',
  'ida',
  'jan',
] as const;

let database: PgliteDatabase;
let t: TestApp;
/** The server's clock for codes, moved on by the tests. */
let now: number;

/** Starts the app on the database, its clock the test's; restarting loses everything in memory. */
async function start(): Promise<void> {
  t = await createTestApp(ENV, { database: kept() });
  for (const action of [
    PasswordSignInAction,
    SetPasswordWithLinkAction,
    SignInWithEmailCodeAction,
    SignInWithEmailLinkAction,
    ReadSecondStepAction,
    VerifySecondStepAction,
    BeginRequiredSetUpAction,
    ConfirmRequiredSetUpAction,
    BeginSetUpAction,
    ConfirmSetUpAction,
    ProvenChange,
  ]) {
    t.app.get<{ now: () => number }>(action, { strict: false }).now = () => now;
  }
}

/** The test's database, closing nothing when the app does. */
function kept(): PgliteDatabase {
  const open = Object.create(database) as PgliteDatabase;
  open.close = () => Promise.resolve();
  return open;
}

beforeAll(async () => {
  now = Date.now();
  database = await createTestDatabase();
  await start();
  await seedAccess(
    database,
    Seed.parse({
      roles: [...admin.roles],
      users: [
        {
          id: admin.id,
          name: 'Two Admin',
          email: 'two-admin@example.org',
          roles: admin.roles.map((r) => r.id),
        },
        ...PEOPLE.map((id) => ({
          id,
          name: `Person ${id}`,
          email: `${id}@example.org`,
          roles: [],
        })),
      ],
    }),
  );
  const hash = await t.app
    .get(PasswordHasher, { strict: false })
    .hash(PASSWORD);
  const store = t.app.get(PasswordStore, { strict: false });
  await unit().run(async (tx) => {
    for (const id of [...PEOPLE, admin.id]) await store.set(tx, id, hash);
  });
});
afterAll(async () => {
  await t?.close();
  await database?.close();
});
afterEach(() => t?.actAs(undefined));

const unit = () => t.app.get(UnitOfWork, { strict: false });
const error = (body: unknown) => ErrorDocument.parse(body).errors[0];
type Answer = { headers: Record<string, unknown> };

/** A public POST from the editor's origin, with the browser's cookies when given. */
const post = (path: string, body: unknown, cookie = '', origin = ORIGIN) => {
  const req = t
    .anonymous()
    .post(path)
    .set('Content-Type', JSON_API)
    .set('Origin', origin);
  if (cookie) req.set('Cookie', cookie);
  return req.send(JSON.stringify(body));
};
const get = (path: string, cookie = '') => {
  const req = t.anonymous().get(path);
  return cookie ? req.set('Cookie', cookie) : req;
};
const setCookies = (res: Answer) =>
  (res.headers['set-cookie'] as string[] | undefined) ?? [];
const cookieNamed = (res: Answer, name: string) =>
  setCookies(res)
    .find((c) => c.startsWith(`${name}=`))
    ?.split(';', 1)[0];
const sessionOf = (res: Answer) => cookieNamed(res, SESSION_COOKIE);
const stepOf = (res: Answer) => cookieNamed(res, SECOND_FACTOR_COOKIE);

const signIn = (id: string, password = PASSWORD) =>
  post('/auth/password/sign-in', {
    data: {
      type: 'PasswordSignIn',
      attributes: { email: `${id}@example.org`, password },
    },
  });
const codeBody = (code: string) => ({
  data: { type: 'SecondFactorCode', attributes: { code } },
});
const verify = (code: string, cookie?: string) =>
  post('/auth/second-factor/verify', codeBody(code), cookie);
const proof = (attributes: { password?: string; code?: string }) => ({
  data: { type: 'SecondFactorProof', attributes },
});

/** The app's next code: a step further each time, so each is new. */
function next(secret: string): string {
  now += 30_000;
  return totpCode(secret, totpStep(now));
}

/** Signs `id` in with the password alone, and sets its second factor up. */
async function turnOn(id: string) {
  const session = sessionOf(await signIn(id).expect(200))!;
  const begun = SecondFactorSetUpDocument.parse(
    (
      await post(
        '/me/second-factor/set-up',
        {
          data: {
            type: 'SecondFactorSetUp',
            attributes: { password: PASSWORD },
          },
        },
        session,
      ).expect(200)
    ).body,
  ).meta;
  const on = SecondFactorOnDocument.parse(
    (
      await post(
        '/me/second-factor/confirm',
        codeBody(next(begun.secret)),
        session,
      ).expect(200)
    ).body,
  ).meta;
  return { session, ...begun, ...on };
}

/** The right password of `id`, answered with its second step's cookie. */
async function firstStep(id: string, step = 'verify'): Promise<string> {
  const res = await signIn(id).expect(200);
  expect(SignedInDocument.parse(res.body).meta).toEqual({
    userId: null,
    secondFactor: step,
  });
  return stepOf(res)!;
}

async function rule(secondFactor: 'optional' | 'admins' | 'everyone') {
  t.actAs(admin);
  const res = await t.patch('/settings').send(
    JSON.stringify({
      data: { type: 'InstallationSettings', attributes: { secondFactor } },
    }),
  );
  t.actAs(undefined);
  expect(res.status).toBe(200);
}

describe('two-factor sign-in (#611)', () => {
  it('is set up from the account menu: a QR code, a code, recovery codes once', async () => {
    const session = sessionOf(await signIn('ann').expect(200))!;
    const read = async () =>
      SecondFactorDocument.parse(
        (await get('/me/second-factor', session).expect(200)).body,
      ).data;
    expect(await read()).toMatchObject({
      attributes: { enabledAt: null },
      meta: { required: false, available: true, hasPassword: true },
    });
    const ask = (attributes: object) =>
      post(
        '/me/second-factor/set-up',
        { data: { type: 'SecondFactorSetUp', attributes } },
        session,
      );
    const wrong = await ask({ password: 'not it' });
    expect([wrong.status, error(wrong.body)?.code]).toEqual([
      403,
      'wrong-password',
    ]);
    const res = await ask({ password: PASSWORD }).expect(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const begun = SecondFactorSetUpDocument.parse(res.body).meta;
    expect(begun.otpauthUrl).toBe(
      `otpauth://totp/OpenFolia:ann%40example.org?secret=${begun.secret}&issuer=OpenFolia&algorithm=SHA1&digits=6&period=30`,
    );
    expect(begun.qrCode).toContain('<svg');
    // Sealed at rest, never in the clear.
    const [row] = await database.db
      .select()
      .from(secondFactors)
      .where(eq(secondFactors.userId, 'ann'));
    expect(row?.sealedSecret).toMatch(/^v1\./);
    expect(row?.sealedSecret).not.toContain(begun.secret);
    const other = sessionOf(await signIn('ann').expect(200))!;
    const on = SecondFactorOnDocument.parse(
      (
        await post(
          '/me/second-factor/confirm',
          codeBody(next(begun.secret)),
          session,
        ).expect(200)
      ).body,
    ).meta;
    expect(on.recoveryCodes).toHaveLength(10);
    expect(on.sessionsEnded).toBe(1);
    await get('/me', other).expect(401);
    await get('/me', session).expect(200);
    // Hashed at rest.
    const stored = await database.db
      .select()
      .from(secondFactorRecoveryCodes)
      .where(eq(secondFactorRecoveryCodes.userId, 'ann'));
    expect(stored).toHaveLength(10);
    const own = await read();
    expect(own.attributes.enabledAt).not.toBeNull();
    expect(own.meta?.recoveryCodesLeft).toBe(10);
    expect(JSON.stringify(own)).not.toContain(begun.secret);
    t.actAs(admin);
    const listed = await t.get('/users?filter[q]=ann@example.org').expect(200);
    expect(
      UserPageDocument.parse(listed.body).data[0]?.meta?.signIn?.secondFactor,
    ).toBe(true);
  });

  it('gives no session and no API access before the second step', async () => {
    const { secret } = await turnOn('bea');
    const theirs = () =>
      database.db.select().from(sessions).where(eq(sessions.userId, 'bea'));
    const before = await theirs();
    const res = await signIn('bea').expect(200);
    expect(sessionOf(res)).toBeUndefined();
    const set = setCookies(res);
    expect(set).toHaveLength(1);
    expect(set[0]).toMatch(
      /^__Host-openfolia-second-factor=ccms_2fa_[0-9a-f]{64}; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=600$/,
    );
    const step = stepOf(res)!;
    const token = step.split('=')[1]!;
    expect(await theirs()).toHaveLength(before.length);
    // Only its hash is kept.
    const open = await database.db.select().from(pendingSignIns);
    expect(JSON.stringify(open)).not.toContain(token);
    // Its cookie is no session, under its own name, the session's, or as a bearer token.
    for (const [path, cookie] of [
      ['/me', step],
      ['/me', `${SESSION_COOKIE}=${token}`],
      ['/me/second-factor', step],
      ['/manuals', step],
    ] as const) {
      await get(path, cookie).expect(401);
    }
    await t
      .anonymous()
      .get('/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(401);
    // Nor does it change anything of the account.
    await post(
      '/me/second-factor/turn-off',
      proof({ password: PASSWORD }),
      step,
    ).expect(401);

    expect(
      SecondStepDocument.parse(
        (await get('/auth/second-factor', step).expect(200)).body,
      ).meta,
    ).toMatchObject({ secondFactor: 'verify', email: 'bea@example.org' });

    const wrong = await verify('000000', step);
    expect([wrong.status, error(wrong.body)?.code]).toEqual([
      403,
      'wrong-code',
    ]);
    const code = next(secret);
    const done = await verify(code, step).expect(200);
    expect(SecondStepDoneDocument.parse(done.body).meta.userId).toBe('bea');
    expect(
      setCookies(done).some((c) => c.startsWith(`${SECOND_FACTOR_COOKIE}=;`)),
    ).toBe(true);
    await get('/me', sessionOf(done)).expect(200);
    // Used once.
    const again = await verify(next(secret), step);
    expect([again.status, error(again.body)?.code]).toEqual([
      410,
      'second-factor-expired',
    ]);
    // The code too, in another sign-in.
    const replayed = await verify(code, await firstStep('bea'));
    expect([replayed.status, error(replayed.body)?.code]).toEqual([
      403,
      'wrong-code',
    ]);
  });

  it('is bound to this browser, to the editor, and to ten minutes', async () => {
    const { secret } = await turnOn('cem');
    const step = await firstStep('cem');
    const gone = async (cookie?: string) => {
      const res = await verify(next(secret), cookie);
      expect([res.status, error(res.body)?.code]).toEqual([
        410,
        'second-factor-expired',
      ]);
    };
    await gone();
    await gone(`${SECOND_FACTOR_COOKIE}=ccms_2fa_${'0'.repeat(64)}`);
    // Two of one name: neither is trusted.
    await gone(`${step}; ${step}`);
    for (const path of ['verify', 'set-up', 'confirm']) {
      const res = await post(
        `/auth/second-factor/${path}`,
        codeBody(next(secret)),
        step,
        'https://elsewhere.example.org',
      );
      expect([res.status, error(res.body)?.code]).toEqual([
        403,
        'cross-origin-request',
      ]);
    }
    now += 600_000;
    await gone(step);
  });

  it('stands before every way in that ends here', async () => {
    const { secret } = await turnOn('dan');
    // A code by email, and its link.
    const hasher = t.app.get(EmailCodeHasher, { strict: false });
    const codes = t.app.get(EmailCodes, { strict: false });
    const mailed = async () => {
      const minted = mintEmailCode();
      await unit().run((tx) =>
        codes.replace(tx, {
          userId: 'dan',
          codeHash: hasher.hash('dan', minted.code),
          linkHash: minted.linkHash,
          sentTo: 'dan@example.org',
          expiresAt: new Date(now + 600_000),
        }),
      );
      return minted;
    };
    /** An admin's reset link or invite: a new password, the same second factor. */
    const setWith = async (kind: string) => {
      t.actAs(admin);
      const made = await t.post(`/users/dan/${kind}`).expect(201);
      t.actAs(undefined);
      return post('/auth/password/set', {
        data: {
          type: 'PasswordSet',
          attributes: {
            token: SignInLinkMadeDocument.parse(made.body).meta.token,
            password: PASSWORD,
          },
        },
      }).expect(200);
    };
    const ways: Record<string, () => Promise<Answer & { body: unknown }>> = {
      code: async () =>
        post('/auth/email-code/sign-in', {
          data: {
            type: 'EmailCodeSignIn',
            attributes: {
              email: 'dan@example.org',
              code: (await mailed()).code,
            },
          },
        }).expect(200),
      link: async () =>
        post('/auth/email-code/link', {
          data: {
            type: 'EmailCodeLink',
            attributes: { token: (await mailed()).linkToken },
          },
        }).expect(200),
      'password-reset': () => setWith('password-reset'),
      invite: () => setWith('invite'),
    };
    for (const [way, enter] of Object.entries(ways)) {
      const res = await enter();
      expect(SignedInDocument.parse(res.body).meta, way).toEqual({
        userId: null,
        secondFactor: 'verify',
      });
      expect(sessionOf(res), way).toBeUndefined();
      const done = await verify(next(secret), stepOf(res)).expect(200);
      await get('/me', sessionOf(done)).expect(200);
    }
    const signIns = (await database.db.select().from(auditEvents))
      .filter((e) => e.action === 'user.sign-in' && e.subjectId === 'dan')
      .map((e) => e.data);
    expect(signIns.slice(-4)).toEqual([
      {
        method: 'email-code',
        provider: 'email-code',
        via: 'code',
        secondFactor: 'totp',
      },
      {
        method: 'email-code',
        provider: 'email-code',
        via: 'link',
        secondFactor: 'totp',
      },
      { method: 'password', provider: 'password', secondFactor: 'totp' },
      { method: 'password', provider: 'password', secondFactor: 'totp' },
    ]);
  });

  it('locks wrong codes out for the person: a new password step resets nothing, nor does a restart', async () => {
    const { secret, recoveryCodes, session } = await turnOn('eva');
    let step = await firstStep('eva');
    // Codes and recovery codes count together, whichever step or page they are typed in.
    for (let i = 0; i < 3; i++) {
      expect((await verify('000000', step)).status).toBe(403);
    }
    for (let i = 0; i < 4; i++) {
      // Each with a step of its own: the right password, again.
      step = await firstStep('eva');
      const wrong = i % 2 === 0 ? '0000-0000-0000-0000' : '000000';
      expect((await verify(wrong, step)).status).toBe(403);
    }
    for (let i = 0; i < 3; i++) {
      const res = await post(
        '/me/second-factor/turn-off',
        proof({ code: '000000' }),
        session,
      );
      expect(res.status).toBe(403);
    }
    const locked = async () => {
      // The step open so far, and a new one: neither takes a right code now.
      for (const open of [step, await firstStep('eva')]) {
        for (const code of [next(secret), recoveryCodes[0]!]) {
          const res = await verify(code, open);
          expect([res.status, error(res.body)?.code]).toEqual([
            429,
            'too-many-failed-attempts',
          ]);
          expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
        }
      }
    };
    await locked();
    // Another server, or this one restarted: the same database, nothing else.
    await t.close();
    await start();
    await locked();
    // Someone else is not locked.
    const other = await turnOn('fay');
    await verify(next(other.secret), await firstStep('fay')).expect(200);
  });

  it('a right code gives nothing back of the wrong ones before it', async () => {
    const { secret } = await turnOn('jan');
    const step = await firstStep('jan');
    for (let i = 0; i < 9; i++) {
      expect((await verify('000000', step)).status).toBe(403);
    }
    await verify(next(secret), step).expect(200);
    expect((await verify('000000', await firstStep('jan'))).status).toBe(403);
    expect((await verify(next(secret), await firstStep('jan'))).status).toBe(
      429,
    );
  });

  it('takes a recovery code once, and new ones replace the earlier', async () => {
    const { session, recoveryCodes } = await turnOn('gil');
    const [used, unused] = recoveryCodes as [string, string];
    await verify(used, await firstStep('gil')).expect(200);
    const again = await verify(used, await firstStep('gil'));
    expect(error(again.body)?.code).toBe('wrong-code');
    const none = await post(
      '/me/second-factor/recovery-codes',
      proof({}),
      session,
    );
    expect(none.status).toBe(400);
    const made = RecoveryCodesDocument.parse(
      (
        await post(
          '/me/second-factor/recovery-codes',
          proof({ password: PASSWORD }),
          session,
        ).expect(200)
      ).body,
    ).meta.recoveryCodes;
    expect((await verify(unused, await firstStep('gil'))).status).toBe(403);
    await verify(made[0]!, await firstStep('gil')).expect(200);
  });

  it('turns off with the password or a code, never without', async () => {
    const { session, secret } = await turnOn('hal');
    const off = (attributes: { password?: string; code?: string }) =>
      post('/me/second-factor/turn-off', proof(attributes), session);
    expect((await off({})).status).toBe(400);
    expect((await off({ password: 'x', code: '123456' })).status).toBe(400);
    const wrong = await off({ password: 'not it' });
    expect([wrong.status, error(wrong.body)?.code]).toEqual([
      403,
      'wrong-password',
    ]);
    await off({ code: next(secret) }).expect(204);
    expect(
      SignedInDocument.parse((await signIn('hal').expect(200)).body).meta,
    ).toEqual({ userId: 'hal', secondFactor: null });
  });

  it('required, is set up before anything else, and an admin resets it', async () => {
    await rule('everyone');
    try {
      const res = await signIn('ida').expect(200);
      expect(SignedInDocument.parse(res.body).meta).toEqual({
        userId: null,
        secondFactor: 'set-up',
      });
      expect(sessionOf(res)).toBeUndefined();
      const step = stepOf(res)!;
      await get('/me', step).expect(401);
      expect((await verify('123456', step)).status).toBe(410);
      const early = await post(
        '/auth/second-factor/confirm',
        codeBody('123456'),
        step,
      );
      expect(error(early.body)?.code).toBe('second-factor-not-begun');
      const begun = SecondFactorSetUpDocument.parse(
        (await post('/auth/second-factor/set-up', {}, step).expect(200)).body,
      ).meta;
      const wrong = await post(
        '/auth/second-factor/confirm',
        codeBody('000000'),
        step,
      );
      expect(error(wrong.body)?.code).toBe('wrong-code');
      await get('/me', step).expect(401);
      const done = await post(
        '/auth/second-factor/confirm',
        codeBody(next(begun.secret)),
        step,
      ).expect(200);
      expect(SecondStepSetUpDoneDocument.parse(done.body).meta).toMatchObject({
        userId: 'ida',
      });
      const session = sessionOf(done)!;
      await get('/me', session).expect(200);
      expect(
        SecondFactorDocument.parse(
          (await get('/me/second-factor', session).expect(200)).body,
        ).data.meta?.required,
      ).toBe(true);

      t.actAs(admin);
      await t.delete('/users/ida/second-factor').expect(204);
      expect((await t.delete('/users/ida/second-factor')).status).toBe(404);
      const own = await t.delete(`/users/${admin.id}/second-factor`);
      expect([own.status, error(own.body)?.code]).toEqual([
        409,
        'second-factor-own',
      ]);
      t.actAs(undefined);
      // Required: set up anew at once.
      await firstStep('ida', 'set-up');
    } finally {
      await rule('optional');
    }
    expect((await signIn('ida').expect(200)).body).toMatchObject({
      meta: { userId: 'ida' },
    });
  });

  it('lets an admin who signs in here require it only with theirs on', async () => {
    const require = (session: string, secondFactor: string) =>
      t
        .anonymous()
        .patch('/settings')
        .set('Content-Type', JSON_API)
        .set('Origin', ORIGIN)
        .set('Cookie', session)
        .send(
          JSON.stringify({
            data: {
              type: 'InstallationSettings',
              attributes: { secondFactor },
            },
          }),
        );
    const session = sessionOf(await signIn(admin.id).expect(200))!;
    const refused = await require(session, 'admins');
    expect([refused.status, error(refused.body)?.code]).toEqual([
      409,
      'second-factor-own-first',
    ]);
    const on = await turnOn(admin.id);
    await require(on.session, 'admins').expect(200);
    // Only the admins.
    expect((await signIn('hal').expect(200)).body).toMatchObject({
      meta: { secondFactor: null },
    });
    await require(on.session, 'optional').expect(200);
  });

  it('leaves no secret, code or token in the audit log', async () => {
    const log = JSON.stringify(
      (await database.db.select().from(auditEvents)).map((e) => [
        e.action,
        e.data,
      ]),
    );
    expect(log).toContain('user.second-factor-on');
    expect(log).toContain('user.second-factor-reset');
    expect(log).not.toMatch(/ccms_2fa_|otpauth|[A-Z2-7]{32}/);
    expect(log).not.toMatch(/"[0-9a-z]{4}(-[0-9a-z]{4}){3}"/);
    expect(log).not.toMatch(/"code":/);
  });
});
