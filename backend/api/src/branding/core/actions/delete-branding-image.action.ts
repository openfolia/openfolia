import { Injectable } from '@nestjs/common';
import type { Actor } from '../../../access/core/actor.js';
import { ActorAction } from '../../../access/core/policy.js';
import {
  ConflictError,
  NotFoundError,
  UnavailableError,
} from '../../../base/core/errors.js';
import { isSha256 } from '../../../blobs/core/blob-store.js';
import { BrandingImageRemoval } from '../branding-image-removal.js';

/**
 * Deletes an image uploaded for the branding that no field names (#559):
 * its record and, unless something else keeps them, its bytes
 * (`BrandingImageRemoval`), audited as `branding.image-delete`. One a
 * field names is 409 `branding-image-in-use` (`meta.usedIn`, the fields);
 * one never uploaded (or a malformed hash) 404; 503 `branding-image-busy`
 * while another deletion of the same bytes is under way. Takes effect at once,
 * however recent the upload. Needs `admin.branding`.
 */
@Injectable()
export class DeleteBrandingImageAction extends ActorAction<
  { actor: Actor; sha256: string },
  void
> {
  readonly policy = 'admin.branding';

  constructor(private readonly removal: BrandingImageRemoval) {
    super();
  }

  protected async run({
    actor,
    sha256,
  }: {
    actor: Actor;
    sha256: string;
  }): Promise<void> {
    const notFound = () =>
      new NotFoundError(
        'No image with this hash was uploaded for the branding.',
      );
    if (!isSha256(sha256)) throw notFound();
    const removal = await this.removal.remove(actor, sha256);
    if (removal.kind === 'gone') throw notFound();
    if (removal.kind === 'busy') {
      throw new UnavailableError(
        'branding-image-busy',
        'The same file is being deleted elsewhere; try again.',
        1,
      );
    }
    if (removal.kind === 'in-use') {
      throw new ConflictError(
        'branding-image-in-use',
        'A field of the branding names this image; set the field to another image or null first.',
        { usedIn: removal.usedIn },
      );
    }
  }
}
