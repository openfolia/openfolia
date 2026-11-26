import { CLI_ACTOR } from '../../access/repos/issue-token-locally.js';
import { recordEnded } from '../../access/core/refused-sign-ins.js';
import { DrizzleRefusedSignIns } from '../../access/repos/drizzle-refused-sign-ins.js';
import { DrizzleAuditLog } from '../../audit/repos/drizzle-audit-log.js';
import { runContended } from '../../base/core/unit-of-work.js';
import type { Database } from '../../database/database.js';
import { DrizzleUnitOfWork } from '../../database/drizzle-unit-of-work.js';
import { SETTINGS_SUBJECT } from '../core/installation-settings.js';
import { DrizzleInstallationSettingsStore } from './drizzle-installation-settings-store.js';

/**
 * Lets people sign in without single sign-on again (#378), from the server's command line
 * (`api:allow-other-sign-ins`): for an identity provider that is gone, with no break-glass account
 * to turn the setting off. First ends every session, open second step, link and code, whatever it
 * was begun with (which providers are offered, only the running server knows), so nothing the
 * setting refused comes back. Audited as `service:cli`. Answers whether it was required.
 */
export async function allowOtherSignInsLocally(
  database: Database,
): Promise<boolean> {
  const store = new DrizzleInstallationSettingsStore(database);
  const unit = new DrizzleUnitOfWork(database);
  const auditLog = new DrizzleAuditLog(database);
  const required = (settings: { readonly singleSignOn: string }) =>
    settings.singleSignOn !== 'optional';
  if (!required((await store.read()).settings)) return false;
  await runContended(unit, async (tx) => {
    const ended = await new DrizzleRefusedSignIns().end(tx, {
      allowed: { providers: [], breakGlassUserId: null },
      limits: null,
      now: new Date(),
    });
    await recordEnded(auditLog, tx, CLI_ACTOR, ended);
  });
  return runContended(unit, async (tx) => {
    const { settings } = await store.lock(tx);
    if (!required(settings)) return false;
    await store.write(tx, { ...settings, singleSignOn: 'optional' });
    await auditLog.record(tx, CLI_ACTOR, {
      action: 'settings.single-sign-on',
      subject: SETTINGS_SUBJECT,
      data: { from: settings.singleSignOn, to: 'optional', via: 'cli' },
    });
    return true;
  });
}
