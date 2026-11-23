import {
  createTestDatabase,
  type PgliteDatabase,
} from '../../../tests/database.js';
import { auditEvents } from '../../audit/repos/audit.tables.js';
import { hashSignInLinkToken } from '../core/sign-in-links.js';
import { roles, users } from './access.tables.js';
import { DrizzleAccessAdmin } from './drizzle-access-admin.js';
import { DrizzleSignInLinks } from './drizzle-passwords.js';
import {
  firstAdminIntoEmpty,
  firstAdminLocally,
} from './first-admin-locally.js';
import { STARTUP_ACTOR } from './first-admin-at-start.js';
import { DrizzleUnitOfWork } from '../../database/drizzle-unit-of-work.js';

const WEEK = 7 * 24 * 60 * 60 * 1000;

describe('firstAdminLocally (#610)', () => {
  let database: PgliteDatabase;
  beforeEach(async () => {
    database = await createTestDatabase();
  });
  afterEach(() => database?.close());

  it('makes the admin and the role, and a one-time link recorded without its token', async () => {
    const made = await firstAdminLocally(database, {
      email: 'Root.Person@example.org',
      inviteMs: WEEK,
      linkBase: 'https://docs.example.com/',
    });
    expect(made).toMatchObject({ userId: 'root.person', created: true });
    const token = /set-password#(ccms_pwl_[0-9a-f]{64})$/.exec(made.link)?.[1];
    expect(made.link.startsWith('https://docs.example.com/set-password#')).toBe(
      true,
    );
    const link = await new DrizzleSignInLinks(database).find(
      hashSignInLinkToken(token!),
    );
    expect(link).toMatchObject({ userId: 'root.person', kind: 'invite' });
    const user = await new DrizzleUnitOfWork(database).run((tx) =>
      new DrizzleAccessAdmin(database).findUser(tx, 'root.person'),
    );
    expect(user?.permissions).toContain('admin.roles');
    const events = await database.db.select().from(auditEvents);
    expect(events.map((e) => e.action)).toEqual([
      'role.create',
      'user.create',
      'role.assign',
      'user.invite',
    ]);
    expect(JSON.stringify(events.map((e) => e.data))).not.toContain(token!);
  });

  it('gives an existing user the role and a new link, the earlier one revoked', async () => {
    await database.db
      .insert(users)
      .values({ id: 'pat', name: 'Pat', email: 'pat@example.org' });
    const first = await firstAdminLocally(database, {
      email: 'PAT@example.org',
      inviteMs: WEEK,
      linkBase: null,
    });
    expect(first).toMatchObject({ userId: 'pat', created: false });
    expect(first.link).toMatch(/^set-password#ccms_pwl_/);
    const second = await firstAdminLocally(database, {
      email: 'pat@example.org',
      inviteMs: WEEK,
      linkBase: null,
    });
    const links = new DrizzleSignInLinks(database);
    const tokenOf = (l: string) => l.split('#')[1]!;
    expect(
      await links.find(hashSignInLinkToken(tokenOf(first.link))),
    ).toBeUndefined();
    expect(
      await links.find(hashSignInLinkToken(tokenOf(second.link))),
    ).toBeDefined();
  });

  it('refuses a role admin that does not administer', async () => {
    await database.db
      .insert(roles)
      .values({ id: 'admin', name: 'Admin', permissions: ['content.read'] });
    await expect(
      firstAdminLocally(database, {
        email: 'root@example.org',
        inviteMs: WEEK,
        linkBase: null,
      }),
    ).rejects.toThrow(/admin\.roles/);
  });

  describe('into an empty instance only (#373, CCMS_FIRST_ADMIN_EMAIL)', () => {
    it('makes the admin once, recorded by the start-up, and then does nothing', async () => {
      const made = await firstAdminIntoEmpty(database, {
        email: 'first@example.org',
        name: 'First Admin',
        inviteMs: WEEK,
        linkBase: 'https://docs.example.com/',
        withLink: true,
        actor: STARTUP_ACTOR,
        via: 'environment',
      });
      expect(made).toMatchObject({ userId: 'first', created: true });
      expect(made?.link?.url).toMatch(
        /^https:\/\/docs\.example\.com\/set-password#ccms_pwl_[0-9a-f]{64}$/,
      );
      const again = await firstAdminIntoEmpty(database, {
        email: 'other@example.org',
        inviteMs: WEEK,
        linkBase: null,
        withLink: true,
      });
      expect(again).toBeNull();
      const rows = await database.db.select().from(users);
      expect(rows.map((u) => [u.id, u.name])).toEqual([
        ['first', 'First Admin'],
      ]);
      const events = await database.db.select().from(auditEvents);
      expect(events.map((e) => [e.action, e.actorId])).toEqual([
        ['role.create', 'service:startup'],
        ['user.create', 'service:startup'],
        ['role.assign', 'service:startup'],
        ['user.invite', 'service:startup'],
      ]);
      expect(events.at(-1)?.data).toMatchObject({ via: 'environment' });
      // The link from the first start still works: nothing replaced it.
      const token = made!.link!.url.split('#')[1]!;
      expect(
        await new DrizzleSignInLinks(database).find(hashSignInLinkToken(token)),
      ).toBeDefined();
    });

    it('does nothing where any user exists, an admin or not', async () => {
      await database.db
        .insert(users)
        .values({ id: 'pat', name: 'Pat', email: 'pat@example.org' });
      expect(
        await firstAdminIntoEmpty(database, {
          email: 'pat@example.org',
          inviteMs: WEEK,
          linkBase: null,
          withLink: true,
        }),
      ).toBeNull();
      expect(await database.db.select().from(roles)).toEqual([]);
      expect(await database.db.select().from(auditEvents)).toEqual([]);
    });

    it('makes no link with password sign-in off: they sign in with the provider', async () => {
      const made = await firstAdminIntoEmpty(database, {
        email: 'first@example.org',
        inviteMs: WEEK,
        linkBase: null,
        withLink: false,
      });
      expect(made).toEqual({ userId: 'first', created: true, link: null });
      const events = await database.db.select().from(auditEvents);
      expect(events.map((e) => e.action)).not.toContain('user.invite');
    });
  });
});
