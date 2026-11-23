import { Injectable } from '@nestjs/common';
import type { UnguardedAction } from '../../../access/core/policy.js';
import { deriveBrand, type DerivedBrand } from '../brand-colours.js';
import type { StoredBranding } from '../branding.js';
import { BrandingStore } from '../branding-store.js';

/** The branding with the tokens its colours give. */
export interface BrandingView extends StoredBranding {
  readonly derived: DerivedBrand;
}

export const viewOf = (stored: StoredBranding): BrandingView => ({
  ...stored,
  derived: deriveBrand(stored.branding.primary, stored.branding.accent),
});

/**
 * The branding (#169), for anyone: the shell reads it before anyone signs
 * in, and it holds nothing sensitive (a name, image hashes, colours).
 */
@Injectable()
export class GetBrandingAction implements UnguardedAction {
  readonly policy = 'public';

  constructor(private readonly store: BrandingStore) {}

  async handle(): Promise<BrandingView> {
    return viewOf(await this.store.read());
  }
}
