import { DrizzleAuditLog } from '../../audit/repos/drizzle-audit-log.js';
import type { Database } from '../../database/database.js';
import { DrizzleUnitOfWork } from '../../database/drizzle-unit-of-work.js';
import { WaysIn } from '../core/ways-in.js';
import { DrizzleAccessAdmin } from './drizzle-access-admin.js';
import { DrizzleEmailCodes } from './drizzle-email-codes.js';
import { DrizzleSignInLinks } from './drizzle-passwords.js';
import {
  DrizzlePendingSignIns,
  DrizzleSecondFactors,
} from './drizzle-second-factors.js';
import {
  DrizzleSessionStore,
  DrizzleUserIdentities,
} from './drizzle-sign-in.js';
import { CLI_ACTOR } from './issue-token-locally.js';

/**
 * Removes the second factor of the user with the address `email` (#611), from the server's
 * command line (`api:reset-second-factor`): for an administrator who lost their phone and their
 * recovery codes with nobody else to reset it. Audited as an admin's reset, by `service:cli`.
 * Answers the user's ID.
 */
export async function resetSecondFactorLocally(
  database: Database,
  email: string,
): Promise<string> {
  const admin = new DrizzleAccessAdmin(database);
  const waysIn = new WaysIn(
    new DrizzleSessionStore(database),
    new DrizzleSignInLinks(database),
    new DrizzleEmailCodes(database),
    new DrizzlePendingSignIns(database),
  );
  return new DrizzleUnitOfWork(database).run(async (tx) => {
    await admin.lock(tx);
    const userId = await new DrizzleUserIdentities().userWithEmail(
      tx,
      email.trim(),
    );
    if (userId === undefined) throw new Error('No user has this address.');
    await waysIn.holdPerson(tx, userId);
    if (!(await new DrizzleSecondFactors(database).remove(tx, userId))) {
      throw new Error(`The user "${userId}" has no second factor on.`);
    }
    await waysIn.endOpenSteps(tx, userId);
    await new DrizzleAuditLog(database).record(tx, CLI_ACTOR, {
      action: 'user.second-factor-reset',
      subject: { type: 'user', id: userId },
      data: { via: 'cli' },
    });
    return userId;
  });
}
