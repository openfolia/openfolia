import { Injectable } from '@nestjs/common';
import type { UnguardedAction } from '../../../access/core/policy.js';
import { ImportStore } from '../import-store.js';
import { ImportUploads } from '../import-uploads.js';

/** The most expired imports one sweep removes. */
export const SWEEP_LIMIT = 100;

export interface SweepReport {
  /** The imports removed, with their uploads where nothing else names them. */
  readonly removed: readonly string[];
  /** Those that could not be removed (left for the next sweep), with why. */
  readonly failed: readonly { readonly id: string; readonly error: unknown }[];
}

/**
 * Removes imports past their `expiresAt` that are not being applied, and
 * the uploads only they name (`ImportUploads.release`), at most
 * `SWEEP_LIMIT` per run, oldest first. Each is checked again under its
 * hash's lock, so an import of the same file made meanwhile keeps it.
 */
@Injectable()
export class SweepImportsAction implements UnguardedAction {
  readonly policy = 'internal';

  constructor(
    private readonly store: ImportStore,
    private readonly uploads: ImportUploads,
  ) {}

  async handle({ now }: { readonly now: Date }): Promise<SweepReport> {
    const removed: string[] = [];
    const failed: { id: string; error: unknown }[] = [];
    for (const record of await this.store.expired(now, SWEEP_LIMIT)) {
      try {
        await this.uploads.release(record, { remove: true, before: now });
        removed.push(record.id);
      } catch (error) {
        failed.push({ id: record.id, error });
      }
    }
    return { removed, failed };
  }
}
