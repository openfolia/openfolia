import pg from 'pg';
import { BackupLock } from '../core/backup-ports.js';

/** The advisory lock's key: a fixed number of its own ("backups", #529). */
export const BACKUP_LOCK_KEY = 529_000_529;

/**
 * `BackupLock` with a Postgres session advisory lock
 * (`pg_try_advisory_lock`) on a connection of its own, held for the run
 * and released after it (or when the connection closes, should the
 * process die), so two backup processes never run the same backup. Needs
 * a direct connection or a session-mode pooler.
 */
export class PgBackupLock extends BackupLock {
  constructor(private readonly databaseUrl: string) {
    super();
  }

  async tryWith<T>(work: () => Promise<T>): Promise<T | undefined> {
    const client = new pg.Client({ connectionString: this.databaseUrl });
    // The connection idles through the whole run: a dropped one (a Postgres restart) must not
    // crash the process with an unhandled 'error' (the unlock below then fails, and is caught).
    let lost: Error | undefined;
    client.on('error', (error) => {
      lost = error;
    });
    await client.connect();
    try {
      const { rows } = await client.query<{ locked: boolean }>(
        'select pg_try_advisory_lock($1) as locked',
        [BACKUP_LOCK_KEY],
      );
      if (!rows[0]?.locked) return undefined;
      try {
        return await work();
      } finally {
        // With the connection gone, the lock went with it.
        if (!lost) {
          await client
            .query('select pg_advisory_unlock($1)', [BACKUP_LOCK_KEY])
            .catch(() => undefined);
        }
      }
    } finally {
      await client.end().catch(() => undefined);
    }
  }
}
