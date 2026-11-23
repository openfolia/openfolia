import { Injectable } from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';
import type { Actor } from '../../access/core/actor.js';
import { serviceAccountActor } from '../../access/core/service-accounts.js';
import { UserDirectory } from '../../access/core/user-directory.js';
import { roles } from '../../access/repos/access.tables.js';
import { toRole } from '../../access/repos/drizzle-user-directory.js';
import {
  serviceAccountRoles,
  serviceAccounts,
} from '../../access/repos/service-accounts.tables.js';
import { Database } from '../../database/database.js';
import type { WebhookOwner } from '../core/webhook.js';
import { WebhookOwners } from '../core/webhook-ports.js';

/**
 * `WebhookOwners`: a user through the user directory (none when
 * deactivated), a service account with its roles from the database (none
 * when deactivated or gone).
 */
@Injectable()
export class DrizzleWebhookOwners extends WebhookOwners {
  constructor(
    private readonly users: UserDirectory,
    private readonly database: Database,
  ) {
    super();
  }

  async find(owner: WebhookOwner): Promise<Actor | undefined> {
    if (owner.kind === 'user') return this.users.findActor(owner.id);
    // One statement: the account and its roles read together.
    const rows = await this.database.db
      .select({
        deactivatedAt: serviceAccounts.deactivatedAt,
        role: roles,
      })
      .from(serviceAccounts)
      .leftJoin(
        serviceAccountRoles,
        eq(serviceAccountRoles.serviceAccountId, serviceAccounts.id),
      )
      .leftJoin(roles, eq(roles.id, serviceAccountRoles.roleId))
      .where(eq(serviceAccounts.id, owner.id))
      .orderBy(asc(roles.id));
    const [first] = rows;
    if (!first || first.deactivatedAt !== null) return undefined;
    return serviceAccountActor(
      owner.id,
      rows.flatMap(({ role }) => (role ? [toRole(role)] : [])),
    );
  }
}
