import { Injectable } from '@nestjs/common';
import {
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  ne,
  or,
  sql,
} from 'drizzle-orm';
import type { PageRequest, Paginated } from '../../base/core/paging.js';
import type { Transaction } from '../../base/core/unit-of-work.js';
import { Database } from '../../database/database.js';
import { drizzleOf } from '../../database/drizzle-unit-of-work.js';
import {
  type BackupKey,
  BackupStore,
  type FinishedBackupRun,
  type NewBackupRun,
} from '../core/backup-ports.js';
import type {
  BackupError,
  BackupRequest,
  BackupRequestKind,
  BackupRequestStatus,
  BackupRun,
  BackupRunStatus,
  BackupServiceState,
  BackupTrigger,
  VerifyMode,
} from '../core/backup-run.js';
import {
  type BackupLocation,
  DEFAULT_SETTINGS,
  Frequency,
  Retention,
  type StoredBackupSettings,
} from '../core/backup-settings.js';
import {
  backupKeys,
  backupRequests,
  backupRuns,
  backupService,
  backupSettings,
} from './backups.tables.js';

const ROW = 1;

type SettingsRow = typeof backupSettings.$inferSelect;
type KeyRow = typeof backupKeys.$inferSelect;
type RunRow = typeof backupRuns.$inferSelect;
type RequestRow = typeof backupRequests.$inferSelect;

function toSettings(row: SettingsRow | undefined): StoredBackupSettings {
  if (!row) return DEFAULT_SETTINGS;
  const location = row.location as BackupLocation;
  return {
    enabled: row.enabled,
    frequency: Frequency.parse(row.frequency),
    time: row.time,
    timeZone: row.timeZone,
    retention: Retention.parse(row.retention),
    location:
      location.kind === 's3'
        ? {
            kind: 's3',
            endpoint: location.endpoint ?? null,
            region: location.region,
            bucket: location.bucket,
            prefix: location.prefix,
            accessKeyId: location.accessKeyId,
          }
        : { kind: 'local', subfolder: location.subfolder ?? '' },
    verify: row.verify,
    verifyByDecrypting: row.verifyByDecrypting,
    s3SecretSealed: row.s3SecretSealed,
    updatedAt: row.updatedAt,
  };
}

function toRow(
  settings: StoredBackupSettings,
): typeof backupSettings.$inferInsert {
  return {
    id: ROW,
    enabled: settings.enabled,
    frequency: settings.frequency,
    time: settings.time,
    timeZone: settings.timeZone,
    retention: settings.retention,
    location: settings.location,
    s3SecretSealed: settings.s3SecretSealed,
    verify: settings.verify,
    verifyByDecrypting: settings.verifyByDecrypting,
    updatedAt: settings.updatedAt,
  };
}

const toKey = (row: KeyRow): BackupKey => ({
  id: row.id,
  recipient: row.recipient,
  fingerprint: row.fingerprint,
  identitySealed: row.identitySealed,
  createdAt: row.createdAt,
  retiredAt: row.retiredAt,
});

const toRun = (row: RunRow): BackupRun => ({
  id: row.id,
  trigger: row.trigger as BackupTrigger,
  status: row.status as BackupRunStatus,
  scheduledFor: row.scheduledFor,
  startedAt: row.startedAt,
  finishedAt: row.finishedAt,
  sizeBytes: row.sizeBytes,
  sha256: row.sha256,
  location: row.location,
  name: row.name,
  keyFingerprint: row.keyFingerprint,
  verified: row.verified,
  verifyMode: row.verifyMode as VerifyMode | null,
  error: row.error as BackupError | null,
  errorDetail: row.errorDetail,
});

const toRequest = (row: RequestRow): BackupRequest => ({
  id: row.id,
  kind: row.kind as BackupRequestKind,
  status: row.status as BackupRequestStatus,
  requestedBy: {
    kind: row.requestedByKind as 'user' | 'service',
    id: row.requestedById,
  },
  createdAt: row.createdAt,
  finishedAt: row.finishedAt,
  runId: row.runId,
  error: row.error,
  errorDetail: row.errorDetail,
});

/** `BackupStore` over the `backup_*` tables. */
@Injectable()
export class DrizzleBackupStore extends BackupStore {
  constructor(private readonly database: Database) {
    super();
  }

  private db(tx?: Transaction) {
    return tx ? drizzleOf(tx) : this.database.db;
  }

  async settings(tx?: Transaction): Promise<StoredBackupSettings> {
    const [row] = await this.db(tx)
      .select()
      .from(backupSettings)
      .where(eq(backupSettings.id, ROW));
    return toSettings(row);
  }

  async lockSettings(tx: Transaction): Promise<StoredBackupSettings> {
    const db = drizzleOf(tx);
    await db
      .insert(backupSettings)
      .values(toRow(DEFAULT_SETTINGS))
      .onConflictDoNothing({ target: backupSettings.id });
    const [row] = await db
      .select()
      .from(backupSettings)
      .where(eq(backupSettings.id, ROW))
      .for('update');
    return toSettings(row);
  }

  async saveSettings(
    tx: Transaction,
    settings: StoredBackupSettings,
  ): Promise<void> {
    const values = toRow(settings);
    await drizzleOf(tx)
      .insert(backupSettings)
      .values(values)
      .onConflictDoUpdate({ target: backupSettings.id, set: values });
  }

  async currentKey(tx?: Transaction): Promise<BackupKey | undefined> {
    const [row] = await this.db(tx)
      .select()
      .from(backupKeys)
      .where(isNull(backupKeys.retiredAt));
    return row ? toKey(row) : undefined;
  }

  async keys(page: PageRequest): Promise<Paginated<BackupKey>> {
    const db = this.database.db;
    const [rows, [total]] = await Promise.all([
      db
        .select()
        .from(backupKeys)
        .orderBy(desc(backupKeys.createdAt), asc(backupKeys.id))
        .limit(page.size)
        .offset((page.number - 1) * page.size),
      db.select({ n: count() }).from(backupKeys),
    ]);
    return { items: rows.map(toKey), total: total?.n ?? 0 };
  }

  async addKey(tx: Transaction, key: BackupKey): Promise<void> {
    const db = drizzleOf(tx);
    await db
      .update(backupKeys)
      .set({ retiredAt: key.createdAt, identitySealed: null })
      .where(isNull(backupKeys.retiredAt));
    await db.insert(backupKeys).values({
      id: key.id,
      recipient: key.recipient,
      fingerprint: key.fingerprint,
      identitySealed: key.identitySealed,
      createdAt: key.createdAt,
      retiredAt: null,
    });
  }

  async dropIdentity(tx: Transaction, id: string): Promise<void> {
    await drizzleOf(tx)
      .update(backupKeys)
      .set({ identitySealed: null })
      .where(eq(backupKeys.id, id));
  }

  async runs(page: PageRequest): Promise<Paginated<BackupRun>> {
    const db = this.database.db;
    const [rows, [total]] = await Promise.all([
      db
        .select()
        .from(backupRuns)
        .orderBy(desc(backupRuns.startedAt), asc(backupRuns.id))
        .limit(page.size)
        .offset((page.number - 1) * page.size),
      db.select({ n: count() }).from(backupRuns),
    ]);
    return { items: rows.map(toRun), total: total?.n ?? 0 };
  }

  async run(id: string): Promise<BackupRun | undefined> {
    const [row] = await this.database.db
      .select()
      .from(backupRuns)
      .where(eq(backupRuns.id, id));
    return row ? toRun(row) : undefined;
  }

  async latestRun(): Promise<BackupRun | undefined> {
    const [row] = await this.database.db
      .select()
      .from(backupRuns)
      .orderBy(desc(backupRuns.startedAt))
      .limit(1);
    return row ? toRun(row) : undefined;
  }

  async latestGoodRun(): Promise<BackupRun | undefined> {
    const [row] = await this.database.db
      .select()
      .from(backupRuns)
      .where(
        and(
          eq(backupRuns.status, 'succeeded'),
          or(isNull(backupRuns.verified), eq(backupRuns.verified, true)),
        ),
      )
      .orderBy(desc(backupRuns.startedAt))
      .limit(1);
    return row ? toRun(row) : undefined;
  }

  async lastScheduledFor(): Promise<Date | undefined> {
    const [row] = await this.database.db
      .select({ at: backupRuns.scheduledFor })
      .from(backupRuns)
      .where(isNotNull(backupRuns.scheduledFor))
      .orderBy(desc(backupRuns.scheduledFor))
      .limit(1);
    return row?.at ?? undefined;
  }

  async startRun(run: NewBackupRun): Promise<void> {
    await this.database.db.insert(backupRuns).values({
      id: run.id,
      trigger: run.trigger,
      status: 'running',
      scheduledFor: run.scheduledFor,
      startedAt: run.startedAt,
      processId: run.processId,
      requestId: run.requestId,
    });
  }

  async finishRun(id: string, finished: FinishedBackupRun): Promise<void> {
    await this.database.db
      .update(backupRuns)
      .set(
        finished.status === 'succeeded'
          ? {
              status: 'succeeded',
              finishedAt: finished.finishedAt,
              sizeBytes: finished.sizeBytes,
              sha256: finished.sha256,
              location: finished.location,
              name: finished.name,
              keyFingerprint: finished.keyFingerprint,
              verified: finished.verified,
              verifyMode: finished.verifyMode,
            }
          : {
              status: 'failed',
              finishedAt: finished.finishedAt,
              error: finished.error,
              errorDetail: finished.errorDetail,
              location: finished.location,
              keyFingerprint: finished.keyFingerprint,
              verified: finished.verified,
              verifyMode: finished.verifyMode,
            },
      )
      .where(eq(backupRuns.id, id));
  }

  async interruptRuns(at: Date): Promise<number> {
    const rows = await this.database.db
      .update(backupRuns)
      .set({
        status: 'failed',
        finishedAt: at,
        error: 'interrupted',
        errorDetail: 'The backup process stopped during this run.',
      })
      .where(eq(backupRuns.status, 'running'))
      .returning({ id: backupRuns.id });
    return rows.length;
  }

  async addRequest(
    tx: Transaction,
    request: Parameters<BackupStore['addRequest']>[1],
  ): Promise<void> {
    await drizzleOf(tx).insert(backupRequests).values({
      id: request.id,
      kind: request.kind,
      status: 'pending',
      requestedByKind: request.requestedBy.kind,
      requestedById: request.requestedBy.id,
      createdAt: request.createdAt,
    });
  }

  async request(id: string): Promise<BackupRequest | undefined> {
    const [row] = await this.database.db
      .select()
      .from(backupRequests)
      .where(eq(backupRequests.id, id));
    return row ? toRequest(row) : undefined;
  }

  async pendingRequest(
    tx: Transaction,
    kind: BackupRequestKind,
  ): Promise<BackupRequest | undefined> {
    const [row] = await drizzleOf(tx)
      .select()
      .from(backupRequests)
      .where(
        and(
          eq(backupRequests.kind, kind),
          inArray(backupRequests.status, ['pending', 'running']),
        ),
      )
      .orderBy(asc(backupRequests.createdAt))
      .limit(1);
    return row ? toRequest(row) : undefined;
  }

  async claimRequest(at: Date): Promise<BackupRequest | undefined> {
    const rows = await this.database.db
      .update(backupRequests)
      .set({ status: 'running', startedAt: at })
      .where(
        eq(
          backupRequests.id,
          sql`(select ${backupRequests.id} from ${backupRequests} where ${backupRequests.status} = 'pending' order by ${backupRequests.createdAt} limit 1 for update skip locked)`,
        ),
      )
      .returning();
    return rows[0] ? toRequest(rows[0]) : undefined;
  }

  async finishRequest(
    id: string,
    result: Parameters<BackupStore['finishRequest']>[1],
  ): Promise<void> {
    await this.database.db
      .update(backupRequests)
      .set({
        status: result.status,
        finishedAt: result.finishedAt,
        runId: result.runId ?? null,
        error: result.error ?? null,
        errorDetail: result.errorDetail ?? null,
      })
      .where(and(eq(backupRequests.id, id), ne(backupRequests.status, 'done')));
  }

  async interruptRequests(at: Date): Promise<number> {
    const rows = await this.database.db
      .update(backupRequests)
      .set({
        status: 'failed',
        finishedAt: at,
        error: 'interrupted',
        errorDetail: 'The backup process stopped while answering this request.',
      })
      .where(eq(backupRequests.status, 'running'))
      .returning({ id: backupRequests.id });
    return rows.length;
  }

  async service(): Promise<BackupServiceState | undefined> {
    const [row] = await this.database.db
      .select()
      .from(backupService)
      .where(eq(backupService.id, ROW));
    if (!row) return undefined;
    return {
      processId: row.processId,
      startedAt: row.startedAt,
      lastSeenAt: row.lastSeenAt,
      overrides: row.overrides as BackupServiceState['overrides'],
      keyFingerprint: row.keyFingerprint,
    };
  }

  async heartbeat(state: BackupServiceState): Promise<void> {
    const values = {
      id: ROW,
      processId: state.processId,
      startedAt: state.startedAt,
      lastSeenAt: state.lastSeenAt,
      overrides: state.overrides,
      keyFingerprint: state.keyFingerprint,
    };
    await this.database.db
      .insert(backupService)
      .values(values)
      .onConflictDoUpdate({ target: backupService.id, set: values });
  }
}
