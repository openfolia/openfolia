import { z } from 'zod';
import { Condition, Version } from './condition.js';
import { compareVersions } from './condition-eval.js';
import { Deprecation } from './deprecation.js';
import {
  AssetRef,
  ConfigKey,
  LanguageTag,
  ModuleId,
  SingleLine,
} from './ids.js';
import { LanguageKey } from './localized-text-schema.js';
import { DEFAULT_NOTICE_GROUPING, NOTICE_GROUPINGS } from './derive.js';
import { SAFETY_SEVERITIES } from './safety.js';
import { CommitId, SourceHash } from './translation.js';
import { VariantValues } from './variant.js';
import type { LocalizedText } from './localized-text.js';
import { localizedText } from './localized-text-schema.js';

export const CURRENT_MANIFEST_VERSION = 1;

/**
 * A module in a manual, or a titled group (chapter) of entries. Either can be conditional. A
 * group's title is one text or one per language (#731, `LocalizedText`).
 */
export type ManifestEntry =
  | { module: string; when?: Condition }
  | { title: LocalizedText; when?: Condition; entries: ManifestEntry[] };

/**
 * A manual's title or a group's (#731): one line for every language, or one per language by
 * language tag, translated like module text. A language without its own takes the source
 * language's.
 */
export const ManualTitle = localizedText(SingleLine);

export const ManifestEntry: z.ZodType<ManifestEntry, ManifestEntry> = z.lazy(
  () =>
    z.union([
      z.strictObject({ module: ModuleId, when: Condition.optional() }),
      z.strictObject({
        title: ManualTitle,
        when: Condition.optional(),
        entries: z.array(ManifestEntry).min(1),
      }),
    ]),
);

/** A text attribute's value: one value, or conditional values where the first match wins. */
export const AttributeValue = z.union([
  SingleLine,
  z
    .array(z.strictObject({ value: SingleLine, when: Condition.optional() }))
    .min(1),
]);
export type AttributeValue = z.infer<typeof AttributeValue>;

/** The most languages a cover image's alternative text is written in. */
const MAX_ALT_LANGUAGES = 100;

/** The longest alternative text of a cover image, in characters. */
export const MAX_COVER_ALT_LENGTH = 500;

/**
 * A cover image's alternative text (#394): the same in every language (one line), or written per
 * language, by language tag in its canonical case (at least one), translated like module text. A
 * language without its own takes the source language's.
 */
export const CoverImageAlt = z.union([
  SingleLine.max(MAX_COVER_ALT_LENGTH),
  z
    .record(
      z
        .string()
        .max(35)
        .refine(
          (tag) => LanguageTag.safeParse(tag).data === tag,
          'a language tag in its canonical case, e.g. "en" or "pt-BR"',
        ),
      SingleLine.max(MAX_COVER_ALT_LENGTH),
    )
    .refine((langs) => Object.keys(langs).length >= 1, 'at least one language')
    .refine(
      (langs) => Object.keys(langs).length <= MAX_ALT_LANGUAGES,
      `at most ${MAX_ALT_LANGUAGES} languages`,
    ),
]);
export type CoverImageAlt = z.infer<typeof CoverImageAlt>;

/** A manual's cover image (#394): a file of the media library and its alternative text (required). */
export const ManualCoverImage = z.strictObject({
  asset: AssetRef,
  alt: CoverImageAlt,
});
export type ManualCoverImage = z.infer<typeof ManualCoverImage>;

/** The most variants with a cover image of their own. */
export const MAX_COVER_VARIANTS = 100;

/** The most units a manifest's translation record names (its title, its groups, its covers). */
export const MAX_MANIFEST_UNITS = 10_000;

/**
 * A unit of a manifest's translatable text: its title (`title`, #731), a group's title
 * (`group.<12 hex>`, the first 12 hex digits of the SHA-256 of the group's source-language title,
 * so the key stays when entries are reordered; groups of the same title share it), a cover
 * image's alternative text (#656), `coverImage.default` for the manual's own,
 * `coverImage.variant-<12 hex>` for a variant's (the first 12 hex digits of the SHA-256 of its
 * `variantSlug`, so the key stays when entries are reordered). An XML name token, as an XLIFF
 * unit's `id` must be.
 */
export const ManifestUnitKey = z
  .string()
  .max(64)
  .regex(
    /^(?:title|group\.[0-9a-f]{12}|coverImage\.(?:default|variant-[0-9a-f]{12}))$/,
    '"title", "group.<12 hex digits>", "coverImage.default" or "coverImage.variant-<12 hex digits>"',
  );
export type ManifestUnitKey = z.infer<typeof ManifestUnitKey>;

/**
 * What a manifest's translatable text in one target language was translated from (#656), as a
 * page design's record says it (`DesignTranslationRecord`): per unit (`ManifestUnitKey`) the
 * source hash of the source text it was made from, and the source commit that was read. Written
 * by a translation import and by marking a translation current.
 */
export const ManifestTranslationRecord = z.strictObject({
  sourceCommit: CommitId,
  blocks: z
    .record(ManifestUnitKey, SourceHash)
    .refine(
      (units) => Object.keys(units).length <= MAX_MANIFEST_UNITS,
      `at most ${MAX_MANIFEST_UNITS} units`,
    ),
});
export type ManifestTranslationRecord = z.output<
  typeof ManifestTranslationRecord
>;

/** The most modules a derived manual's rule lists in one of its lists (`exclude`, `front`, `back`). */
export const MAX_RULE_MODULES = 500;

/** The most module types a derived manual's rule names. */
export const MAX_RULE_MODULE_TYPES = 100;

/** A list of module IDs, each once. */
const ModuleList = z
  .array(ModuleId)
  .max(MAX_RULE_MODULES)
  .refine((ids) => new Set(ids).size === ids.length, 'a module listed twice')
  .default([]);

/**
 * A derived manual's notice gathering (#670, `DerivedRule.notices`): in place of whole modules,
 * the safety messages (`safety` blocks) of its source manual's modules, whatever their type.
 * `groupBy` (`NOTICE_GROUPINGS`, default `DEFAULT_NOTICE_GROUPING`): `module`, a heading per
 * source module (its title) with its notices under it, in the source's order; `level`, a heading
 * per hazard level (its output label in the manual's language), and under it, per source module,
 * that module's notices of the level. `levels`: the levels gathered, in the order their groups
 * come; none: every level, most severe first (`SAFETY_SEVERITIES`).
 */
export const NoticeRule = z.strictObject({
  groupBy: z.enum(NOTICE_GROUPINGS).default(DEFAULT_NOTICE_GROUPING),
  levels: z
    .array(z.enum(SAFETY_SEVERITIES))
    .min(1)
    .max(SAFETY_SEVERITIES.length)
    .refine((ids) => new Set(ids).size === ids.length, 'a level listed twice')
    .optional(),
});
export type NoticeRule = z.output<typeof NoticeRule>;

/**
 * How a derived manual (#451, `kind: derived`) gathers its content: every module of the given
 * types that its source manual includes, in the source manual's order, each once, with the
 * source's conditions, between its own front and back matter. Which types count is
 * configuration: `moduleTypes`, else every type the configuration marks `safety: true`.
 */
export const DerivedRule = z.strictObject({
  /** The manual it is derived from (`manuals/<id>.yaml`), an assembled one. */
  source: ModuleId,
  /**
   * The module types it gathers, each a configured one. None: the configured safety types
   * (`safetyTypes`).
   */
  moduleTypes: z
    .array(ConfigKey)
    .min(1)
    .max(MAX_RULE_MODULE_TYPES)
    .refine((ids) => new Set(ids).size === ids.length, 'a type listed twice')
    .optional(),
  /** Modules of the source it leaves out on purpose (each a safety one is a warning). */
  exclude: ModuleList,
  /** Modules before the gathered ones (a title, a general safety introduction). */
  front: ModuleList,
  /** Modules after the gathered ones (contacts). */
  back: ModuleList,
  /**
   * Gathers the source's safety notices in place of whole modules (#670, `NoticeRule`); then
   * `moduleTypes`, when given, names the types whose modules are searched (none: every type).
   * Absent: whole modules, as above.
   */
  notices: NoticeRule.optional(),
});
export type DerivedRule = z.output<typeof DerivedRule>;

/** The most steps an update guide holds. */
export const MAX_UPDATE_STEPS = 2000;

/** The most versions an update guide offers. */
export const MAX_UPDATE_VERSIONS = 500;

/**
 * A step of an update guide (#906, `UpdateGuide.steps`): a module, the release that needs it, when
 * it is done and, optionally, for which readers. `version` and `phase` are checked by
 * `validateManifest` rather than here, so a draft with a step not filled in yet still saves:
 * a step without a dotted version is `update-step-version`, one with another phase than
 * `UPDATE_PHASES` `update-step-phase` (both errors).
 */
export const UpdateStep = z.strictObject({
  /** The module holding the step's text (its title and body). */
  module: ModuleId,
  /**
   * The release that needs it, a dotted version of the guide's version attribute (`2.3`). It
   * applies to a jump from `from` to `to` when `from < version <= to`.
   */
  version: z.string().max(64).optional(),
  /** `before`, `during` or `after` the update (`UPDATE_PHASES`). */
  phase: z.string().max(64),
  /**
   * The least restricted audience level it is for (a configured `audiences` ID): a reader who
   * picks that level or a more restricted one sees it. Absent: every level.
   */
  level: ConfigKey.optional(),
  /** A condition on the reader's options (enum variant attributes). Absent: every setup. */
  when: Condition.optional(),
});
export type UpdateStep = z.infer<typeof UpdateStep>;

/**
 * An update guide's own part (#906, `kind: update-guide`): the version attribute it follows, the
 * versions a reader picks from and to, and its steps in the order written. Its entries are made
 * from the steps when it is read (`updateGuideEntries`).
 */
export const UpdateGuide = z.strictObject({
  /** The configured version attribute (`variantAttributes`, `kind: version`) it follows. */
  attribute: ConfigKey,
  /** The versions a reader picks from, oldest first (at least two, each once, numerically). */
  versions: z
    .array(Version.max(64))
    .min(2)
    .max(MAX_UPDATE_VERSIONS)
    .refine(
      (vs) =>
        vs.every(
          (v, i) => i === 0 || compareVersions(vs[i - 1] as string, v) < 0,
        ),
      'versions listed oldest first, each once',
    ),
  steps: z.array(UpdateStep).max(MAX_UPDATE_STEPS).default([]),
});
export type UpdateGuide = z.output<typeof UpdateGuide>;

/** The kinds of manual besides an assembled one (no `kind`). */
export const MANUAL_KINDS = ['derived', 'update-guide'] as const;

/**
 * A manual: which modules, in which order, for which variants. Stored as
 * YAML next to the modules; the ID is the file name.
 */
export const Manifest = z.strictObject({
  schemaVersion: z.literal(CURRENT_MANIFEST_VERSION),
  id: ModuleId,
  /**
   * `derived` (#451): its entries come from `rule`, gathered from another manual, never written
   * by hand. `update-guide` (#906): its entries are its `guide`'s steps. Absent: an assembled
   * manual, its entries its own.
   */
  kind: z.enum(MANUAL_KINDS).optional(),
  /** One line, or one per language (#731, `ManualTitle`). */
  title: ManualTitle,
  /** The audience this manual is published for; modules above it are left out. */
  audience: ConfigKey.optional(),
  /** Withdrawn or superseded (#266), with why and what replaces it (a manual ID). */
  deprecated: Deprecation.optional(),
  /**
   * A generated glossary at the end of the manual (#245): the terms linked
   * in it, alphabetical in its language. Default: none.
   */
  glossary: z.boolean().optional(),
  /**
   * The page design the manual's PDF uses (#390), by ID (`design/<id>.yaml`). Default: the
   * project's (`pdf.design` in the configuration), else the built-in one.
   */
  design: ModuleId.optional(),
  /**
   * The cover image its page design's image slot shows (#394): `variants` gives one variant of
   * `variants` (by its exact values) its own, which wins over `default`, the manual's; both win
   * over the design's own cover image. None: the design's.
   */
  coverImage: z
    .strictObject({
      default: ManualCoverImage.optional(),
      variants: z
        .array(ManualCoverImage.extend({ variant: VariantValues }))
        .max(MAX_COVER_VARIANTS)
        .default([]),
    })
    .optional(),
  /**
   * Per target language, what its title, group titles (#731) and cover images' alternative text
   * (#656) were translated from (`ManifestTranslationRecord`). None: no translation of it has a
   * record (each is outdated).
   */
  translations: z
    .record(LanguageKey, ManifestTranslationRecord)
    .refine(
      (langs) => Object.keys(langs).length <= MAX_ALT_LANGUAGES,
      `at most ${MAX_ALT_LANGUAGES} languages`,
    )
    .optional(),
  /** The variant combinations that are actually shipped and built. */
  variants: z
    .array(VariantValues)
    .min(1)
    .refine(
      (vs) =>
        new Set(vs.map((v) => JSON.stringify(Object.entries(v).sort())))
          .size === vs.length,
      'duplicate variant',
    ),
  /**
   * Values for text attributes (`{product-name}`), possibly per variant. A derived manual's
   * own win over its source's, which it takes otherwise.
   */
  attributes: z.record(ConfigKey, AttributeValue).default({}),
  /**
   * How a derived manual gathers its entries (`DerivedRule`); only with `kind: derived`, which
   * needs one.
   */
  rule: DerivedRule.optional(),
  /**
   * An update guide's versions and steps (`UpdateGuide`); only with `kind: update-guide`, which
   * needs one.
   */
  guide: UpdateGuide.optional(),
  /**
   * The modules in order. A stored assembled manual has at least one (`StoredManifest`). A
   * derived manual's file has none: they are gathered when it is read (`deriveManifest`), and
   * never printed.
   */
  entries: z.array(ManifestEntry).default([]),
});
export type Manifest = z.infer<typeof Manifest>;

/**
 * What a stored manifest must be beyond its shape: an assembled manual has at least one entry;
 * a derived one has its rule, and only it has one. `StoredManifest` checks it; kept apart from
 * `Manifest` so that schema can still be extended and picked from.
 */
export function storedManifestProblems(
  manifest: Pick<Manifest, 'kind' | 'rule' | 'guide' | 'entries'>,
): { path: string; message: string }[] {
  const guide =
    manifest.guide && manifest.kind !== 'update-guide'
      ? [
          {
            path: 'kind',
            message:
              'a manual with a guide is an update guide (`kind: update-guide`)',
          },
        ]
      : [];
  if (manifest.kind === 'derived') {
    return [
      ...guide,
      ...(manifest.rule
        ? []
        : [{ path: 'rule', message: 'a derived manual needs its rule' }]),
    ];
  }
  if (manifest.kind === 'update-guide') {
    return [
      ...(manifest.guide
        ? []
        : [{ path: 'guide', message: 'an update guide needs its guide' }]),
      ...(manifest.rule
        ? [{ path: 'rule', message: 'an update guide has no rule' }]
        : []),
    ];
  }
  return [
    ...guide,
    ...(manifest.rule
      ? [
          {
            path: 'kind',
            message: 'a manual with a rule is a derived one (`kind: derived`)',
          },
        ]
      : []),
    ...(manifest.entries.length === 0
      ? [{ path: 'entries', message: 'at least one entry' }]
      : []),
  ];
}

/** A manifest as one is stored: `Manifest` with `storedManifestProblems` checked. */
export const StoredManifest = Manifest.superRefine((manifest, ctx) => {
  for (const problem of storedManifestProblems(manifest)) {
    ctx.addIssue({
      code: 'custom',
      message: problem.message,
      path: [problem.path],
    });
  }
});
/** A manifest as one is written: settings with defaults may be left out. */
export type ManifestInput = z.input<typeof Manifest>;

/**
 * The files a manifest names (#394): its cover images, the manual's first, then each variant's,
 * with where (`coverImage.default`, `coverImage.variants.<n>`), one entry per place.
 */
export function manifestAssets(
  manifest: Pick<Manifest, 'coverImage'>,
): { asset: string; path: string }[] {
  const cover = manifest.coverImage;
  if (!cover) return [];
  return [
    ...(cover.default
      ? [{ asset: cover.default.asset, path: 'coverImage.default' }]
      : []),
    ...cover.variants.map((v, i) => ({
      asset: v.asset,
      path: `coverImage.variants.${i}`,
    })),
  ];
}
