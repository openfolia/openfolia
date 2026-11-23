import { parse as parseYaml, stringify } from 'yaml';
import { parseInline, printInline } from './asciidoc/inline.js';
import { parseBlocksSource } from './asciidoc/parse.js';
import { printBlocksSource } from './asciidoc/print.js';
import {
  formatCondition,
  parseCondition,
} from './asciidoc/condition-syntax.js';
import { AsciidocParseError } from './asciidoc/syntax.js';
import type { Block } from './blocks.js';
import type { Inline } from './inline.js';
import { normalizeBlock, normalizeInline } from './normalize.js';
import {
  type DesignTranslationRecord,
  isLocalized,
  PAGE_DESIGN_SCHEMA_VERSION,
  PageDesign,
  type RunningRegion,
  type RunningSlots,
  type Translatable,
} from './page-design.js';
import { regionSlots } from './page-design-options.js';

export class PageDesignParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PageDesignParseError';
  }
}

/** The most characters a design's file may have before it is read: far more than any design. */
export const MAX_PAGE_DESIGN_FILE_LENGTH = 1_000_000;

type Raw = Record<string, unknown>;
const isRecord = (value: unknown): value is Raw =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Rewrites a translatable text read from the file (a string, or strings by language). */
function readTranslatable(
  value: unknown,
  path: string,
  read: (text: string, path: string) => unknown,
): unknown {
  if (typeof value === 'string') return read(value, path);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([lang, text]) => [
      lang,
      typeof text === 'string' ? read(text, `${path}.${lang}`) : text,
    ]),
  );
}

function asciidoc<T>(parse: () => T, path: string): T {
  try {
    return parse();
  } catch (e) {
    if (!(e instanceof AsciidocParseError)) throw e;
    throw new PageDesignParseError(
      `invalid page design: ${path}: ${e.message}`,
    );
  }
}

const readBlocks = (text: string, path: string) =>
  asciidoc(() => parseBlocksSource(text), path);
const readInline = (text: string, path: string) =>
  asciidoc(() => parseInline(text), path);

/**
 * A stored design (a file's data, or a working copy saved earlier) without the settings that have
 * moved out of it, so one written before still reads: before #395 the back page held the
 * manufacturer, which is the configuration's now (`manufacturer` in `openfolia.yaml`). Anything else,
 * the value itself included, is left as it is.
 */
export function withoutMovedSettings<T>(data: T): T {
  if (!isRecord(data)) return data;
  const back = data['backPage'];
  if (!isRecord(back) || !('manufacturer' in back)) return data;
  const { manufacturer: _moved, ...rest } = back;
  return { ...data, backPage: rest } as T;
}

/**
 * A design's file (`design/<id>.yaml`) as `PageDesign`; the ID is the file name's. Region text
 * is AsciiDoc blocks, running header and footer text AsciiDoc inline markup (placeholders as
 * `placeholder:<key>[]`), a cover image rule's `when` a condition as modules write it.
 */
export function parsePageDesign(
  source: string,
  options: { id: string },
): PageDesign {
  if (source.length > MAX_PAGE_DESIGN_FILE_LENGTH) {
    throw new PageDesignParseError(
      `a page design has at most ${MAX_PAGE_DESIGN_FILE_LENGTH} characters`,
    );
  }
  let data: unknown;
  try {
    data = parseYaml(source, { maxAliasCount: 0 });
  } catch (e) {
    throw new PageDesignParseError(`invalid YAML: ${(e as Error).message}`);
  }
  if (!isRecord(data)) {
    throw new PageDesignParseError('a page design must be a YAML mapping');
  }
  // The ID is the file name's; a file naming another is no design of it.
  if ('id' in data && data['id'] !== options.id) {
    throw new PageDesignParseError(
      `the file names the design "${String(data['id'])}", not "${options.id}"`,
    );
  }
  const input: Raw = { ...data, id: options.id };
  if (isRecord(data['regions'])) {
    input['regions'] = Object.fromEntries(
      Object.entries(data['regions']).map(([slot, text]) => [
        slot,
        readTranslatable(text, `regions.${slot}`, readBlocks),
      ]),
    );
  }
  for (const where of ['header', 'footer'] as const) {
    const region = data[where];
    if (!isRecord(region)) continue;
    input[where] = Object.fromEntries(
      Object.entries(region).map(([page, slots]) => [
        page,
        isRecord(slots)
          ? Object.fromEntries(
              Object.entries(slots).map(([place, text]) => [
                place,
                readTranslatable(text, `${where}.${page}.${place}`, readInline),
              ]),
            )
          : slots,
      ]),
    );
  }
  if ('backPage' in data) {
    input['backPage'] = withoutMovedSettings(data)['backPage'];
  }
  const cover = data['coverImage'];
  if (isRecord(cover) && Array.isArray(cover['variants'])) {
    input['coverImage'] = {
      ...cover,
      variants: cover['variants'].map((rule: unknown, i) => {
        if (!isRecord(rule) || typeof rule['when'] !== 'string') return rule;
        const when = rule['when'];
        return {
          ...rule,
          when: asciidoc(
            () => parseCondition(when),
            `coverImage.variants.${i}.when`,
          ),
        };
      }),
    };
  }
  const result = PageDesign.safeParse(input);
  if (!result.success) {
    throw new PageDesignParseError(
      `invalid page design: ${result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`,
    );
  }
  return normalizePageDesign(result.data);
}

/** Text by language in a stable order (languages sorted), or the text for every language. */
function printTranslatable<T>(
  text: Translatable<T>,
  print: (value: T) => unknown,
): unknown {
  if (!isLocalized(text)) return print(text);
  return Object.fromEntries(
    Object.keys(text)
      .sort()
      .map((lang) => [lang, print(text[lang] as T)]),
  );
}

const printRegion = (blocks: Block[]) => printBlocksSource(blocks);
const printRunning = (content: Inline[]) =>
  printInline(normalizeInline(content), false);

function printSlots(slots: RunningSlots): Raw {
  const out: Raw = {};
  for (const place of ['left', 'centre', 'right'] as const) {
    const text = slots[place];
    if (text !== undefined) out[place] = printTranslatable(text, printRunning);
  }
  return out;
}

function printRunningRegion(region: RunningRegion): Raw {
  return {
    default: printSlots(region.default),
    ...(region.first && { first: printSlots(region.first) }),
    ...(region.even && { even: printSlots(region.even) }),
  };
}

/**
 * The regions in a stable order: the preset's own slots in its order, then any others
 * (a validation error, kept so nothing is lost) sorted.
 */
function regionOrder(design: PageDesign): string[] {
  const known = regionSlots(design.preset);
  const names = Object.keys(design.regions);
  return [
    ...known.filter((slot) => names.includes(slot)),
    ...names.filter((slot) => !known.includes(slot)).sort(),
  ];
}

/**
 * A design in canonical form: inline content and blocks normalized as a module's are, so
 * a design compares equal to what its printed file reads back as.
 */
export function normalizePageDesign(design: PageDesign): PageDesign {
  const blocks = (text: Translatable<Block[]>) =>
    mapTranslatable(text, (b) => b.map(normalizeBlock));
  const inline = (text: Translatable<Inline[]>) =>
    mapTranslatable(text, (c) => normalizeInline(c));
  const slots = (s: RunningSlots): RunningSlots =>
    ({
      ...(s.left && { left: inline(s.left) }),
      ...(s.centre && { centre: inline(s.centre) }),
      ...(s.right && { right: inline(s.right) }),
    }) as RunningSlots;
  const running = (r: RunningRegion): RunningRegion => ({
    default: slots(r.default),
    ...(r.first && { first: slots(r.first) }),
    ...(r.even && { even: slots(r.even) }),
  });
  return {
    ...design,
    regions: Object.fromEntries(
      Object.entries(design.regions).map(([slot, text]) => [
        slot,
        blocks(text),
      ]),
    ),
    header: running(design.header),
    footer: running(design.footer),
  };
}

function mapTranslatable<T>(
  text: Translatable<T>,
  map: (value: T) => T,
): Translatable<T> {
  if (!isLocalized(text)) return map(text);
  return Object.fromEntries(
    Object.entries(text).map(([lang, value]) => [lang, map(value)]),
  );
}

/**
 * A design as its file: canonical YAML, every setting in the schema's order (defaults
 * included, so the file shows every choice), languages sorted, region text as AsciiDoc
 * blocks, running text as AsciiDoc inline markup, conditions as text.
 * `printPageDesign(parsePageDesign(t)) === t` for every `t` it prints.
 */
export function printPageDesign(design: PageDesign): string {
  const d = normalizePageDesign(design);
  const single = (text: Translatable<string>) =>
    printTranslatable(text, (t) => t);
  const doc: Raw = {
    schemaVersion: PAGE_DESIGN_SCHEMA_VERSION,
    name: d.name,
    preset: d.preset,
    ...(d.template !== undefined && { template: d.template }),
    page: {
      size: d.page.size,
      margins: {
        top: d.page.margins.top,
        right: d.page.margins.right,
        bottom: d.page.margins.bottom,
        left: d.page.margins.left,
      },
      doubleSided: d.page.doubleSided,
    },
    colours: {
      primary: d.colours.primary,
      accent: d.colours.accent,
      text: d.colours.text,
    },
  };
  const fonts: Raw = {};
  for (const role of ['body', 'heading'] as const) {
    const font = d.fonts[role];
    if (!font) continue;
    fonts[role] = {
      family: font.family,
      regular: font.regular,
      ...(font.bold && { bold: font.bold }),
      ...(font.italic && { italic: font.italic }),
      ...(font.boldItalic && { boldItalic: font.boldItalic }),
    };
  }
  fonts['embeddingAllowed'] = d.fonts.embeddingAllowed;
  doc['fonts'] = fonts;
  if (d.logo) {
    doc['logo'] = {
      light: d.logo.light,
      ...(d.logo.dark && { dark: d.logo.dark }),
    };
  }
  doc['titlePage'] = { fields: [...d.titlePage.fields] };
  if (Object.keys(d.regions).length > 0) {
    doc['regions'] = Object.fromEntries(
      regionOrder(d).map((slot) => [
        slot,
        printTranslatable(
          d.regions[slot] as Translatable<Block[]>,
          printRegion,
        ),
      ]),
    );
  }
  if (d.translations && Object.keys(d.translations).length > 0) {
    const records = d.translations;
    doc['translations'] = Object.fromEntries(
      Object.keys(records)
        .sort()
        .map((lang) => {
          const record = records[lang] as DesignTranslationRecord;
          return [
            lang,
            {
              sourceCommit: record.sourceCommit,
              blocks: Object.fromEntries(
                Object.keys(record.blocks)
                  .sort()
                  .map((key) => [key, record.blocks[key]]),
              ),
            },
          ];
        }),
    );
  }
  if (d.coverImage) {
    const image = (c: { asset: string; alt?: Translatable<string> }) => ({
      asset: c.asset,
      ...(c.alt !== undefined && { alt: single(c.alt) }),
    });
    doc['coverImage'] = {
      ...(d.coverImage.default && { default: image(d.coverImage.default) }),
      variants: d.coverImage.variants.map((rule) => ({
        when: formatCondition(rule.when),
        ...image(rule),
      })),
    };
  }
  if (d.backPage) {
    doc['backPage'] = {
      position: d.backPage.position,
      ...(d.backPage.copyright !== undefined && {
        copyright: single(d.backPage.copyright),
      }),
      documentNumber: d.backPage.documentNumber,
      date: d.backPage.date,
    };
  }
  doc['header'] = printRunningRegion(d.header);
  doc['footer'] = printRunningRegion(d.footer);
  doc['headings'] = {
    numbering: [...d.headings.numbering],
    sizes: [...d.headings.sizes],
    colour: d.headings.colour,
    pageBreakBeforeLevel1: d.headings.pageBreakBeforeLevel1,
  };
  doc['body'] = {
    fontSize: d.body.fontSize,
    lineHeight: d.body.lineHeight,
    paragraphSpacing: d.body.paragraphSpacing,
    columns: d.body.columns,
  };
  doc['tables'] = {
    headerTint: d.tables.headerTint,
    borders: d.tables.borders,
    zebra: d.tables.zebra,
  };
  doc['steps'] = { marker: d.steps.marker };
  doc['notes'] = { style: d.notes.style };
  doc['safety'] = { standard: d.safety.standard };
  return stringify(doc, { lineWidth: 0 });
}
