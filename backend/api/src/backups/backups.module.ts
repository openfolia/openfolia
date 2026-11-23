import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuditModule } from '../audit/audit.module.js';
import type { Env } from '../config/env.js';
import { BackupsController } from './api/backups.controller.js';
import {
  CreateBackupKeyAction,
  GetBackupRequestAction,
  GetBackupSettingsAction,
  GetBackupStatusAction,
  ListBackupKeysAction,
  ListBackupRunsAction,
  RequestBackupAction,
  UpdateBackupSettingsAction,
} from './core/actions/manage-backups.action.js';
import {
  BackupClock,
  BackupStatusSettings,
  SystemBackupClock,
} from './core/backup-clock.js';
import { BackupKeyMaker, BackupStore } from './core/backup-ports.js';
import { AgeBackupKeys } from './repos/age-backup-keys.js';
import { DrizzleBackupStore } from './repos/drizzle-backup-store.js';

/**
 * Backups (#529), the API's side: the settings, the key, the requests to
 * the backup process, the history and the status. The backups themselves
 * are made by the backup process (`backup.main.ts`, `CCMS_ROLE=backup`),
 * which reads the same tables.
 */
@Module({
  imports: [AuditModule],
  controllers: [BackupsController],
  providers: [
    GetBackupSettingsAction,
    UpdateBackupSettingsAction,
    CreateBackupKeyAction,
    ListBackupKeysAction,
    ListBackupRunsAction,
    RequestBackupAction,
    GetBackupRequestAction,
    GetBackupStatusAction,
    { provide: BackupStore, useClass: DrizzleBackupStore },
    { provide: BackupKeyMaker, useClass: AgeBackupKeys },
    { provide: BackupClock, useClass: SystemBackupClock },
    {
      provide: BackupStatusSettings,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>): BackupStatusSettings => ({
        warnAfterHours: config.get('CCMS_BACKUP_WARN_AFTER_HOURS', {
          infer: true,
        }),
      }),
    },
  ],
})
export class BackupsModule {}
