import { Condition, UPDATE_PHASES } from '@openfolia/content-model';
import { z } from 'zod';
import { modulesOf } from './modules.ts';

/**
 * What one build (one audience, one language) is made from: written by the fetch step
 * (`build/fetch.ts`) from the API, read by the pages. It holds data only, never markup: the
 * pages render the resolved manuals with `@openfolia/render-html` themselves, so the only HTML that
 * reaches the site is the renderer's, escaped by construction.
 */
export const SNAPSHOT_FORMAT = 3;

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

/**
 * An update guide's step (#907, `GET /manuals/{id}/update-guide/{lang}/steps`): what the page
 * filters on. Its text is its module's in the guide's resolved manual (`SnapshotVariant`), whose
 * audience is checked as any manual's.
 */
export const SnapshotStep = z.object({
  /** The step's ID: its module's, with `--2`, `--3`, … for its later steps. */
  id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*(?:--[0-9]+)?$/),
  module: Segment,
  title: z.string(),
  version: z.string(),
  phase: z.enum(UPDATE_PHASES),
  /** The least restricted level it is for (an audience ID); null: every level. */
  level: z.string().nullable(),
  /** The condition on the reader's options; null: every setup. */
  when: Condition.nullable(),
});
export type SnapshotStep = z.infer<typeof SnapshotStep>;

/**
 * An update guide's own part (#907, `GET /manuals/{id}/update-guide/{lang}`): the versions a
 * reader picks from and to, the levels and options, and every step the token may read.
 */
export const SnapshotGuide = z.object({
  attribute: Label,
  versions: z.array(z.string()).min(2),
  levels: z.array(Label),
  options: z.array(Label.extend({ values: z.array(Label) })),
  steps: z.array(SnapshotStep),
});
export type SnapshotGuide = z.infer<typeof SnapshotGuide>;

export const SnapshotManual = z.object({
  id: Segment,
  title: z.string(),
  audience: z.string(),
  variants: z.array(SnapshotVariant),
  /** Set for an update guide (`kind: update-guide`): its page is the guide's, not a manual's. */
  guide: SnapshotGuide.optional(),
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

/**
 * An older release of a product (#896): built beside its newest, under
 * `<product>/v/<segment>/`. The segment is its revision in lowercase where that is a safe path
 * segment and unique among the product's, else its ID.
 */
export const SnapshotOlderRelease = SnapshotRelease.extend({
  segment: Segment,
});
export type SnapshotOlderRelease = z.infer<typeof SnapshotOlderRelease>;

/** The path segment under `<product>/` that leads to a product's older releases. */
export const OLDER_SEGMENT = 'v';

/** An older release's search index, in its folder: no manual ID starts with `_` (`SEGMENT`). */
export const OLDER_INDEX = '_pagefind';

/**
 * The authored start page (#897): an ordinary manual of the content repository, named by the
 * build's settings, as its release has it. It is the start page instead of a manual: it has no
 * page of its own and is in no list. `variants` holds its first variant only.
 */
export const SnapshotStart = z.object({
  manual: SnapshotManual,
  /** The portal's own address (`CCMS_PORTAL_URL`): links to it are links to this site's pages. Null: not set. */
  origin: z.string().nullable(),
  /** The path the languages' sites are served under on it. */
  basePath: z.string(),
});
export type SnapshotStart = z.infer<typeof SnapshotStart>;

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
  /** Each product's newest built release: the addresses readers have always used. */
  releases: z.array(SnapshotRelease),
  /** The products' older built releases, newest first (#896); empty by default. */
  older: z.array(SnapshotOlderRelease).default([]),
  /** Whether the older releases' pages carry `noindex` (`CCMS_PORTAL_OLDER_NOINDEX`). */
  olderNoindex: z.boolean().default(true),
  /** The authored start page (#897); null: the default one. */
  start: SnapshotStart.nullable().default(null),
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
  for (const release of [...snapshot.releases, ...snapshot.older])
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
  // One newest release per product: its pages are the product's addresses.
  const products = new Set<string>();
  for (const release of snapshot.releases) {
    if (products.has(release.product))
      throw new Error(`two newest releases of ${release.product}`);
    products.add(release.product);
  }
  // An older release sits beside its product's newest, at addresses of its own.
  const segments = new Set<string>();
  for (const release of snapshot.older) {
    const newest = snapshot.releases.find((r) => r.product === release.product);
    if (!newest)
      throw new Error(
        `release ${release.id} is an older release of ${release.product}, which has no newest release in the build`,
      );
    // `<product>/v/<segment>/` is the older release's page: a newest manual `v` would share it.
    if (newest.manuals.some((m) => m.id === OLDER_SEGMENT))
      throw new Error(
        `manual ${OLDER_SEGMENT} of ${release.product} would share its address with the product's older releases (${release.product}/${OLDER_SEGMENT}/…)`,
      );
    const key = `${release.product}/${release.segment}`;
    if (segments.has(key)) throw new Error(`two older releases at ${key}`);
    segments.add(key);
  }
  const manuals = [...snapshot.releases, ...snapshot.older].flatMap(
    (release) => release.manuals,
  );
  // The start page is checked as any manual is, and is none of the site's manuals itself.
  const start = snapshot.start?.manual;
  if (start && manuals.some((m) => m.id === start.id && !m.guide))
    throw new Error(`manual ${start.id} is both the start page and a manual`);
  for (const manual of start ? [...manuals, start] : manuals) {
    if (above(manual.audience))
      throw new Error(
        `manual ${manual.id} is for "${manual.audience}", above the build's audience "${snapshot.audience}"`,
      );
    for (const variant of manual.variants) {
      for (const [module, audience] of Object.entries(variant.moduleAudiences))
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
    // An update guide's steps show its first variant's modules: each one checked there.
    if (manual.guide) {
      const checked = manual.variants[0]?.moduleAudiences ?? {};
      for (const step of manual.guide.steps) {
        if (!Object.hasOwn(checked, step.module))
          throw new Error(
            `step ${step.id} in update guide ${manual.id} has no checked audience`,
          );
        if (step.level !== null && above(step.level))
          throw new Error(
            `step ${step.id} in update guide ${manual.id} is for the level "${step.level}", above the build's audience "${snapshot.audience}"`,
          );
      }
      for (const level of manual.guide.levels)
        if (above(level.id))
          throw new Error(
            `update guide ${manual.id} offers the level "${level.id}", above the build's audience "${snapshot.audience}"`,
          );
    }
  }
  return snapshot;
}
