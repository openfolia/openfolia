import { and, arrayContains, eq } from 'drizzle-orm';
import type { Transaction } from '../../base/core/unit-of-work.js';
import type { Database } from '../../database/database.js';
import { drizzleOf } from '../../database/drizzle-unit-of-work.js';
import { installationSettings } from '../../settings/repos/installation-settings.tables.js';
import {
  type BegunSession,
  type BreakGlassProblem,
  DEFAULT_SIGN_IN_RULE,
  type SignInRule,
  SignInRules,
  type SingleSignOnRule,
} from '../core/sign-in-rules.js';
import { PASSWORD_PROVIDER } from '../core/passwords.js';
import { roleAssignments, roles, users } from './access.tables.js';
import { userPasswords } from './passwords.tables.js';

/** `SignInRules` over the installation's settings row and the break-glass account's own rows. */
export class DrizzleSignInRules extends SignInRules {
  constructor(
    private readonly database: Database,
    /** Whether people may sign in with a password on this server. */
    private readonly passwordOn: boolean,
  ) {
    super();
  }

  read(tx?: Transaction): Promise<SignInRule> {
    return this.rule(() => true, tx);
  }

  readFor(session: BegunSession, tx?: Transaction): Promise<SignInRule> {
    return this.rule(
      (singleSignOn, breakGlassUserId) =>
        singleSignOn !== 'optional' &&
        session.providerId === PASSWORD_PROVIDER &&
        session.userId === breakGlassUserId,
      tx,
    );
  }

  /** `needed`: whether the break-glass account is looked up; nobody is it otherwise. */
  private async rule(
    needed: (
      singleSignOn: SingleSignOnRule,
      breakGlassUserId: string,
    ) => boolean,
    tx?: Transaction,
  ): Promise<SignInRule> {
    const t = installationSettings;
    const db = tx ? drizzleOf(tx) : this.database.db;
    const select = db
      .select({
        singleSignOn: t.singleSignOn,
        breakGlassUserId: t.breakGlassUserId,
        sessionIdleMinutes: t.sessionIdleMinutes,
        sessionMaxHours: t.sessionMaxHours,
      })
      .from(t)
      .where(eq(t.id, 1));
    // Shared in a transaction, as `InstallationSettingsStore.read`: a change waits for it.
    let [row] = await (tx ? select.for('share') : select);
    if (!row && tx) {
      // Nothing set yet, so nothing to hold: made here, as a first change makes it.
      await db.insert(t).values({ id: 1, version: 0 }).onConflictDoNothing();
      [row] = await select.for('share');
    }
    if (!row) return DEFAULT_SIGN_IN_RULE;
    const { breakGlassUserId, ...limits } = row;
    const singleSignOn =
      row.singleSignOn === null
        ? 'optional'
        : (row.singleSignOn as SingleSignOnRule);
    if (breakGlassUserId === null || !needed(singleSignOn, breakGlassUserId)) {
      return { ...limits, singleSignOn, breakGlass: null };
    }
    const problem = await this.breakGlassProblem(breakGlassUserId, tx);
    return {
      ...limits,
      singleSignOn,
      breakGlass:
        problem === 'no-such-user'
          ? null
          : { userId: breakGlassUserId, problem },
    };
  }

  async breakGlassProblem(
    userId: string,
    tx?: Transaction,
  ): Promise<BreakGlassProblem | 'no-such-user' | null> {
    const db = tx ? drizzleOf(tx) : this.database.db;
    const [row] = await db
      .select({
        deactivatedAt: users.deactivatedAt,
        roleId: roles.id,
        passwordOf: userPasswords.userId,
      })
      .from(users)
      .leftJoin(
        roleAssignments,
        and(
          eq(roleAssignments.userId, users.id),
          eq(roleAssignments.direct, true),
        ),
      )
      .leftJoin(
        roles,
        and(
          eq(roles.id, roleAssignments.roleId),
          arrayContains(roles.permissions, ['admin.roles']),
        ),
      )
      .leftJoin(userPasswords, eq(userPasswords.userId, users.id))
      .where(eq(users.id, userId))
      // The role with the permission first, when they hold several.
      .orderBy(roles.id)
      .limit(1);
    if (!row) return 'no-such-user';
    if (row.deactivatedAt !== null) return 'deactivated';
    if (row.roleId === null) return 'no-admin-role';
    if (row.passwordOf === null) return 'no-password';
    return this.passwordOn ? null : 'password-sign-in-off';
  }
}
