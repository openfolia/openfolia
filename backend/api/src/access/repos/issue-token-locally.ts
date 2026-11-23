import { DrizzleAuditLog } from '../../audit/repos/drizzle-audit-log.js';
import type { Database } from '../../database/database.js';
import { DrizzleUnitOfWork } from '../../database/drizzle-unit-of-work.js';
import type { Actor } from '../core/actor.js';
import {
  DEFAULT_TOKEN_LIFETIME_MS,
  MAX_ACTIVE_TOKENS,
  MAX_TOKEN_LIFETIME_MS,
  ServiceAccountId,
  ServiceTokenName,
} from '../core/service-accounts.js';
import { mintServiceToken } from '../core/service-token.js';
import { DrizzleAccessAdmin } from './drizzle-access-admin.js';
import { DrizzleServiceAccountStore } from './drizzle-service-accounts.js';

/**
 * Who the command line acts as in the audit log: someone with access to the
 * server and its database. Outside the `UserId` format (":"), so no user or
 * service account has this ID.
 */
export const CLI_ACTOR: Actor = Object.freeze({
  kind: 'service',
  id: 'service:cli',
  roles: Object.freeze([]),
}) as Actor;

export interface LocalTokenRequest {
  readonly serviceAccountId: string;
  /** What the token is for. */
  readonly name: string;
  /** Only for a service account that does not exist yet: the roles it starts with. */
  readonly roleIds: readonly string[];
  /** How long it is valid, in days (default 90, at most 366). */
  readonly days?: number;
}

/**
 * Issues a token from the server's command line (`api:service-token`), for
 * the first service account of a deployment without the shared token,
 * where no person can sign in yet: creates the service account when it does
 * not exist (with `roleIds`), then issues a token and answers it, to be
 * shown once. An existing account keeps its roles (`roleIds` must be empty;
 * change roles in the admin screens). Audited like the API's changes, by
 * `service:cli`, in one transaction under the access lock.
 */
export async function issueTokenLocally(
  database: Database,
  request: LocalTokenRequest,
): Promise<{ readonly token: string; readonly expiresAt: Date }> {
  const id = ServiceAccountId.parse(request.serviceAccountId);
  const name = ServiceTokenName.parse(request.name);
  const lifetime =
    request.days === undefined
      ? DEFAULT_TOKEN_LIFETIME_MS
      : request.days * 24 * 60 * 60 * 1000;
  if (!(lifetime > 0 && lifetime <= MAX_TOKEN_LIFETIME_MS)) {
    throw new Error('A token is valid for 1 to 366 days.');
  }
  const admin = new DrizzleAccessAdmin(database);
  const store = new DrizzleServiceAccountStore(database);
  const audit = new DrizzleAuditLog(database);
  return new DrizzleUnitOfWork(database).run(async (tx) => {
    await admin.lock(tx);
    const existing = await store.find(id, tx);
    if (existing && request.roleIds.length > 0) {
      throw new Error(
        `The service account "${id}" exists: its roles are changed in Admin, not here.`,
      );
    }
    if (existing?.deactivatedAt) {
      throw new Error(`The service account "${id}" is deactivated.`);
    }
    if (!existing) {
      const roleIds = [...new Set(request.roleIds)];
      const missing = await admin.missingRoles(tx, roleIds);
      if (missing.length > 0) throw new Error(`No role ${missing.join(', ')}.`);
      for (const roleId of roleIds) {
        if (
          (await admin.findRole(roleId, tx))?.permissions.includes(
            'admin.roles',
          )
        ) {
          throw new Error(
            `The role "${roleId}" holds admin.roles, which no service account may hold.`,
          );
        }
      }
      await store.insert(tx, { id, name: id, description: null });
      await audit.record(tx, CLI_ACTOR, {
        action: 'service-account.create',
        subject: { type: 'service-account', id },
        data: { roleIds },
      });
      for (const roleId of roleIds) {
        await store.assign(tx, id, roleId);
        await audit.record(tx, CLI_ACTOR, {
          action: 'role.assign',
          subject: { type: 'role', id: roleId },
          data: { serviceAccountId: id },
        });
      }
    }
    if ((await store.countActiveTokens(tx, id)) >= MAX_ACTIVE_TOKENS) {
      throw new Error(
        `The service account "${id}" holds ${MAX_ACTIVE_TOKENS} tokens neither revoked nor expired; revoke one first.`,
      );
    }
    const minted = mintServiceToken();
    const expiresAt = new Date(Date.now() + lifetime);
    const token = await store.insertToken(tx, {
      id: minted.id,
      serviceAccountId: id,
      name,
      secretHash: minted.secretHash,
      expiresAt,
    });
    if (!token) throw new Error('The token ID is taken; run it again.');
    await audit.record(tx, CLI_ACTOR, {
      action: 'service-token.issue',
      subject: { type: 'service-account', id },
      data: { tokenId: token.id, expiresAt: expiresAt.toISOString() },
    });
    return { token: minted.token, expiresAt };
  });
}
