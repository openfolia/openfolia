/**
 * The backup service's health (#813): the loop writes the time of each heartbeat that reached
 * the database into a file (`CCMS_BACKUP_HEALTH_FILE`, the image's `/tmp`), and the image's
 * health check (`backup-health.main.ts`) reads it. Healthy while the last one is recent, so
 * `docker compose up --wait` waits for the service as for the others, on any Compose version.
 */
import { readFile, rename, writeFile } from 'node:fs/promises';

/** The loop's heartbeats (`backup.main.ts`), independent of a long run. */
export const HEARTBEAT_MS = 15_000;

/** Three heartbeats: a slow or missed one is no failure yet. */
export const HEALTH_MAX_AGE_MS = 3 * HEARTBEAT_MS;

/** Records a heartbeat that reached the database at `at`; written whole (a rename). */
export async function markAlive(path: string, at: Date): Promise<void> {
  const partial = `${path}.${process.pid}.partial`;
  await writeFile(partial, `${at.toISOString()}\n`, { mode: 0o600 });
  await rename(partial, path);
}

export interface BackupHealth {
  readonly healthy: boolean;
  /** What the check found, for `docker inspect` and the log of a failed `--wait`. */
  readonly detail: string;
}

/** Whether the last heartbeat recorded at `path` is at most `maxAgeMs` old at `now`. */
export async function healthOf(
  path: string,
  now: Date,
  maxAgeMs = HEALTH_MAX_AGE_MS,
): Promise<BackupHealth> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return {
        healthy: false,
        detail: `no heartbeat yet (${path} does not exist): the service is starting, or cannot reach the database`,
      };
    throw error;
  }
  const at = new Date(text.trim());
  if (Number.isNaN(at.getTime()))
    return {
      healthy: false,
      detail: `${path} holds no time: ${JSON.stringify(text.slice(0, 40))}`,
    };
  const age = now.getTime() - at.getTime();
  if (age > maxAgeMs)
    return {
      healthy: false,
      detail: `the last heartbeat that reached the database was ${Math.round(age / 1000)} s ago (at ${at.toISOString()}; at most ${maxAgeMs / 1000} s)`,
    };
  return {
    healthy: true,
    detail: `last heartbeat ${Math.max(0, Math.round(age / 1000))} s ago`,
  };
}
