import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DiscoveryModule } from '@nestjs/core';
import type { Env } from '../config/env.js';
import { ServerRole } from '../config/server-role.js';
import { JobWorker } from './api/job-worker.js';
import { JobsStatusController } from './api/jobs-status.controller.js';
import { GetJobsStatusAction } from './core/actions/get-jobs-status.action.js';
import { RunJobAction } from './core/actions/run-job.action.js';
import { JobClaims } from './core/job-claims.js';
import { JobConsumers, JobsOverview } from './core/job-consumers.js';
import { JobHandlers } from './core/job-handlers.js';
import { JobQueue } from './core/job-queue.js';
import {
  JobsConnection,
  PgBossJobClaims,
  PgBossJobQueue,
  PgBossJobs,
} from './repos/pg-boss-jobs.js';
import {
  DrizzleJobConsumers,
  PgBossJobsOverview,
} from './repos/drizzle-job-consumers.js';

/**
 * Background jobs (#41) on pg-boss in the app's database: global, so a
 * component injects `JobQueue` to enqueue, and provides a `JobHandler`
 * per kind it runs (found here among every module's providers).
 * `JobWorker` claims and runs them; see `backend/api/README.md`, "Jobs".
 */
@Global()
@Module({
  imports: [DiscoveryModule],
  controllers: [JobsStatusController],
  providers: [
    GetJobsStatusAction,
    {
      provide: JobsConnection,
      inject: [ConfigService, ServerRole],
      useFactory: (
        config: ConfigService<Env, true>,
        role: ServerRole,
      ): JobsConnection => ({
        options: {
          connectionString: config.get('CCMS_DATABASE_URL', { infer: true }),
          max: config.get('CCMS_JOBS_POOL_MAX', { infer: true }),
          connectionTimeoutMillis: 5_000,
          // Maintenance (expiring attempts, retries after a lost
          // heartbeat) where jobs are consumed (#527); pg-boss coordinates
          // it between instances itself.
          supervise: role.runsBackground,
          instanceName: role.name,
        },
        // A worker never migrates (#527): it waits for the API's.
        migrate:
          role.migrates && config.get('CCMS_DATABASE_MIGRATE', { infer: true }),
      }),
    },
    // Filled from every module's providers as the app starts (`PgBossJobs`).
    { provide: JobHandlers, useFactory: () => new JobHandlers() },
    PgBossJobs,
    { provide: JobQueue, useClass: PgBossJobQueue },
    { provide: JobClaims, useClass: PgBossJobClaims },
    DrizzleJobConsumers,
    { provide: JobConsumers, useExisting: DrizzleJobConsumers },
    PgBossJobsOverview,
    { provide: JobsOverview, useExisting: PgBossJobsOverview },
    RunJobAction,
    JobWorker,
  ],
  exports: [JobQueue, JobsOverview],
})
export class JobsModule {}
