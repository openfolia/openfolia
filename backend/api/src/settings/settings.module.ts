import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { SelfApprovalRule } from '../change-sets/core/self-approval.js';
import { SettingsController } from './api/settings.controller.js';
import { GetInstallationSettingsAction } from './core/actions/get-installation-settings.action.js';
import { UpdateInstallationSettingsAction } from './core/actions/update-installation-settings.action.js';
import { InstallationSettingsStore } from './core/installation-settings-store.js';
import { StoredSelfApprovalRule } from './core/stored-self-approval-rule.js';
import { DrizzleInstallationSettingsStore } from './repos/drizzle-installation-settings-store.js';

/**
 * The installation's own settings (#588), set by holders of `admin.roles` and kept in the
 * database (global). Exports the self-approval rule the change-set workflow reads.
 */
@Module({
  imports: [AuditModule],
  controllers: [SettingsController],
  providers: [
    GetInstallationSettingsAction,
    UpdateInstallationSettingsAction,
    { provide: InstallationSettingsStore, useClass: DrizzleInstallationSettingsStore },
    { provide: SelfApprovalRule, useClass: StoredSelfApprovalRule },
  ],
  exports: [SelfApprovalRule],
})
export class SettingsModule {}
