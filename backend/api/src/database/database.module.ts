import { Global, Module, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.js';
import { ServerRole } from '../config/server-role.js';
import { UnitOfWork } from '../base/core/unit-of-work.js';
import { Database } from './database.js';
import { DrizzleUnitOfWork } from './drizzle-unit-of-work.js';
import { openDatabase } from './open-database.js';

/** How long a `worker` waits at start for the migrations to be applied (#527). */
export const WORKER_MIGRATION_WAIT_MS = 120_000;

/**
 * The database for every component: global, so a component's adapters in
 * `repos/` inject `Database` (and actions `UnitOfWork`) without importing
 * this module. Closed after the HTTP server has stopped, so no request
 * still uses it.
 */
@Global()
@Module({
  providers: [
    {
      provide: Database,
      inject: [ConfigService, ServerRole],
      useFactory: (config: ConfigService<Env, true>, role: ServerRole) =>
        openDatabase({
          // A worker never migrates (#527): it waits for the API's.
          ...(!role.migrates && {
            waitForMigrationsMs: WORKER_MIGRATION_WAIT_MS,
          }),
          CCMS_DATABASE_URL: config.get('CCMS_DATABASE_URL', { infer: true }),
          CCMS_DATABASE_MIGRATE: config.get('CCMS_DATABASE_MIGRATE', {
            infer: true,
          }),
          CCMS_DATABASE_POOL_MAX: config.get('CCMS_DATABASE_POOL_MAX', {
            infer: true,
          }),
          CCMS_DATABASE_LOCK_TIMEOUT_MS: config.get(
            'CCMS_DATABASE_LOCK_TIMEOUT_MS',
            { infer: true },
          ),
          CCMS_DATABASE_MIGRATE_ATTEMPTS: config.get(
            'CCMS_DATABASE_MIGRATE_ATTEMPTS',
            { infer: true },
          ),
        }),
    },
    {
      provide: UnitOfWork,
      inject: [Database, ConfigService],
      useFactory: (database: Database, config: ConfigService<Env, true>) =>
        new DrizzleUnitOfWork(database, {
          lockTimeoutMs: config.get('CCMS_DATABASE_WRITE_LOCK_TIMEOUT_MS', {
            infer: true,
          }),
          statementTimeoutMs: config.get(
            'CCMS_DATABASE_WRITE_STATEMENT_TIMEOUT_MS',
            { infer: true },
          ),
        }),
    },
  ],
  exports: [Database, UnitOfWork],
})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(private readonly database: Database) {}

  async onApplicationShutdown(): Promise<void> {
    await this.database.close();
  }
}
