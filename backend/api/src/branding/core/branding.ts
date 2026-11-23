import type { Actor } from '../../access/core/actor.js';
import type { Hex } from './brand-colours.js';

/**
 * The platform's branding (#169): what an administrator sets in place of the
 * neutral defaults, without a code change or a redeploy. Every field is
 * optional; null means the default (`frontend/editor/src/docs.config.ts` and
 * `frontend/theme`). Operational state, kept in Postgres, never in the
 * content repository. Holds nothing sensitive: anyone may read it.
 */
export interface Branding {
  /** The product's name: document title, the logo's accessible name, the breadcrumb's home. */
  readonly productName: string | null;
  /** The logo with the name, for light pages (the expanded sidebar, the sign-in page). */
  readonly logoLight: string | null;
  /** The same for dark pages; without it, the light one there too. */
  readonly logoDark: string | null;
  /** The compact mark: the collapsed sidebar. */
  readonly mark: string | null;
  /** The browser tab's icon. Square. */
  readonly favicon: string | null;
  /** The icon a phone puts on its home screen. Square. */
  readonly appIcon: string | null;
  /** The primary colour, `#rrggbb`. */
  readonly primary: Hex | null;
  /** The optional accent (the light sidebar's tint), `#rrggbb`. */
  readonly accent: Hex | null;
}

/** The image fields, each a blob's SHA-256 (64 lowercase hex characters) or null. */
export const IMAGE_SLOTS = [
  'logoLight',
  'logoDark',
  'mark',
  'favicon',
  'appIcon',
] as const;
export type ImageSlot = (typeof IMAGE_SLOTS)[number];

/** Image fields that must be square (an icon a browser or phone scales). */
export const SQUARE_SLOTS: ReadonlySet<ImageSlot> = new Set([
  'favicon',
  'appIcon',
]);

export const BRANDING_FIELDS = [
  'productName',
  ...IMAGE_SLOTS,
  'primary',
  'accent',
] as const satisfies readonly (keyof Branding)[];

export const DEFAULT_BRANDING: Branding = {
  productName: null,
  logoLight: null,
  logoDark: null,
  mark: null,
  favicon: null,
  appIcon: null,
  primary: null,
  accent: null,
};

/** The branding as stored, with what tells one version from the next. */
export interface StoredBranding {
  readonly branding: Branding;
  /** Counts the changes: 0 before the first. */
  readonly version: number;
  /** When it last changed; null before the first change. */
  readonly updatedAt: Date | null;
}

/** An image uploaded for the branding, in the blob store under its hash. */
export interface BrandingImage {
  readonly sha256: string;
  /** `image/png` or `image/webp`, from the bytes. */
  readonly contentType: BrandingImageType;
  readonly size: number;
  readonly width: number;
  readonly height: number;
  readonly uploadedBy: Pick<Actor, 'kind' | 'id'>;
  readonly uploadedAt: Date;
}

/** What an image upload takes. SVG is refused, like content images (see `backend/api/README.md`). */
export const BRANDING_IMAGE_TYPES = ['image/png', 'image/webp'] as const;
export type BrandingImageType = (typeof BRANDING_IMAGE_TYPES)[number];

/** The largest image file taken, in bytes (1 MiB): a logo or an icon, never a photo. */
export const MAX_BRANDING_IMAGE_BYTES = 1024 * 1024;

/** The widest and tallest image taken, in pixels. */
export const MAX_BRANDING_IMAGE_SIDE = 4096;

/**
 * How many images the branding keeps at most: those a field names and
 * those uploaded within `UNUSED_BRANDING_IMAGE_MS`. An older one no field
 * names is removed by the sweep (`SweepBrandingImagesAction`) and no
 * longer counts (#559).
 */
export const MAX_BRANDING_IMAGES = 200;

/** How long an upload no field names is kept (a day, as an unused content file). */
export const UNUSED_BRANDING_IMAGE_MS = 24 * 60 * 60 * 1000;

/** Who removes unused branding images on its own: the server (the sweep). */
export const BRANDING_SERVICE: Actor = Object.freeze({
  kind: 'service',
  // Outside the `UserId` format (":"), so no user can have this ID.
  id: 'service:branding',
  roles: Object.freeze([]),
}) as Actor;

/**
 * The product's name while the branding sets none: the editor's default
 * (`frontend/editor/src/docs.config.ts`, `branding.productName`; a test keeps
 * them equal), for what the server writes itself (an email's sender name).
 */
export const DEFAULT_PRODUCT_NAME = 'OpenFolia';

/** The longest product name. */
export const MAX_PRODUCT_NAME = 80;

/** The audit log's subject for every branding event. */
export const BRANDING_SUBJECT = { type: 'branding', id: 'branding' } as const;

/** The fields of `branding` naming `sha256`, in field order. */
export const fieldsNaming = (branding: Branding, sha256: string): ImageSlot[] =>
  IMAGE_SLOTS.filter((slot) => branding[slot] === sha256);

/** The hashes the branding refers to now: those that are served without a sign-in. */
export const referencedImages = (branding: Branding): ReadonlySet<string> =>
  new Set(
    IMAGE_SLOTS.map((slot) => branding[slot]).filter(
      (hash): hash is string => hash !== null,
    ),
  );
