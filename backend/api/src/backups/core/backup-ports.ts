import type { Actor } from '../../access/core/actor.js';
import type { PageRequest, Paginated } from '../../base/core/paging.js';
import type { Transaction } from '../../base/core/unit-of-work.js';
import type {
  BackupError,
  BackupRequest,
  BackupRequestKind,
  BackupRun,
  BackupServiceState,
  BackupTrigger,
  VerifyMode,
} from './backup-run.js';
import type {
  BackupLocation,
  StoredBackupSettings,
} from './backup-settings.js';
import type { StoredBackup } from './retention.js';

/** A backup key: the age recipient backups are encrypted to. */
export interface BackupKey {
  readonly id: string;
  /** The age X25519 recipient (`age1…`): public, backups are encrypted to it. */
  readonly recipient: string;
  readonly fingerprint: string;
  /** The identity (`AGE-SECRET-KEY-1…`), sealed; null when the server keeps none. */
  readonly identitySealed: string | null;
  readonly createdAt: Date;
  /** When a rotation replaced it; null for the current key. */
  readonly retiredAt: Date | null;
}

/** A run as it starts. */
export interface NewBackupRun {
  readonly id: string;
  readonly trigger: BackupTrigger;
  readonly scheduledFor: Date | null;
  readonly startedAt: Date;
  readonly processId: string;
  readonly requestId: string | null;
}

/** How a run ended. */
export type FinishedBackupRun =
  | {
      readonly status: 'succeeded';
      readonly finishedAt: Date;
      readonly sizeBytes: number;
      readonly sha256: string;
      readonly location: string;
      readonly name: string;
      readonly keyFingerprint: string;
      readonly verified: boolean | null;
      readonly verifyMode: VerifyMode | null;
    }
  | {
      readonly status: 'failed';
      readonly finishedAt: Date;
      readonly error: BackupError;
      readonly errorDetail: string;
      readonly location: string | null;
      readonly keyFingerprint: string | null;
      /** False when the backup was made but its check failed. */
      readonly verified: false | null;
      readonly verifyMode: VerifyMode | null;
    };

/**
 * Port: the backup state in the database (#529): the settings (one row),
 * the keys, the runs, the requests from the page and the backup process's
 * heartbeat.
 */
export abstract class BackupStore {
  /** The stored settings, or the defaults when nothing was stored yet. */
  abstract settings(tx?: Transaction): Promise<StoredBackupSettings>;
  /** The stored settings, holding their row until `tx` ends (made when missing). */
  abstract lockSettings(tx: Transaction): Promise<StoredBackupSettings>;
  abstract saveSettings(
    tx: Transaction,
    settings: StoredBackupSettings,
  ): Promise<void>;

  /** The current key (not retired), or undefined when none was made. */
  abstract currentKey(tx?: Transaction): Promise<BackupKey | undefined>;
  /** Every key, newest first. */
  abstract keys(page: PageRequest): Promise<Paginated<BackupKey>>;
  /** Adds `key` as the current one, retiring the one before (at `key.createdAt`). */
  abstract addKey(tx: Transaction, key: BackupKey): Promise<void>;
  /** Drops the sealed identity of the key `id`. */
  abstract dropIdentity(tx: Transaction, id: string): Promise<void>;

  /** The runs, newest first. */
  abstract runs(page: PageRequest): Promise<Paginated<BackupRun>>;
  abstract run(id: string): Promise<BackupRun | undefined>;
  abstract latestRun(): Promise<BackupRun | undefined>;
  /** The newest run that succeeded and whose check did not fail. */
  abstract latestGoodRun(): Promise<BackupRun | undefined>;
  /** The newest scheduled run's `scheduledFor`. */
  abstract lastScheduledFor(): Promise<Date | undefined>;
  abstract startRun(run: NewBackupRun): Promise<void>;
  abstract finishRun(id: string, finished: FinishedBackupRun): Promise<void>;
  /** Marks every run still `running` failed (`interrupted`); answers how many. */
  abstract interruptRuns(at: Date): Promise<number>;

  abstract addRequest(
    tx: Transaction,
    request: {
      id: string;
      kind: BackupRequestKind;
      requestedBy: Pick<Actor, 'kind' | 'id'>;
      createdAt: Date;
    },
  ): Promise<void>;
  abstract request(id: string): Promise<BackupRequest | undefined>;
  /** A request of `kind` still pending or running, if any. */
  abstract pendingRequest(
    tx: Transaction,
    kind: BackupRequestKind,
  ): Promise<BackupRequest | undefined>;
  /** Takes the oldest pending request (`running` from now on), if any. */
  abstract claimRequest(at: Date): Promise<BackupRequest | undefined>;
  abstract finishRequest(
    id: string,
    result: {
      status: 'done' | 'failed';
      finishedAt: Date;
      runId?: string | null;
      error?: string | null;
      errorDetail?: string | null;
    },
  ): Promise<void>;
  /** Marks requests still `running` failed (`interrupted`), as the process starts. */
  abstract interruptRequests(at: Date): Promise<number>;

  /** The backup process's last heartbeat, if it ever ran. */
  abstract service(): Promise<BackupServiceState | undefined>;
  abstract heartbeat(state: BackupServiceState): Promise<void>;
}

/** Port: makes and reads age keys. */
export abstract class BackupKeyMaker {
  /** A new X25519 identity and its recipient. */
  abstract generate(): Promise<{ identity: string; recipient: string }>;
  /** The recipient of `identity`; throws for one that is no age identity. */
  abstract recipientOf(identity: string): Promise<string>;
}

/** What a backup holds, as `manifest.json` in it says. */
export interface BackupManifest {
  readonly format: 1;
  readonly runId: string;
  readonly createdAt: string;
  readonly database: {
    /** The migrations applied (`drizzle.__drizzle_migrations`). */
    readonly migrations: number;
    /** Rows per table of the dump's snapshot (`schema.table`). */
    readonly rows: Readonly<Record<string, number>>;
  };
  /** The content repository as a Git bundle; null when there was none. */
  readonly content: { readonly file: string; readonly refs: number } | null;
  /** The blobs of an `fs` blob store, under `dir`; null with an S3 blob store. */
  readonly blobs: {
    readonly dir: string;
    /** The hashes the database refers to, at the dump's snapshot. */
    readonly referenced: readonly string[];
  } | null;
  /** The instance secret key file, when it is one: its name in the backup. */
  readonly secretKeyFile: string | null;
}

/** A backup made ready in the staging folder, not yet encrypted. */
export interface PreparedBackup {
  readonly runId: string;
  /** The staging folder (inside the backup volume). */
  readonly dir: string;
  readonly manifest: BackupManifest;
}

/** The encrypted file, in the staging folder. */
export interface EncryptedBackup {
  readonly path: string;
  readonly sizeBytes: number;
  readonly sha256: string;
}

/** A step of a run failed: `code` says which, `message` the exact error. */
export class BackupStepError extends Error {
  constructor(
    readonly code: BackupError,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'BackupStepError';
  }
}

/**
 * Port: what a backup is made of. `prepare` dumps the database (at one
 * snapshot, with its row counts) and the content repository (a bundle)
 * into a staging folder; `encrypt` archives them with the blobs and the
 * instance key file and encrypts the archive to the recipient.
 */
export abstract class BackupSource {
  abstract prepare(runId: string): Promise<PreparedBackup>;
  abstract encrypt(
    prepared: PreparedBackup,
    recipient: string,
  ): Promise<EncryptedBackup>;
  /** Removes the staging folder and everything in it. */
  abstract discard(prepared: PreparedBackup): Promise<void>;
}

/** Port: checks a backup can be restored (#529, "verifies it"). */
export abstract class BackupVerifier {
  /**
   * With `identity`, decrypts `encrypted` and checks what comes out; else
   * checks the prepared parts and the encrypted file's size and hash.
   * Throws `BackupStepError` (`verify-failed`) saying what did not hold.
   */
  abstract verify(input: {
    readonly prepared: PreparedBackup;
    readonly encrypted: EncryptedBackup;
    readonly identity: string | undefined;
  }): Promise<VerifyMode>;
}

/** Where one location's backups are. */
export abstract class BackupTarget {
  /** `local:<subfolder>` or `s3:<bucket>/<prefix>`, never a credential. */
  abstract readonly description: string;
  /** Moves or uploads `file` there as `name`. */
  abstract put(file: EncryptedBackup, name: string): Promise<void>;
  /** The backups there (only names a run gives). */
  abstract list(): Promise<StoredBackup[]>;
  abstract delete(name: string): Promise<void>;
  /** Writes, reads back and deletes a small object; throws with the exact error. */
  abstract test(): Promise<void>;
}

/** Port: opens the target of a location. */
export abstract class BackupTargets {
  /** `s3Secret` for an S3 location; throws `BackupStepError` (`location-unavailable`). */
  abstract open(
    location: BackupLocation,
    s3Secret: string | undefined,
  ): BackupTarget;
}

/** Port: one run at a time across every backup process (a Postgres advisory lock). */
export abstract class BackupLock {
  /** Runs `work` holding the lock; undefined, without running it, when another holds it. */
  abstract tryWith<T>(work: () => Promise<T>): Promise<T | undefined>;
}

/** An incident admins hear of once (`backup.failed`, `backup.overdue`). */
export interface BackupIncident {
  readonly topic: 'backup.failed' | 'backup.overdue';
  /** Once per incident: the last good run it follows. */
  readonly key: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

/** Port: the outbox rows of backup incidents, for notifications. */
export abstract class BackupIncidents {
  /** Writes `incident`; false when one with its key was written already. */
  abstract emit(incident: BackupIncident): Promise<boolean>;
}
