import { createHash, randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import pg from 'pg';
import { DrizzleAuditLog } from '../../audit/repos/drizzle-audit-log.js';
import { DrizzleUnitOfWork } from '../../database/drizzle-unit-of-work.js';
import { PostgresDatabase } from '../../database/postgres.database.js';
import type { MailOutbox } from '../../mail/core/mail-outbox.js';
import type { User } from '../core/user-directory.js';
import {
  FakePasswordHasher,
  FakePasswordSignIn,
} from '../../../tests/fakes/fake-passwords.js';
import { FakeSessionPolicy } from '../../../tests/fakes/fake-sign-in.js';
import {
  RequestEmailCodeAction,
  SignInWithEmailCodeAction,
  SignInWithEmailLinkAction,
} from '../core/actions/email-code.action.js';
import { SetPasswordWithLinkAction } from '../core/actions/sign-in-links.action.js';
import {
  EmailCodeHasher,
  EmailCodeSignIn,
  mintEmailCode,
} from '../core/email-codes.js';
import { mintSignInLinkToken } from '../core/sign-in-links.js';
import { PasswordAttempts } from '../core/password-attempts.js';
import { WaysIn } from '../core/ways-in.js';
import { users } from './access.tables.js';
import { DrizzleAccessAdmin } from './drizzle-access-admin.js';
import { DrizzleEmailCodes } from './drizzle-email-codes.js';
import {
  DrizzlePasswordStore,
  DrizzleSignInLinks,
} from './drizzle-passwords.js';
import {
  DrizzleSessionStore,
  DrizzleUserIdentities,
} from './drizzle-sign-in.js';
import { emailSignInCodes } from './email-codes.tables.js';

/**
 * "Email me a code" racing a password set or changed, or a deactivation, on a real Postgres
 * server (#650): two transactions at once, which PGlite (one connection) cannot run. It runs
 * only when `CCMS_TEST_PG_URL` names a server (the compose Postgres:
 * `postgres://ccms:ccms@127.0.0.1:5432/ccms`), in a database of its own that it creates and
 * drops; without it, it is skipped.
 */
const url = process.env['CCMS_TEST_PG_URL'];

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

class OnSettings extends EmailCodeSignIn {
  enabled = true;
  lifetimeMs = 10 * 60_000;
  linkBase = null;
}

class PlainHasher extends EmailCodeHasher {
  available = true;
  hash(userId: string, code: string): string {
    return createHash('sha256').update(`${userId}\n${code}`).digest('hex');
  }
}

/** The fake's hashes, in the shape the table takes (`$argon2id$`). */
class StoredShapeHasher extends FakePasswordHasher {
  override async hash(password: string): Promise<string> {
    return `$argon2id$${createHash('sha256').update(password).digest('hex')}`;
  }
}

class NoBudget extends PasswordAttempts {
  async reserve() {
    return {
      attempt: { keyHash: 'k', windowStart: new Date(0) },
      remaining: 1,
    };
  }
  async forgive(): Promise<void> {
    // Nothing counted, nothing to take back.
  }
}

/** Takes the email without sending it: what matters here is the stored code. */
const mail = {
  enabled: true,
  queue: async () => ({ id: 'mail' }),
} as unknown as MailOutbox;

/** Settles once `ms` pass. */
const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));

describe.skipIf(!url)(
  'a code asked for while the ways in end (Postgres, #650)',
  () => {
    const name = `ccms_test_codes_${randomBytes(6).toString('hex')}`;
    let database: PostgresDatabase;
    let unit: DrizzleUnitOfWork;
    let waysIn: WaysIn;
    let codes: DrizzleEmailCodes;
    let sessions: DrizzleSessionStore;
    let links: DrizzleSignInLinks;
    let passwords: DrizzlePasswordStore;
    let admin: DrizzleAccessAdmin;
    /** Opens once the request has read the person; the test then lets it go on. */
    let read: () => void;
    let goOn: Promise<void>;
    let release: () => void;
    let request: RequestEmailCodeAction;

    const server = () => new pg.Client({ connectionString: url });

    beforeAll(async () => {
      const client = server();
      await client.connect();
      try {
        await client.query(`create database ${name}`);
      } finally {
        await client.end();
      }
      const target = new URL(url as string);
      target.pathname = `/${name}`;
      database = await PostgresDatabase.connect(target.toString(), {
        poolMax: 5,
      });
      await database.migrate();
      unit = new DrizzleUnitOfWork(database);
      passwords = new DrizzlePasswordStore(database);
      codes = new DrizzleEmailCodes(database);
      sessions = new DrizzleSessionStore(database);
      links = new DrizzleSignInLinks(database);
      waysIn = new WaysIn(sessions, links, codes);
      // The request's read of the person, held open until the test lets it go on: the moment a
      // password change or a deactivation can run in between.
      admin = new DrizzleAccessAdmin(database);
      const gated = Object.create(admin) as DrizzleAccessAdmin;
      gated.findUser = async (tx, userId): Promise<User | undefined> => {
        const user = await admin.findUser(tx, userId);
        read();
        await goOn;
        return user;
      };
      request = new RequestEmailCodeAction(
        new OnSettings(),
        new PlainHasher(),
        codes,
        new NoBudget(),
        new DrizzleUserIdentities(),
        gated,
        mail,
        new DrizzleAuditLog(database),
        unit,
      );
    });

    afterAll(async () => {
      await database?.close();
      const client = server();
      await client.connect();
      try {
        await client.query(`drop database if exists ${name} with (force)`);
      } finally {
        await client.end();
      }
    });

    beforeEach(async () => {
      await database.db.delete(emailSignInCodes);
      await database.db.delete(users).where(eq(users.id, 'pat'));
      await database.db
        .insert(users)
        .values({ id: 'pat', name: 'Pat', email: 'pat@example.org' });
      goOn = new Promise((done) => (release = done));
    });

    /**
     * Asks for a code, and runs `end` (in its own transaction) once the request has read the
     * person, before it stores the code; then lets the request go on, and waits for both.
     */
    async function askWhile(
      end: (tx: Parameters<Parameters<typeof unit.run>[0]>[0]) => Promise<void>,
    ): Promise<void> {
      const hasRead = new Promise<void>((done) => (read = done));
      const asked = await request.handle({ email: 'pat@example.org' });
      if (!('sending' in asked)) throw new Error('Refused.');
      await hasRead;
      let endedFirst = false;
      const ended = unit.run(end).then(() => {
        endedFirst = true;
      });
      // Long enough for the change to commit if nothing held it: it waits for the request.
      await Promise.race([ended, pause(300)]);
      const waited = !endedFirst;
      release();
      await Promise.all([asked.sending, ended]);
      expect(waited).toBe(true);
    }

    const openCodes = () =>
      database.db
        .select({ userId: emailSignInCodes.userId })
        .from(emailSignInCodes);

    it('ends a code asked for before a first password was set (an invite)', async () => {
      await askWhile(async (tx) => {
        await passwords.set(tx, 'pat', '$argon2id$one');
        await waysIn.endAll(tx, 'pat');
      });
      expect(await openCodes()).toEqual([]);
    });

    it('ends a code asked for before the password was changed', async () => {
      await unit.run((tx) => passwords.set(tx, 'pat', '$argon2id$one'));
      await askWhile(async (tx) => {
        expect(
          await passwords.replaceIf(
            tx,
            'pat',
            '$argon2id$one',
            '$argon2id$two',
          ),
        ).toBe(true);
        await passwords.set(tx, 'pat', '$argon2id$two');
        await waysIn.endAll(tx, 'pat');
      });
      expect(await openCodes()).toEqual([]);
    });

    it('stores no code for a person deactivated after the request read them', async () => {
      await askWhile(async (tx) => {
        await admin.setDeactivated(tx, 'pat', true);
        await waysIn.endAll(tx, 'pat');
      });
      expect(await openCodes()).toEqual([]);
    });

    it('keeps a code asked for after the password was set', async () => {
      await unit.run(async (tx) => {
        await passwords.set(tx, 'pat', '$argon2id$one');
        await waysIn.endAll(tx, 'pat');
      });
      read = () => undefined;
      release();
      const asked = await request.handle({ email: 'pat@example.org' });
      if (!('sending' in asked)) throw new Error('Refused.');
      await asked.sending;
      expect(await openCodes()).toEqual([{ userId: 'pat' }]);
    });

    it('waits for a password change under way, then keeps the code asked for after it', async () => {
      read = () => undefined;
      release();
      let commit!: () => void;
      const committing = new Promise<void>((done) => (commit = done));
      let changed!: () => void;
      const hasChanged = new Promise<void>((done) => (changed = done));
      const ended = unit.run(async (tx) => {
        await passwords.set(tx, 'pat', '$argon2id$one');
        await waysIn.endAll(tx, 'pat');
        changed();
        await committing;
      });
      await hasChanged;
      const asked = await request.handle({ email: 'pat@example.org' });
      if (!('sending' in asked)) throw new Error('Refused.');
      let sentFirst = false;
      const sent = asked.sending.then(() => {
        sentFirst = true;
      });
      await Promise.race([sent, pause(300)]);
      expect(sentFirst).toBe(false);
      commit();
      await Promise.all([ended, sent]);
      expect(await openCodes()).toEqual([{ userId: 'pat' }]);
    });

    it('lets a sign-in by the code finish while a password change waits for it, without a deadlock', async () => {
      read = () => undefined;
      release();
      const asked = await request.handle({ email: 'pat@example.org' });
      if (!('sending' in asked)) throw new Error('Refused.');
      await asked.sending;
      const [{ linkHash } = { linkHash: '' }] = await database.db
        .select({ linkHash: emailSignInCodes.linkHash })
        .from(emailSignInCodes);
      let goOnSigningIn!: () => void;
      const signingIn = new Promise<void>((done) => (goOnSigningIn = done));
      let taken!: () => void;
      const hasTaken = new Promise<void>((done) => (taken = done));
      // A sign-in by the code: takes it (its row), then starts a session (a foreign key to the
      // person's row) once the password change is waiting.
      const signIn = unit.run(async (tx) => {
        const took = await codes.take(tx, 'pat', { linkHash }, new Date());
        taken();
        expect(took).toBe(true);
        await signingIn;
        await sessions.create(tx, {
          hash: createHash('sha256').update('session').digest('hex'),
          userId: 'pat',
          provider: 'email-code',
          endedBefore: new Date(),
        });
      });
      await hasTaken;
      const ended = unit.run(async (tx) => {
        await passwords.set(tx, 'pat', '$argon2id$one');
        return waysIn.endAll(tx, 'pat');
      });
      await pause(300);
      goOnSigningIn();
      await signIn;
      // The change saw the session the code started, and ended it.
      expect(await ended).toBe(1);
      expect(await openCodes()).toEqual([]);
    });

    it('sets a password through an invite while an admin deactivates the person, without a deadlock', async () => {
      const tokenHash = createHash('sha256').update('invite').digest('hex');
      await unit.run((tx) =>
        links.replace(tx, {
          hash: tokenHash,
          userId: 'pat',
          kind: 'invite',
          expiresAt: new Date(Date.now() + 60_000),
        }),
      );
      let goOnSetting!: () => void;
      const setting = new Promise<void>((done) => (goOnSetting = done));
      let tookLink!: () => void;
      const hasTakenLink = new Promise<void>((done) => (tookLink = done));
      // As `SetPasswordWithLinkAction` does: the person, then the link, then the password and
      // the ways in. It is held after taking the link while the deactivation starts.
      const set = unit.run(async (tx) => {
        await waysIn.holdPerson(tx, 'pat');
        const taken = await links.take(tx, tokenHash);
        tookLink();
        await setting;
        if (!taken) throw new Error('No link.');
        await passwords.set(tx, 'pat', '$argon2id$one');
        await waysIn.endAll(tx, 'pat');
      });
      await hasTakenLink;
      // As `DeactivateUserAction` does: the person's row, then the ways in (the links first).
      const deactivated = unit.run(async (tx) => {
        await admin.setDeactivated(tx, 'pat', true);
        await waysIn.endAll(tx, 'pat');
      });
      await pause(300);
      goOnSetting();
      await Promise.all([set, deactivated]);
      expect(
        await database.db
          .select({ off: users.deactivatedAt })
          .from(users)
          .where(eq(users.id, 'pat')),
      ).toEqual([{ off: expect.any(Date) }]);
    });

    /**
     * A sign-in by email code (or its link) and a password set through the person's invite at
     * the same moment (#660), the real actions on two connections. `holdSignIn` pauses the
     * sign-in once it has taken the code (at its new session), `holdSet` pauses the password set
     * once it has taken the invite (at the password). Answers both outcomes.
     */
    async function signInWhileInviteSets(
      how: 'code' | 'link',
      first: 'sign-in' | 'set',
    ) {
      const minted = mintEmailCode();
      const hasher = new PlainHasher();
      await unit.run((tx) =>
        codes.replace(tx, {
          userId: 'pat',
          codeHash: hasher.hash('pat', minted.code),
          linkHash: minted.linkHash,
          sentTo: 'pat@example.org',
          expiresAt: new Date(Date.now() + 60_000),
        }),
      );
      const invite = mintSignInLinkToken();
      await unit.run((tx) =>
        links.replace(tx, {
          hash: invite.hash,
          userId: 'pat',
          kind: 'invite',
          expiresAt: new Date(Date.now() + 60_000),
        }),
      );
      let goOn!: () => void;
      const going = new Promise<void>((done) => (goOn = done));
      let paused!: () => void;
      const hasPaused = new Promise<void>((done) => (paused = done));
      const pausing = async () => {
        paused();
        await going;
      };
      const signInSessions = Object.create(sessions) as DrizzleSessionStore;
      signInSessions.create = async (tx, session) => {
        if (first === 'sign-in') await pausing();
        return sessions.create(tx, session);
      };
      const setPasswords = Object.create(passwords) as DrizzlePasswordStore;
      setPasswords.set = async (tx, userId, hash) => {
        if (first === 'set') await pausing();
        return passwords.set(tx, userId, hash);
      };
      const policy = new FakeSessionPolicy();
      const audit = new DrizzleAuditLog(database);
      const identities = new DrizzleUserIdentities();
      const signIn = () =>
        how === 'code'
          ? new SignInWithEmailCodeAction(
              new OnSettings(),
              hasher,
              codes,
              new NoBudget(),
              mail,
              signInSessions,
              policy,
              audit,
              unit,
              identities,
              links,
            ).handle({ email: 'pat@example.org', code: minted.code })
          : new SignInWithEmailLinkAction(
              new OnSettings(),
              hasher,
              codes,
              mail,
              admin,
              signInSessions,
              policy,
              audit,
              unit,
              identities,
              links,
            ).handle({ token: minted.linkToken });
      const set = () =>
        new SetPasswordWithLinkAction(
          new FakePasswordSignIn(),
          links,
          admin,
          setPasswords,
          new StoredShapeHasher(),
          sessions,
          policy,
          waysIn,
          audit,
          unit,
        ).handle({ token: invite.token, password: 'a long new passphrase 42' });
      const firstOne = first === 'sign-in' ? signIn() : set();
      await hasPaused;
      const second = first === 'sign-in' ? set() : signIn();
      // Long enough for the second to reach the rows the first holds.
      await pause(300);
      goOn();
      const [a, b] = await Promise.all([firstOne, second]);
      return first === 'sign-in'
        ? { signedIn: a, set: b }
        : { signedIn: b, set: a };
    }

    for (const how of ['code', 'link'] as const) {
      it(`signs in by ${how} while the invite sets a password, without a deadlock: the invite is closed (#660)`, async () => {
        const { signedIn, set } = await signInWhileInviteSets(how, 'sign-in');
        expect(signedIn).toMatchObject({ userId: 'pat' });
        expect(set).toEqual({ refused: 'link-invalid' });
        expect(await openCodes()).toEqual([]);
      });

      it(`sets a password through the invite while a sign-in by ${how} starts, without a deadlock: the code is ended (#660)`, async () => {
        const { signedIn, set } = await signInWhileInviteSets(how, 'set');
        expect(set).toMatchObject({ userId: 'pat' });
        expect(signedIn).toEqual({
          refused: how === 'code' ? 'invalid-code' : 'link-invalid',
        });
        expect(await openCodes()).toEqual([]);
      });
    }

    it('changes the password while a reset link sets one, without a deadlock', async () => {
      await unit.run((tx) => passwords.set(tx, 'pat', '$argon2id$one'));
      const tokenHash = createHash('sha256').update('reset').digest('hex');
      await unit.run((tx) =>
        links.replace(tx, {
          hash: tokenHash,
          userId: 'pat',
          kind: 'reset',
          expiresAt: new Date(Date.now() + 60_000),
        }),
      );
      let goOnChanging!: () => void;
      const changing = new Promise<void>((done) => (goOnChanging = done));
      let held!: () => void;
      const hasHeld = new Promise<void>((done) => (held = done));
      // As `ChangePasswordAction` does: the person, then the password, then the ways in.
      const changed = unit.run(async (tx) => {
        await waysIn.holdPerson(tx, 'pat');
        held();
        await changing;
        await passwords.replaceIf(tx, 'pat', '$argon2id$one', '$argon2id$two');
        await waysIn.endAll(tx, 'pat');
      });
      await hasHeld;
      // As `SetPasswordWithLinkAction` does: the person, the link, the password, the ways in.
      const set = unit.run(async (tx) => {
        await waysIn.holdPerson(tx, 'pat');
        // The change before it ended the link: the action refuses it then (`LinkGone`).
        if (!(await links.take(tx, tokenHash))) return;
        await passwords.set(tx, 'pat', '$argon2id$three');
        await waysIn.endAll(tx, 'pat');
      });
      await pause(300);
      goOnChanging();
      await Promise.all([changed, set]);
      // The change went first and ended the link, which then set nothing.
      expect(await unit.run((tx) => passwords.hashOf('pat', tx))).toBe(
        '$argon2id$two',
      );
    });
  },
);
