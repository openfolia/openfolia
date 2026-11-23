import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuditModule } from '../audit/audit.module.js';
import type { Env } from '../config/env.js';
import { StorageRecounter } from './api/storage-recounter.js';
import { StorageUsageController } from './api/storage-usage.controller.js';
import { GetStorageUsageAction } from './core/actions/get-storage-usage.action.js';
import { ListStoredFilesAction } from './core/actions/list-stored-files.action.js';
import { RecordStorageLimitAction } from './core/actions/record-storage-limit.action.js';
import { RecountStorageAction } from './core/actions/recount-storage.action.js';
import { StorageQuota, StorageSettings } from './core/storage-quota.js';
import {
  InstanceSizes,
  MediaMeter,
  PdfArchiveMeter,
  StorageUsage,
} from './core/storage-usage.js';
import { BlobStoreMediaMeter } from './repos/blob-store-media-meter.js';
import { DrizzlePdfArchiveMeter } from './repos/drizzle-pdf-archive-meter.js';
import { DrizzleStorageUsage } from './repos/drizzle-storage-usage.js';
import { LocalInstanceSizes } from './repos/local-instance-sizes.js';

/**
 * The storage an instance uses (#404): the kept totals (`StorageUsage`),
 * the limit on the upload path (`StorageQuota`, global, for the assets'
 * upload and delete and the release outputs), the periodic recount and
 * `GET /storage-usage` for administrators.
 */
@Global()
@Module({
  imports: [AuditModule],
  controllers: [StorageUsageController],
  providers: [
    GetStorageUsageAction,
    ListStoredFilesAction,
    RecountStorageAction,
    RecordStorageLimitAction,
    StorageRecounter,
    StorageQuota,
    { provide: StorageUsage, useClass: DrizzleStorageUsage },
    { provide: MediaMeter, useClass: BlobStoreMediaMeter },
    { provide: PdfArchiveMeter, useClass: DrizzlePdfArchiveMeter },
    { provide: InstanceSizes, useClass: LocalInstanceSizes },
    {
      provide: StorageSettings,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>): StorageSettings => ({
        limitBytes:
          config.get('CCMS_STORAGE_LIMIT_BYTES', { infer: true }) ?? null,
        recountEveryMs:
          config.get('CCMS_STORAGE_RECOUNT_HOURS', { infer: true }) * 3_600_000,
      }),
    },
  ],
  exports: [StorageQuota],
})
export class StorageUsageModule {}
