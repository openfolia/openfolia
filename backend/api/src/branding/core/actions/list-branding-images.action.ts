import { Injectable } from '@nestjs/common';
import type { Actor } from '../../../access/core/actor.js';
import { ActorAction } from '../../../access/core/policy.js';
import type { PageRequest, Paginated } from '../../../base/core/paging.js';
import {
  type BrandingImage,
  fieldsNaming,
  type ImageSlot,
} from '../branding.js';
import { BrandingStore } from '../branding-store.js';

/** An uploaded image with the fields naming it now. */
export interface ListedBrandingImage {
  readonly image: BrandingImage;
  readonly usedIn: readonly ImageSlot[];
}

/**
 * The images uploaded for the branding (#559), last uploaded first, each
 * with the fields naming it now (none: unused, `DELETE
 * /branding/images/{hash}` removes it, and so does the sweep a day after
 * its upload). Needs `admin.branding`: the images not in use are served to
 * nobody.
 */
@Injectable()
export class ListBrandingImagesAction extends ActorAction<
  { actor: Actor; page: PageRequest },
  Paginated<ListedBrandingImage>
> {
  readonly policy = 'admin.branding';

  constructor(private readonly store: BrandingStore) {
    super();
  }

  protected async run({
    page,
  }: {
    page: PageRequest;
  }): Promise<Paginated<ListedBrandingImage>> {
    const [{ branding }, images] = await Promise.all([
      this.store.read(),
      this.store.listImages(page),
    ]);
    return {
      total: images.total,
      items: images.items.map((image) => ({
        image,
        usedIn: fieldsNaming(branding, image.sha256),
      })),
    };
  }
}
