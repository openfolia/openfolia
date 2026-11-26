import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module.js';
import { SignInEvents } from '../access/core/sign-in-events.js';
import { OutboxSignInEvents } from '../access/repos/outbox-sign-in-events.js';
import { SignInAtStart } from '../access/repos/sign-in-at-start.js';
import { SecondFactorRule } from '../access/core/second-factors.js';
import { EndRefusedSignIns } from '../access/core/refused-sign-ins.js';
import { AuditModule } from '../audit/audit.module.js';
import { MailModule } from '../mail/mail.module.js';
import { SelfApprovalRule } from '../change-sets/core/self-approval.js';
import { SettingsController } from './api/settings.controller.js';
import { GetInstallationSettingsAction } from './core/actions/get-installation-settings.action.js';
import { UpdateInstallationSettingsAction } from './core/actions/update-installation-settings.action.js';
import { InstallationSettingsStore } from './core/installation-settings-store.js';
import { StoredSelfApprovalRule } from './core/stored-self-approval-rule.js';
import { StoredSecondFactorRule } from './core/stored-second-factor-rule.js';
import { SignInStates } from './core/sign-in-state.js';
import { DrizzleInstallationSettingsStore } from './repos/drizzle-installation-settings-store.js';

/**
 * The installation's own settings (#588), set by holders of `admin.roles` and kept in the
 * database (global). Exports the self-approval rule the change-set workflow reads, and
 * the second factor's, which signing in reads (#611), and what sign-ins tell others of (#378).
 */
@Module({
  imports: [AccessModule, AuditModule, MailModule],
  controllers: [SettingsController],
  providers: [
    SignInStates,
    EndRefusedSignIns,
    SignInAtStart,
    { provide: SignInEvents, useClass: OutboxSignInEvents },
    GetInstallationSettingsAction,
    UpdateInstallationSettingsAction,
    {
      provide: InstallationSettingsStore,
      useClass: DrizzleInstallationSettingsStore,
    },
    { provide: SelfApprovalRule, useClass: StoredSelfApprovalRule },
    { provide: SecondFactorRule, useClass: StoredSecondFactorRule },
  ],
  exports: [SelfApprovalRule, SecondFactorRule, SignInEvents],
})
export class SettingsModule {}
