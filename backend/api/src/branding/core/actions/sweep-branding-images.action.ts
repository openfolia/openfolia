import { Injectable } from '@nestjs/common';
import type { UnguardedAction } from '../../../access/core/policy.js';
import {
  BRANDING_SERVICE,
  referencedImages,
  UNUSED_BRANDING_IMAGE_MS,
} from '../branding.js';
import { BrandingImageRemoval } from '../branding-image-removal.js';
import { BrandingStore } from '../branding-store.js';

/** The most images one sweep removes. */
export const SWEEP_LIMIT = 100;
/** A sweep stops taking the next image after this long (the rest waits for the next one). */
export const SWEEP_DEADLINE_MS = 5 * 60_000;

export interface BrandingSweepReport {
  /** The hashes of the images removed. */
  readonly removed: readonly string[];
  /** Those that could not be removed (left for the next sweep), with why. */
  readonly failed: readonly {
    readonly sha256: string;
    readonly error: unknown;
  }[];
}

/**
 * Removes the images uploaded for the branding that no field names and
 * that were uploaded more than `UNUSED_BRANDING_IMAGE_MS` before `now`
 * (#559), at most `SWEEP_LIMIT` per run, oldest first, as
 * `service:branding` (`BrandingImageRemoval`: each decided again under
 * the branding's row lock and the hash's lock, so one a change named
 * meanwhile stays). Stops between images once `signal` aborts (shutdown)
 * or after `SWEEP_DEADLINE_MS`; one that fails is reported and left.
 */
@Injectable()
export class SweepBrandingImagesAction implements UnguardedAction {
  readonly policy = 'internal';

  constructor(
    private readonly store: BrandingStore,
    private readonly removal: BrandingImageRemoval,
  ) {}

  /** The clock for the deadline; tests set their own. */
  clock: () => number = Date.now;

  async handle({
    now,
    signal,
  }: {
    readonly now: Date;
    readonly signal?: AbortSignal;
  }): Promise<BrandingSweepReport> {
    const deadline = this.clock() + SWEEP_DEADLINE_MS;
    const before = new Date(now.getTime() - UNUSED_BRANDING_IMAGE_MS);
    const { branding } = await this.store.read();
    const removed: string[] = [];
    const failed: { sha256: string; error: unknown }[] = [];
    for (const image of await this.store.unusedImages(
      referencedImages(branding),
      before,
      SWEEP_LIMIT,
    )) {
      if (signal?.aborted || this.clock() > deadline) break;
      try {
        const removal = await this.removal.remove(
          BRANDING_SERVICE,
          image.sha256,
          { before },
        );
        if (removal.kind === 'removed') removed.push(image.sha256);
      } catch (error) {
        failed.push({ sha256: image.sha256, error });
      }
    }
    return { removed, failed };
  }
}
