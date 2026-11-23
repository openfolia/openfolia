import type { PageRequest, Paginated } from '../../src/base/core/paging.js';
import { paginate } from '../../src/base/core/paging.js';
import type { Transaction } from '../../src/base/core/unit-of-work.js';
import {
  type BackupIncident,
  BackupIncidents,
  type BackupKey,
  BackupLock,
  BackupStore,
  type FinishedBackupRun,
  type NewBackupRun,
} from '../../src/backups/core/backup-ports.js';
import type {
  BackupRequest,
  BackupRequestKind,
  BackupRun,
  BackupServiceState,
} from '../../src/backups/core/backup-run.js';
import {
  DEFAULT_SETTINGS,
  type StoredBackupSettings,
} from '../../src/backups/core/backup-settings.js';
import { BackupClock } from '../../src/backups/core/backup-clock.js';
import { fakeOf } from './fake-unit-of-work.js';

/** A clock tests move by hand. */
export class FakeBackupClock extends BackupClock {
  constructor(public at: Date = new Date('2026-11-20T10:00:00Z')) {
    super();
  }
  now(): Date {
    return new Date(this.at);
  }
  advance(ms: number): void {
    this.at = new Date(this.at.getTime() + ms);
  }
}

/** `BackupStore` in memory; writes inside a transaction apply when it commits. */
export class FakeBackupStore extends BackupStore {
  stored: StoredBackupSettings | undefined;
  readonly keyRows: BackupKey[] = [];
  readonly runRows: (BackupRun & { requestId: string | null })[] = [];
  readonly requests: BackupRequest[] = [];
  state: BackupServiceState | undefined;

  async settings(): Promise<StoredBackupSettings> {
    return this.stored ?? DEFAULT_SETTINGS;
  }
  async lockSettings(): Promise<StoredBackupSettings> {
    return this.settings();
  }
  async saveSettings(
    tx: Transaction,
    settings: StoredBackupSettings,
  ): Promise<void> {
    fakeOf(tx).onCommit(() => {
      this.stored = settings;
    });
  }

  async currentKey(): Promise<BackupKey | undefined> {
    return this.keyRows.find((k) => k.retiredAt === null);
  }
  async keys(page: PageRequest): Promise<Paginated<BackupKey>> {
    return paginate([...this.keyRows].reverse(), page);
  }
  async addKey(tx: Transaction, key: BackupKey): Promise<void> {
    fakeOf(tx).onCommit(() => {
      for (const [i, k] of this.keyRows.entries()) {
        if (k.retiredAt === null) {
          this.keyRows[i] = {
            ...k,
            retiredAt: key.createdAt,
            identitySealed: null,
          };
        }
      }
      this.keyRows.push(key);
    });
  }
  async dropIdentity(tx: Transaction, id: string): Promise<void> {
    fakeOf(tx).onCommit(() => {
      const i = this.keyRows.findIndex((k) => k.id === id);
      if (i >= 0)
        this.keyRows[i] = { ...this.keyRows[i]!, identitySealed: null };
    });
  }

  private newestFirst(): BackupRun[] {
    return [...this.runRows].sort(
      (a, b) => b.startedAt.getTime() - a.startedAt.getTime(),
    );
  }
  async runs(page: PageRequest): Promise<Paginated<BackupRun>> {
    return paginate(this.newestFirst(), page);
  }
  async run(id: string): Promise<BackupRun | undefined> {
    return this.runRows.find((r) => r.id === id);
  }
  async latestRun(): Promise<BackupRun | undefined> {
    return this.newestFirst()[0];
  }
  async latestGoodRun(): Promise<BackupRun | undefined> {
    return this.newestFirst().find(
      (r) => r.status === 'succeeded' && r.verified !== false,
    );
  }
  async lastScheduledFor(): Promise<Date | undefined> {
    return this.runRows
      .map((r) => r.scheduledFor)
      .filter((d): d is Date => d !== null)
      .sort((a, b) => b.getTime() - a.getTime())[0];
  }
  async startRun(run: NewBackupRun): Promise<void> {
    this.runRows.push({
      id: run.id,
      trigger: run.trigger,
      status: 'running',
      scheduledFor: run.scheduledFor,
      startedAt: run.startedAt,
      finishedAt: null,
      sizeBytes: null,
      sha256: null,
      location: null,
      name: null,
      keyFingerprint: null,
      verified: null,
      verifyMode: null,
      error: null,
      errorDetail: null,
      requestId: run.requestId,
    });
  }
  async finishRun(id: string, finished: FinishedBackupRun): Promise<void> {
    const i = this.runRows.findIndex((r) => r.id === id);
    const run = this.runRows[i]!;
    this.runRows[i] =
      finished.status === 'succeeded'
        ? { ...run, ...finished }
        : {
            ...run,
            status: 'failed',
            finishedAt: finished.finishedAt,
            error: finished.error,
            errorDetail: finished.errorDetail,
            location: finished.location,
            keyFingerprint: finished.keyFingerprint,
            verified: finished.verified,
            verifyMode: finished.verifyMode,
          };
  }
  async interruptRuns(at: Date): Promise<number> {
    let n = 0;
    for (const [i, r] of this.runRows.entries()) {
      if (r.status !== 'running') continue;
      this.runRows[i] = {
        ...r,
        status: 'failed',
        finishedAt: at,
        error: 'interrupted',
        errorDetail: 'stopped',
      };
      n++;
    }
    return n;
  }

  async addRequest(
    tx: Transaction,
    request: {
      id: string;
      kind: BackupRequestKind;
      requestedBy: BackupRequest['requestedBy'];
      createdAt: Date;
    },
  ): Promise<void> {
    fakeOf(tx).onCommit(() => {
      this.requests.push({
        ...request,
        status: 'pending',
        finishedAt: null,
        runId: null,
        error: null,
        errorDetail: null,
      });
    });
  }
  async request(id: string): Promise<BackupRequest | undefined> {
    return this.requests.find((r) => r.id === id);
  }
  async pendingRequest(
    _tx: Transaction,
    kind: BackupRequestKind,
  ): Promise<BackupRequest | undefined> {
    return this.requests.find(
      (r) =>
        r.kind === kind && (r.status === 'pending' || r.status === 'running'),
    );
  }
  async claimRequest(): Promise<BackupRequest | undefined> {
    const i = this.requests.findIndex((r) => r.status === 'pending');
    if (i < 0) return undefined;
    this.requests[i] = { ...this.requests[i]!, status: 'running' };
    return this.requests[i];
  }
  async finishRequest(
    id: string,
    result: Parameters<BackupStore['finishRequest']>[1],
  ): Promise<void> {
    const i = this.requests.findIndex((r) => r.id === id);
    this.requests[i] = {
      ...this.requests[i]!,
      status: result.status,
      finishedAt: result.finishedAt,
      runId: result.runId ?? null,
      error: result.error ?? null,
      errorDetail: result.errorDetail ?? null,
    };
  }
  async interruptRequests(): Promise<number> {
    return 0;
  }

  async service(): Promise<BackupServiceState | undefined> {
    return this.state;
  }
  async heartbeat(state: BackupServiceState): Promise<void> {
    this.state = state;
  }
}

/** `BackupLock` in memory: one holder at a time. */
export class FakeBackupLock extends BackupLock {
  held = false;
  /** Set: taking the lock fails with it (a lost database connection). */
  broken: Error | undefined;
  async tryWith<T>(work: () => Promise<T>): Promise<T | undefined> {
    if (this.broken) throw this.broken;
    if (this.held) return undefined;
    this.held = true;
    try {
      return await work();
    } finally {
      this.held = false;
    }
  }
}

/** `BackupIncidents` in memory: once per topic and key. */
export class FakeBackupIncidents extends BackupIncidents {
  readonly emitted: BackupIncident[] = [];
  async emit(incident: BackupIncident): Promise<boolean> {
    if (
      this.emitted.some(
        (e) => e.topic === incident.topic && e.key === incident.key,
      )
    )
      return false;
    this.emitted.push(incident);
    return true;
  }
}
