import { Injectable, Logger } from '@nestjs/common';
import type { Actor } from '../../access/core/actor.js';
import { AuditLog } from '../../audit/core/audit-log.js';
import { ConflictError } from '../../base/core/errors.js';
import {
  BOUNDED,
  type Transaction,
  UnitOfWork,
} from '../../base/core/unit-of-work.js';
import {
  type MediaExclusion,
  StorageUsage,
  usedBytes,
} from './storage-usage.js';

/** The storage settings (`CCMS_STORAGE_*`, `.env.example`). */
export abstract class StorageSettings {
  /** The most bytes media and archived PDFs may hold together; null: no limit (the default). */
  abstract readonly limitBytes: number | null;
  /** How often the totals are counted afresh, in milliseconds. */
  abstract readonly recountEveryMs: number;
}

/** From this share of the limit on, the admin view warns. */
export const WARN_AT = 0.8;

/** Who records a change of the limit: the server itself, at start-up. */
export const STORAGE_SERVICE: Actor = Object.freeze({
  kind: 'service',
  // Outside the `UserId` format (":"), so no user can have this ID.
  id: 'service:storage',
  roles: Object.freeze([]),
}) as Actor;

/**
 * A refused upload is audited at most once per actor in this long, on this
 * server: the next event says how many were refused meanwhile
 * (`refusedMeanwhile`), so a loop of refused requests cannot flood the
 * append-only log.
 */
export const REFUSAL_AUDIT_EVERY_MS = 10 * 60_000;
/** How many actors the refusals are remembered for at most; past that, the oldest is forgotten. */
export const REFUSAL_ACTORS_KEPT = 10_000;

/** The audit subject of the limit and of refused uploads. */
export const STORAGE_SUBJECT = { type: 'storage', id: 'instance' } as const;

/**
 * An upload would take the instance past its storage limit: 409
 * `storage-limit-reached`, with `meta.limit` in bytes (what is used is the
 * administrators', `GET /storage-usage`, and the audit event's). Nothing of
 * the upload is stored.
 */
export class StorageLimitReachedError extends ConflictError {
  constructor(
    readonly limit: number,
    readonly used: number,
  ) {
    super(
      'storage-limit-reached',
      'The storage limit of this installation is reached; the file is not stored. Delete unused files or ask an administrator for more storage.',
      { limit },
    );
  }
}

/**
 * The storage limit on the upload path (#404): the room left before a byte
 * is read, and the new bytes counted (and, past the limit, refused) in the
 * transaction recording the upload, so uploads at the same time never
 * both slip past it. Without a limit nothing is refused; the totals are
 * kept all the same.
 */
@Injectable()
export class StorageQuota {
  private readonly logger = new Logger(StorageQuota.name);
  /** Per actor: when a refusal was last audited, and how many were not since. */
  private readonly refusals = new Map<
    string,
    { at: number; meanwhile: number }
  >();
  /** The clock for the refusals' audit; tests set their own. */
  now: () => number = Date.now;

  constructor(
    private readonly usage: StorageUsage,
    private readonly settings: StorageSettings,
    private readonly unit: UnitOfWork,
    private readonly auditLog: AuditLog,
  ) {}

  get limit(): number | null {
    return this.settings.limitBytes;
  }

  /**
   * The bytes an upload may still add (undefined: no limit), read before
   * the upload is; throws `StorageLimitReachedError` when there is no room.
   */
  async room(): Promise<number | undefined> {
    const limit = this.limit;
    if (limit === null) return undefined;
    const used = usedBytes(
      await this.unit.run((tx) => this.usage.read(tx), BOUNDED),
    );
    if (used >= limit) throw new StorageLimitReachedError(limit, used);
    return limit - used;
  }

  /**
   * Counts a media file inside `tx`, called by the first upload record of
   * its hash (under the hash's lock), so exactly one recording transaction
   * counts it whatever the blob store's put said; a hash counted apart (an
   * archived PDF) or not at all (a rendition, an import's bundle) is not
   * counted again. Past the limit it throws `StorageLimitReachedError`,
   * which rolls `tx` back.
   */
  async addMedia(
    tx: Transaction,
    sha256: string,
    bytes: number,
  ): Promise<void> {
    if ((await this.usage.apartFromMedia(tx, sha256)) !== undefined) return;
    const totals = await this.usage.adjust(tx, 'media', { bytes, files: 1 });
    const limit = this.limit;
    if (limit !== null && usedBytes(totals) > limit) {
      throw new StorageLimitReachedError(limit, usedBytes(totals) - bytes);
    }
  }

  /**
   * Takes a deleted media file off the totals inside `tx`, unless its hash
   * is not counted as media (`apartFromMedia`, given when known).
   */
  async removeMedia(
    tx: Transaction,
    sha256: string,
    bytes: number,
    apart?: MediaExclusion,
  ): Promise<void> {
    if ((apart ?? (await this.usage.apartFromMedia(tx, sha256))) !== undefined)
      return;
    await this.usage.adjust(tx, 'media', { bytes: -bytes, files: -1 });
  }

  /** Why the blob is not counted as media, if it is not (`StorageUsage.apartFromMedia`). */
  apartFromMedia(
    tx: Transaction,
    sha256: string,
  ): Promise<MediaExclusion | undefined> {
    return this.usage.apartFromMedia(tx, sha256);
  }

  /** Counts a newly archived PDF inside `tx`; a release's files are never refused. */
  async addPdf(tx: Transaction, bytes: number): Promise<void> {
    await this.usage.adjust(tx, 'pdfs', { bytes, files: 1 });
  }

  /**
   * Records an upload refused for the limit (`storage.upload-refused`,
   * with the change set it was for, or `target: "branding"`), in
   * a transaction of its own (the upload's rolled back), at most once per
   * actor every `REFUSAL_AUDIT_EVERY_MS` (the others are counted into the
   * next event). Best effort: a failure is logged, and the refusal stands.
   */
  async refused(
    actor: Actor,
    error: StorageLimitReachedError,
    data: { readonly changeSetId: string } | { readonly target: 'branding' },
  ): Promise<void> {
    const key = `${actor.kind}:${actor.id}`;
    const now = this.now();
    const last = this.refusals.get(key);
    if (last && now - last.at < REFUSAL_AUDIT_EVERY_MS) {
      last.meanwhile++;
      return;
    }
    // Re-inserted, so the map's order is by last event: the first is the oldest.
    this.refusals.delete(key);
    this.refusals.set(key, { at: now, meanwhile: 0 });
    if (this.refusals.size > REFUSAL_ACTORS_KEPT) {
      const first = this.refusals.keys().next();
      if (!first.done) this.refusals.delete(first.value);
    }
    try {
      await this.unit.run(
        (tx) =>
          this.auditLog.record(tx, actor, {
            action: 'storage.upload-refused',
            subject: STORAGE_SUBJECT,
            data: {
              ...data,
              limit: error.limit,
              used: error.used,
              ...(last?.meanwhile ? { refusedMeanwhile: last.meanwhile } : {}),
            },
          }),
        BOUNDED,
      );
    } catch (failure) {
      // Not recorded: the next refusal tries again, counting this one.
      this.refusals.set(key, {
        at: last?.at ?? Number.NEGATIVE_INFINITY,
        meanwhile: (last?.meanwhile ?? 0) + 1,
      });
      this.logger.warn(
        `A refused upload could not be audited: ${String(failure)}`,
      );
    }
  }
}
