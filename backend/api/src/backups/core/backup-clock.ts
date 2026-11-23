/** Port: the time, so tests can set it (a schedule, retention, a stale heartbeat). */
export abstract class BackupClock {
  abstract now(): Date;
}

export class SystemBackupClock extends BackupClock {
  now(): Date {
    return new Date();
  }
}

/** What the API's backup routes read from the environment. */
export abstract class BackupStatusSettings {
  /**
   * The status warns when the last good backup is older than this
   * (`CCMS_BACKUP_WARN_AFTER_HOURS`, default 26).
   */
  abstract readonly warnAfterHours: number;
}
