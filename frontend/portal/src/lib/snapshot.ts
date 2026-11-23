import { z } from 'zod';
import { modulesOf } from './modules.ts';

/**
 * What one build (one audience, one language) is made from: written by the fetch step
 * (`build/fetch.ts`) from the API, read by the pages. It holds data only, never markup: the
 * pages render the resolved manuals with `@openfolia/render-html` themselves, so the only HTML that
 * reaches the site is the renderer's, escaped by construction.
 */
export const SNAPSHOT_FORMAT = 2;

/** A language tag this build writes as a folder and an attribute (`en`, `de-AT`, `zh-Hant`). */
export const LANGUAGE_TAG = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/;

/** A path segment the build writes: lowercase IDs, variant slugs (`model=large,region=eu`). */
export const SEGMENT = /^[a-z0-9][a-z0-9._=,-]{0,199}$/;
const Segment = z.string().regex(SEGMENT);

/** A SHA-256 in hex. */
const Hash = z.string().regex(/^[0-9a-f]{64}$/);

/** A file the build writes under `assets/`: the hash, an extension it chose from a fixed list. */
export const ASSET_FILE =
  /^[0-9a-f]{64}\.(png|jpg|gif|webp|pdf|zip|json|csv|txt|bin)$/;

const Label = z.object({ id: z.string(), label: z.string() });
const AssetFile = z.string().regex(ASSET_FILE);

/**
 * A variant's PDF (#784): the release's rendered file (`GET /releases/{id}/outputs`), carried
 * by the build under `assets/`, with the name it downloads as.
 */
export const SnapshotPdf = z.object({
  file: z.string().regex(/^[0-9a-f]{64}\.pdf$/),
  size: z.number().int().min(1),
  /** ASCII letters, digits, `.`, `_` and `-` only, ending in `.pdf`. */
  name: z.string().regex(/^[A-Za-z0-9._-]{1,200}\.pdf$/),
});
export type SnapshotPdf = z.infer<typeof SnapshotPdf>;

/** The theme tokens a brand may set (the API's `BRAND_TOKENS`), never a status or safety colour. */
export const BRAND_TOKENS = [
  'primary',
  'primary-foreground',
  'ring',
  'accent',
  'sidebar',
  'sidebar-border',
  'sidebar-primary',
  'sidebar-primary-foreground',
  'sidebar-ring',
] as const;
const Hex = z.string().regex(/^#[0-9a-f]{6}$/);
const Tokens = z.partialRecord(z.enum(BRAND_TOKENS), Hex);

/**
 * The organisation's branding (#784, `GET /branding`): its name, its images as files under
 * `assets/` (null: the default's), its colours as theme tokens for light and dark (null: the
 * theme's). Null as a whole: OpenFolia's default look (none set, or the build's off switch).
 */
export const SnapshotBranding = z.object({
  productName: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}]*$/u)
    .nullable(),
  logoLight: AssetFile.nullable(),
  logoDark: AssetFile.nullable(),
  mark: AssetFile.nullable(),
  favicon: AssetFile.nullable(),
  appIcon: AssetFile.nullable(),
  tokens: z.object({ light: Tokens, dark: Tokens }).nullable(),
});
export type SnapshotBranding = z.infer<typeof SnapshotBranding>;

export const SnapshotVariant = z.object({
  slug: Segment,
  label: z.string(),
  values: z.record(z.string(), z.string()),
  /** The resolved manual as the API gave it (`ResolvedManual` of `@openfolia/content-model`). */
  resolved: z.record(z.string(), z.unknown()),
  /** Every module the resolved manual holds (its entries and what module references inlined), by ID, with its audience. */
  moduleAudiences: z.record(z.string(), z.string()),
  /** The release's PDF of this variant in the build's language; null: none rendered (yet). */
  pdf: SnapshotPdf.nullable(),
});
export type SnapshotVariant = z.infer<typeof SnapshotVariant>;

export const SnapshotManual = z.object({
  id: Segment,
  title: z.string(),
  audience: z.string(),
  variants: z.array(SnapshotVariant),
});
export type SnapshotManual = z.infer<typeof SnapshotManual>;

export const SnapshotRelease = z.object({
  id: z.string(),
  product: Segment,
  productLabel: z.string(),
  revision: z.string(),
  tag: z.string(),
  publishedAt: z.string(),
  notes: z.string().nullable(),
  manuals: z.array(SnapshotManual),
});
export type SnapshotRelease = z.infer<typeof SnapshotRelease>;

export const Snapshot = z.object({
  format: z.literal(SNAPSHOT_FORMAT),
  /** The audience the build is for, and the configured levels in order (least restricted first). */
  audience: z.string(),
  audiences: z.array(Label),
  /** The build's language, and every language the deployment builds (for the language switch). */
  lang: z.string().regex(LANGUAGE_TAG),
  dir: z.enum(['ltr', 'rtl']),
  languages: z.array(z.string().regex(LANGUAGE_TAG)),
  variantAttributes: z.array(
    z.object({ id: z.string(), label: z.string(), values: z.array(Label) }),
  ),
  safetySymbols: z.array(Label),
  outputLabels: z.record(z.string(), z.unknown()),
  releases: z.array(SnapshotRelease),
  /** `sha256` (hex) → its file under `assets/`. */
  assets: z.record(Hash, z.string().regex(ASSET_FILE)),
  /** Safety symbol ID → its file under `assets/` (always a raster image). */
  symbols: z.record(z.string(), z.string().regex(ASSET_FILE)),
  branding: SnapshotBranding.nullable(),
});
export type Snapshot = z.infer<typeof Snapshot>;

/** Every file under `assets/` a snapshot's pages link: images, attachments, symbols, the branding's images and the PDFs. */
export function linkedFiles(snapshot: Snapshot): Set<string> {
  const files = new Set([
    ...Object.values(snapshot.assets),
    ...Object.values(snapshot.symbols),
  ]);
  const b = snapshot.branding;
  if (b)
    for (const file of [b.logoLight, b.logoDark, b.mark, b.favicon, b.appIcon])
      if (file !== null) files.add(file);
  for (const release of snapshot.releases)
    for (const manual of release.manuals)
      for (const variant of manual.variants)
        if (variant.pdf) files.add(variant.pdf.file);
  return files;
}

/** The rank of an audience level: its index among the configured ones, or undefined. */
export function audienceRank(
  audiences: readonly { id: string }[],
  id: string | undefined,
): number | undefined {
  if (id === undefined) return undefined;
  const rank = audiences.findIndex((a) => a.id === id);
  return rank < 0 ? undefined : rank;
}

/**
 * Checks a snapshot read back from disk again before a page is made of it: every manual and
 * every module it holds is at most the build's audience. The modules are counted again from
 * each resolved manual's own structure (`modulesOf`), so a module the recorded audiences miss
 * is refused too. The fetch step checked the same before writing it; this holds a snapshot
 * written by hand or by an older build to the rule.
 */
export function parseSnapshot(value: unknown): Snapshot {
  const snapshot = Snapshot.parse(value);
  const limit = audienceRank(snapshot.audiences, snapshot.audience);
  if (limit === undefined)
    throw new Error(
      `the build's audience "${snapshot.audience}" is not configured`,
    );
  const above = (audience: string) => {
    const rank = audienceRank(snapshot.audiences, audience);
    return rank === undefined || rank > limit;
  };
  for (const release of snapshot.releases)
    for (const manual of release.manuals) {
      if (above(manual.audience))
        throw new Error(
          `manual ${manual.id} is for "${manual.audience}", above the build's audience "${snapshot.audience}"`,
        );
      for (const variant of manual.variants) {
        for (const [module, audience] of Object.entries(
          variant.moduleAudiences,
        ))
          if (above(audience))
            throw new Error(
              `module ${module} in manual ${manual.id} is for "${audience}", above the build's audience "${snapshot.audience}"`,
            );
        for (const module of modulesOf(variant.resolved))
          if (!Object.hasOwn(variant.moduleAudiences, module))
            throw new Error(
              `module ${module} in manual ${manual.id} has no checked audience`,
            );
      }
    }
  return snapshot;
}
