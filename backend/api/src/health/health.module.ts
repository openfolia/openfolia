import { Module } from '@nestjs/common';
import { HealthController } from './api/health.controller.js';
import { CheckHealthAction } from './core/actions/check-health.action.js';
import { BlobStoreProbe } from './core/blob-store-probe.js';
import { DatabaseProbe } from './core/database-probe.js';
import { BlobStoreHealthProbe } from './repos/blob-store-health-probe.js';
import { DrizzleDatabaseProbe } from './repos/drizzle-database-probe.js';

@Module({
  controllers: [HealthController],
  providers: [
    CheckHealthAction,
    { provide: DatabaseProbe, useClass: DrizzleDatabaseProbe },
    { provide: BlobStoreProbe, useClass: BlobStoreHealthProbe },
  ],
})
export class HealthModule {}
