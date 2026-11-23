import {
  COLOUR_PATTERN,
  contrastRatio,
  isLocalized,
  MIN_TEXT_CONTRAST,
  PAGE_DESIGN_PRESET_IDS,
  PAGE_DESIGN_PRESETS,
  textInLanguage,
  TITLE_PAGE_FIELDS,
  type PageDesignPreset,
  type PlaceholderKey,
  type TitlePageField,
} from '@openfolia/content-model/core';

import type { Schema } from '../../api';

/** A page design as the API reads and saves it (`design/<id>.yaml`, every default filled in). */
export type PageDesign = Schema<'PageDesign'>;
export type DesignColours = PageDesign['colours'];
export type ColourRole = keyof DesignColours;
export type RunningRegion = PageDesign['header'];
export type RunningSlots = RunningRegion['default'];
export type RunningPlace = keyof RunningSlots;
/** A running header's or footer's variant: every page, the first page, left (even) pages. */
export type RunningVariant = keyof RunningRegion;
/** One place's text: inline content, the same in every language or per language. */
export type RunningText = NonNullable<RunningSlots['left']>;
/** A problem the API found checking a design (`meta.issues`). */
export type DesignIssue = Schema<'Issue'>;

export const PRESETS: readonly PageDesignPreset[] = PAGE_DESIGN_PRESET_IDS;
export const COLOUR_ROLES: readonly ColourRole[] = [
  'primary',
  'accent',
  'text',
];
export const RUNNING_PLACES: readonly RunningPlace[] = [
  'left',
  'centre',
  'right',
];
/** The heading levels the screen sets (deeper levels follow the last, as the renderer does). */
export const HEADING_LEVELS = 4;
/** The most a design ID takes (a module ID's limit). */
export const DESIGN_ID_MAX = 64;
export const DESIGN_NAME_MAX = 200;

/** The page every design starts from on the screen: a new design's settings. */
export function newDesign(
  id: string,
  name: string,
  preset: PageDesignPreset,
): PageDesign {
  return {
    schemaVersion: 1,
    id,
    name,
    preset,
    page: {
      size: 'a4',
      margins: { top: 26, right: 22, bottom: 24, left: 22 },
      doubleSided: false,
    },
    colours: { primary: '#1f4e79', accent: '#b45309', text: '#1f2328' },
    fonts: { embeddingAllowed: false },
    titlePage: { fields: ['title', 'variant', 'language', 'release', 'date'] },
    regions: {},
    header: {
      default: {
        left: [{ type: 'placeholder', key: 'title' }],
        right: [{ type: 'placeholder', key: 'variant' }],
      },
    },
    footer: {
      default: {
        left: [{ type: 'placeholder', key: 'language' }],
        right: [{ type: 'placeholder', key: 'page' }],
      },
    },
    headings: {
      numbering: ['decimal'],
      sizes: ['3xl', '2xl', 'xl', 'base'],
      colour: 'text',
      pageBreakBeforeLevel1: true,
    },
    body: { fontSize: 10, lineHeight: 1.45, paragraphSpacing: 7, columns: 1 },
    tables: { headerTint: true, borders: 'horizontal', zebra: false },
    steps: { marker: 'filled-circle' },
    notes: { style: 'tinted' },
    safety: { standard: 'ansi-z535' },
  } as PageDesign;
}

/** The ID a name suggests: lowercase words joined by hyphens (a module ID's form). */
export function idFromName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, DESIGN_ID_MAX)
    .replace(/-+$/, '');
}

/** A design ID as the content model takes it: a slug, never `builtin`. */
export const DESIGN_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Why `id` cannot be a new design's ID (a translation key), or null. */
export function designIdProblem(
  id: string,
  taken: readonly string[],
): string | null {
  if (!id) return 'editor.admin.pageDesigns.create.idRequired';
  if (id.length > DESIGN_ID_MAX || !DESIGN_ID.test(id)) {
    return 'editor.admin.pageDesigns.create.idInvalid';
  }
  if (id === 'builtin') return 'editor.admin.pageDesigns.create.idReserved';
  if (taken.includes(id)) return 'editor.admin.pageDesigns.create.idTaken';
  return null;
}

/** Whether a preset shows a cover image (it then needs one: `missing-cover-image`). */
export function presetShowsCover(preset: string): boolean {
  return (
    Object.hasOwn(PAGE_DESIGN_PRESETS, preset) &&
    PAGE_DESIGN_PRESETS[preset as PageDesignPreset].coverImage
  );
}

/** A colour typed by a person as the design stores it (`#rrggbb`, lowercase), or null. */
export function normalColour(typed: string): string | null {
  let value = typed.trim().toLowerCase();
  if (!value.startsWith('#')) value = `#${value}`;
  if (/^#[0-9a-f]{3}$/.test(value)) {
    value = `#${[...value.slice(1)].map((c) => c + c).join('')}`;
  }
  return COLOUR_PATTERN.test(value) ? value : null;
}

/** A colour's contrast against the white page, and whether text in it is readable (WCAG AA). */
export function contrastOnWhite(colour: string): {
  ratio: number;
  enough: boolean;
} {
  const ratio = contrastRatio(colour, '#ffffff');
  return {
    ratio: Math.round(ratio * 10) / 10,
    enough: ratio >= MIN_TEXT_CONTRAST,
  };
}

/** The title page's fields in the design's order, the shown ones first, then the rest. */
export function fieldRows(
  shown: readonly TitlePageField[],
): readonly { id: TitlePageField; label: string; shown: boolean }[] {
  const rest = TITLE_PAGE_FIELDS.filter((f) => !shown.includes(f));
  return [
    ...shown.map((id) => ({ id, label: FIELD_LABELS[id], shown: true })),
    ...rest.map((id) => ({ id, label: FIELD_LABELS[id], shown: false })),
  ];
}

/** The fields shown, in order, from the rows a person ordered and switched. */
export function shownFields(
  rows: readonly { id: TitlePageField; shown: boolean }[],
): TitlePageField[] {
  return rows.filter((r) => r.shown).map((r) => r.id);
}

export const FIELD_LABELS: Readonly<Record<TitlePageField, string>> = {
  title: 'editor.admin.pageDesigns.fields.names.title',
  subtitle: 'editor.admin.pageDesigns.fields.names.subtitle',
  product: 'editor.admin.pageDesigns.fields.names.product',
  variant: 'editor.admin.pageDesigns.fields.names.variant',
  'product-version': 'editor.admin.pageDesigns.fields.names.productVersion',
  language: 'editor.admin.pageDesigns.fields.names.language',
  release: 'editor.admin.pageDesigns.fields.names.release',
  date: 'editor.admin.pageDesigns.fields.names.date',
  'document-number': 'editor.admin.pageDesigns.fields.names.documentNumber',
  'revision-number': 'editor.admin.pageDesigns.fields.names.revisionNumber',
  audience: 'editor.admin.pageDesigns.fields.names.audience',
};

// --- Running header and footer ---

/** What a place of the running header or footer shows, as the screen offers it. */
export const RUNNING_CHOICES = [
  'none',
  'title',
  'chapter',
  'page',
  'page-of',
  'document-number',
  'release',
  'language',
  'variant',
  'product',
  'date',
  'manufacturer-name',
] as const;
export type RunningChoice = (typeof RUNNING_CHOICES)[number] | 'custom';

export const RUNNING_CHOICE_LABELS: Readonly<Record<RunningChoice, string>> = {
  none: 'editor.admin.pageDesigns.running.choices.none',
  title: 'editor.admin.pageDesigns.running.choices.title',
  chapter: 'editor.admin.pageDesigns.running.choices.chapter',
  page: 'editor.admin.pageDesigns.running.choices.page',
  'page-of': 'editor.admin.pageDesigns.running.choices.pageOf',
  'document-number': 'editor.admin.pageDesigns.running.choices.documentNumber',
  release: 'editor.admin.pageDesigns.running.choices.release',
  language: 'editor.admin.pageDesigns.running.choices.language',
  variant: 'editor.admin.pageDesigns.running.choices.variant',
  product: 'editor.admin.pageDesigns.running.choices.product',
  date: 'editor.admin.pageDesigns.running.choices.date',
  'manufacturer-name':
    'editor.admin.pageDesigns.running.choices.manufacturerName',
  custom: 'editor.admin.pageDesigns.running.choices.custom',
};

const placeholder = (key: PlaceholderKey) =>
  ({ type: 'placeholder', key }) as const;

/** The text a choice puts in a place; undefined: the place is empty. */
export function runningText(choice: RunningChoice): RunningText | undefined {
  switch (choice) {
    case 'none':
    case 'custom':
      return undefined;
    case 'page-of':
      // Language-neutral, so it needs no translation: "3 / 12".
      return [
        placeholder('page'),
        { type: 'text', text: ' / ' },
        placeholder('page-count'),
      ] as RunningText;
    default:
      return [placeholder(choice)] as RunningText;
  }
}

/**
 * Which choice a place's text is; `custom` for any other text (written by hand, or per language),
 * which the screen shows but leaves as it is (#393 edits such text).
 */
export function runningChoiceOf(text: RunningText | undefined): RunningChoice {
  if (text === undefined) return 'none';
  if (isLocalized(text)) return 'custom';
  const json = JSON.stringify(text);
  for (const choice of RUNNING_CHOICES) {
    const made = runningText(choice);
    if (made !== undefined && JSON.stringify(made) === json) return choice;
  }
  return 'custom';
}

/** A running header or footer with one place of one variant set to `choice`. */
export function withRunningChoice(
  region: RunningRegion,
  variant: RunningVariant,
  place: RunningPlace,
  choice: RunningChoice,
): RunningRegion {
  if (choice === 'custom') return region;
  const slots: RunningSlots = { ...(region[variant] ?? {}) };
  const text = runningText(choice);
  if (text === undefined) delete slots[place];
  else slots[place] = text;
  return { ...region, [variant]: slots };
}

/**
 * A running header or footer with its first-page or left-page variant on (a copy of the default
 * to start from) or off (gone: those pages show the default).
 */
export function withRunningVariant(
  region: RunningRegion,
  variant: Exclude<RunningVariant, 'default'>,
  on: boolean,
): RunningRegion {
  const next: RunningRegion = { ...region };
  if (on) next[variant] = { ...(region[variant] ?? region.default) };
  else delete next[variant];
  return next;
}

// --- Headings ---

/** A per-level list (numbering, sizes) at `HEADING_LEVELS` entries, the last repeated. */
export function levels<T>(list: readonly T[]): T[] {
  const last = list[list.length - 1] as T;
  return Array.from(
    { length: Math.max(HEADING_LEVELS, list.length) },
    (_, i) => list[i] ?? last,
  );
}

/** A per-level list with one level changed (the levels past the list kept as they read). */
export function withLevel<T>(list: readonly T[], level: number, value: T): T[] {
  const next = levels(list);
  next[level] = value;
  return next;
}

// --- The back page (#395) ---

/** A back page's copyright line: the same in every language, or per language. */
export type Copyright = NonNullable<
  NonNullable<PageDesign['backPage']>['copyright']
>;

/** The copyright line as the PDF prints it in `lang` (else the source language's); '' for none. */
export function copyrightIn(
  text: Copyright | undefined,
  lang: string,
  source: string,
): string {
  return textInLanguage(text, lang, source)?.value ?? '';
}

/**
 * The copyright line with `lang`'s set to `value` (one line, trimmed). A line the same in every
 * language stays so while it is edited in the source language; edited in another language, it
 * becomes the source language's and that language gets its own. An empty value removes `lang`'s
 * line (the source language's, while it is the same in all, removes it); undefined: none left.
 */
export function withCopyright(
  text: Copyright | undefined,
  lang: string,
  source: string,
  value: string,
): Copyright | undefined {
  const line = value.replace(/\s+/g, ' ').trim();
  if (text === undefined || !isLocalized(text)) {
    if (lang === source) return line === '' ? undefined : line;
    if (line === '') return text;
  }
  const byLang: Record<string, string> =
    text === undefined
      ? {}
      : isLocalized(text)
        ? { ...text }
        : { [source]: text };
  if (line === '') delete byLang[lang];
  else byLang[lang] = line;
  return Object.keys(byLang).length > 0 ? byLang : undefined;
}

// --- Issues ---

/** The issues whose place lies in `prefix` (`colours`, `header`, `fonts`, …). */
export function issuesAt(
  issues: readonly DesignIssue[],
  ...prefixes: string[]
): DesignIssue[] {
  return issues.filter((issue) =>
    prefixes.some(
      (prefix) =>
        issue.at !== undefined &&
        (issue.at === prefix ||
          issue.at.startsWith(`${prefix}.`) ||
          issue.at.startsWith(`${prefix}#`)),
    ),
  );
}

/** The issues of no section of the screen (the design as a whole, the back page). */
export function otherIssues(issues: readonly DesignIssue[]): DesignIssue[] {
  const placed = [
    'preset',
    'template',
    'page',
    'colours',
    'fonts',
    'logo',
    'titlePage',
    'regions',
    'header',
    'footer',
    'headings',
    'body',
    'tables',
    'steps',
    'notes',
    'safety',
    'backPage',
  ];
  return issues.filter((issue) => issuesAt([issue], ...placed).length === 0);
}

/** Fixed by the safety standards (`SAFETY_FIXED_SETTINGS`): what the screen lists read-only. */
export const FIXED_SETTINGS = [
  {
    id: 'safety-colours',
    title: 'editor.admin.pageDesigns.fixed.safetyColours.title',
    reason: 'editor.admin.pageDesigns.fixed.safetyColours.reason',
  },
  {
    id: 'signal-words',
    title: 'editor.admin.pageDesigns.fixed.signalWords.title',
    reason: 'editor.admin.pageDesigns.fixed.signalWords.reason',
  },
  {
    id: 'safety-symbols',
    title: 'editor.admin.pageDesigns.fixed.safetySymbols.title',
    reason: 'editor.admin.pageDesigns.fixed.safetySymbols.reason',
  },
] as const;

/** The safety colours the standards fix, shown as they print, never offered as a choice. */
export const SAFETY_SWATCHES = [
  {
    level: 'danger',
    label: 'editor.admin.pageDesigns.fixed.levels.danger',
    swatch: 'bg-safety-danger text-safety-danger-foreground',
  },
  {
    level: 'warning',
    label: 'editor.admin.pageDesigns.fixed.levels.warning',
    swatch: 'bg-safety-warning text-safety-warning-foreground',
  },
  {
    level: 'caution',
    label: 'editor.admin.pageDesigns.fixed.levels.caution',
    swatch: 'bg-safety-caution text-safety-caution-foreground',
  },
  {
    level: 'notice',
    label: 'editor.admin.pageDesigns.fixed.levels.notice',
    swatch: 'bg-safety-notice text-safety-notice-foreground',
  },
] as const;
