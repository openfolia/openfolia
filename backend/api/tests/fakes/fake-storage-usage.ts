import { paginate, type PageRequest } from '../../src/base/core/paging.js';
import type { Transaction } from '../../src/base/core/unit-of-work.js';
import {
  StorageQuota,
  type StorageSettings,
} from '../../src/storage-usage/core/storage-quota.js';
import {
  type CategoryUsage,
  type MediaExclusion,
  type StorageCategory,
  type StorageCount,
  type StorageTotals,
  type StoredFile,
  StorageUsage,
  MediaMeter,
  PdfArchiveMeter,
  InstanceSizes,
  NO_USAGE,
} from '../../src/storage-usage/core/storage-usage.js';
import { FakeAuditLog } from './fake-audit-log.js';
import {
  type FakeTransaction,
  fakeOf,
  FakeUnitOfWork,
} from './fake-unit-of-work.js';

const add = (a: CategoryUsage, b: CategoryUsage): CategoryUsage => ({
  bytes: Math.max(0, a.bytes + b.bytes),
  files: Math.max(0, a.files + b.files),
});

/**
 * The kept totals in memory, with `FakeUnitOfWork`: a change is applied
 * only when its transaction commits, and seen inside it before.
 */
export class FakeStorageUsage extends StorageUsage {
  totals: StorageTotals = {
    media: NO_USAGE,
    pdfs: NO_USAGE,
    gitBytes: null,
    databaseBytes: null,
    recountedAt: null,
  };
  claimedAt: Date | null = null;
  /** What was added since the recount was claimed (the `*_added_*` columns). */
  added = { media: NO_USAGE, pdfs: NO_USAGE };
  limit: number | null = null;
  files: StoredFile[] = [];
  /** Hashes not counted as media, and why (the meter's exclusions). */
  apart = new Map<string, MediaExclusion>();
  private readonly pending = new WeakMap<FakeTransaction, StorageTotals>();

  async read(tx: Transaction): Promise<StorageTotals> {
    return this.pending.get(fakeOf(tx)) ?? this.totals;
  }

  async adjust(
    tx: Transaction,
    category: StorageCategory,
    change: CategoryUsage,
  ): Promise<StorageTotals> {
    const transaction = fakeOf(tx);
    const before = await this.read(tx);
    const after = { ...before, [category]: add(before[category], change) };
    if (!this.pending.has(transaction)) {
      transaction.onCommit(() => {
        const staged = this.pending.get(transaction);
        if (!staged) return;
        // Applied as a delta, as the database's update is.
        const delta = (c: StorageCategory): CategoryUsage => ({
          bytes: staged[c].bytes - before[c].bytes,
          files: staged[c].files - before[c].files,
        });
        const gained = (c: StorageCategory): CategoryUsage => ({
          bytes: Math.max(0, delta(c).bytes),
          files: Math.max(0, delta(c).files),
        });
        this.totals = {
          ...this.totals,
          media: add(this.totals.media, delta('media')),
          pdfs: add(this.totals.pdfs, delta('pdfs')),
        };
        if (this.claimedAt !== null) {
          this.added = {
            media: add(this.added.media, gained('media')),
            pdfs: add(this.added.pdfs, gained('pdfs')),
          };
        }
      });
    }
    this.pending.set(transaction, after);
    return after;
  }

  async claimRecount(
    tx: Transaction,
    now: Date,
    { everyMs, claimMs }: { everyMs: number; claimMs: number },
  ): Promise<boolean> {
    const due =
      this.totals.recountedAt === null ||
      this.totals.recountedAt.getTime() <= now.getTime() - everyMs;
    const free =
      this.claimedAt === null ||
      this.claimedAt.getTime() <= now.getTime() - claimMs;
    if (!due || !free) return false;
    fakeOf(tx).onCommit(() => {
      this.claimedAt = now;
      this.added = { media: NO_USAGE, pdfs: NO_USAGE };
    });
    return true;
  }

  async recounted(
    tx: Transaction,
    count: StorageCount,
    now: Date,
  ): Promise<void> {
    fakeOf(tx).onCommit(() => {
      if (this.claimedAt?.getTime() !== now.getTime()) return;
      this.totals = {
        ...count,
        media: add(count.media, this.added.media),
        pdfs: add(count.pdfs, this.added.pdfs),
        recountedAt: now,
      };
      this.claimedAt = null;
      this.added = { media: NO_USAGE, pdfs: NO_USAGE };
    });
  }

  async lockLimit(): Promise<number | null> {
    return this.limit;
  }

  async recordLimit(tx: Transaction, limit: number | null): Promise<void> {
    fakeOf(tx).onCommit(() => (this.limit = limit));
  }

  async apartFromMedia(
    _tx: Transaction,
    sha256: string,
  ): Promise<MediaExclusion | undefined> {
    return this.apart.get(sha256);
  }

  async largestFiles(page: PageRequest) {
    const sorted = [...this.files].sort(
      (a, b) => b.size - a.size || a.sha256.localeCompare(b.sha256),
    );
    return paginate(sorted, page);
  }
}

/** A meter that answers what it is set to. */
export class FakeMeter extends MediaMeter implements PdfArchiveMeter {
  constructor(public usage: CategoryUsage = NO_USAGE) {
    super();
  }

  async measure(_signal?: AbortSignal): Promise<CategoryUsage> {
    return this.usage;
  }
}

export class FakeInstanceSizes extends InstanceSizes {
  constructor(
    public git: number | null = null,
    public database: number | null = null,
  ) {
    super();
  }

  async gitBytes(_signal?: AbortSignal) {
    return this.git;
  }

  async databaseBytes() {
    return this.database;
  }
}

/** A `StorageQuota` over a `FakeStorageUsage`, with the given limit (none by default). */
export function fakeQuota(
  options: {
    readonly limitBytes?: number | null;
    readonly usage?: FakeStorageUsage;
    readonly auditLog?: FakeAuditLog;
    readonly unit?: FakeUnitOfWork;
  } = {},
) {
  const usage = options.usage ?? new FakeStorageUsage();
  const auditLog = options.auditLog ?? new FakeAuditLog();
  const unit = options.unit ?? new FakeUnitOfWork();
  const settings: StorageSettings = {
    limitBytes: options.limitBytes ?? null,
    recountEveryMs: 24 * 3_600_000,
  };
  return {
    usage,
    auditLog,
    settings,
    quota: new StorageQuota(usage, settings, unit, auditLog),
  };
}
