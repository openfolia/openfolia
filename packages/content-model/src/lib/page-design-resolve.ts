import type { Block, Item } from './blocks.js';
import { textIn } from './localized-text.js';
import { labelOf, variantLabel } from './config-units.js';
import type { Condition } from './condition.js';
import type { Manufacturer, ProjectConfig } from './config.js';
import type { Inline } from './inline.js';
import type { AttributeValue, Manifest, ManualCoverImage } from './manifest.js';
import { normalizeInline } from './normalize.js';
import {
  BUILTIN_PAGE_DESIGN_ID,
  DEFAULT_PAGE_DESIGN,
  type DesignFont,
  regionBlocksDiffer,
  regionDifferenceMessage,
  type PageDesign,
  type RunningRegion,
  type RunningSlots,
  textInLanguage,
  type Translatable,
} from './page-design.js';
import {
  type BackPagePosition,
  isLocalized,
  type TitlePageField,
  regionSlots,
} from './page-design-options.js';
import {
  ATTRIBUTE_PLACEHOLDER_KEYS,
  isPagePlaceholder,
  type PlaceholderKey,
} from './placeholder.js';
import { evaluateCondition, type VariantValues } from './variant.js';

/**
 * The cover image a manual gives one of its variants (#394): the entry of `coverImage.variants`
 * for exactly these values, else the manual's `coverImage.default`; undefined when it sets
 * neither (the page design's own then applies). `at` is where the alternative text is, as
 * `manual.coverImage.…alt`.
 */
export function manualCoverImage(
  manifest: Pick<Manifest, 'coverImage'>,
  variant: VariantValues,
): { image: ManualCoverImage; at: string } | undefined {
  const cover = manifest.coverImage;
  if (!cover) return undefined;
  const index = cover.variants.findIndex((v) =>
    sameVariantValues(v.variant, variant),
  );
  const chosen = cover.variants[index];
  if (chosen) {
    return { image: chosen, at: `manual.coverImage.variants.${index}.alt` };
  }
  return cover.default
    ? { image: cover.default, at: 'manual.coverImage.default.alt' }
    : undefined;
}

/** Whether two variants set the same attributes to the same values (their order aside). */
export function sameVariantValues(a: VariantValues, b: VariantValues): boolean {
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every((key) => Object.hasOwn(b, key) && a[key] === b[key])
  );
}

/** The values placeholders are filled in with, by key; a key without one has no value. */
export type PlaceholderValues = Partial<Record<PlaceholderKey, string>>;

/**
 * The design a manual uses (#390): the one its manifest names (`design`), else the one the
 * configuration names as the project's default (`pdf.design`), else the built-in one
 * (`DEFAULT_PAGE_DESIGN`, ID `builtin`).
 */
export function pageDesignIdFor(
  manifest: Pick<Manifest, 'design'>,
  config: ProjectConfig,
): string {
  return manifest.design ?? config.pdf.design ?? BUILTIN_PAGE_DESIGN_ID;
}

export interface ChoosePageDesignInput {
  manifest: Pick<Manifest, 'design'>;
  config: ProjectConfig;
  /** Loads a design by ID; undefined when there is none (or its file cannot be read). */
  loadDesign: (id: string) => PageDesign | undefined;
}

/**
 * The design for a manual (`pageDesignIdFor`), loaded. A design the manifest or configuration
 * names that `loadDesign` does not give is an `unknown-page-design` issue, and the built-in
 * design is used, so a preview still renders.
 */
export function choosePageDesign({
  manifest,
  config,
  loadDesign,
}: ChoosePageDesignInput): {
  design: PageDesign;
  issues: PageDesignResolveIssue[];
} {
  const id = pageDesignIdFor(manifest, config);
  if (id === BUILTIN_PAGE_DESIGN_ID) {
    return { design: DEFAULT_PAGE_DESIGN, issues: [] };
  }
  const design = loadDesign(id);
  if (design) return { design, issues: [] };
  return {
    design: DEFAULT_PAGE_DESIGN,
    issues: [
      {
        severity: 'error',
        code: 'unknown-page-design',
        message: `${manifest.design === undefined ? 'the configuration' : 'the manual'} names the page design "${id}", which does not exist; the built-in design is used`,
      },
    ],
  };
}

export interface ResolvePageDesignInput {
  design: PageDesign;
  manifest: Manifest;
  variant: VariantValues;
  lang: string;
  config: ProjectConfig;
  /** The release the manual is made for (its name, e.g. its revision `2.3`), when known. */
  release?: string;
  /**
   * The manual's date (`YYYY-MM-DD`), when known: a release's PDF has its release's date (#395).
   * Shown in the manual's language.
   */
  date?: string;
}

export interface PageDesignResolveIssue {
  severity: 'error' | 'warning';
  code:
    | 'unknown-page-design'
    /** A design text has no version in the manual's language: the source language's is used. */
    | 'missing-translation'
    /**
     * A design text has a version in neither the manual's language nor the source language: it
     * is left out (#554).
     */
    | 'dropped-text'
    /** A region's text in the manual's language has other block IDs than the source's (#554). */
    | 'region-languages-differ'
    /** A placeholder has no value for this manual and variant: it stays a placeholder. */
    | 'missing-placeholder-value'
    | 'missing-text-attribute'
    | 'missing-variant-attribute';
  message: string;
  /** Where in the design (`regions.footer`, `header.default.left`, `titlePage.fields`). */
  at?: string;
  /** The block or item of a region's text, when the issue is about one. */
  block?: string;
  /**
   * What it is about, by name: the placeholder or title page field without a value, the text or
   * variant attribute, the language a region's text is compared with.
   */
  name?: string;
}

/** A running header's or footer's places, resolved for one manual: inline content each. */
export interface ResolvedRunningSlots {
  left?: Inline[];
  centre?: Inline[];
  right?: Inline[];
}

export interface ResolvedRunningRegion {
  default: ResolvedRunningSlots;
  first?: ResolvedRunningSlots;
  even?: ResolvedRunningSlots;
}

/**
 * A design for one manual, variant and language: what the renderer needs. Text is in the
 * manual's language (or the source language's), variant blocks applied, text attributes and
 * placeholders filled in, except the page placeholders (`chapter`, `page`, `page-count`),
 * which stay placeholder nodes for the renderer to fill in on each page.
 */
export interface ResolvedPageDesign {
  id: string;
  name: string;
  preset: string;
  /** The organisation's own template that lays it out (#396, `PageDesign.template`); none: the preset's. */
  template?: string;
  lang: string;
  page: PageDesign['page'];
  colours: PageDesign['colours'];
  /** The design's fonts, only when their embedding is confirmed; none: Geist. */
  fonts: { body?: DesignFont; heading?: DesignFont };
  logo?: PageDesign['logo'];
  /** The title page's fields that have a value, in the design's order. */
  titlePage: { fields: { field: TitlePageField; value: string }[] };
  /** Each region of the preset (and the back page) that has text, by slot. */
  regions: Record<string, Block[]>;
  /** The cover image the variant gets, if any; `alt` in the manual's language, none: decorative. */
  coverImage?: { asset: string; alt?: string };
  backPage?: {
    /** Where it goes: last, or on the inside of the title page (#395). */
    position: BackPagePosition;
    /** The configuration's manufacturer details (#395); none: the project has none. */
    manufacturer?: Manufacturer;
    copyright?: string;
    documentNumber?: string;
    date?: string;
  };
  header: ResolvedRunningRegion;
  footer: ResolvedRunningRegion;
  headings: PageDesign['headings'];
  body: PageDesign['body'];
  tables: PageDesign['tables'];
  steps: PageDesign['steps'];
  notes: PageDesign['notes'];
  safety: PageDesign['safety'];
  /** The values the placeholders were filled in with (page placeholders aside). */
  placeholders: PlaceholderValues;
}

/** The language's own name for itself, "Deutsch" for `de`; the tag where the runtime knows none. */
function languageName(tag: string): string {
  try {
    const name = new Intl.DisplayNames([tag], { type: 'language' }).of(tag);
    if (!name) return tag;
    return name.charAt(0).toLocaleUpperCase(tag) + name.slice(1);
  } catch {
    return tag;
  }
}

/** A date (`YYYY-MM-DD`) in the manual's language, "20. November 2026"; the text as is otherwise. */
function formatDate(date: string, lang: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return date;
  const value = new Date(
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])),
  );
  if (Number.isNaN(value.getTime())) return date;
  try {
    return new Intl.DateTimeFormat(lang, {
      dateStyle: 'long',
      timeZone: 'UTC',
    }).format(value);
  } catch {
    return new Intl.DateTimeFormat('en', {
      dateStyle: 'long',
      timeZone: 'UTC',
    }).format(value);
  }
}

/**
 * The manufacturer placeholders' values (#395, `MANUFACTURER_PLACEHOLDER_KEYS`) from the
 * configuration's details: the address's lines joined with commas; none for what it leaves out.
 */
export function manufacturerValues(
  manufacturer: Manufacturer | undefined,
): PlaceholderValues {
  if (!manufacturer) return {};
  return {
    'manufacturer-name': manufacturer.name,
    ...(manufacturer.address.length > 0 && {
      'manufacturer-address': manufacturer.address.join(', '),
    }),
    ...(manufacturer.contact !== undefined && {
      'manufacturer-contact': manufacturer.contact,
    }),
    ...(manufacturer.website !== undefined && {
      'manufacturer-website': manufacturer.website,
    }),
  };
}

function attributeValue(
  value: AttributeValue,
  matches: (when: Condition | undefined) => boolean,
): string | undefined {
  if (typeof value === 'string') return value;
  return value.find((option) => matches(option.when))?.value;
}

/**
 * Resolves a design for one manual, variant and language (#390). Issues come back instead of
 * exceptions, so a preview still renders: a text without a version in the manual's language
 * (the source language's is used, `missing-translation`), a text in neither that language nor
 * the source language (left out, `dropped-text`), a region whose text in the manual's language
 * has other block IDs than the source's (`region-languages-differ`), a placeholder or text
 * attribute without a value (kept as a node, for the renderer to show), a variant attribute a
 * condition tests and the variant does not set.
 */
export function resolvePageDesign(input: ResolvePageDesignInput): {
  design: ResolvedPageDesign;
  issues: PageDesignResolveIssue[];
} {
  const { design, manifest, variant, lang, config } = input;
  const source = config.languages.source;
  const issues: PageDesignResolveIssue[] = [];
  const reported = new Set<string>();
  const report = (issue: PageDesignResolveIssue) => {
    const key = `${issue.code}|${issue.at ?? ''}|${issue.block ?? ''}|${issue.message}`;
    if (reported.has(key)) return;
    reported.add(key);
    issues.push(issue);
  };
  const versionAttributes = new Set(
    config.variantAttributes
      .filter((a) => a.kind === 'version')
      .map((a) => a.id),
  );
  const matches = (
    condition: Condition | undefined,
    at?: string,
    block?: string,
  ) =>
    condition === undefined ||
    evaluateCondition(condition, variant, {
      versionAttributes,
      onMissing: (attr) =>
        report({
          severity: 'error',
          code: 'missing-variant-attribute',
          message: `the variant does not set "${attr}", which a condition uses; content whose condition is unknown is left out`,
          name: attr,
          ...(at !== undefined && { at }),
          ...(block !== undefined && { block }),
        }),
    });

  const textValues = new Map<string, string>();
  for (const [name, value] of Object.entries(manifest.attributes)) {
    const resolved = attributeValue(value, (when) => matches(when));
    if (resolved !== undefined) textValues.set(name, resolved);
  }

  const values: PlaceholderValues = {
    title: textIn(manifest.title, lang, config.languages.source),
    language: languageName(lang),
  };
  const label = variantLabel(variant, config, lang);
  if (label) values.variant = label;
  if (input.release !== undefined) values.release = input.release;
  if (input.date !== undefined) values.date = formatDate(input.date, lang);
  if (manifest.audience !== undefined) {
    values.audience =
      labelOf(config, 'audiences', manifest.audience, lang) ??
      manifest.audience;
  }
  for (const key of ATTRIBUTE_PLACEHOLDER_KEYS) {
    const value = textValues.get(key);
    if (value !== undefined) values[key] = value;
  }
  Object.assign(values, manufacturerValues(config.manufacturer));

  /**
   * The text in the manual's language, else the source language's (reported); a text in neither
   * is left out (reported too).
   */
  const pick = <T>(text: Translatable<T> | undefined, at: string) => {
    const chosen = textInLanguage(text, lang, source);
    if (text !== undefined && chosen === undefined) {
      report({
        severity: 'warning',
        code: 'dropped-text',
        message: `no "${lang}" version of this text, nor one in the source language "${source}"; it is left out`,
        at,
      });
    }
    if (chosen?.fallback) {
      report({
        severity: 'warning',
        code: 'missing-translation',
        message: `no "${lang}" version of this text; using "${chosen.lang}"`,
        at,
      });
    }
    return chosen?.value;
  };

  const fill = (nodes: readonly Inline[], at: string, block?: string) =>
    normalizeInline(
      nodes.map((node): Inline => {
        if (node.type === 'attribute') {
          const value = textValues.get(node.name);
          if (value !== undefined) return { type: 'text', text: value };
          report({
            severity: 'error',
            code: 'missing-text-attribute',
            message: `no value for {${node.name}} in this variant`,
            at,
            name: node.name,
            ...(block !== undefined && { block }),
          });
          return node;
        }
        if (node.type !== 'placeholder' || isPagePlaceholder(node.key))
          return node;
        const value = values[node.key as PlaceholderKey];
        if (value !== undefined && value !== '')
          return { type: 'text', text: value };
        report({
          severity: 'warning',
          code: 'missing-placeholder-value',
          message: `no value for the placeholder "${node.key}" in this manual and variant`,
          at,
          name: node.key,
          ...(block !== undefined && { block }),
        });
        return node;
      }),
    );

  const resolveBlocks = (blocks: readonly Block[], at: string): Block[] =>
    blocks.flatMap((block): Block[] => {
      if (block.type === 'variant') {
        return matches(block.when, at, block.id)
          ? resolveBlocks(block.blocks, at)
          : [];
      }
      return [resolveBlock(block, at)];
    });
  const resolveItem = (item: Item, at: string): Item => ({
    id: item.id,
    content: fill(item.content, at, item.id),
    blocks: resolveBlocks(item.blocks, at),
  });
  const resolveBlock = (block: Block, at: string): Block => {
    const title = (t: Inline[] | undefined) =>
      t === undefined ? {} : { title: fill(t, at, block.id) };
    switch (block.type) {
      case 'paragraph':
        return { ...block, content: fill(block.content, at, block.id) };
      case 'section':
        return {
          ...block,
          title: fill(block.title, at, block.id),
          blocks: resolveBlocks(block.blocks, at),
        };
      case 'list':
        return { ...block, items: block.items.map((i) => resolveItem(i, at)) };
      case 'procedure':
        return {
          ...block,
          ...title(block.title),
          steps: block.steps.map((i) => resolveItem(i, at)),
        };
      case 'table':
        return {
          ...block,
          ...title(block.title),
          rows: block.rows.map((row) => ({
            ...row,
            cells: row.cells.map((cell) => ({
              ...cell,
              blocks: resolveBlocks(cell.blocks, at),
            })),
          })),
        };
      case 'image':
        return { ...block, ...title(block.title) };
      case 'safety':
        return {
          ...block,
          hazard: fill(block.hazard, at, block.id),
          blocks: resolveBlocks(block.blocks, at),
        };
      case 'faq':
        return {
          ...block,
          question: fill(block.question, at, block.id),
          blocks: resolveBlocks(block.blocks, at),
        };
      case 'admonition':
      case 'variant':
        return { ...block, blocks: resolveBlocks(block.blocks, at) };
      default:
        return block;
    }
  };

  const regions: Record<string, Block[]> = {};
  for (const slot of regionSlots(design.preset)) {
    const at = `regions.${slot}`;
    const text = design.regions[slot];
    const blocks = pick(text, at);
    if (blocks === undefined) continue;
    // A translation keeps the source's block IDs (#554); the source's own text, or a fallback to
    // it, is compared with nothing.
    if (
      text !== undefined &&
      isLocalized(text) &&
      lang !== source &&
      Object.hasOwn(text, lang) &&
      Object.hasOwn(text, source)
    ) {
      const differ = regionBlocksDiffer(blocks, text[source] as Block[]);
      if (differ) {
        report({
          severity: 'warning',
          code: 'region-languages-differ',
          message: regionDifferenceMessage(lang, source, differ),
          at,
          name: source,
        });
      }
    }
    const resolved = resolveBlocks(blocks, at);
    if (resolved.length > 0) regions[slot] = resolved;
  }

  const slots = (s: RunningSlots, at: string): ResolvedRunningSlots => {
    const out: ResolvedRunningSlots = {};
    for (const place of ['left', 'centre', 'right'] as const) {
      const content = pick(s[place], `${at}.${place}`);
      if (content !== undefined) out[place] = fill(content, `${at}.${place}`);
    }
    return out;
  };
  const running = (
    r: RunningRegion,
    where: 'header' | 'footer',
  ): ResolvedRunningRegion => ({
    default: slots(r.default, `${where}.default`),
    ...(r.first && { first: slots(r.first, `${where}.first`) }),
    ...(design.page.doubleSided &&
      r.even && { even: slots(r.even, `${where}.even`) }),
  });

  const fields: ResolvedPageDesign['titlePage']['fields'] = [];
  for (const field of design.titlePage.fields) {
    const value = values[field];
    if (value !== undefined && value !== '') fields.push({ field, value });
    else
      report({
        severity: 'warning',
        code: 'missing-placeholder-value',
        message: `no value for the title page's field "${field}" in this manual and variant; it is left out`,
        at: 'titlePage.fields',
        name: field,
      });
  }

  let coverImage: ResolvedPageDesign['coverImage'];
  // The manual's own (#394): its variant's, else the manual's, over the design's rules.
  const own = manualCoverImage(manifest, variant);
  if (own) {
    const alt = pick(own.image.alt, own.at);
    coverImage = { asset: own.image.asset, ...(alt !== undefined && { alt }) };
  } else if (design.coverImage) {
    const index = design.coverImage.variants.findIndex((rule, i) =>
      matches(rule.when, `coverImage.variants.${i}.when`),
    );
    const chosen =
      index >= 0
        ? {
            image: design.coverImage.variants[index],
            at: `coverImage.variants.${index}`,
          }
        : design.coverImage.default && {
            image: design.coverImage.default,
            at: 'coverImage.default',
          };
    if (chosen?.image) {
      const alt = pick(chosen.image.alt, `${chosen.at}.alt`);
      coverImage = {
        asset: chosen.image.asset,
        ...(alt !== undefined && { alt }),
      };
    }
  }

  let backPage: ResolvedPageDesign['backPage'];
  if (design.backPage) {
    const copyright = pick(design.backPage.copyright, 'backPage.copyright');
    backPage = {
      position: design.backPage.position,
      ...(config.manufacturer && { manufacturer: config.manufacturer }),
      ...(copyright !== undefined && { copyright }),
      ...(design.backPage.documentNumber &&
        values['document-number'] !== undefined && {
          documentNumber: values['document-number'],
        }),
      ...(design.backPage.date &&
        values.date !== undefined && { date: values.date }),
    };
  }

  return {
    design: {
      id: design.id,
      name: design.name,
      preset: design.preset,
      ...(design.template !== undefined && { template: design.template }),
      lang,
      page: design.page,
      colours: design.colours,
      // Fonts nobody confirmed may be embedded are not used (`fonts-not-confirmed`): Geist.
      fonts: design.fonts.embeddingAllowed
        ? {
            ...(design.fonts.body && { body: design.fonts.body }),
            ...(design.fonts.heading && { heading: design.fonts.heading }),
          }
        : {},
      ...(design.logo && { logo: design.logo }),
      titlePage: { fields },
      regions,
      ...(coverImage && { coverImage }),
      ...(backPage && { backPage }),
      header: running(design.header, 'header'),
      footer: running(design.footer, 'footer'),
      headings: design.headings,
      body: design.body,
      tables: design.tables,
      steps: design.steps,
      notes: design.notes,
      safety: design.safety,
      placeholders: values,
    },
    issues,
  };
}
