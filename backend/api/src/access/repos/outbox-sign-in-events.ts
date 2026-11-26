import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { and, arrayContains, eq, isNull } from 'drizzle-orm';
import type { Transaction } from '../../base/core/unit-of-work.js';
import { outbox } from '../../change-sets/repos/outbox.tables.js';
import { drizzleOf } from '../../database/drizzle-unit-of-work.js';
import { isMailAddress } from '../../mail/core/mail.js';
import { MailOutbox } from '../../mail/core/mail-outbox.js';
import { userPreferences } from '../../preferences/repos/preferences.tables.js';
import { SignInEvents } from '../core/sign-in-events.js';
import { roleAssignments, roles, users } from './access.tables.js';

/** `SignInEvents` over the `outbox` table and the emails waiting to be sent. */
@Injectable()
export class OutboxSignInEvents extends SignInEvents {
  constructor(private readonly mail: MailOutbox) {
    super();
  }

  async breakGlassUsed(tx: Transaction, userId: string): Promise<void> {
    const db = drizzleOf(tx);
    const admins = await db
      .selectDistinct({
        id: users.id,
        name: users.name,
        email: users.email,
        language: userPreferences.language,
      })
      .from(users)
      .innerJoin(roleAssignments, eq(roleAssignments.userId, users.id))
      .innerJoin(roles, eq(roles.id, roleAssignments.roleId))
      .leftJoin(userPreferences, eq(userPreferences.userId, users.id))
      .where(
        and(
          isNull(users.deactivatedAt),
          arrayContains(roles.permissions, ['admin.roles']),
        ),
      );
    await db.insert(outbox).values({
      topic: 'sign-in.break-glass',
      key: randomUUID(),
      payload: { userId, admins: admins.map((admin) => admin.id) },
    });
    const by = admins.find((admin) => admin.id === userId)?.name ?? userId;
    for (const { id, name, email, language } of admins) {
      if (email === null || !isMailAddress(email)) continue;
      await this.mail.queue(tx, {
        to: { address: email, name },
        language,
        template: 'emergency-sign-in',
        params: { by },
        audit: { recipient: id, kinds: ['sign-in.break-glass'] },
      });
    }
  }
}
