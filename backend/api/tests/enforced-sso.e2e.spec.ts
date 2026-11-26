import { createServer, type AddressInfo } from 'node:net';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { ActorDocument } from '../src/access/api/access.resources.js';
import {
  SignedInDocument,
  SignInLinkMadeDocument,
  SignInOptionsDocument,
} from '../src/access/api/password.resources.js';
import {
  SECOND_FACTOR_COOKIE,
  SESSION_COOKIE,
} from '../src/access/api/session-cookies.js';
import type { Actor } from '../src/access/core/actor.js';
import {
  EmailCodeHasher,
  EmailCodes,
  mintEmailCode,
} from '../src/access/core/email-codes.js';
import {
  IdentityProviders,
  SignInFailedError,
} from '../src/access/core/identity-provider.js';
import {
  hashPendingSignIn,
  mintPendingSignIn,
} from '../src/access/core/pending-sign-ins.js';
import { PasswordHasher, PasswordStore } from '../src/access/core/passwords.js';
import { RefusedSignIns } from '../src/access/core/refused-sign-ins.js';
import { mintSessionToken } from '../src/access/core/sessions.js';
import { mintServiceToken } from '../src/access/core/service-token.js';
import {
  roleAssignments,
  roles,
  users,
} from '../src/access/repos/access.tables.js';
import { emailSignInCodes } from '../src/access/repos/email-codes.tables.js';
import {
  signInLinks,
  userPasswords,
} from '../src/access/repos/passwords.tables.js';
import { pendingSignIns } from '../src/access/repos/second-factors.tables.js';
import { Seed, seedAccess } from '../src/access/repos/seed.js';
import {
  serviceAccountRoles,
  serviceAccounts,
  serviceTokens,
} from '../src/access/repos/service-accounts.tables.js';
import { SignInAtStart } from '../src/access/repos/sign-in-at-start.js';
import { sessions } from '../src/access/repos/sign-in.tables.js';
import { auditEvents } from '../src/audit/repos/audit.tables.js';
import { ErrorDocument, JSON_API } from '../src/base/api/json-api.js';
import { UnitOfWork } from '../src/base/core/unit-of-work.js';
import { outbox } from '../src/change-sets/repos/outbox.tables.js';
import { mailMessages } from '../src/mail/repos/mail.tables.js';
import { scimUsers } from '../src/scim/repos/scim.tables.js';
import { InstallationSettingsDocument } from '../src/settings/api/settings.resources.js';
import { installationSettings } from '../src/settings/repos/installation-settings.tables.js';
import type { PgliteDatabase } from './database.js';
import { actorWith } from './fakes/actors.js';
import { startMockProvider, type MockProvider } from './oidc/mock-provider.js';
import { type CookieJar, signInThroughMock } from './oidc/sign-in-driver.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * Enforced single sign-on and the session limits (#378), end to end: the real app with a real
 * (local) provider, passwords and codes by email all on. Every way in but the provider's is
 * refused, whatever was begun before; one named account keeps its password, as long as it is an
 * administrator's; nobody locks everyone out.
 */
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const PASSWORD = 'a long and quiet river';
const PEOPLE = ['pat', 'sam', 'kim', 'rescue', 'via-group'] as const;

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
let passwordHash: string;
/** The administrator's session, begun at the provider. */
let root: string;

beforeAll(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  mock = await startMockProvider({
    clientId: 'openfolia-test',
    clientSecret: 'test-client-secret-0123456789',
    redirectUris: [`${base}/auth/oidc/callback`],
    postLogoutRedirectUris: [`${base}/sign-in`],
    accounts: {
      root: { name: 'Root', email: 'root@example.org' },
      new: { name: 'New Person', email: 'new@example.org' },
    },
  });
  t = await createTestApp({
    CCMS_OIDC_ISSUER: mock.issuer,
    CCMS_OIDC_CLIENT_ID: 'openfolia-test',
    CCMS_OIDC_CLIENT_SECRET: 'test-client-secret-0123456789',
    CCMS_OIDC_REDIRECT_URL: `${base}/auth/oidc/callback`,
    CCMS_PASSWORD_SIGN_IN: 'on',
    CCMS_PASSWORD_FAILURES_MAX: '0',
    CCMS_MAIL_URL: 'smtp://127.0.0.1:2525',
    CCMS_MAIL_FROM: 'docs@example.com',
    CCMS_PUBLIC_URL: `${base}/`,
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
          id: 'reader',
          name: 'Reader',
          permissions: ['content.read'],
          scope: {},
        },
      ],
      users: [
        {
          id: 'root',
          name: 'Root',
          email: 'root@example.org',
          roles: ['admin'],
        },
        ...PEOPLE.map((id) => ({
          id,
          name: `Person ${id}`,
          email: `${id}@example.org`,
          roles: id === 'rescue' ? ['admin'] : ['reader'],
        })),
      ],
    }),
  );
  await t.database.db.insert(roleAssignments).values({
    userId: 'via-group',
    roleId: 'admin',
    direct: false,
    viaGroups: true,
  });
  passwordHash = await t.app
    .get(PasswordHasher, { strict: false })
    .hash(PASSWORD);
  await unit().run(async (tx) => {
    for (const id of PEOPLE) await passwords().set(tx, id, passwordHash);
  });
  await t.app.listen(port, '127.0.0.1');
});
afterAll(async () => {
  await t?.close();
  await mock?.close();
});

beforeEach(async () => {
  // Every test starts with nothing set, no session and no account changed by another.
  const db = t.database.db;
  await db.delete(installationSettings);
  await db.delete(pendingSignIns);
  await db.delete(signInLinks);
  await db.delete(emailSignInCodes);
  await db.delete(sessions);
  root = sessionOf((await atProvider('root')).cookie);
});
afterEach(() => {
  vi.restoreAllMocks();
  t.actAs(undefined);
});

const unit = () => t.app.get(UnitOfWork, { strict: false });
const passwords = () => t.app.get(PasswordStore, { strict: false });
const error = (body: unknown) => ErrorDocument.parse(body).errors[0];
type Answer = {
  status: number;
  body: unknown;
  headers: Record<string, unknown>;
};
/** A refusal's status and code, for one expectation. */
const refusal = (res: Answer) => [res.status, error(res.body)?.code];

async function atProvider(login: string, jar?: CookieJar) {
  const result = await signInThroughMock({
    signInUrl: `${base}/auth/oidc/sign-in`,
    login,
    ...(jar && { jar }),
  });
  return { ...result, cookie: result.cookieHeader(base) };
}
const sessionOf = (cookie: string) =>
  cookie.split('; ').find((c) => c.startsWith(`${SESSION_COOKIE}=`)) ?? '';

const send = (
  method: 'post' | 'patch' | 'delete',
  path: string,
  body: unknown,
  cookie = '',
) => {
  const req = t
    .anonymous()
    [method](path)
    .set('Content-Type', JSON_API)
    .set('Origin', base);
  if (cookie) req.set('Cookie', cookie);
  return req.send(JSON.stringify(body));
};
const me = (cookie: string) => t.anonymous().get('/me').set('Cookie', cookie);

const setCookies = (res: Answer) =>
  (res.headers['set-cookie'] as string[] | undefined) ?? [];
const cookieNamed = (res: Answer, name: string) =>
  setCookies(res)
    .find((c) => c.startsWith(`${name}=`))
    ?.split(';', 1)[0] ?? '';

const withPassword = (id: string, password = PASSWORD, cookie = '') =>
  send(
    'post',
    '/auth/password/sign-in',
    {
      data: {
        type: 'PasswordSignIn',
        attributes: { email: `${id}@example.org`, password },
      },
    },
    cookie,
  );
const passwordSession = async (id: string) =>
  cookieNamed(await withPassword(id).expect(200), SESSION_COOKIE);

interface Changes {
  singleSignOn?: 'optional' | 'required';
  secondFactor?: 'optional' | 'everyone';
  sessionIdleMinutes?: number | null;
  sessionMaxHours?: number | null;
  breakGlass?: string | null;
}
function change({ breakGlass, ...attributes }: Changes, cookie = root) {
  return send(
    'patch',
    '/settings',
    {
      data: {
        type: 'InstallationSettings',
        attributes,
        ...(breakGlass !== undefined && {
          relationships: {
            breakGlassAccount: {
              data:
                breakGlass === null ? null : { type: 'User', id: breakGlass },
            },
          },
        }),
      },
    },
    cookie,
  );
}
async function set(changes: Changes, cookie = root) {
  const res = await change(changes, cookie);
  expect(res.body).toHaveProperty('data');
  return InstallationSettingsDocument.parse(res.body).data;
}
const settings = async () =>
  InstallationSettingsDocument.parse(
    (await t.anonymous().get('/settings').set('Cookie', root).expect(200)).body,
  ).data;
const options = async () =>
  SignInOptionsDocument.parse(
    (await t.anonymous().get('/auth/options').expect(200)).body,
  ).data.attributes;

const audited = async (action: string) =>
  t.database.db
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.action, action))
    .orderBy(auditEvents.id);

/** A session of `userId` begun with `provider`, straight in the table. */
async function storedSession(userId: string, provider: string) {
  const minted = mintSessionToken();
  await t.database.db
    .insert(sessions)
    .values({ tokenHash: minted.hash, userId, provider });
  return `${SESSION_COOKIE}=${minted.token}`;
}
/** An open second step of `userId`, straight in the table. */
async function storedStep(userId: string, provider: string) {
  const minted = mintPendingSignIn();
  await t.database.db.insert(pendingSignIns).values({
    tokenHash: minted.hash,
    userId,
    step: 'set-up',
    provider,
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 600_000),
  });
  return `${SECOND_FACTOR_COOKIE}=${minted.token}`;
}
/** A code by email of `userId`, straight in the table. */
async function storedCode(userId: string) {
  const minted = mintEmailCode();
  await unit().run((tx) =>
    t.app.get(EmailCodes, { strict: false }).replace(tx, {
      userId,
      codeHash: t.app
        .get(EmailCodeHasher, { strict: false })
        .hash(userId, minted.code),
      linkHash: minted.linkHash,
      sentTo: `${userId}@example.org`,
      expiresAt: new Date(Date.now() + 600_000),
    }),
  );
  return minted;
}
const withCode = (id: string, code: string) =>
  send('post', '/auth/email-code/sign-in', {
    data: {
      type: 'EmailCodeSignIn',
      attributes: { email: `${id}@example.org`, code },
    },
  });
const withCodeLink = (token: string) =>
  send('post', '/auth/email-code/link', {
    data: { type: 'EmailCodeLink', attributes: { token } },
  });
async function resetLink(id: string) {
  const res = await send(
    'post',
    `/users/${id}/password-reset`,
    undefined,
    root,
  );
  expect(res.status).toBe(201);
  return SignInLinkMadeDocument.parse(res.body).meta.token;
}
const openLink = (token: string) =>
  send('post', '/auth/password/link', {
    data: { type: 'SignInLink', attributes: { token } },
  });
const useLink = (token: string) =>
  send('post', '/auth/password/set', {
    data: {
      type: 'PasswordSet',
      attributes: { token, password: 'another quiet river bend' },
    },
  });

const running = () =>
  t.database.db.select().from(sessions).where(isNull(sessions.revokedAt));

describe('turning it on', () => {
  it('is off, with the server’s own limits, until an administrator says so', async () => {
    const read = await settings();
    expect(read.attributes).toMatchObject({
      singleSignOn: 'optional',
      sessionIdleMinutes: null,
      sessionMaxHours: null,
    });
    expect(read.relationships.breakGlassAccount.data).toBeNull();
    expect(read.meta).toMatchObject({
      singleSignOnAvailable: true,
      breakGlassProblem: null,
      serverSessionIdleMinutes: 480,
      serverSessionMaxHours: 168,
    });
    expect(await options()).toMatchObject({
      password: true,
      passwordReset: true,
      emailCode: true,
      singleSignOn: false,
      emergencySignIn: false,
    });
  });

  it('locks nobody out: the administrator’s own session must still be one', async () => {
    const own = [409, 'single-sign-on-own-first'];
    expect(
      refusal(
        await change(
          { singleSignOn: 'required' },
          await passwordSession('rescue'),
        ),
      ),
    ).toEqual(own);
    // No session to go by (a service account, the shared token): nothing shows it works.
    const admin: Actor = { ...actorWith(['admin.roles']), id: 'root' };
    t.actAs(admin);
    expect(
      refusal(
        await t.patch('/settings').send({
          data: {
            type: 'InstallationSettings',
            attributes: { singleSignOn: 'required' },
          },
        }),
      ),
    ).toEqual(own);
    expect((await settings()).attributes.singleSignOn).toBe('optional');
    // As the break-glass account it is theirs to use, so they may: a use as any other, and what
    // else its password opened ends.
    const uses = (await audited('user.break-glass-sign-in')).length;
    const other = await storedSession('rescue', 'password');
    const rescue = await passwordSession('rescue');
    expect(
      (await set({ singleSignOn: 'required', breakGlass: 'rescue' }, rescue))
        .attributes.singleSignOn,
    ).toBe('required');
    expect((await me(other)).status).toBe(401);
    await me(rescue).expect(200);
    expect(await audited('user.break-glass-sign-in')).toHaveLength(uses + 1);
    expect((await audited('user.break-glass-sign-in')).at(-1)).toMatchObject({
      actorId: 'rescue',
    });
  });

  it('needs a provider that works now', async () => {
    const provider = t.app
      .get(IdentityProviders, { strict: false })
      .find('oidc')!;
    vi.spyOn(provider, 'answersNow').mockRejectedValue(
      new SignInFailedError('provider-unavailable', 'down'),
    );
    expect(refusal(await change({ singleSignOn: 'required' }))).toEqual([
      409,
      'single-sign-on-unavailable',
    ]);
    expect((await settings()).attributes.singleSignOn).toBe('optional');
  });

  it('ends at once what was begun another way, and keeps the rest', async () => {
    await set({ secondFactor: 'everyone' });
    const pat = await storedSession('pat', 'password');
    const sam = await storedSession('sam', 'email-code');
    const later = await storedSession('kim', 'a-new-way');
    const rescue = await storedSession('rescue', 'password');
    const rescueByCode = await storedSession('rescue', 'email-code');
    for (const id of ['pat', 'rescue']) {
      expect(
        SignedInDocument.parse((await withPassword(id).expect(200)).body).meta
          .secondFactor,
      ).toBe('set-up');
      await resetLink(id);
      await storedCode(id);
    }
    const written = await set({
      singleSignOn: 'required',
      breakGlass: 'rescue',
    });
    expect(written.relationships.breakGlassAccount.data).toEqual({
      type: 'User',
      id: 'rescue',
    });
    const left = (rows: readonly { userId: string }[]) =>
      rows.map((r) => r.userId).sort();
    // What the emergency account's password opened before, too: every use of it is recorded.
    expect(left(await running())).toEqual(['root']);
    expect(await t.database.db.select().from(pendingSignIns)).toEqual([]);
    expect(await t.database.db.select().from(signInLinks)).toEqual([]);
    expect(await t.database.db.select().from(emailSignInCodes)).toEqual([]);
    for (const cookie of [pat, sam, later, rescue, rescueByCode]) {
      expect((await me(cookie)).status).toBe(401);
    }
    await me(root).expect(200);
    expect((await audited('settings.single-sign-on')).at(-1)).toMatchObject({
      actorId: 'root',
      data: { from: 'optional', to: 'required' },
    });
    expect(
      (await audited('settings.sign-ins-ended')).slice(-2).map((e) => e.data),
    ).toEqual([
      { sessions: 1, secondSteps: 1, links: 1, emailCodes: 0 },
      { sessions: 4, secondSteps: 1, links: 1, emailCodes: 2 },
    ]);
    expect((await audited('settings.break-glass')).at(-1)).toMatchObject({
      data: { from: null, to: 'rescue' },
    });
  });

  it('brings nothing back when the clean-up was interrupted', async () => {
    const unused = await storedSession('pat', 'password');
    const step = await storedStep('pat', 'password');
    const link = await resetLink('pat');
    const code = await storedCode('pat');
    const end = vi
      .spyOn(t.app.get(RefusedSignIns, { strict: false }), 'end')
      .mockImplementation(async () => {
        throw new Error('the database went away');
      });
    // Nothing to end before it: only what follows the change is interrupted, and it holds.
    end.mockImplementationOnce(async () => ({
      sessions: 0,
      secondSteps: 0,
      links: 0,
      emailCodes: 0,
    }));
    expect(
      (await set({ singleSignOn: 'required' })).attributes.singleSignOn,
    ).toBe('required');
    expect(end).toHaveBeenCalledTimes(2);
    vi.restoreAllMocks();
    // All of it is still stored, and refused all the same.
    expect(await t.database.db.select().from(pendingSignIns)).toHaveLength(1);
    const seen = await storedSession('sam', 'password');
    expect((await me(seen)).status).toBe(401);
    expect(
      refusal(
        await send('post', '/auth/second-factor/set-up', undefined, step),
      ),
    ).toEqual([403, 'sign-in-not-allowed']);
    expect(refusal(await openLink(link))).toEqual([404, 'link-invalid']);
    expect(refusal(await useLink(link))).toEqual([404, 'link-invalid']);
    expect(refusal(await withCode('pat', code.code))[0]).toBe(409);
    expect(refusal(await withCodeLink(code.linkToken))[0]).toBe(409);

    // Turning it off ends them first: nothing begun before comes back.
    await set({ singleSignOn: 'optional' });
    expect((await me(unused)).status).toBe(401);
    expect(
      refusal(
        await send('post', '/auth/second-factor/set-up', undefined, step),
      ),
    ).toEqual([410, 'second-factor-expired']);
    expect(refusal(await openLink(link))).toEqual([404, 'link-invalid']);
    expect(refusal(await withCode('pat', code.code))).toEqual([
      401,
      'invalid-code',
    ]);
    expect(refusal(await withCodeLink(code.linkToken))).toEqual([
      404,
      'link-invalid',
    ]);
    // And everyone signs in as before.
    await passwordSession('pat');
  });

  it('is not turned off when what it refuses cannot be ended', async () => {
    const unused = await storedSession('pat', 'password');
    const refused = t.app.get(RefusedSignIns, { strict: false });
    const end = vi.spyOn(refused, 'end').mockImplementation(async () => ({
      sessions: 0,
      secondSteps: 0,
      links: 0,
      emailCodes: 0,
    }));
    await set({ singleSignOn: 'required' });
    end.mockRejectedValue(new Error('the database went away'));
    expect((await change({ singleSignOn: 'optional' })).status).toBe(500);
    vi.restoreAllMocks();
    expect((await settings()).attributes.singleSignOn).toBe('required');
    expect((await me(unused)).status).toBe(401);
  });
});

describe('while it is on', () => {
  it('refuses a right password as a wrong one, whoever it is', async () => {
    await t.database.db
      .update(users)
      .set({ deactivatedAt: new Date() })
      .where(eq(users.id, 'kim'));
    await set({ singleSignOn: 'required' });
    const wrong = await withPassword('pat', 'not the password');
    expect(refusal(wrong)).toEqual([401, 'invalid-credentials']);
    for (const res of [
      await withPassword('pat'),
      await withPassword('rescue'),
      // Deactivated, and an address nobody has: the same.
      await withPassword('kim'),
      await withPassword('nobody'),
    ]) {
      expect(res.status).toBe(401);
      expect(res.body).toEqual(wrong.body);
      expect(setCookies(res)).toEqual([]);
    }
    await t.database.db
      .update(users)
      .set({ deactivatedAt: null })
      .where(eq(users.id, 'kim'));
  });

  it('does the same work for every password, whose ever the address, right or wrong', async () => {
    await set({ singleSignOn: 'required', breakGlass: 'rescue' });
    const hasher = t.app.get(PasswordHasher, { strict: false });
    const hashed = vi.spyOn(hasher, 'verify');
    const query = vi.spyOn((t.database as PgliteDatabase).client, 'query');
    const events = async () => [
      await t.database.db.$count(auditEvents),
      await t.database.db.$count(outbox),
    ];
    const before = await events();
    /** The statements asked, without what was put in them, and how many passwords were hashed. */
    const work = async (id: string, password?: string) => {
      query.mockClear();
      hashed.mockClear();
      const res = await withPassword(id, password);
      return {
        asked: query.mock.calls.map(([sql]) => sql),
        hashes: hashed.mock.calls.length,
        answer: [res.status, res.body, setCookies(res)],
      };
    };
    const wrong = 'not the password';
    const reference = await work('rescue', wrong);
    expect(reference.hashes).toBe(1);
    expect(reference.asked.length).toBeGreaterThan(2);
    for (const attempt of [
      await work('pat', wrong),
      await work('pat'),
      await work('root', wrong),
      await work('via-group', wrong),
      await work('nobody', wrong),
    ]) {
      expect(attempt).toEqual(reference);
    }
    // Nothing is recorded and nobody is told before it succeeded.
    expect(await events()).toEqual(before);
    vi.restoreAllMocks();
    await passwordSession('rescue');
  });

  it('refuses codes by email and “Forgot password” for every address alike', async () => {
    await set({ singleSignOn: 'required', breakGlass: 'rescue' });
    for (const id of ['pat', 'rescue', 'nobody']) {
      const asked = await send('post', '/auth/email-code/request', {
        data: {
          type: 'EmailCodeRequest',
          attributes: { email: `${id}@example.org` },
        },
      });
      expect(refusal(asked)).toEqual([409, 'single-sign-on-required']);
      expect(refusal(await withCode(id, '123456'))).toEqual([
        409,
        'single-sign-on-required',
      ]);
      const forgot = await send('post', '/auth/password/forgot', {
        data: {
          type: 'PasswordReset',
          attributes: { email: `${id}@example.org` },
        },
      });
      expect(refusal(forgot)).toEqual([404, 'not-configured']);
    }
    expect(await t.database.db.select().from(emailSignInCodes)).toEqual([]);
    expect(await t.database.db.select().from(signInLinks)).toEqual([]);
    expect(await options()).toMatchObject({
      password: false,
      passwordReset: false,
      emailCode: false,
      providers: 1,
      singleSignOn: true,
      emergencySignIn: true,
    });
  });

  it('makes no invite and no reset link, but the break-glass account’s reset', async () => {
    await set({ singleSignOn: 'required', breakGlass: 'rescue' });
    for (const what of ['invite', 'password-reset']) {
      expect(
        refusal(await send('post', `/users/pat/${what}`, undefined, root)),
      ).toEqual([409, 'single-sign-on-required']);
    }
    const link = await resetLink('rescue');
    expect((await openLink(link)).status).toBe(200);
    const used = await useLink(link).expect(200);
    await me(cookieNamed(used, SESSION_COOKIE)).expect(200);
    expect((await audited('user.break-glass-sign-in')).length).toBeGreaterThan(
      0,
    );
    await unit().run((tx) => passwords().set(tx, 'rescue', passwordHash));
  });

  it('lets people in at the provider, new ones too', async () => {
    await set({ singleSignOn: 'required' });
    const { cookie, finalUrl } = await atProvider('new');
    expect(finalUrl).toBe(`${base}/`);
    expect(
      ActorDocument.parse((await me(sessionOf(cookie)).expect(200)).body).data
        .id,
    ).toBe('new');
  });

  it('leaves service accounts, provisioning and the API’s tokens as they are', async () => {
    const minted = mintServiceToken();
    const { db } = t.database;
    await db.insert(roles).values({
      id: 'robot',
      name: 'Robot',
      permissions: ['content.read', 'scim.provision'],
    });
    await db.insert(serviceAccounts).values({ id: 'ci', name: 'CI' });
    await db
      .insert(serviceAccountRoles)
      .values({ serviceAccountId: 'ci', roleId: 'robot' });
    await db.insert(serviceTokens).values({
      id: minted.id,
      serviceAccountId: 'ci',
      name: 'CI',
      secretHash: minted.secretHash,
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    const asBot = (path: string) =>
      t.anonymous().get(path).set('Authorization', `Bearer ${minted.token}`);
    await set({ singleSignOn: 'required' });
    await asBot('/config').expect(200);
    await asBot('/scim/v2/Users').expect(200);
    await t.get('/config').expect(200);
  });

  it('lets the directory deactivate the emergency account, which then is no way in', async () => {
    const minted = mintServiceToken();
    const { db } = t.database;
    await db.insert(roles).values({
      id: 'directory',
      name: 'Directory',
      permissions: ['scim.provision'],
    });
    await db.insert(serviceAccounts).values({ id: 'sync', name: 'Sync' });
    await db
      .insert(serviceAccountRoles)
      .values({ serviceAccountId: 'sync', roleId: 'directory' });
    await db.insert(serviceTokens).values({
      id: minted.id,
      serviceAccountId: 'sync',
      name: 'Sync',
      secretHash: minted.secretHash,
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    // Linked by its address, as the directory links someone who was there before.
    await db
      .insert(scimUsers)
      .values({ userId: 'rescue', userName: 'rescue@example.org' });
    await set({ singleSignOn: 'required', breakGlass: 'rescue' });
    const cookie = await passwordSession('rescue');
    const res = await t
      .anonymous()
      .patch('/scim/v2/Users/rescue')
      .set('Authorization', `Bearer ${minted.token}`)
      .set('Content-Type', 'application/scim+json')
      .send({
        schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
        Operations: [{ op: 'replace', path: 'active', value: false }],
      });
    expect(res.status).toBe(200);
    expect((await settings()).meta.breakGlassProblem).toBe('deactivated');
    expect((await me(cookie)).status).not.toBe(200);
    // As the other rows found them.
    await db.delete(scimUsers);
    await db
      .update(users)
      .set({ deactivatedAt: null })
      .where(eq(users.id, 'rescue'));
  });

  it('is nobody’s to walk around with a second step begun before', async () => {
    await set({ singleSignOn: 'required' });
    const step = await storedStep('pat', 'password');
    const res = await send(
      'post',
      '/auth/second-factor/set-up',
      undefined,
      step,
    );
    expect(refusal(res)).toEqual([403, 'sign-in-not-allowed']);
  });
});

describe('the break-glass account', () => {
  it('signs in with its password alone, audited and told of', async () => {
    await t.database.db.delete(mailMessages);
    await set({ singleSignOn: 'required', breakGlass: 'rescue' });
    const before = (await audited('user.break-glass-sign-in')).length;
    const cookie = await passwordSession('rescue');
    await me(cookie).expect(200);
    const events = await audited('user.break-glass-sign-in');
    expect(events).toHaveLength(before + 1);
    expect(events.at(-1)).toMatchObject({
      actorId: 'rescue',
      subjectId: 'rescue',
    });
    const told = await t.database.db
      .select()
      .from(outbox)
      .where(eq(outbox.topic, 'sign-in.break-glass'));
    const admins = ['rescue', 'root', 'via-group'];
    const { userId, admins: toldOf } = told.at(-1)?.payload as {
      userId: string;
      admins: string[];
    };
    expect([userId, toldOf.sort()]).toEqual(['rescue', admins]);
    // By email too, queued with the sign-in: what becomes of their roles or settings is too late.
    const mails = await t.database.db
      .select()
      .from(mailMessages)
      .where(eq(mailMessages.template, 'emergency-sign-in'));
    expect(mails.map((m) => m.toAddress).sort()).toEqual(
      admins.map((id) => `${id}@example.org`),
    );
    // The wrong password is a wrong password, and recorded as none.
    expect(refusal(await withPassword('rescue', 'not it'))).toEqual([
      401,
      'invalid-credentials',
    ]);
    expect(await audited('user.break-glass-sign-in')).toHaveLength(before + 1);
  });

  it('keeps its second factor: no session, and no event, before it', async () => {
    await set({
      singleSignOn: 'required',
      breakGlass: 'rescue',
      secondFactor: 'everyone',
    });
    const before = (await audited('user.break-glass-sign-in')).length;
    const res = await withPassword('rescue').expect(200);
    expect(SignedInDocument.parse(res.body).meta).toEqual({
      userId: null,
      secondFactor: 'set-up',
    });
    expect(cookieNamed(res, SESSION_COOKIE)).toBe('');
    expect(await audited('user.break-glass-sign-in')).toHaveLength(before);
  });

  it('is an active administrator of their own, with a password', async () => {
    for (const [who, problem] of [
      ['pat', 'no-admin-role'],
      ['via-group', 'no-admin-role'],
      ['root', 'no-password'],
      ['no-such-user', 'no-such-user'],
    ] as const) {
      const res = await change({ breakGlass: who });
      expect(refusal(res)).toEqual([422, 'break-glass-not-usable']);
      expect(error(res.body)?.meta).toMatchObject({ problem });
    }
    await t.database.db
      .update(users)
      .set({ deactivatedAt: new Date() })
      .where(eq(users.id, 'rescue'));
    const res = await change({ breakGlass: 'rescue' });
    expect(error(res.body)?.meta).toMatchObject({ problem: 'deactivated' });
    await t.database.db
      .update(users)
      .set({ deactivatedAt: null })
      .where(eq(users.id, 'rescue'));
  });

  it.each([
    [
      'no-admin-role',
      'losing the role',
      async () => {
        await send(
          'delete',
          '/users/rescue/relationships/roles',
          { data: [{ type: 'Role', id: 'admin' }] },
          root,
        ).expect(200);
      },
      async () => {
        await send(
          'post',
          '/users/rescue/relationships/roles',
          { data: [{ type: 'Role', id: 'admin' }] },
          root,
        ).expect(200);
      },
    ],
    [
      'no-admin-role',
      'the role no longer holding admin.roles for them directly',
      async () => {
        await t.database.db
          .update(roleAssignments)
          .set({ direct: false, viaGroups: true })
          .where(
            and(
              eq(roleAssignments.userId, 'rescue'),
              eq(roleAssignments.roleId, 'admin'),
            ),
          );
      },
      async () => {
        await t.database.db
          .update(roleAssignments)
          .set({ direct: true, viaGroups: false })
          .where(eq(roleAssignments.userId, 'rescue'));
      },
    ],
    [
      'no-password',
      'losing the password',
      async () => {
        await t.database.db
          .delete(userPasswords)
          .where(eq(userPasswords.userId, 'rescue'));
      },
      async () => {
        await unit().run((tx) => passwords().set(tx, 'rescue', passwordHash));
      },
    ],
    [
      'deactivated',
      'being deactivated',
      async () => {
        await send('post', '/users/rescue/deactivate', undefined, root).expect(
          200,
        );
      },
      async () => {
        await send('post', '/users/rescue/reactivate', undefined, root).expect(
          200,
        );
      },
    ],
  ] as const)(
    'is nobody’s after %s (%s), at the next request, and the settings say so',
    async (problem, _what, lose, giveBack) => {
      await set({ singleSignOn: 'required', breakGlass: 'rescue' });
      const cookie = await passwordSession('rescue');
      await lose();
      try {
        const [status] = refusal(await me(cookie));
        expect([401, 403]).toContain(status);
        expect(refusal(await withPassword('rescue'))).toEqual([
          401,
          'invalid-credentials',
        ]);
        const read = await settings();
        expect(read.relationships.breakGlassAccount.data?.id).toBe('rescue');
        expect(read.meta.breakGlassProblem).toBe(problem);
        expect((await options()).emergencySignIn).toBe(false);
      } finally {
        await giveBack();
      }
      expect((await settings()).meta.breakGlassProblem).toBeNull();
    },
  );

  it.each([
    [
      'the person losing the role',
      () =>
        send(
          'delete',
          '/users/rescue/relationships/roles',
          { data: [{ type: 'Role', id: 'admin' }] },
          root,
        ),
      () =>
        send(
          'post',
          '/users/rescue/relationships/roles',
          { data: [{ type: 'Role', id: 'admin' }] },
          root,
        ),
    ],
    [
      'a restart without its password sign-in',
      async () => {
        await t.database.db
          .delete(userPasswords)
          .where(eq(userPasswords.userId, 'rescue'));
        await t.app
          .get(SignInAtStart, { strict: false })
          .onApplicationBootstrap();
      },
      () => unit().run((tx) => passwords().set(tx, 'rescue', passwordHash)),
    ],
  ] as const)(
    'brings no session back that was not used meanwhile: %s',
    async (_what, lose, giveBack) => {
      await set({ singleSignOn: 'required', breakGlass: 'rescue' });
      const cookie = await passwordSession('rescue');
      await lose();
      await giveBack();
      expect((await settings()).meta.breakGlassProblem).toBeNull();
      expect((await me(cookie)).status).toBe(401);
      await me(await passwordSession('rescue')).expect(200);
    },
  );

  it('is never a later holder of the same ID', async () => {
    await set({ singleSignOn: 'required', breakGlass: 'rescue' });
    await t.database.db.delete(users).where(eq(users.id, 'rescue'));
    await t.database.db.insert(users).values({
      id: 'rescue',
      name: 'Someone else',
      email: 'rescue@example.org',
    });
    await t.database.db
      .insert(roleAssignments)
      .values({ userId: 'rescue', roleId: 'admin' });
    await unit().run((tx) => passwords().set(tx, 'rescue', passwordHash));
    expect((await settings()).relationships.breakGlassAccount.data).toBeNull();
    expect(refusal(await withPassword('rescue'))).toEqual([
      401,
      'invalid-credentials',
    ]);
  });

  it('is not taken away by the one signed in with it', async () => {
    await set({ singleSignOn: 'required', breakGlass: 'rescue' });
    const cookie = await passwordSession('rescue');
    expect(refusal(await change({ breakGlass: null }, cookie))).toEqual([
      409,
      'single-sign-on-own-first',
    ]);
    // They may turn it off, for the day the provider is gone.
    await set({ singleSignOn: 'optional', breakGlass: null }, cookie);
    await me(cookie).expect(200);
  });

  it('ends its sessions when another account is named', async () => {
    await set({ singleSignOn: 'required', breakGlass: 'rescue' });
    const cookie = await passwordSession('rescue');
    await set({ breakGlass: null });
    expect((await me(cookie)).status).toBe(401);
    await set({ breakGlass: 'rescue' });
    expect((await me(cookie)).status).toBe(401);
  });
});

describe('session limits', () => {
  it('apply to running sessions from their next request, and to the cookie', async () => {
    const pat = await passwordSession('pat');
    await t.database.db
      .update(sessions)
      .set({ lastSeenAt: sql`now() - interval '10 minutes'` })
      .where(eq(sessions.userId, 'pat'));
    await set({ sessionIdleMinutes: 5, sessionMaxHours: 2 });
    expect((await me(pat)).status).toBe(401);
    const res = await withPassword('sam').expect(200);
    expect(setCookies(res).find((c) => c.startsWith(SESSION_COOKIE))).toContain(
      'Max-Age=7200',
    );
    expect((await audited('settings.session-limits')).at(-1)).toMatchObject({
      data: {
        from: { idleMinutes: null, maxHours: null },
        to: { idleMinutes: 5, maxHours: 2 },
      },
    });
  });

  it('never bring back a session that had ended, when they are lengthened', async () => {
    await set({ sessionIdleMinutes: 5, sessionMaxHours: 1 });
    const idle = await storedSession('pat', 'password');
    const old = await storedSession('sam', 'password');
    await t.database.db
      .update(sessions)
      .set({ lastSeenAt: sql`now() - interval '10 minutes'` })
      .where(eq(sessions.userId, 'pat'));
    await t.database.db
      .update(sessions)
      .set({ createdAt: sql`now() - interval '2 hours'` })
      .where(eq(sessions.userId, 'sam'));
    const fresh = await storedSession('kim', 'password');
    await set({ sessionIdleMinutes: null, sessionMaxHours: null });
    expect((await me(idle)).status).toBe(401);
    expect((await me(old)).status).toBe(401);
    await me(fresh).expect(200);
  });

  it('keep within their bounds, and idle within the lifetime', async () => {
    for (const changes of [
      { sessionIdleMinutes: 4 },
      { sessionIdleMinutes: 43_201 },
      { sessionMaxHours: 0 },
      { sessionMaxHours: 8_761 },
      { sessionIdleMinutes: 7.5 },
    ]) {
      expect((await change(changes)).status).toBe(400);
    }
    expect(
      refusal(await change({ sessionIdleMinutes: 61, sessionMaxHours: 1 })),
    ).toEqual([422, 'session-limits-crossed']);
    // Against the server's own: 480 minutes idle.
    expect(refusal(await change({ sessionMaxHours: 7 }))).toEqual([
      422,
      'session-limits-crossed',
    ]);
    await set({ sessionMaxHours: 8 });
  });
});

describe('any completed sign-in', () => {
  const steps = () => t.database.db.select().from(pendingSignIns);

  it('ends the second step open in the same browser: its cookie and its row', async () => {
    const step = await storedStep('pat', 'password');
    const other = await storedStep('sam', 'password');
    const jar: CookieJar = new Map([
      [base, new Map([[SECOND_FACTOR_COOKIE, step.split('=')[1]!]])],
    ]);
    const { cookie } = await atProvider('root', jar);
    expect(sessionOf(cookie)).not.toBe('');
    expect(cookie).not.toContain(SECOND_FACTOR_COOKIE);
    expect((await steps()).map((s) => s.tokenHash)).toEqual([
      hashPendingSignIn(other.split('=')[1]!),
    ]);

    const again = await storedStep('pat', 'password');
    const res = await withPassword('kim', PASSWORD, again).expect(200);
    expect(
      setCookies(res).find((c) => c.startsWith(SECOND_FACTOR_COOKIE)),
    ).toContain('Max-Age=0');
    expect((await steps()).map((s) => s.userId)).toEqual(['sam']);
  });

  it('leaves it when the sign-in fails', async () => {
    const step = await storedStep('pat', 'password');
    await withPassword('kim', 'not it', step).expect(401);
    expect(await steps()).toHaveLength(1);
  });
});
