import type { Actor } from '../../access/core/actor.js';

/** What started a run. */
export type BackupTrigger = 'schedule' | 'manual' | 'command';

export type BackupRunStatus = 'running' | 'succeeded' | 'failed';

/**
 * Why a run failed, a stable code (the detail says the rest):
 * `backup-key-missing` (no key to encrypt to: never unencrypted),
 * `location-unavailable`, `database-dump-failed`, `archive-failed`,
 * `encrypt-failed`, `upload-failed`, `verify-failed`, `interrupted` (the
 * process stopped during the run), `failed` (anything else).
 */
export const BACKUP_ERRORS = [
  'backup-key-missing',
  'location-unavailable',
  'database-dump-failed',
  'archive-failed',
  'encrypt-failed',
  'upload-failed',
  'verify-failed',
  'interrupted',
  'failed',
] as const;
export type BackupError = (typeof BACKUP_ERRORS)[number];

/** How a run was checked: by decrypting the written file, or before encrypting it. */
export type VerifyMode = 'decrypted' | 'before-encryption';

/** A run, as the history shows it. */
export interface BackupRun {
  readonly id: string;
  readonly trigger: BackupTrigger;
  readonly status: BackupRunStatus;
  /** The schedule's time it ran for (a scheduled run). */
  readonly scheduledFor: Date | null;
  readonly startedAt: Date;
  readonly finishedAt: Date | null;
  /** The encrypted file's size in bytes. */
  readonly sizeBytes: number | null;
  /** The encrypted file's SHA-256 (hex). */
  readonly sha256: string | null;
  /** Where it went: `local:<subfolder>` or `s3:<bucket>/<prefix>`; never a credential. */
  readonly location: string | null;
  /** Its name at the location. */
  readonly name: string | null;
  /** The fingerprint of the key it was encrypted to. */
  readonly keyFingerprint: string | null;
  /** Null: not checked (verification off, or the run failed before). */
  readonly verified: boolean | null;
  readonly verifyMode: VerifyMode | null;
  readonly error: BackupError | null;
  /** What went wrong, for an operator; never a secret. */
  readonly errorDetail: string | null;
}

/** What a request asks the backup process to do. */
export type BackupRequestKind = 'run' | 'test-location';

export type BackupRequestStatus = 'pending' | 'running' | 'done' | 'failed';

/** A request from the page to the backup process ("Back up now", "Test location"). */
export interface BackupRequest {
  readonly id: string;
  readonly kind: BackupRequestKind;
  readonly status: BackupRequestStatus;
  readonly requestedBy: Pick<Actor, 'kind' | 'id'>;
  readonly createdAt: Date;
  readonly finishedAt: Date | null;
  /** The run it started (`run`). */
  readonly runId: string | null;
  /** Why it failed: a stable code, and the exact error. */
  readonly error: string | null;
  readonly errorDetail: string | null;
}

/** The backup process, as its last heartbeat said. */
export interface BackupServiceState {
  readonly processId: string;
  readonly startedAt: Date;
  readonly lastSeenAt: Date;
  /** What its environment fixes. */
  readonly overrides: Readonly<
    Record<string, { variable: string; value?: unknown }>
  >;
  /** The fingerprint of the key `CCMS_BACKUP_KEY_FILE` sets, when it does. */
  readonly keyFingerprint: string | null;
}

/** A heartbeat older than this means the backup process is not running. */
export const SERVICE_STALE_MS = 60_000;

/** A run still `running` with no heartbeat for this long was cut off. */
export const RUN_STALE_MS = 5 * 60_000;
