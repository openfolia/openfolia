/**
 * The backup image's health check (#813, the Dockerfile's `HEALTHCHECK`):
 * `node dist/backups/backup-health.main.js` exits 0 while the backup loop's
 * last heartbeat that reached the database is recent (`repos/health-file.ts`),
 * else 1, and prints what it found either way.
 */
import { z } from 'zod';
import { BackupHealthEnv } from '../config/backup-env.js';
import { healthOf } from './repos/health-file.js';

async function check(): Promise<number> {
  const parsed = BackupHealthEnv.safeParse(process.env);
  if (!parsed.success) {
    console.error(`openfolia backup health: ${z.prettifyError(parsed.error)}`);
    return 1;
  }
  const file = parsed.data.CCMS_BACKUP_HEALTH_FILE;
  if (file === undefined) {
    console.error(
      'openfolia backup health: CCMS_BACKUP_HEALTH_FILE is not set, so the service records no heartbeat to check.',
    );
    return 1;
  }
  const health = await healthOf(file, new Date());
  (health.healthy ? console.log : console.error)(
    `openfolia backup health: ${health.healthy ? 'healthy' : 'unhealthy'}, ${health.detail}`,
  );
  return health.healthy ? 0 : 1;
}

check().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(
      `openfolia backup health: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  },
);
