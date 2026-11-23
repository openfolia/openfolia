import { Injectable } from '@nestjs/common';
import type { Actor } from '../../../access/core/actor.js';
import { ActorAction } from '../../../access/core/policy.js';
import { AuditLog } from '../../../audit/core/audit-log.js';
import {
  type Problem,
  UnprocessableProblems,
} from '../../../base/core/errors.js';
import {
  BOUNDED,
  runContended,
  UnitOfWork,
} from '../../../base/core/unit-of-work.js';
import { deriveBrand } from '../brand-colours.js';
import {
  type Branding,
  BRANDING_FIELDS,
  BRANDING_SUBJECT,
  IMAGE_SLOTS,
  SQUARE_SLOTS,
} from '../branding.js';
import { BrandingStore } from '../branding-store.js';
import { type BrandingView, viewOf } from './get-branding.action.js';

export interface UpdateBrandingInput {
  readonly actor: Actor;
  /** The fields to change; left out stays, null is the default again. */
  readonly changes: Partial<Branding>;
}

const pointer = (field: keyof Branding) => `/data/attributes/${field}`;

/**
 * Changes the branding (#169): the fields given, each null for its default
 * again (all of them null: "reset to default"). An image field names an
 * image uploaded for the branding (`POST /branding/images`; another hash is
 * 422 `unknown-image`); the favicon and the app icon must be square (422
 * `image-not-square`). The colours are refused when a pair they make falls
 * below its contrast (422 `insufficient-contrast`, a problem per pair with
 * `meta.theme`, `meta.pair`, `meta.ratio` and `meta.required`): text 4.5:1,
 * shapes 3:1, in light and dark (`deriveBrand`). One change at a time (the
 * row is locked), audited as `branding.update` with each field changed,
 * from and to (a name, hashes, colours: nothing personal). A change that
 * changes nothing is answered as it is, with no event. Needs
 * `admin.branding`.
 */
@Injectable()
export class UpdateBrandingAction extends ActorAction<
  UpdateBrandingInput,
  BrandingView
> {
  readonly policy = 'admin.branding';

  constructor(
    private readonly store: BrandingStore,
    private readonly auditLog: AuditLog,
    private readonly unit: UnitOfWork,
  ) {
    super();
  }

  protected async run({
    actor,
    changes,
  }: UpdateBrandingInput): Promise<BrandingView> {
    return runContended(
      this.unit,
      async (tx) => {
        const current = await this.store.lock(tx);
        const next: Branding = { ...current.branding, ...changes };
        const problems: Problem[] = [];
        for (const slot of IMAGE_SLOTS) {
          const hash = changes[slot];
          if (hash === undefined || hash === null) continue;
          const image = await this.store.findImage(hash, tx);
          if (!image) {
            problems.push({
              code: 'unknown-image',
              detail: `No image with this hash was uploaded for the branding (POST /branding/images).`,
              pointer: pointer(slot),
            });
          } else if (SQUARE_SLOTS.has(slot) && image.width !== image.height) {
            problems.push({
              code: 'image-not-square',
              detail: `The ${slot === 'favicon' ? 'favicon' : 'app icon'} must be square; this image is ${image.width} × ${image.height} pixels.`,
              pointer: pointer(slot),
              meta: { width: image.width, height: image.height },
            });
          }
        }
        const derived = deriveBrand(next.primary, next.accent);
        for (const failing of derived.failing) {
          problems.push({
            code: 'insufficient-contrast',
            detail: `In ${failing.theme} mode, ${failing.pair} has a contrast of ${failing.ratio}:1, below the ${failing.required}:1 it needs.`,
            pointer: pointer(failing.colour),
            meta: {
              theme: failing.theme,
              pair: failing.pair,
              ratio: failing.ratio,
              required: failing.required,
            },
          });
        }
        if (problems.length > 0) {
          // Each problem answers as an error object with its own code.
          throw new UnprocessableProblems(
            'invalid-branding',
            'The branding was not changed.',
            problems,
          );
        }
        const changed = BRANDING_FIELDS.filter(
          (field) => next[field] !== current.branding[field],
        );
        if (changed.length === 0) return viewOf(current);
        const written = await this.store.write(tx, next);
        await this.auditLog.record(tx, actor, {
          action: 'branding.update',
          subject: BRANDING_SUBJECT,
          data: {
            changed: Object.fromEntries(
              changed.map((field) => [
                field,
                { from: current.branding[field], to: next[field] },
              ]),
            ),
          },
        });
        return viewOf(written);
      },
      BOUNDED,
    );
  }
}
