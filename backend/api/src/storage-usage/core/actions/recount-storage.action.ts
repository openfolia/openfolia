import { Injectable, Logger } from '@nestjs/common';
import type { UnguardedAction } from '../../../access/core/policy.js';
import { BOUNDED, UnitOfWork } from '../../../base/core/unit-of-work.js';
import { StorageSettings } from '../storage-quota.js';
import {
  InstanceSizes,
  MediaMeter,
  PdfArchiveMeter,
  StorageUsage,
} from '../storage-usage.js';

/** A recount claimed this long ago and not finished is taken over (its server stopped). */
export const RECOUNT_CLAIM_MS = 60 * 60_000;
/** A recount still counting after this long stops (well before its claim lapses). */
export const RECOUNT_DEADLINE_MS = 30 * 60_000;

/**
 * Counts the storage afresh (#404) and replaces the kept totals, which
 * corrects any drift of the changes counted on upload and delete: the
 * media in the blob store and the archived PDFs, each by its own meter,
 * and the Git content and database sizes for information. Only when the
 * last recount is `recountEveryMs` old, and once for servers side by
 * side (`claimRecount`). What is added while it counts is added to what
 * it finds (`recounted`): counted at worst twice, never lost; the next
 * recount sets it right. It stops at `RECOUNT_DEADLINE_MS` or when
 * `signal` aborts (shutdown), and its claim lapses.
 */
@Injectable()
export class RecountStorageAction implements UnguardedAction {
  readonly policy = 'internal';
  private readonly logger = new Logger(RecountStorageAction.name);

  constructor(
    private readonly usage: StorageUsage,
    private readonly media: MediaMeter,
    private readonly pdfs: PdfArchiveMeter,
    private readonly sizes: InstanceSizes,
    private readonly settings: StorageSettings,
    private readonly unit: UnitOfWork,
  ) {}

  /** Whether it recounted (false: not due, or another server is at it). */
  async handle({
    now = new Date(),
    signal,
  }: { now?: Date; signal?: AbortSignal } = {}): Promise<boolean> {
    const claimed = await this.unit.run(
      (tx) =>
        this.usage.claimRecount(tx, now, {
          everyMs: this.settings.recountEveryMs,
          claimMs: RECOUNT_CLAIM_MS,
        }),
      BOUNDED,
    );
    if (!claimed) return false;
    const deadline = AbortSignal.timeout(RECOUNT_DEADLINE_MS);
    const stop = signal ? AbortSignal.any([signal, deadline]) : deadline;
    const [media, pdfs, gitBytes, databaseBytes] = await Promise.all([
      this.media.measure(stop),
      this.pdfs.measure(stop),
      this.informational(() => this.sizes.gitBytes(stop), 'Git content'),
      this.informational(() => this.sizes.databaseBytes(), 'database'),
    ]);
    stop.throwIfAborted();
    await this.unit.run(
      (tx) =>
        this.usage.recounted(tx, { media, pdfs, gitBytes, databaseBytes }, now),
      BOUNDED,
    );
    return true;
  }

  /** A size for information: null when it cannot be read, never a failed recount. */
  private async informational(
    read: () => Promise<number | null>,
    what: string,
  ): Promise<number | null> {
    try {
      return await read();
    } catch (error) {
      this.logger.warn(`The ${what} size could not be read: ${String(error)}`);
      return null;
    }
  }
}
