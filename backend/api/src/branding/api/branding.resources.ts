import { z } from 'zod';
import {
  pagedDocument,
  resourceObject,
  singleDocument,
} from '../../base/api/json-api.js';
import type { ListedBrandingImage } from '../core/actions/list-branding-images.action.js';
import type { BrandingView } from '../core/actions/get-branding.action.js';
import {
  BRAND_TOKENS,
  type ContrastCheck,
  type ThemeTokens,
} from '../core/brand-colours.js';
import {
  type Branding,
  BRANDING_IMAGE_TYPES,
  type BrandingImage,
  IMAGE_SLOTS,
  type ImageSlot,
  MAX_PRODUCT_NAME,
} from '../core/branding.js';

/** `sha256:<hash>`: how the branding names an uploaded image. */
const ImageRef = z
  .string()
  .regex(/^sha256:[0-9a-f]{64}$/)
  .describe(
    'An image uploaded for the branding (`POST /branding/images`), as `sha256:<hash>`; served at `GET /branding/images/{hash}`.',
  );

const HexColour = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/)
  .describe('`#rrggbb` (answered in lowercase).');

const ProductName = z
  .string()
  .trim()
  .min(1)
  .max(MAX_PRODUCT_NAME)
  // No control characters: it becomes the document title and an alt text.
  .regex(
    /^[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}]*$/u,
    'No control, format or line-break characters.',
  )
  .describe(
    `The product’s name (1 to ${MAX_PRODUCT_NAME} characters, trimmed): the document title, the logo’s accessible name, the breadcrumb’s home.`,
  );

const IMAGE_DESCRIPTIONS: Record<ImageSlot, string> = {
  logoLight:
    'The logo with the name, for light pages: the expanded sidebar and the sign-in page.',
  logoDark: 'The logo for dark pages; null: the light one there too.',
  mark: 'The compact mark, for the collapsed sidebar.',
  favicon: 'The browser tab’s icon; square.',
  appIcon: 'The icon a phone puts on its home screen; square.',
};

const attributes = {
  productName: ProductName.nullable(),
  ...(Object.fromEntries(
    IMAGE_SLOTS.map((slot) => [
      slot,
      ImageRef.nullable().describe(IMAGE_DESCRIPTIONS[slot]),
    ]),
  ) as Record<ImageSlot, z.ZodNullable<typeof ImageRef>>),
  primary: HexColour.nullable().describe(
    'The primary colour (buttons, links, the focus ring, the selected item’s icon), used as given in light; the dark one is derived from it. `#rrggbb`.',
  ),
  accent: HexColour.nullable().describe(
    'The optional accent: tints the light sidebar (else the primary colour does). `#rrggbb`.',
  ),
};

const Tokens = z
  .object(
    Object.fromEntries(
      BRAND_TOKENS.map((t) => [
        t,
        z
          .string()
          .regex(/^#[0-9a-f]{6}$/)
          .optional(),
      ]),
    ) as Record<(typeof BRAND_TOKENS)[number], z.ZodOptional<z.ZodString>>,
  )
  .meta({ id: 'BrandThemeTokens' });

const Check = z
  .object({
    theme: z.enum(['light', 'dark']),
    pair: z
      .string()
      .describe(
        '`<foreground>/<background>` by token name, e.g. `primary-foreground/primary`.',
      ),
    colour: z
      .enum(['primary', 'accent'])
      .describe('The brand colour it comes from.'),
    ratio: z
      .number()
      .describe('The contrast ratio, rounded down to two decimals.'),
    required: z.number().describe('4.5 for text, 3 for a shape or an outline.'),
  })
  .meta({ id: 'BrandContrastCheck' });

export const BrandingResource = resourceObject('Branding', {
  attributes: z.object({
    ...attributes,
    updatedAt: z.iso
      .datetime({ offset: true })
      .nullable()
      .describe('When it last changed; null: never.'),
  }),
  meta: z.object({
    tokens: z
      .object({ light: Tokens, dark: Tokens })
      .nullable()
      .describe(
        'The theme tokens the colours give (`frontend/theme` names), each `#rrggbb`, for light and dark: applied over the theme’s defaults. Null without colours. Never a status or safety colour.',
      ),
    contrast: z
      .array(Check)
      .describe(
        'Every pair the colours make, with its contrast; each meets what it requires.',
      ),
  }),
})
  .describe(
    'The platform’s branding. `id` is always `branding`. Null fields take the neutral defaults.',
  )
  .meta({ id: 'BrandingResource' });

export const BrandingDocument = singleDocument(BrandingResource).meta({
  id: 'BrandingDocument',
});
export type BrandingDocument = z.infer<typeof BrandingDocument>;

export const UpdateBrandingDocument = z
  .strictObject({
    data: z.strictObject({
      type: z.literal('Branding'),
      id: z.literal('branding').optional(),
      attributes: z
        .strictObject(
          Object.fromEntries(
            Object.entries(attributes).map(([name, schema]) => [
              name,
              schema.optional(),
            ]),
          ) as {
            [K in keyof typeof attributes]: z.ZodOptional<
              (typeof attributes)[K]
            >;
          },
        )
        .describe(
          'The fields to change; left out stays, null is the default again.',
        ),
    }),
  })
  .meta({ id: 'UpdateBrandingDocument' });
export type UpdateBrandingDocument = z.output<typeof UpdateBrandingDocument>;

export const BrandingImageResource = resourceObject('BrandingImage', {
  attributes: z.object({
    reference: ImageRef.describe(
      'How a branding field names it: `sha256:<hash>`, for `PATCH /branding`.',
    ),
    contentType: z.enum(BRANDING_IMAGE_TYPES),
    size: z.int().min(1).describe('In bytes.'),
    width: z.int().min(1).describe('In pixels.'),
    height: z.int().min(1).describe('In pixels.'),
    uploadedAt: z.iso.datetime({ offset: true }),
  }),
})
  .describe('`id` is the image’s SHA-256.')
  .meta({ id: 'BrandingImageResource' });

export const BrandingImageDocument = singleDocument(BrandingImageResource).meta(
  { id: 'BrandingImageDocument' },
);
export type BrandingImageDocument = z.infer<typeof BrandingImageDocument>;

/** An uploaded image in the list, with the fields naming it now. */
export const ListedBrandingImageResource = BrandingImageResource.extend({
  meta: z.object({
    usedIn: z
      .array(z.enum(IMAGE_SLOTS))
      .describe(
        'The fields naming it now; none: unused, deleted with `DELETE /branding/images/{hash}` or by the sweep a day after its upload.',
      ),
  }),
}).meta({ id: 'ListedBrandingImageResource' });

export const BrandingImagePageDocument = pagedDocument(
  ListedBrandingImageResource,
).meta({ id: 'BrandingImagePageDocument' });
export type BrandingImagePageDocument = z.infer<
  typeof BrandingImagePageDocument
>;

export function toListedBrandingImageResource({
  image,
  usedIn,
}: ListedBrandingImage): z.infer<typeof ListedBrandingImageResource> {
  return { ...toBrandingImageResource(image), meta: { usedIn: [...usedIn] } };
}

const ref = (hash: string | null) => (hash === null ? null : `sha256:${hash}`);
const unref = (value: string | null) =>
  value === null ? null : value.slice('sha256:'.length);

/** The body's attributes as the action takes them. */
export function toChanges(
  body: UpdateBrandingDocument['data']['attributes'],
): Partial<Branding> {
  const changes: { -readonly [K in keyof Branding]?: Branding[K] } = {};
  if (body.productName !== undefined) changes.productName = body.productName;
  for (const slot of IMAGE_SLOTS) {
    const value = body[slot];
    if (value !== undefined) changes[slot] = unref(value);
  }
  if (body.primary !== undefined) {
    changes.primary =
      body.primary === null
        ? null
        : (body.primary.toLowerCase() as `#${string}`);
  }
  if (body.accent !== undefined) {
    changes.accent =
      body.accent === null ? null : (body.accent.toLowerCase() as `#${string}`);
  }
  return changes;
}

const tokensOf = (t: ThemeTokens) => ({ ...t });
const checkOf = (c: ContrastCheck) => ({ ...c });

export function toBrandingResource(
  view: BrandingView,
): z.infer<typeof BrandingResource> {
  const b = view.branding;
  return {
    type: 'Branding',
    id: 'branding',
    attributes: {
      productName: b.productName,
      logoLight: ref(b.logoLight),
      logoDark: ref(b.logoDark),
      mark: ref(b.mark),
      favicon: ref(b.favicon),
      appIcon: ref(b.appIcon),
      primary: b.primary,
      accent: b.accent,
      updatedAt: view.updatedAt?.toISOString() ?? null,
    },
    meta: {
      tokens: view.derived.tokens
        ? {
            light: tokensOf(view.derived.tokens.light),
            dark: tokensOf(view.derived.tokens.dark),
          }
        : null,
      contrast: view.derived.checks.map(checkOf),
    },
  };
}

export function toBrandingImageResource(
  image: BrandingImage,
): z.infer<typeof BrandingImageResource> {
  return {
    type: 'BrandingImage',
    id: image.sha256,
    attributes: {
      reference: `sha256:${image.sha256}`,
      contentType: image.contentType,
      size: image.size,
      width: image.width,
      height: image.height,
      uploadedAt: image.uploadedAt.toISOString(),
    },
  };
}
