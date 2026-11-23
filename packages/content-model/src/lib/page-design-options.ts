/**
 * A page design's fixed choices (#390): the layout presets and their regions, page sizes, the
 * title page's data fields, and the settings' allowed values, with the rules that need no schema
 * (colour contrast, font files). Schema-free, for `@openfolia/content-model/core`: the design screen
 * offers exactly these.
 */

/**
 * The layout presets (#389): **classic** (logo top, title block, data fields, footer),
 * **image-led** (a large cover image, the title over a band) and **minimal** (title and fields
 * only, lots of white space). Each has fixed regions on its title page (`slots`), named blocks of
 * text a design fills in; `coverImage` says the preset shows a cover image.
 */
export const PAGE_DESIGN_PRESETS = {
  classic: {
    slots: ['above-title', 'below-fields', 'footer'],
    coverImage: false,
  },
  'image-led': { slots: ['band', 'footer'], coverImage: true },
  minimal: { slots: ['footer'], coverImage: false },
} as const satisfies Record<
  string,
  { slots: readonly string[]; coverImage: boolean }
>;
export type PageDesignPreset = keyof typeof PAGE_DESIGN_PRESETS;
export const PAGE_DESIGN_PRESET_IDS = Object.keys(
  PAGE_DESIGN_PRESETS,
) as PageDesignPreset[];

/** The back page's regions, the same in every preset: its main text and its foot. */
export const BACK_PAGE_SLOTS = ['back', 'back-footer'] as const;

/**
 * Where the back page goes (#395): `last`, the manual's last page (on an even page printed
 * double-sided), or `inside-cover`, the page right after the title page (its back, printed
 * double-sided), before the contents.
 */
export const BACK_PAGE_POSITIONS = ['last', 'inside-cover'] as const;
export type BackPagePosition = (typeof BACK_PAGE_POSITIONS)[number];

/** Whether `id` names a preset. */
export function isPageDesignPreset(id: unknown): id is PageDesignPreset {
  return typeof id === 'string' && Object.hasOwn(PAGE_DESIGN_PRESETS, id);
}

/** The regions a design with `preset` may fill: its title page's and the back page's. */
export function regionSlots(preset: string): readonly string[] {
  return isPageDesignPreset(preset)
    ? [...PAGE_DESIGN_PRESETS[preset].slots, ...BACK_PAGE_SLOTS]
    : BACK_PAGE_SLOTS;
}

/** Page sizes (#389: A4 and US Letter; #668: A5, for a short document such as a safety leaflet), all portrait. */
export const PAGE_SIZES = ['a4', 'us-letter', 'a5'] as const;
export type PageSize = (typeof PAGE_SIZES)[number];

/** Each page size's width and height in millimetres (portrait), for a preview's shape. */
export const PAGE_SIZE_MM: Readonly<
  Record<PageSize, { width: number; height: number }>
> = {
  a4: { width: 210, height: 297 },
  'us-letter': { width: 215.9, height: 279.4 },
  a5: { width: 148, height: 210 },
};

/** The data fields a title page can show (#389), in the order a design lists them. */
export const TITLE_PAGE_FIELDS = [
  'title',
  'subtitle',
  'product',
  'variant',
  'product-version',
  'language',
  'release',
  'date',
  'document-number',
  'revision-number',
  'audience',
] as const;
export type TitlePageField = (typeof TITLE_PAGE_FIELDS)[number];

/** A heading level's numbering: `decimal` (1.2.3) or none. */
export const HEADING_NUMBERINGS = ['decimal', 'none'] as const;
export type HeadingNumbering = (typeof HEADING_NUMBERINGS)[number];

/** The type scale heading sizes are picked from, each a multiple of the body text size. */
export const TYPE_SCALE: Readonly<Record<TypeScaleStep, number>> = {
  base: 1,
  lg: 1.125,
  xl: 1.25,
  '2xl': 1.5,
  '3xl': 2,
};
export const TYPE_SCALE_STEPS = ['base', 'lg', 'xl', '2xl', '3xl'] as const;
export type TypeScaleStep = (typeof TYPE_SCALE_STEPS)[number];

/** The heading levels a design sets (a group is one level, a module one deeper, its sections each one more). */
export const MAX_DESIGN_HEADING_LEVELS = 6;

/** The design's colours a setting may pick from (never a free colour there). */
export const DESIGN_COLOUR_ROLES = ['text', 'primary', 'accent'] as const;
export type DesignColourRole = (typeof DESIGN_COLOUR_ROLES)[number];

/** Table borders: none, horizontal rules between rows, or a full grid. */
export const TABLE_BORDERS = ['none', 'horizontal', 'grid'] as const;
export type TableBorders = (typeof TABLE_BORDERS)[number];

/** A procedure step's marker: its number in a filled circle, or the plain number. */
export const STEP_MARKERS = ['filled-circle', 'number'] as const;
export type StepMarker = (typeof STEP_MARKERS)[number];

/** A note's (admonition's) style: a tinted box or a frame. */
export const NOTE_STYLES = ['tinted', 'framed'] as const;
export type NoteStyle = (typeof NOTE_STYLES)[number];

/**
 * The standard a safety notice is laid out to: ANSI Z535 (the signal word panel on top) or
 * ISO 3864 / EN 82079-1 (the symbol beside the text). The colours are the standard's, never a
 * design's: `SAFETY_FIXED_SETTINGS` says so, for the design screen to show.
 */
export const SAFETY_STANDARDS = ['ansi-z535', 'iso-3864'] as const;
export type SafetyStandard = (typeof SAFETY_STANDARDS)[number];

/**
 * What a page design cannot change, because the safety standards fix it: the signal word
 * colours (ANSI Z535, ISO 3864), the signal words (the output labels in the manual's language)
 * and the safety symbols (the configured artwork). The design screen lists them read-only, each
 * with its reason as a translated text of its own.
 */
export const SAFETY_FIXED_SETTINGS = [
  'safety-colours',
  'signal-words',
  'safety-symbols',
] as const;

/** The least contrast a colour needs against the page for text (WCAG 2 AA, normal text). */
export const MIN_TEXT_CONTRAST = 4.5;

/** A colour as a design stores it: `#rrggbb`, lowercase. */
export const COLOUR_PATTERN = /^#[0-9a-f]{6}$/;

/** The relative luminance (WCAG 2) of a `#rrggbb` colour. */
export function relativeLuminance(colour: string): number {
  const channel = (offset: number) => {
    const value = parseInt(colour.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

/** The contrast ratio (WCAG 2) of two `#rrggbb` colours, 1 to 21. */
export function contrastRatio(a: string, b: string): number {
  const [light, dark] = [relativeLuminance(a), relativeLuminance(b)].sort(
    (x, y) => y - x,
  ) as [number, number];
  return (light + 0.05) / (dark + 0.05);
}

/**
 * The font formats a design takes: TrueType, OpenType (CFF), WOFF and WOFF2 (#555; the PDF
 * renderer decodes the last two to TrueType or OpenType).
 */
export type FontFormat = 'ttf' | 'otf' | 'woff' | 'woff2';

/**
 * A font file's format by its first bytes: TrueType (`00 01 00 00` or `true`), OpenType with
 * CFF outlines (`OTTO`), WOFF (`wOFF`) or WOFF2 (`wOF2`); `undefined` for anything else (a
 * collection, not a font).
 */
export function fontFormatOf(bytes: Uint8Array): FontFormat | undefined {
  if (bytes.length < 4) return undefined;
  const tag = String.fromCharCode(
    bytes[0] as number,
    bytes[1] as number,
    bytes[2] as number,
    bytes[3] as number,
  );
  if (tag === '\u0000\u0001\u0000\u0000' || tag === 'true') return 'ttf';
  if (tag === 'OTTO') return 'otf';
  if (tag === 'wOFF') return 'woff';
  if (tag === 'wOF2') return 'woff2';
  return undefined;
}

/** A design's text in every language, or by language (a record by language tag). */
export type Translatable<T> = T | Record<string, T>;

/** Whether a design's text is written per language (a record), not the same in all. */
export function isLocalized<T>(
  text: Translatable<T>,
): text is Record<string, T> {
  return typeof text === 'object' && text !== null && !Array.isArray(text);
}

/**
 * A design's text in `lang`: the text for every language, else `lang`'s own, else the source
 * language's (`fallback: true`), else none. `lang` names the language the text is in (absent
 * for text the same in all).
 */
export function textInLanguage<T>(
  text: Translatable<T> | undefined,
  lang: string,
  source: string,
): { value: T; lang?: string; fallback: boolean } | undefined {
  if (text === undefined) return undefined;
  if (!isLocalized(text)) return { value: text, fallback: false };
  if (Object.hasOwn(text, lang))
    return { value: text[lang] as T, lang, fallback: false };
  if (Object.hasOwn(text, source))
    return { value: text[source] as T, lang: source, fallback: true };
  return undefined;
}
