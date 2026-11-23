import { z } from 'zod';
import {
  isTemplateFilePath,
  isTemplateTextFile,
  MAX_TEMPLATE_FILE_PATH,
  TEMPLATE_TEXT_EXTENSIONS,
} from './template-file-rules.js';
import { Block } from './blocks.js';
import { TABLE_TOO_LARGE, tablesTooLarge } from './table-limits.js';
import { Condition } from './condition.js';
import type { ProjectConfig } from './config.js';
import {
  AssetRef,
  ConfigKey,
  LanguageTag,
  ModuleId,
  SingleLine,
} from './ids.js';
import { type Inline, InlineTitle } from './inline.js';
import {
  BACK_PAGE_POSITIONS,
  COLOUR_PATTERN,
  contrastRatio,
  DESIGN_COLOUR_ROLES,
  fontFormatOf,
  HEADING_NUMBERINGS,
  isPageDesignPreset,
  MAX_DESIGN_HEADING_LEVELS,
  MIN_TEXT_CONTRAST,
  NOTE_STYLES,
  PAGE_DESIGN_PRESET_IDS,
  PAGE_DESIGN_PRESETS,
  PAGE_SIZES,
  regionSlots,
  SAFETY_STANDARDS,
  STEP_MARKERS,
  TABLE_BORDERS,
  TITLE_PAGE_FIELDS,
  TYPE_SCALE_STEPS,
  isLocalized,
  type Translatable,
} from './page-design-options.js';
import { isPlaceholderKey, PLACEHOLDER_KEYS } from './placeholder.js';
import { ownInlineContent } from './term-links.js';
import { CommitId, SourceHash } from './translation.js';
import { blockIssues, conditionIssues, type IssueCode } from './validate.js';
import { walk } from './walk.js';

export * from './page-design-options.js';

/** Bumped on every breaking change to a design file's format. */
export const PAGE_DESIGN_SCHEMA_VERSION = 1;

/** The built-in design's ID, which no file may take (a manual naming none gets it). */
export const BUILTIN_PAGE_DESIGN_ID = 'builtin';

/** A design's ID: its file name (`design/<id>.yaml`), a slug like a module's; never `builtin`. */
export const PageDesignId = ModuleId.refine(
  (id) => id !== BUILTIN_PAGE_DESIGN_ID,
  `reserved: "${BUILTIN_PAGE_DESIGN_ID}" is the built-in design`,
);
export type PageDesignId = z.infer<typeof PageDesignId>;

/**
 * Where an organisation's own Typst templates live in the content repository (#396): one folder
 * per template, `templates/<id>/`, its entry file `manual.typ` (`designTemplatePath`). The folder
 * holds the template's own files (more Typst files it imports, images it shows); a template reads
 * nothing else of the repository.
 */
export const DESIGN_TEMPLATES_DIR = 'templates';
/** A template's entry file in its folder: what the generated document imports. */
export const DESIGN_TEMPLATE_ENTRY = 'manual.typ';
/** A template's ID: its folder's name, a slug like a module's. */
export const DesignTemplateId = ModuleId;
export type DesignTemplateId = z.infer<typeof DesignTemplateId>;
/** The most files a template's folder may hold (#396): one with more is not compiled. */
export const MAX_TEMPLATE_FILES = 200;
/** The most bytes a template's files may hold together (#396): one larger is not compiled. */
export const MAX_TEMPLATE_BYTES = 16 * 1024 * 1024;
/** A template's folder in the content repository. */
export const designTemplateDir = (id: DesignTemplateId): string =>
  `${DESIGN_TEMPLATES_DIR}/${id}`;
/** A template's entry file in the content repository. */
export const designTemplatePath = (id: DesignTemplateId): string =>
  `${designTemplateDir(id)}/${DESIGN_TEMPLATE_ENTRY}`;

/**
 * A text file's path in its template folder (#396), as a change set edits it: `manual.typ`,
 * `parts/notice.typ` (`isTemplateFilePath`, `isTemplateTextFile`).
 */
export const DesignTemplateFilePath = z
  .string()
  .max(MAX_TEMPLATE_FILE_PATH)
  .refine(
    isTemplateFilePath,
    'a path in the template folder: names of letters, digits, "_", "-" and ".", joined by "/", none starting with "."',
  )
  .refine(
    isTemplateTextFile,
    `a text file: one of .${TEMPLATE_TEXT_EXTENSIONS.join(', .')}`,
  );
export type DesignTemplateFilePath = z.infer<typeof DesignTemplateFilePath>;

/** A template file's path in the content repository (`templates/<id>/<path>`). */
export const designTemplateFilePath = (
  id: DesignTemplateId,
  path: DesignTemplateFilePath,
): string => `${designTemplateDir(id)}/${path}`;

/** A language as a key of translated text: a language tag in its canonical case. */
const LanguageKey = z
  .string()
  .max(35)
  .refine(
    (tag) => LanguageTag.safeParse(tag).data === tag,
    'a language tag in its canonical case, e.g. "en" or "pt-BR"',
  );

/** The most languages one translated text holds. */
const MAX_LANGUAGES = 100;

/** Text in each language it is written in (at least one): translated like module text. */
const Localized = <T extends z.ZodType>(value: T) =>
  z
    .record(LanguageKey, value)
    .refine((langs) => Object.keys(langs).length >= 1, 'at least one language')
    .refine(
      (langs) => Object.keys(langs).length <= MAX_LANGUAGES,
      `at most ${MAX_LANGUAGES} languages`,
    );

/**
 * A design's text: the same in every language (`value` itself: placeholders only, a name, a
 * number), or written per language (a record by language tag), translated like module text.
 */
const Translatable = <T extends z.ZodType>(value: T) =>
  z.union([value, Localized(value)]);

/** A colour, `#rrggbb` (stored lowercase). */
export const DesignColour = z
  .string()
  .overwrite((c) => c.toLowerCase())
  .regex(COLOUR_PATTERN, 'a colour as "#rrggbb"');

/** The most blocks one region holds in one language. */
export const MAX_REGION_BLOCKS = 50;

/** Inline nodes a design's text may not hold: a cross-reference has no target on a title page. */
const noXrefs = (content: readonly Inline[]) =>
  content.every((n) => n.type !== 'xref');

/**
 * A region's text in one language: blocks of the document model, with placeholders. Headings
 * one level deep only: a section at the top of the region (its title a heading on the page,
 * never in the table of contents or the bookmarks), no section in it nor in any other block
 * (#393). No page breaks, module references or cross-references: a region is a short text on
 * a fixed place of a page. Variant blocks are fine (resolved per variant), as are text
 * attributes. Block IDs are unique, and the same in every language (a translation keeps them).
 */
export const RegionBlocks = z
  .array(Block)
  .min(1)
  .max(MAX_REGION_BLOCKS)
  .superRefine((blocks, ctx) => {
    const seen = new Set<string>();
    const top = new Set<Block>(blocks);
    for (const { node } of walk(blocks)) {
      if (seen.has(node.id)) {
        ctx.addIssue({
          code: 'custom',
          message: `duplicate block id "${node.id}"`,
        });
      }
      seen.add(node.id);
      if ('type' in node && node.type === 'section' && !top.has(node)) {
        ctx.addIssue({
          code: 'custom',
          message: `a region's headings are one level deep: no section inside another block ("${node.id}")`,
        });
      }
      if (
        'type' in node &&
        (node.type === 'pageBreak' || node.type === 'moduleRef')
      ) {
        ctx.addIssue({
          code: 'custom',
          message: `a region holds no ${node.type === 'moduleRef' ? 'module reference' : 'page break'} ("${node.id}")`,
        });
      }
      if (!ownInlineContent(node).every(noXrefs)) {
        ctx.addIssue({
          code: 'custom',
          message: `a region holds no cross-reference ("${node.id}")`,
        });
      }
    }
  });
export type RegionBlocks = z.output<typeof RegionBlocks>;

/**
 * A unit of a design's region text (#568): `<slot>.<blockId>`, the region's slot and the block's
 * (or item's) ID. Neither a slot nor a block ID holds a dot, so the key reads back unambiguously,
 * and it is an XML name token, as an XLIFF unit's `id` must be.
 */
export const DesignUnitKey = z
  .string()
  .max(200)
  .regex(
    /^[a-z][a-z0-9-]*\.[a-z_][a-z0-9_-]*$/,
    '"<slot>.<block id>", e.g. "back.imprint"',
  );
export type DesignUnitKey = z.infer<typeof DesignUnitKey>;

/**
 * What one language's region text was translated from (#568), as a module's translation record
 * says it (`TranslationRecord`): per unit (`DesignUnitKey`) the source hash of the source text it
 * was made from, and the source commit that was read. Written by a translation import; editing
 * the source text leaves it as it is, so the translation shows as outdated.
 */
export const DesignTranslationRecord = z.strictObject({
  sourceCommit: CommitId,
  blocks: z.record(DesignUnitKey, SourceHash),
});
export type DesignTranslationRecord = z.output<typeof DesignTranslationRecord>;

/** One line of a running header or footer: inline content, placeholders included, no links to blocks. */
export const RunningText = InlineTitle.refine(
  noXrefs,
  'no cross-references in a running header or footer',
);

/** A running header's or footer's three places, each optional, each translated. */
export const RunningSlots = z.strictObject({
  left: Translatable(RunningText).optional(),
  centre: Translatable(RunningText).optional(),
  right: Translatable(RunningText).optional(),
});
export type RunningSlots = z.output<typeof RunningSlots>;

/**
 * A running header or footer: on every page (`default`), with its own text on the first page of
 * the content (`first`) and, for double-sided print, on left (even) pages (`even`).
 */
export const RunningRegion = z.strictObject({
  default: RunningSlots,
  first: RunningSlots.optional(),
  even: RunningSlots.optional(),
});
export type RunningRegion = z.output<typeof RunningRegion>;

/** A font family from font files the design names: its name, as the files give it, and its styles. */
export const DesignFont = z.strictObject({
  family: SingleLine,
  regular: AssetRef,
  bold: AssetRef.optional(),
  italic: AssetRef.optional(),
  boldItalic: AssetRef.optional(),
});
export type DesignFont = z.output<typeof DesignFont>;

/** A cover image: the file and its alternative text per language (none: decorative). */
export const CoverImage = z.strictObject({
  asset: AssetRef,
  alt: Translatable(SingleLine).optional(),
});
export type CoverImage = z.output<typeof CoverImage>;

/** A length on the page, in millimetres. */
const Millimetres = z.number().min(0).max(100);

/** The defaults of every setting, as the built-in design has them. */
const DEFAULT_MARGINS = { top: 26, right: 22, bottom: 24, left: 22 };

/**
 * A page design (#390): one organisation's look of a manual's PDF, kept in the content
 * repository (`design/<id>.yaml`) and versioned with the content. A layout preset with its
 * regions, the page, colours, fonts and logo, the title page's fields, the cover image rule, the
 * back page, and the inner pages' settings (running header and footer, headings, body, tables,
 * steps and notes, the safety layout's standard). Settings are choices from fixed lists, never
 * code; an organisation's own Typst template is a project file of its own, which `template` names.
 */
export const PageDesign = z
  .strictObject({
    schemaVersion: z.literal(PAGE_DESIGN_SCHEMA_VERSION),
    id: PageDesignId,
    /** The name the design screen and pickers show. */
    name: SingleLine,
    /** A key of `PAGE_DESIGN_PRESETS`; another one is a validation error (`unknown-preset`). */
    preset: ConfigKey,
    /**
     * An organisation's own Typst template (#396), by its folder (`templates/<id>/manual.typ`,
     * `designTemplatePath`): it lays the PDF out in place of the preset, reading the design's
     * settings and regions as data. The preset still decides which regions the design has. None:
     * the preset's layout.
     */
    template: DesignTemplateId.optional(),
    page: z
      .strictObject({
        size: z.enum(PAGE_SIZES).default('a4'),
        margins: z
          .strictObject({
            top: Millimetres,
            right: Millimetres,
            bottom: Millimetres,
            left: Millimetres,
          })
          .default(DEFAULT_MARGINS),
        /** Double-sided print: left and right pages (`even` running regions; margins mirrored). */
        doubleSided: z.boolean().default(false),
      })
      .default({ size: 'a4', margins: DEFAULT_MARGINS, doubleSided: false }),
    colours: z.strictObject({
      primary: DesignColour,
      accent: DesignColour,
      text: DesignColour,
    }),
    /**
     * Font files of the design (TrueType, OpenType, WOFF or WOFF2); Geist where none is given. Using
     * an organisation's own fonts needs `embeddingAllowed`: someone confirmed the licence
     * allows embedding them in PDFs (#389).
     */
    fonts: z
      .strictObject({
        body: DesignFont.optional(),
        heading: DesignFont.optional(),
        embeddingAllowed: z.boolean().default(false),
      })
      .default({ embeddingAllowed: false }),
    /** The logo, for a light background and, optionally, a dark one (a preset's band). */
    logo: z
      .strictObject({ light: AssetRef, dark: AssetRef.optional() })
      .optional(),
    /** The title page's data fields shown, in this order. */
    titlePage: z
      .strictObject({
        fields: z
          .array(z.enum(TITLE_PAGE_FIELDS))
          .refine(
            (fields) => new Set(fields).size === fields.length,
            'each field once',
          ),
      })
      .default({ fields: ['title', 'variant', 'language', 'release', 'date'] }),
    /** Region text by the preset's slot (`regionSlots`), each in its languages. */
    regions: z
      .record(ConfigKey, Translatable(RegionBlocks))
      .superRefine((regions, ctx) => {
        // The tables of every region in every language together (#686), as a module's.
        let cells = 0;
        for (const text of Object.values(regions)) {
          const lists = Array.isArray(text) ? [text] : Object.values(text);
          for (const blocks of lists) {
            for (const { node } of walk(blocks as RegionBlocks)) {
              if ('type' in node && node.type === 'table') {
                cells += node.rows.length * node.columns.length;
              }
            }
          }
        }
        const problem = tablesTooLarge(cells);
        if (problem) {
          ctx.addIssue({
            code: 'custom',
            message: problem,
            params: { code: TABLE_TOO_LARGE },
          });
        }
      })
      .default({}),
    /**
     * The translation record of each target language's region text (#568), by language: what
     * the translation status compares the source text with. None: no translation was imported.
     */
    translations: z
      .record(LanguageKey, DesignTranslationRecord)
      .refine(
        (langs) => Object.keys(langs).length <= MAX_LANGUAGES,
        `at most ${MAX_LANGUAGES} languages`,
      )
      .optional(),
    /**
     * The cover image: the first of `variants` whose condition the manual's variant meets, else
     * `default`; none: no cover image.
     */
    coverImage: z
      .strictObject({
        default: CoverImage.optional(),
        variants: z
          .array(CoverImage.extend({ when: Condition }))
          .max(100)
          .default([]),
      })
      .optional(),
    /**
     * The back page (imprint); none: the manual has no back page. It prints the configuration's
     * manufacturer details (#395, `manufacturer`), the copyright, the document number and the
     * date; `position` puts it last or on the inside of the title page.
     */
    backPage: z
      .strictObject({
        position: z.enum(BACK_PAGE_POSITIONS).default('last'),
        copyright: Translatable(SingleLine).optional(),
        documentNumber: z.boolean().default(true),
        date: z.boolean().default(true),
      })
      .optional(),
    header: RunningRegion.default({
      default: {
        left: [{ type: 'placeholder', key: 'title' }],
        right: [{ type: 'placeholder', key: 'variant' }],
      },
    }),
    footer: RunningRegion.default({
      default: {
        left: [{ type: 'placeholder', key: 'language' }],
        right: [{ type: 'placeholder', key: 'page' }],
      },
    }),
    headings: z
      .strictObject({
        /** Per level, from level 1; levels past the list are numbered as its last entry. */
        numbering: z
          .array(z.enum(HEADING_NUMBERINGS))
          .min(1)
          .max(MAX_DESIGN_HEADING_LEVELS)
          .default(['decimal']),
        /** Per level, from level 1, a step of `TYPE_SCALE`; levels past the list take its last. */
        sizes: z
          .array(z.enum(TYPE_SCALE_STEPS))
          .min(1)
          .max(MAX_DESIGN_HEADING_LEVELS)
          .default(['3xl', '2xl', 'xl', 'base']),
        colour: z.enum(DESIGN_COLOUR_ROLES).default('text'),
        pageBreakBeforeLevel1: z.boolean().default(true),
      })
      .default({
        numbering: ['decimal'],
        sizes: ['3xl', '2xl', 'xl', 'base'],
        colour: 'text',
        pageBreakBeforeLevel1: true,
      }),
    body: z
      .strictObject({
        /** Points. */
        fontSize: z.number().min(6).max(24).default(10),
        /** A multiple of the font size. */
        lineHeight: z.number().min(1).max(3).default(1.45),
        /** Points between paragraphs. */
        paragraphSpacing: z.number().min(0).max(36).default(7),
        columns: z.union([z.literal(1), z.literal(2)]).default(1),
      })
      .default({
        fontSize: 10,
        lineHeight: 1.45,
        paragraphSpacing: 7,
        columns: 1,
      }),
    tables: z
      .strictObject({
        headerTint: z.boolean().default(true),
        borders: z.enum(TABLE_BORDERS).default('horizontal'),
        zebra: z.boolean().default(false),
      })
      .default({ headerTint: true, borders: 'horizontal', zebra: false }),
    steps: z
      .strictObject({ marker: z.enum(STEP_MARKERS).default('filled-circle') })
      .default({ marker: 'filled-circle' }),
    notes: z
      .strictObject({ style: z.enum(NOTE_STYLES).default('tinted') })
      .default({ style: 'tinted' }),
    safety: z
      .strictObject({ standard: z.enum(SAFETY_STANDARDS).default('ansi-z535') })
      .default({ standard: 'ansi-z535' }),
  })
  .meta({ id: 'PageDesign' });
export type PageDesign = z.output<typeof PageDesign>;
/** A design as a request sends it: settings with defaults may be left out. */
export type PageDesignInput = z.input<typeof PageDesign>;

/**
 * The built-in design (`builtin`), which a manual gets when neither it nor the configuration
 * names one: the classic preset on A4, Geist, the title page's fields of the built-in
 * template. Its colours are neutral; a project's own design replaces it.
 */
export const DEFAULT_PAGE_DESIGN: PageDesign = {
  ...PageDesign.parse({
    schemaVersion: PAGE_DESIGN_SCHEMA_VERSION,
    id: 'built-in',
    name: 'Built-in',
    preset: 'classic',
    colours: { primary: '#1f4e79', accent: '#2563eb', text: '#1f2328' },
  }),
  id: BUILTIN_PAGE_DESIGN_ID,
};

/** Every text of a design written per language, by where it is (a dotted path), in a stable order. */
function localizedTexts(
  design: PageDesign,
): { path: string; langs: string[] }[] {
  const out: { path: string; langs: string[] }[] = [];
  const add = (path: string, value: Translatable<unknown> | undefined) => {
    if (value !== undefined && isLocalized(value))
      out.push({ path, langs: Object.keys(value) });
  };
  for (const [slot, text] of Object.entries(design.regions)) {
    add(`regions.${slot}`, text);
  }
  for (const where of ['header', 'footer'] as const) {
    for (const page of ['default', 'first', 'even'] as const) {
      const slots = design[where][page];
      if (!slots) continue;
      for (const place of ['left', 'centre', 'right'] as const) {
        add(`${where}.${page}.${place}`, slots[place]);
      }
    }
  }
  add('coverImage.default.alt', design.coverImage?.default?.alt);
  design.coverImage?.variants.forEach((v, i) =>
    add(`coverImage.variants.${i}.alt`, v.alt),
  );
  add('backPage.copyright', design.backPage?.copyright);
  return out;
}

/** The placeholders whose value is the release's (#395): its name and its date. */
const RELEASE_KEYS: ReadonlySet<string> = new Set(['release', 'date']);

/**
 * Whether a manual's PDF in `design` prints anything of the release it is made for (#395): its
 * name or date as a title page field, as a placeholder in any text (any language), or the date on
 * the back page. Such a PDF differs from release to release even when its content does not, so a
 * release never reuses an earlier release's file of it.
 */
export function pageDesignShowsRelease(design: PageDesign): boolean {
  if (design.titlePage.fields.some((f) => RELEASE_KEYS.has(f))) return true;
  if (design.backPage?.date) return true;
  const shows = (content: readonly Inline[]) =>
    content.some((n) => n.type === 'placeholder' && RELEASE_KEYS.has(n.key));
  for (const text of Object.values(design.regions)) {
    for (const [, blocks] of languagesOf(text as Translatable<RegionBlocks>)) {
      for (const { node } of walk(blocks)) {
        if (ownInlineContent(node).some(shows)) return true;
      }
    }
  }
  for (const where of ['header', 'footer'] as const) {
    for (const page of ['default', 'first', 'even'] as const) {
      const places = design[where][page];
      if (!places) continue;
      for (const place of ['left', 'centre', 'right'] as const) {
        const text = places[place];
        if (text === undefined) continue;
        if (languagesOf(text).some(([, content]) => shows(content)))
          return true;
      }
    }
  }
  return false;
}

/** A text's versions with their language (`undefined`: the text for every language). */
function languagesOf<T>(text: Translatable<T>): [string | undefined, T][] {
  return isLocalized(text) ? Object.entries(text) : [[undefined, text]];
}

/**
 * How one language's text of a region differs from another's (#554): the IDs of the blocks and
 * items it has that `other` has not (`extra`), and those it lacks (`missing`), each sorted.
 * Translations of a region keep its block IDs, as a module's do; undefined when both hold the
 * same IDs.
 */
export function regionBlocksDiffer(
  blocks: readonly Block[],
  other: readonly Block[],
): { extra: string[]; missing: string[] } | undefined {
  const ids = (b: readonly Block[]) =>
    new Set([...walk(b)].map(({ node }) => node.id));
  const own = ids(blocks);
  const theirs = ids(other);
  const extra = [...own].filter((id) => !theirs.has(id)).sort();
  const missing = [...theirs].filter((id) => !own.has(id)).sort();
  return extra.length === 0 && missing.length === 0
    ? undefined
    : { extra, missing };
}

/** `regionBlocksDiffer` in words: what the `lang` text has and lacks against the `against` text. */
export function regionDifferenceMessage(
  lang: string,
  against: string,
  { extra, missing }: { extra: readonly string[]; missing: readonly string[] },
): string {
  const has =
    extra.length > 0
      ? `has blocks the "${against}" text has not (${extra.join(', ')})`
      : undefined;
  const lacks =
    missing.length > 0
      ? has
        ? `lacks some it has (${missing.join(', ')})`
        : `lacks blocks the "${against}" text has (${missing.join(', ')})`
      : undefined;
  return `the "${lang}" text ${[has, lacks].filter(Boolean).join(' and ')}`;
}

/** Every asset a design refers to, with what it is: logos, fonts and cover images. */
export interface PageDesignAsset {
  asset: string;
  kind: 'logo' | 'font' | 'cover-image' | 'image' | 'attachment';
  /** Where the design names it, e.g. `fonts.body.bold`; a region's block after `#` (`regions.back.en#map`). */
  path: string;
}

/** The assets `design` refers to, in a stable order (one entry per place it is named). */
export function pageDesignAssets(design: PageDesign): PageDesignAsset[] {
  const out: PageDesignAsset[] = [];
  if (design.logo) {
    out.push({ asset: design.logo.light, kind: 'logo', path: 'logo.light' });
    if (design.logo.dark)
      out.push({ asset: design.logo.dark, kind: 'logo', path: 'logo.dark' });
  }
  for (const role of ['body', 'heading'] as const) {
    const font = design.fonts[role];
    if (!font) continue;
    for (const style of ['regular', 'bold', 'italic', 'boldItalic'] as const) {
      const asset = font[style];
      if (asset)
        out.push({ asset, kind: 'font', path: `fonts.${role}.${style}` });
    }
  }
  if (design.coverImage?.default) {
    out.push({
      asset: design.coverImage.default.asset,
      kind: 'cover-image',
      path: 'coverImage.default',
    });
  }
  design.coverImage?.variants.forEach((v, i) =>
    out.push({
      asset: v.asset,
      kind: 'cover-image',
      path: `coverImage.variants.${i}`,
    }),
  );
  for (const slot of Object.keys(design.regions).sort()) {
    const text = design.regions[slot] as Translatable<RegionBlocks>;
    const versions: [string, RegionBlocks][] = isLocalized(text)
      ? Object.keys(text)
          .sort()
          .map((lang) => [
            `regions.${slot}.${lang}`,
            text[lang] as RegionBlocks,
          ])
      : [[`regions.${slot}`, text]];
    for (const [path, blocks] of versions) {
      for (const { kind, node } of walk(blocks)) {
        if (kind !== 'block') continue;
        if (node.type !== 'image' && node.type !== 'attachment') continue;
        out.push({
          asset: node.asset,
          kind: node.type,
          path: `${path}#${node.id}`,
        });
      }
    }
  }
  return out;
}

/**
 * The design's own template against the templates the content repository has (#396, their IDs):
 * `unknown-template` (an error, at `template`) when it names one that is not there; its preset
 * lays the PDF out then.
 */
export function pageDesignTemplateIssues(
  design: Pick<PageDesign, 'template'>,
  templates: readonly string[],
): PageDesignIssue[] {
  const id = design.template;
  if (id === undefined || templates.includes(id)) return [];
  return [
    {
      severity: 'error',
      code: 'unknown-template',
      message: `no template "${id}" (${designTemplatePath(id)}); the preset lays the PDF out`,
      at: 'template',
    },
  ];
}

/** A page design's validation issue: `at` is where in the design (`regions.footer`, `colours.accent`). */
export interface PageDesignIssue {
  severity: 'error' | 'warning';
  code: PageDesignIssueCode;
  message: string;
  /** Where in the design, as a dotted path (`regions.footer.en`, `colours.primary`). */
  at?: string;
  /** The block or item in a region's text, when the issue is about one. */
  block?: string;
}

export type PageDesignIssueCode =
  | 'unknown-preset'
  | 'unknown-region'
  | 'unknown-placeholder'
  | 'unknown-language'
  | 'low-contrast'
  | 'missing-cover-image'
  | 'fonts-not-confirmed'
  | 'missing-manufacturer'
  | 'missing-asset'
  | 'invalid-font'
  /** The design names an own template the content repository does not have (#396). */
  | 'unknown-template'
  /** A region's text in one language has other block IDs than the source language's (#554). */
  | 'region-languages-differ'
  | Exclude<IssueCode, 'placeholder-in-module'>;

/**
 * Checks a design against the configuration and its own rules: the preset is one of
 * `PAGE_DESIGN_PRESETS` (`unknown-preset`), every region is one of its slots (`unknown-region`),
 * every placeholder one of `PLACEHOLDER_KEYS` (`unknown-placeholder`), every language of its
 * text configured (`unknown-language`), its region text's text attributes, safety symbols and
 * variant conditions configured (as in a module), and the cover image rules' conditions too.
 * Warnings: a colour below 4.5:1 against the white page (`low-contrast`), an image-led preset
 * without a cover image (`missing-cover-image`), fonts whose embedding licence nobody confirmed
 * (`fonts-not-confirmed`, an error), a back page while the configuration has no manufacturer
 * details (`missing-manufacturer`, #395), a region whose text in one language has other block IDs than the
 * source language's, else the first language's (`region-languages-differ`, #554). Whether its
 * assets exist, and are fonts where they should be, is
 * `pageDesignAssetIssues`.
 */
export function validatePageDesign(
  design: PageDesign,
  config: ProjectConfig,
): PageDesignIssue[] {
  const issues: PageDesignIssue[] = [];
  const add = (
    severity: PageDesignIssue['severity'],
    code: PageDesignIssueCode,
    message: string,
    at?: string,
    block?: string,
  ) =>
    issues.push({
      severity,
      code,
      message,
      ...(at !== undefined && { at }),
      ...(block !== undefined && { block }),
    });

  if (!isPageDesignPreset(design.preset)) {
    add(
      'error',
      'unknown-preset',
      `"${design.preset}" is no layout preset; one of ${PAGE_DESIGN_PRESET_IDS.join(', ')}`,
      'preset',
    );
  }
  const slots = regionSlots(design.preset);
  const configured = new Set([
    config.languages.source,
    ...config.languages.targets,
  ]);

  for (const { path, langs } of localizedTexts(design)) {
    for (const lang of langs) {
      if (!configured.has(lang)) {
        add(
          'error',
          'unknown-language',
          `language "${lang}" is neither the source nor a target language`,
          `${path}.${lang}`,
        );
      }
    }
  }

  for (const [slot, text] of Object.entries(design.regions)) {
    if (!slots.includes(slot)) {
      add(
        'error',
        'unknown-region',
        `"${slot}" is no region of the ${design.preset} preset; one of ${slots.join(', ')}`,
        `regions.${slot}`,
      );
    }
    if (isLocalized(text)) {
      // Each language's text keeps the source language's block IDs (else the first language's).
      const langs = Object.keys(text).sort();
      const against = Object.hasOwn(text, config.languages.source)
        ? config.languages.source
        : langs[0];
      const base = against === undefined ? undefined : text[against];
      for (const lang of langs) {
        if (lang === against || base === undefined) continue;
        const differ = regionBlocksDiffer(text[lang] as RegionBlocks, base);
        if (!differ) continue;
        add(
          'warning',
          'region-languages-differ',
          regionDifferenceMessage(lang, against as string, differ),
          `regions.${slot}.${lang}`,
        );
      }
    }
    for (const [lang, blocks] of languagesOf(text)) {
      for (const issue of blockIssues(blocks, config, {
        placeholders: 'check',
      })) {
        add(
          issue.severity,
          issue.code as PageDesignIssueCode,
          issue.message,
          lang === undefined ? `regions.${slot}` : `regions.${slot}.${lang}`,
          issue.at,
        );
      }
    }
  }

  for (const where of ['header', 'footer'] as const) {
    for (const page of ['default', 'first', 'even'] as const) {
      const places = design[where][page];
      if (!places) continue;
      for (const place of ['left', 'centre', 'right'] as const) {
        const text = places[place];
        if (text === undefined) continue;
        for (const [lang, content] of languagesOf(text)) {
          const at = `${where}.${page}.${place}${lang === undefined ? '' : `.${lang}`}`;
          for (const node of content) {
            if (node.type === 'placeholder' && !isPlaceholderKey(node.key)) {
              add(
                'error',
                'unknown-placeholder',
                `"${node.key}" is no placeholder; one of ${PLACEHOLDER_KEYS.join(', ')}`,
                at,
              );
            } else if (
              node.type === 'attribute' &&
              !config.textAttributes.some((a) => a.id === node.name)
            ) {
              add(
                'error',
                'unknown-text-attribute',
                `text attribute "${node.name}" is not configured`,
                at,
              );
            }
          }
        }
      }
    }
  }

  design.coverImage?.variants.forEach((rule, i) => {
    for (const issue of conditionIssues(rule.when, config)) {
      add(
        issue.severity,
        issue.code as PageDesignIssueCode,
        issue.message,
        `coverImage.variants.${i}.when`,
      );
    }
  });

  for (const role of ['primary', 'accent', 'text'] as const) {
    const ratio = contrastRatio(design.colours[role], '#ffffff');
    if (ratio < MIN_TEXT_CONTRAST) {
      add(
        'warning',
        'low-contrast',
        `the ${role} colour has a contrast of ${ratio.toFixed(2)}:1 against the white page, below ${MIN_TEXT_CONTRAST}:1: text in it is hard to read`,
        `colours.${role}`,
      );
    }
  }

  if (
    isPageDesignPreset(design.preset) &&
    PAGE_DESIGN_PRESETS[design.preset].coverImage &&
    design.coverImage?.default === undefined &&
    (design.coverImage?.variants.length ?? 0) === 0
  ) {
    add(
      'warning',
      'missing-cover-image',
      `the ${design.preset} preset shows a cover image, and the design has none`,
      'coverImage',
    );
  }

  if (
    (design.fonts.body !== undefined || design.fonts.heading !== undefined) &&
    !design.fonts.embeddingAllowed
  ) {
    add(
      'error',
      'fonts-not-confirmed',
      "the design's fonts are embedded in every PDF: confirm their licence allows it (fonts.embeddingAllowed)",
      'fonts.embeddingAllowed',
    );
  }

  if (design.backPage && config.manufacturer === undefined) {
    add(
      'warning',
      'missing-manufacturer',
      'the back page has no manufacturer to print: the project configuration has no manufacturer details (manufacturer)',
      'backPage',
    );
  }
  return issues;
}

/** What `pageDesignAssetIssues` needs to know of an asset; `undefined`: it is not stored. */
export interface StoredAsset {
  /** The file's first bytes (at least 4 for a font), to tell its format. */
  head: Uint8Array;
}

/**
 * The design's assets checked against the store: each one named must be stored
 * (`missing-asset`, an error) and a font must be TrueType, OpenType, WOFF or WOFF2 (`invalid-font`, an
 * error). `stat` reads one asset (`sha256:<hash>`); it is asked once per asset.
 */
export async function pageDesignAssetIssues(
  design: PageDesign,
  stat: (asset: string) => Promise<StoredAsset | undefined>,
): Promise<PageDesignIssue[]> {
  const issues: PageDesignIssue[] = [];
  const stats = new Map<string, Promise<StoredAsset | undefined>>();
  for (const { asset, kind, path } of pageDesignAssets(design)) {
    let pending = stats.get(asset);
    if (!pending) {
      pending = stat(asset);
      stats.set(asset, pending);
    }
    const stored = await pending;
    if (!stored) {
      issues.push({
        severity: 'error',
        code: 'missing-asset',
        message: `the ${kind === 'cover-image' ? 'cover image' : kind === 'attachment' ? 'attached file' : kind} ${asset} is not stored`,
        at: path,
      });
    } else if (kind === 'font' && fontFormatOf(stored.head) === undefined) {
      issues.push({
        severity: 'error',
        code: 'invalid-font',
        message: `${asset} is no TrueType, OpenType, WOFF or WOFF2 font file`,
        at: path,
      });
    }
  }
  return issues;
}
