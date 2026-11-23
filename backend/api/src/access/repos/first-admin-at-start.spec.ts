import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import {
  createTestDatabase,
  type PgliteDatabase,
} from '../../../tests/database.js';
import type { Env } from '../../config/env.js';
import { ServerRole } from '../../config/server-role.js';
import { hashSignInLinkToken } from '../core/sign-in-links.js';
import type { PasswordSignIn } from '../core/passwords.js';
import type { RequestEmailCodeAction } from '../core/actions/email-code.action.js';
import { StaticIdentityProviders } from '../core/identity-provider.js';
import { DrizzleSignInLinks } from './drizzle-passwords.js';
import {
  FIRST_ADMIN_LINK_MS,
  FirstAdminAtStart,
} from './first-admin-at-start.js';
import { firstAdminLocally } from './first-admin-locally.js';
import { signInLinks } from './passwords.tables.js';

const WEEK = 7 * 24 * 60 * 60 * 1000;

/** The first admin at start-up (#373): the link's lifetime, the log switch, the roles, a restart. */
describe('FirstAdminAtStart', () => {
  let database: PgliteDatabase;
  let logged: string[];
  let warned: string[];
  beforeEach(async () => {
    database = await createTestDatabase();
    logged = [];
    warned = [];
    vi.spyOn(Logger.prototype, 'log').mockImplementation((message: unknown) => {
      logged.push(String(message));
    });
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(
      (message: unknown) => {
        warned.push(String(message));
      },
    );
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await database?.close();
  });

  const start = (
    settings: Partial<Record<keyof Env, unknown>> = {},
    role: 'api' | 'all' | 'worker' = 'api',
    ways: { password: boolean; emailCode: boolean } = {
      password: true,
      emailCode: false,
    },
  ) => {
    const values: Partial<Record<keyof Env, unknown>> = {
      CCMS_FIRST_ADMIN_EMAIL: 'first@example.org',
      CCMS_FIRST_ADMIN_LINK_LOG: true,
      ...settings,
    };
    const config = {
      get: (key: keyof Env) => values[key],
    } as unknown as ConfigService<Env, true>;
    const passwords: PasswordSignIn = {
      enabled: ways.password,
      inviteMs: WEEK,
      linkBase: 'https://docs.example.com/',
    };
    return new FirstAdminAtStart(
      config,
      new ServerRole(role),
      database,
      passwords,
      new StaticIdentityProviders([]),
      { offered: ways.emailCode } as RequestEmailCodeAction,
    ).onApplicationBootstrap();
  };
  const tokenIn = (lines: string[]) =>
    /set-password#(ccms_pwl_[0-9a-f]{64})$/.exec(
      lines.find((l) => l.includes('set-password#')) ?? '',
    )?.[1];

  it('logs a link that works one hour, not the invite days', async () => {
    const before = Date.now();
    await start();
    const token = tokenIn(logged);
    expect(token).toBeDefined();
    const link = await new DrizzleSignInLinks(database).find(
      hashSignInLinkToken(token!),
    );
    const ms = link!.expiresAt.getTime() - before;
    expect(ms).toBeGreaterThanOrEqual(FIRST_ADMIN_LINK_MS - 5_000);
    expect(ms).toBeLessThanOrEqual(FIRST_ADMIN_LINK_MS + 5_000);
  });

  it('prints nothing of a link on a restart: the instance has a user', async () => {
    await start();
    logged.length = 0;
    await start();
    expect(logged).toEqual([
      expect.stringContaining('CCMS_FIRST_ADMIN_EMAIL is ignored'),
    ]);
    expect(logged.join('\n')).not.toContain('set-password#');
  });

  it('makes no link with CCMS_FIRST_ADMIN_LINK_LOG=false, and says how to get one', async () => {
    await start({ CCMS_FIRST_ADMIN_LINK_LOG: false });
    expect(logged.join('\n')).not.toContain('set-password#');
    expect(logged.at(-1)).toContain('first-admin.main.js');
    expect(await database.db.select().from(signInLinks)).toEqual([]);
  });

  it('with codes by email alone (#639): no link, and the log says to sign in by code', async () => {
    await start({}, 'api', { password: false, emailCode: true });
    expect(logged.join('\n')).not.toContain('set-password#');
    expect(logged.at(-1)).toContain('They sign in with a code by email');
    expect(warned).toEqual([]);
    expect(await database.db.select().from(signInLinks)).toEqual([]);
  });

  it('warns that nobody can sign in with no way in at all', async () => {
    await start({}, 'api', { password: false, emailCode: false });
    expect(warned).toEqual([expect.stringContaining('nobody can sign in yet')]);
  });

  it('does nothing on a worker', async () => {
    await start({}, 'worker');
    expect(logged).toEqual([]);
  });

  it('the command line revokes the logged link with a new one', async () => {
    await start();
    const logged1 = tokenIn(logged)!;
    const made = await firstAdminLocally(database, {
      email: 'first@example.org',
      inviteMs: WEEK,
      linkBase: null,
    });
    const links = new DrizzleSignInLinks(database);
    expect(await links.find(hashSignInLinkToken(logged1))).toBeUndefined();
    expect(
      await links.find(hashSignInLinkToken(made.link.split('#')[1]!)),
    ).toBeDefined();
  });
});
