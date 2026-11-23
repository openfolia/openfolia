import { randomUUID } from 'node:crypto';
import type { UnguardedAction } from '../../../access/core/policy.js';
import { SecretSealer } from '../../../base/core/secret-sealer.js';
import { BackupClock } from '../backup-clock.js';
import { backupName } from '../backup-paths.js';
import {
  BackupIncidents,
  BackupKeyMaker,
  BackupLock,
  BackupSource,
  BackupStepError,
  BackupStore,
  BackupTargets,
  type EncryptedBackup,
  type PreparedBackup,
} from '../backup-ports.js';
import type {
  BackupError,
  BackupRun,
  BackupTrigger,
  VerifyMode,
} from '../backup-run.js';
import {
  type BackupOverrides,
  type BackupSettings,
  backupIdentityContext,
  S3_SECRET_CONTEXT,
} from '../backup-settings.js';
import { BackupVerifier } from '../backup-ports.js';
import { effectiveSettings, fingerprintOf } from '../effective-settings.js';
import { retained } from '../retention.js';
import { cronOf, nextRun } from '../schedule.js';

/**
 * Port: what the backup process's environment fixes (#529): the settings
 * it overrides, the S3 secret key and the backup key's identity when
 * variables give them, and the process's own ID and limits.
 */
export abstract class BackupEnvironment {
  abstract readonly processId: string;
  abstract readonly overrides: BackupOverrides;
  /** The S3 secret key from `CCMS_BACKUP_S3_SECRET_ACCESS_KEY(_FILE)`. */
  abstract readonly s3Secret: string | undefined;
  /** The identity from `CCMS_BACKUP_KEY_FILE`. */
  abstract readonly identity: string | undefined;
  /** Hours past which a missing good backup is an incident. */
  abstract readonly warnAfterHours: number;
}

/** Something the run logs (never a secret). */
export abstract class BackupLog {
  abstract info(message: string): void;
  abstract warn(message: string): void;
}

/** What a run ended as. */
export interface RunOutcome {
  readonly runId: string;
  readonly status: 'succeeded' | 'failed';
  readonly error?: BackupError;
  readonly errorDetail?: string;
}

const detailOf = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).slice(0, 2_000);

/**
 * One backup run (#529), holding the run lock (the caller takes it): the
 * key, the dump and the archive, encrypted to the key's recipient (never
 * unencrypted: no key, no backup), checked, put at the location, then
 * retention. Each step that fails marks the run failed with its code and
 * the exact error, and admins hear of it once per incident.
 */
export class RunBackupAction implements UnguardedAction {
  readonly policy = 'internal';

  constructor(
    private readonly store: BackupStore,
    private readonly env: BackupEnvironment,
    private readonly keys: BackupKeyMaker,
    private readonly sealer: SecretSealer,
    private readonly source: BackupSource,
    private readonly verifier: BackupVerifier,
    private readonly targets: BackupTargets,
    private readonly incidents: BackupIncidents,
    private readonly clock: BackupClock,
    private readonly log: BackupLog,
  ) {}

  async handle(input: {
    trigger: BackupTrigger;
    scheduledFor: Date | null;
    requestId: string | null;
  }): Promise<RunOutcome> {
    const runId = randomUUID();
    const startedAt = this.clock.now();
    await this.store.startRun({
      id: runId,
      trigger: input.trigger,
      scheduledFor: input.scheduledFor,
      startedAt,
      processId: this.env.processId,
      requestId: input.requestId,
    });
    this.log.info(`Backup ${runId} started (${input.trigger}).`);
    let location: string | null = null;
    let fingerprint: string | null = null;
    let verifyMode: VerifyMode | null = null;
    let verifyFailed = false;
    try {
      const settings = effectiveSettings(
        await this.store.settings(),
        this.env.overrides,
      );
      const key = await this.keyFor(settings);
      fingerprint = key.fingerprint;
      const target = this.targets.open(
        settings.location,
        await this.s3Secret(),
      );
      location = target.description;
      const prepared = await this.step('archive-failed', () =>
        this.source.prepare(runId),
      );
      let encrypted: EncryptedBackup;
      const name = backupName(startedAt, runId);
      try {
        encrypted = await this.step('encrypt-failed', () =>
          this.source.encrypt(prepared, key.recipient),
        );
        if (settings.verify) {
          try {
            verifyMode = await this.verify(
              prepared,
              encrypted,
              settings,
              key.identity,
            );
          } catch (error) {
            verifyFailed = true;
            throw error;
          }
        }
        await this.step('upload-failed', () => target.put(encrypted, name));
      } finally {
        await this.source.discard(prepared).catch((error: unknown) => {
          this.log.warn(
            `Could not remove the staging folder of ${runId}: ${detailOf(error)}`,
          );
        });
      }
      await this.store.finishRun(runId, {
        status: 'succeeded',
        finishedAt: this.clock.now(),
        sizeBytes: encrypted.sizeBytes,
        sha256: encrypted.sha256,
        location,
        name,
        keyFingerprint: fingerprint,
        verified: settings.verify ? true : null,
        verifyMode,
      });
      this.log.info(
        `Backup ${runId} written to ${location} as ${name} (${encrypted.sizeBytes} bytes${settings.verify ? ', verified' : ''}).`,
      );
      await this.prune(target, settings);
      return { runId, status: 'succeeded' };
    } catch (error) {
      const code: BackupError =
        error instanceof BackupStepError ? error.code : 'failed';
      const errorDetail = detailOf(error);
      this.log.warn(`Backup ${runId} failed (${code}): ${errorDetail}`);
      await this.store.finishRun(runId, {
        status: 'failed',
        finishedAt: this.clock.now(),
        error: code,
        errorDetail,
        location,
        keyFingerprint: fingerprint,
        verified: verifyFailed ? false : null,
        verifyMode,
      });
      const good = await this.store.latestGoodRun();
      await this.incidents.emit({
        topic: 'backup.failed',
        key: `failed:${good?.id ?? 'none'}`,
        payload: { runId, error: code },
      });
      return { runId, status: 'failed', error: code, errorDetail };
    }
  }

  private async verify(
    prepared: PreparedBackup,
    encrypted: EncryptedBackup,
    settings: BackupSettings,
    identity: string | undefined,
  ): Promise<VerifyMode> {
    return this.step('verify-failed', () =>
      this.verifier.verify({
        prepared,
        encrypted,
        identity: settings.verifyByDecrypting ? identity : undefined,
      }),
    );
  }

  /** The recipient to encrypt to, and the identity to verify with when there is one. */
  private async keyFor(settings: BackupSettings): Promise<{
    recipient: string;
    fingerprint: string;
    identity: string | undefined;
  }> {
    if (this.env.identity !== undefined) {
      const recipient = await this.step('backup-key-missing', () =>
        this.keys.recipientOf(this.env.identity!),
      );
      return {
        recipient,
        fingerprint: fingerprintOf(recipient),
        identity: this.env.identity,
      };
    }
    const key = await this.store.currentKey();
    if (!key) {
      throw new BackupStepError(
        'backup-key-missing',
        'There is no backup key, and a backup is never written unencrypted: create the key in Admin → Backups (or set CCMS_BACKUP_KEY_FILE).',
      );
    }
    let identity: string | undefined;
    if (settings.verifyByDecrypting && key.identitySealed !== null) {
      try {
        identity = this.sealer.open(
          key.identitySealed,
          backupIdentityContext(key.id),
        );
      } catch (error) {
        throw new BackupStepError(
          'verify-failed',
          'The backup key’s identity does not open with the instance secret key.',
          { cause: error },
        );
      }
    }
    return { recipient: key.recipient, fingerprint: key.fingerprint, identity };
  }

  private async s3Secret(): Promise<string | undefined> {
    if (this.env.overrides.location) return this.env.s3Secret;
    const sealed = (await this.store.settings()).s3SecretSealed;
    if (sealed === null) return undefined;
    try {
      return this.sealer.open(sealed, S3_SECRET_CONTEXT);
    } catch (error) {
      throw new BackupStepError(
        'location-unavailable',
        'The S3 secret key does not open with the instance secret key: give it again in Admin → Backups.',
        { cause: error },
      );
    }
  }

  /** Retention at the location; a failure there is logged, the run stays good. */
  private async prune(
    target: ReturnType<BackupTargets['open']>,
    settings: BackupSettings,
  ): Promise<void> {
    try {
      const { prune } = retained(
        await target.list(),
        settings.retention,
        settings.timeZone,
        this.clock.now(),
      );
      for (const backup of prune) {
        await target.delete(backup.name);
        this.log.info(
          `Retention: removed ${backup.name} from ${target.description}.`,
        );
      }
    } catch (error) {
      this.log.warn(
        `Retention at ${target.description} failed: ${detailOf(error)}`,
      );
    }
  }

  private async step<T>(code: BackupError, work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof BackupStepError) throw error;
      throw new BackupStepError(code, detailOf(error), { cause: error });
    }
  }

  /** The S3 secret, for a location test. */
  secretForTest(): Promise<string | undefined> {
    return this.s3Secret();
  }
}

/**
 * One pass of the backup process (#529), every few seconds: the oldest
 * request from the page first ("Back up now", "Test location"), else a
 * scheduled run when one is due, then the overdue check. The settings are
 * read afresh each pass, so a change applies at the next run without a
 * restart. A run holds the advisory lock, so two processes never run the
 * same backup; the due check is repeated under it.
 */
export class BackupTickAction implements UnguardedAction {
  readonly policy = 'internal';
  /** When this process began: its first use of the clock (never in the constructor). */
  private started: Date | undefined;

  constructor(
    private readonly store: BackupStore,
    private readonly env: BackupEnvironment,
    private readonly lock: BackupLock,
    private readonly runBackup: RunBackupAction,
    private readonly targets: BackupTargets,
    private readonly incidents: BackupIncidents,
    private readonly clock: BackupClock,
    private readonly log: BackupLog,
  ) {}

  private get startedAt(): Date {
    this.started ??= this.clock.now();
    return this.started;
  }

  /** At the process's start: runs and requests left `running` by a process that stopped. */
  async recover(): Promise<void> {
    void this.startedAt;
    await this.lock.tryWith(async () => {
      const now = this.clock.now();
      const runs = await this.store.interruptRuns(now);
      const requests = await this.store.interruptRequests(now);
      if (runs + requests > 0) {
        this.log.warn(
          `Marked ${runs} run(s) and ${requests} request(s) cut off by a stop as failed.`,
        );
      }
    });
  }

  /** Answers what it did, for logs and tests. */
  async handle(): Promise<'request' | 'scheduled' | 'idle'> {
    const request = await this.store.claimRequest(this.clock.now());
    if (request) {
      try {
        await this.answer(request.id, request.kind);
      } catch (error) {
        // Never left `running`: the page would wait on it, and every later request would be it.
        await this.store
          .finishRequest(request.id, {
            status: 'failed',
            finishedAt: this.clock.now(),
            error: 'failed',
            errorDetail: detailOf(error),
          })
          .catch((cause: unknown) =>
            this.log.warn(
              `Could not mark request ${request.id} failed: ${detailOf(cause)}`,
            ),
          );
        throw error;
      }
      return 'request';
    }
    const ran = await this.scheduled();
    await this.checkOverdue();
    return ran ? 'scheduled' : 'idle';
  }

  private async answer(
    id: string,
    kind: 'run' | 'test-location',
  ): Promise<void> {
    if (kind === 'test-location') {
      try {
        const settings = effectiveSettings(
          await this.store.settings(),
          this.env.overrides,
        );
        const target = this.targets.open(
          settings.location,
          await this.runBackup.secretForTest(),
        );
        await target.test();
        await this.store.finishRequest(id, {
          status: 'done',
          finishedAt: this.clock.now(),
        });
        this.log.info(`Location test of ${target.description} passed.`);
      } catch (error) {
        await this.store.finishRequest(id, {
          status: 'failed',
          finishedAt: this.clock.now(),
          error: 'location-test-failed',
          errorDetail: detailOf(error),
        });
        this.log.warn(`Location test failed: ${detailOf(error)}`);
      }
      return;
    }
    const outcome = await this.lock.tryWith(() =>
      this.runBackup.handle({
        trigger: 'manual',
        scheduledFor: null,
        requestId: id,
      }),
    );
    await this.store.finishRequest(id, {
      status: outcome?.status === 'succeeded' ? 'done' : 'failed',
      finishedAt: this.clock.now(),
      runId: outcome?.runId ?? null,
      error: outcome === undefined ? 'backup-running' : (outcome.error ?? null),
      errorDetail:
        outcome === undefined
          ? 'Another backup process is running a backup; try again once it has finished.'
          : (outcome.errorDetail ?? null),
    });
  }

  /** The schedule's time due now, if any. */
  private async due(): Promise<Date | undefined> {
    const stored = await this.store.settings();
    const settings = effectiveSettings(stored, this.env.overrides);
    if (!settings.enabled) return undefined;
    const last = await this.store.lastScheduledFor();
    const known = [last, stored.updatedAt].filter(
      (d): d is Date => d !== undefined && d !== null,
    );
    // From the last scheduled run or the last change of the settings,
    // whichever is later; a process that never ran one starts from now.
    const from =
      known.length > 0
        ? known.reduce((a, b) => (a.getTime() >= b.getTime() ? a : b))
        : this.startedAt;
    const cron = cronOf(settings.frequency, settings.time);
    const now = this.clock.now().getTime();
    let at = nextRun(cron, settings.timeZone, from);
    if (!at || at.getTime() > now) return undefined;
    // Only the newest time past is run: a stopped process catches up once.
    for (let i = 0; i < 10_000; i++) {
      const next = nextRun(cron, settings.timeZone, at);
      if (!next || next.getTime() > now) break;
      at = next;
    }
    return at;
  }

  private async scheduled(): Promise<boolean> {
    if ((await this.due()) === undefined) return false;
    const ran = await this.lock.tryWith(async () => {
      const at = await this.due();
      if (!at) return false;
      await this.runBackup.handle({
        trigger: 'schedule',
        scheduledFor: at,
        requestId: null,
      });
      return true;
    });
    return ran === true;
  }

  /** Admins hear once when the last good backup is older than the limit. */
  private async checkOverdue(): Promise<void> {
    const stored = await this.store.settings();
    const settings = effectiveSettings(stored, this.env.overrides);
    if (!settings.enabled) return;
    const good: BackupRun | undefined = await this.store.latestGoodRun();
    const since = good?.startedAt ?? stored.updatedAt ?? this.startedAt;
    const limit = this.env.warnAfterHours * 3_600_000;
    if (this.clock.now().getTime() - since.getTime() <= limit) return;
    const emitted = await this.incidents.emit({
      topic: 'backup.overdue',
      key: `overdue:${good?.id ?? 'none'}`,
      payload: {
        lastGoodRunId: good?.id ?? null,
        lastGoodAt: good?.startedAt.toISOString() ?? null,
        warnAfterHours: this.env.warnAfterHours,
      },
    });
    if (emitted) {
      this.log.warn(
        `No good backup for more than ${this.env.warnAfterHours} hours: admins are notified.`,
      );
    }
  }
}
