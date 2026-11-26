import { DrizzleAuditLog } from '../../audit/repos/drizzle-audit-log.js';
import type { Database } from '../../database/database.js';
import type { Transaction } from '../../base/core/unit-of-work.js';
import {
  drizzleOf,
  DrizzleUnitOfWork,
} from '../../database/drizzle-unit-of-work.js';
import type { Actor } from '../core/actor.js';
import type { RoleDefinition } from '../core/access-admin.js';
import { UserEmail, UserName } from '../core/actor.js';
import { PERMISSIONS } from '../core/permissions.js';
import { userIdBase, userIdCandidates } from '../core/sign-in-users.js';
import { mintSignInLinkToken, signInLinkUrl } from '../core/sign-in-links.js';
import { users } from './access.tables.js';
import { DrizzleAccessAdmin } from './drizzle-access-admin.js';
import { DrizzleSignInLinks } from './drizzle-passwords.js';
import { DrizzleUserIdentities } from './drizzle-sign-in.js';
import { CLI_ACTOR } from './issue-token-locally.js';

/** The role the first admin gets when there is no role `admin` yet: every permission. */
export const FIRST_ADMIN_ROLE: RoleDefinition = Object.freeze({
  id: 'admin',
  name: 'Administrator',
  description: 'Everything, including roles and users.',
  permissions: [...PERMISSIONS],
  scope: {},
});

export interface FirstAdminRequest {
  readonly email: string;
  /** For a user made now; default: the address's local part. */
  readonly name?: string | undefined;
  /** How long the link works. */
  readonly inviteMs: number;
  /** The editor's address, ending in `/`; null prints the link's path only. */
  readonly linkBase: string | null;
  /** Who it is recorded as (default `service:cli`). */
  readonly actor?: Actor;
  /** Recorded as the invite's `via` (default `cli`). */
  readonly via?: string;
}

export interface FirstAdminLink {
  readonly userId: string;
  readonly created: boolean;
  /** `<linkBase>set-password#<token>`, or `set-password#<token>` without a base. */
  readonly link: string;
  readonly expiresAt: Date;
}

/** The first admin made at start-up, with their link when password sign-in is on. */
export interface FirstAdminMade {
  readonly userId: string;
  readonly created: boolean;
  readonly link: { readonly url: string; readonly expiresAt: Date } | null;
}

/**
 * The first admin of a deployment with password sign-in (#610), from the server's command line
 * (`api:first-admin`): the user with `email` (made when there is none, with the role `admin`,
 * made too when missing), holding the role `admin`, and a one-time link for them to choose
 * their password, shown once. Replaces their earlier link. Audited like the API's changes, by
 * `service:cli`, in one transaction under the access lock; the link's token is never recorded.
 */
export async function firstAdminLocally(
  database: Database,
  request: FirstAdminRequest,
): Promise<FirstAdminLink> {
  return new DrizzleUnitOfWork(database).run(async (tx) => {
    await new DrizzleAccessAdmin(database).lock(tx);
    const made = await makeFirstAdmin(database, tx, request, true);
    if (made.link === null) throw new Error('No link was made.');
    return {
      userId: made.userId,
      created: made.created,
      link: made.link.url,
      expiresAt: made.link.expiresAt,
    };
  });
}

/**
 * The first admin from the environment at start-up (`CCMS_FIRST_ADMIN_EMAIL`, #373): as
 * `firstAdminLocally`, but only into an instance without users, checked under the access lock in
 * the same transaction, so it happens once, on the first start, and never again (null: there were
 * users, nothing was changed). `withLink` false (password sign-in off) makes no link: they sign
 * in with the provider, which finds their user by its verified email address.
 */
export async function firstAdminIntoEmpty(
  database: Database,
  request: FirstAdminRequest & { readonly withLink: boolean },
): Promise<FirstAdminMade | null> {
  const admin = new DrizzleAccessAdmin(database);
  return new DrizzleUnitOfWork(database).run(async (tx) => {
    await admin.lock(tx);
    const [row] = await drizzleOf(tx)
      .select({ id: users.id })
      .from(users)
      .limit(1);
    if (row !== undefined) return null;
    return makeFirstAdmin(database, tx, request, request.withLink);
  });
}

async function makeFirstAdmin(
  database: Database,
  tx: Transaction,
  request: FirstAdminRequest,
  withLink: boolean,
): Promise<FirstAdminMade> {
  const email = UserEmail.parse(request.email.trim());
  const actor = request.actor ?? CLI_ACTOR;
  const admin = new DrizzleAccessAdmin(database);
  const identities = new DrizzleUserIdentities();
  const links = new DrizzleSignInLinks(database);
  const audit = new DrizzleAuditLog(database);
  const role = await admin.findRole(FIRST_ADMIN_ROLE.id, tx);
  if (role && !role.permissions.includes('admin.roles')) {
    throw new Error(
      `The role "${FIRST_ADMIN_ROLE.id}" does not hold admin.roles; give it that permission, or make the first admin another way.`,
    );
  }
  if (!role) {
    await admin.insertRole(tx, FIRST_ADMIN_ROLE);
    await audit.record(tx, actor, {
      action: 'role.create',
      subject: { type: 'role', id: FIRST_ADMIN_ROLE.id },
      data: {
        permissions: [...FIRST_ADMIN_ROLE.permissions],
        scope: {},
      },
    });
  }
  let userId = await identities.userWithEmail(tx, email);
  const created = userId === undefined;
  if (userId === undefined) {
    const local = email.split('@')[0] ?? 'admin';
    const base = userIdBase({ email, username: null });
    for (const candidate of userIdCandidates(base, 50)) {
      if (
        await admin.insertUser(tx, {
          id: candidate,
          name: UserName.parse(request.name ?? local),
          email,
        })
      ) {
        userId = candidate;
        break;
      }
    }
    if (userId === undefined) throw new Error('No free user ID; run it again.');
    await audit.record(tx, actor, {
      action: 'user.create',
      subject: { type: 'user', id: userId },
      data: { roleIds: [FIRST_ADMIN_ROLE.id] },
    });
  }
  const user = await admin.findUser(tx, userId);
  if (!user) throw new Error(`User "${userId}" is missing.`);
  if (user.deactivatedAt !== null) {
    throw new Error(
      `The user "${userId}" is deactivated; reactivate them first.`,
    );
  }
  if (await admin.assign(tx, userId, FIRST_ADMIN_ROLE.id)) {
    await audit.record(tx, actor, {
      action: 'role.assign',
      subject: { type: 'role', id: FIRST_ADMIN_ROLE.id },
      data: { userId },
    });
  }
  if (!withLink) return { userId, created, link: null };
  const minted = mintSignInLinkToken();
  const expiresAt = new Date(Date.now() + request.inviteMs);
  const replaced = await links.replace(tx, {
    hash: minted.hash,
    userId,
    kind: 'invite',
    expiresAt,
  });
  await audit.record(tx, actor, {
    action: 'user.invite',
    subject: { type: 'user', id: userId },
    data: {
      via: request.via ?? 'cli',
      emailed: false,
      replaced,
      expiresAt: expiresAt.toISOString(),
    },
  });
  return {
    userId,
    created,
    link: {
      url: signInLinkUrl(request.linkBase ?? '', minted.token),
      expiresAt,
    },
  };
}
