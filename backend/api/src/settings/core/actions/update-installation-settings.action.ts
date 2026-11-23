import { Injectable } from '@nestjs/common';
import type { Actor } from '../../../access/core/actor.js';
import { ActorAction } from '../../../access/core/policy.js';
import { AuditLog } from '../../../audit/core/audit-log.js';
import {
  BOUNDED,
  runContended,
  UnitOfWork,
} from '../../../base/core/unit-of-work.js';
import {
  type InstallationSettings,
  SETTINGS_SUBJECT,
  type StoredInstallationSettings,
} from '../installation-settings.js';
import { InstallationSettingsStore } from '../installation-settings-store.js';

export interface UpdateInstallationSettingsInput {
  readonly actor: Actor;
  /** The settings to change; left out stays. */
  readonly changes: Partial<InstallationSettings>;
}

/**
 * Changes the installation's settings (#588), at once and one change at a time (the row is
 * locked). Each setting changed is audited on its own, as `settings.<setting>` with `from` and
 * `to` (`settings.self-approval`). A change that changes nothing is answered as it is, with no
 * event. Approvals already given stay whatever the new self-approval rule says: it is read when
 * an approval is given. Needs `admin.roles`.
 */
@Injectable()
export class UpdateInstallationSettingsAction extends ActorAction<
  UpdateInstallationSettingsInput,
  StoredInstallationSettings
> {
  readonly policy = 'admin.roles';

  constructor(
    private readonly store: InstallationSettingsStore,
    private readonly auditLog: AuditLog,
    private readonly unit: UnitOfWork,
  ) {
    super();
  }

  protected run({
    actor,
    changes,
  }: UpdateInstallationSettingsInput): Promise<StoredInstallationSettings> {
    return runContended(
      this.unit,
      async (tx) => {
        const current = await this.store.lock(tx);
        const next: InstallationSettings = {
          selfApproval: changes.selfApproval ?? current.settings.selfApproval,
        };
        if (next.selfApproval === current.settings.selfApproval) {
          return current;
        }
        const written = await this.store.write(tx, next);
        await this.auditLog.record(tx, actor, {
          action: 'settings.self-approval',
          subject: SETTINGS_SUBJECT,
          data: {
            from: current.settings.selfApproval,
            to: next.selfApproval,
          },
        });
        return written;
      },
      BOUNDED,
    );
  }
}
