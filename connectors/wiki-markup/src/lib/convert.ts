import { createHash } from 'node:crypto';
import {
  type Block,
  CURRENT_IMPORT_FORMAT_VERSION,
  CURRENT_SCHEMA_VERSION,
  type ImportDocument,
  type Inline,
  DEFAULT_IMPORT_MAX_VALUES,
  MAX_ITEM_VALUES,
  tablesTooLarge,
  tableTooLarge,
  type Item,
  type List,
  MARK_ORDER,
  type Mark,
  MAX_KEYWORD_LENGTH,
  MAX_KEYWORDS,
  MAX_LIST_DEPTH,
  MAX_SECTION_DEPTH,
  type Module,
  type Section,
  type Table,
  type TextNode,
  toFileName,
} from '@openfolia/content-model';
import { blockNodes, type ListLine, type WikiNode } from './blocks.js';
import {
  type Embed,
  type InlineContext,
  parseInline,
  textOnly,
} from './inline.js';
import type { WikiMapping } from './mapping.js';
import {
  ConversionReport,
  type FindingPlace,
  quote,
  type WikiReportCode,
} from './report.js';

/** One page of an export. */
export interface WikiPage {
  /** Its ID in the source system (one line), for `meta.source` and the report. */
  readonly id: string;
  readonly title: string;
  /** Its text, in the markup. */
  readonly markup: string;
  /** The files attached to it, by file name, which its images and attachment links name. */
  readonly attachments?: ReadonlyMap<string, Uint8Array>;
  /** Its labels, mapped by `mapping.labels`. */
  readonly labels?: readonly string[];
}

export interface WikiConversion {
  /** `import.json`: the modules, the manual (if the mapping asks for one) and the report. */
  readonly document: ImportDocument;
  /** The files the modules use, by `sha256:<hash>`. */
  readonly assets: ReadonlyMap<string, Uint8Array>;
  /** How many findings of each code the report holds. */
  readonly counts: ReadonlyMap<WikiReportCode, number>;
}

/** The format a `passthrough` block of this markup names. */
export const WIKI_PASSTHROUGH_FORMAT = 'wiki';

/**
 * Converts pages of the markup into an import bundle's document, for the
 * target configuration the mapping names. Every page becomes one module in
 * `mapping.language`; links between the pages become cross-references.
 * Nothing is dropped silently: whatever has no counterpart is kept (as
 * text, or verbatim in a `passthrough` block) and reported, block by block,
 * in `document.report`. Pure and deterministic: the same pages and mapping
 * give the same document.
 */
export function convertWikiPages(
  pages: readonly WikiPage[],
  mapping: WikiMapping,
  { exportedAt }: { exportedAt?: string } = {},
): WikiConversion {
  const report = new ConversionReport();
  const assets = new Map<string, Uint8Array>();
  const ids = moduleIds(pages, mapping, report);
  const byTitle = new Map<string, string>();
  pages.forEach((page, index) => {
    const key = titleKey(page.title);
    if (!byTitle.has(key)) byTitle.set(key, ids[index] as string);
  });
  const tables = { values: 0 };
  const modules = pages.map((page, index) =>
    convertPage(page, ids[index] as string, mapping, {
      report,
      assets,
      pageByTitle: (title) => byTitle.get(titleKey(title)),
      tables,
    }),
  );
  const manuals: NonNullable<ImportDocument['manuals']> = mapping.manual
    ? [
        {
          schemaVersion: 1,
          id: mapping.manual.id,
          title: mapping.manual.title,
          ...(mapping.manual.audience && { audience: mapping.manual.audience }),
          variants: mapping.manual.variants,
          attributes: {},
          entries: modules.map((m) => ({ module: m.id })),
        },
      ]
    : [];
  return {
    document: {
      formatVersion: CURRENT_IMPORT_FORMAT_VERSION,
      source: {
        system: mapping.system,
        ...(exportedAt && { exportedAt }),
      },
      modules,
      manuals,
      report: report.list(),
    },
    assets,
    counts: report.counts,
  };
}

/** What converting one page's (or one field's) markup shares with the rest. */
export interface MarkupContext {
  readonly report: ConversionReport;
  /** The files used so far, by `sha256:<hash>`; the markup's are added. */
  readonly assets: Map<string, Uint8Array>;
  /** The module of an exported page by its title, for links. */
  readonly pageByTitle: (title: string) => string | undefined;
  /**
   * The values (as the import counts them) the bundle's tables hold so far,
   * shared by every page of one bundle (`MAX_BUNDLE_TABLE_VALUES`). Pass one
   * object for all the calls making one bundle.
   */
  readonly tables?: { values: number };
}

/**
 * The most values (array elements and object members, as `validateImport`
 * counts them) one module's tables may hold: room left within the import's
 * limit on one module (`MAX_ITEM_VALUES`) for the rest of the page.
 */
export const MAX_MODULE_TABLE_VALUES = Math.floor(MAX_ITEM_VALUES * 0.8);

/**
 * The most values a bundle's tables may hold together: room left within
 * the import's limit on a whole bundle (`DEFAULT_IMPORT_MAX_VALUES`), and a
 * bound on the memory a hostile export can take.
 */
export const MAX_BUNDLE_TABLE_VALUES = Math.floor(
  DEFAULT_IMPORT_MAX_VALUES * 0.8,
);

/** What may split a cell's text into more nodes: markup characters and line breaks. */
const FORMATTING = /[*_[\]!{}\\^~?+|\n-]/g;
/**
 * The most values one such character can add: a new text node under every
 * mark the model has open at once (at most six, about 17 values), or a
 * break, or a block for an image moved after the text.
 */
const PER_FORMATTING = 18;

/**
 * At least the values a table of these rows holds once converted: the
 * table 5 and 2 a column, a row 2, a cell of plain text 11 (the cell, its
 * paragraph and text node), each
 * formatting character or line break up to `PER_FORMATTING` more, a padded
 * one 2, a column 2.
 */
function tableValues(
  rows: readonly { cells: readonly { text: string }[] }[],
  width: number,
): number {
  let values = 5 + 2 * width;
  for (const row of rows) {
    values += 2 + 2 * (width - row.cells.length);
    for (const cell of row.cells) {
      values +=
        11 + PER_FORMATTING * (cell.text.match(FORMATTING)?.length ?? 0);
    }
  }
  return values;
}

/**
 * The blocks of one piece of markup (a page, or a field of another
 * source), as the module `moduleId` holds them; findings are reported
 * against `sourceId`. `idPrefix` starts every block ID (so the blocks of
 * several fields in one module never clash).
 */
export function convertMarkup(
  markup: string,
  {
    sourceId,
    sourceKind,
    moduleId,
    mapping,
    attachments = new Map(),
    idPrefix,
    reserve = DEFAULT_RESERVE,
  }: {
    sourceId: string;
    /** What the source item is, for the report (default `page`). */
    sourceKind?: string;
    moduleId: string;
    mapping: WikiMapping;
    attachments?: ReadonlyMap<string, Uint8Array>;
    idPrefix?: string;
    /**
     * The values (as `validateImport` counts them) the module holds beside
     * its blocks: its own members and its `meta` (`valuesIn`). Default
     * 1,000, room for a usual `meta`.
     */
    reserve?: number;
  },
  context: MarkupContext,
): Block[] {
  const place = {
    sourceId,
    module: moduleId,
    ...(sourceKind && { sourceKind }),
  };
  const mark = context.report.mark();
  const bundleBefore = context.tables?.values;
  const maxValues = Math.max(0, MAX_ITEM_VALUES - reserve);
  const converter = new PageConverter(
    place,
    mapping,
    attachments,
    context,
    new BlockIds(idPrefix),
    maxValues,
  );
  try {
    const blocks = converter.top(
      blockNodes(markup, { containers: containerNames(mapping) }),
    );
    if (!holdsMoreThan(blocks, maxValues)) return blocks;
  } catch (error) {
    if (!(error instanceof PageTooLarge)) throw error;
  }
  // Too much for one module (very many blocks): the whole page verbatim,
  // once, instead of a module the import refuses. The conversion stops as
  // soon as it passes the limit, so a very large page costs no more than
  // a module's worth of blocks. What it found or used is forgotten with it.
  context.report.rollBack(mark);
  for (const key of converter.addedAssets) context.assets.delete(key);
  if (context.tables && bundleBefore !== undefined) {
    context.tables.values = bundleBefore;
  }
  const id = new BlockIds(idPrefix).next(undefined, 'raw');
  context.report.add(
    { ...place, block: id },
    'page-too-large',
    `Its converted blocks pass the import's limit on one module (about ${maxValues.toLocaleString('en')} values beside its meta); it is kept verbatim (passthrough), any files in it as written.`,
  );
  return [
    {
      type: 'passthrough',
      id,
      format: WIKI_PASSTHROUGH_FORMAT,
      raw: markup.replace(/\r\n?/g, '\n'),
    },
  ];
}

/**
 * The values `convertMarkup` leaves within `MAX_ITEM_VALUES` for the rest
 * of a module when its caller names none: room for a usual `meta`.
 */
const DEFAULT_RESERVE = 1_000;

/** The values (array elements and object members, at any depth) `value` holds, as `validateImport` counts them. */
function valuesIn(value: unknown): number {
  let values = 0;
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const next = stack.pop();
    if (typeof next !== 'object' || next === null) continue;
    const children = Object.values(next);
    values += children.length;
    for (const child of children) stack.push(child);
  }
  return values;
}

/** Whether `value` holds more than `max` values (array elements and object members, at any depth). */
function holdsMoreThan(value: unknown, max: number): boolean {
  let values = 0;
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const next = stack.pop();
    if (typeof next !== 'object' || next === null) continue;
    const children = Object.values(next);
    values += children.length;
    if (values > max) return true;
    for (const child of children) stack.push(child);
  }
  return false;
}

function convertPage(
  page: WikiPage,
  id: string,
  mapping: WikiMapping,
  context: MarkupContext,
): Module {
  const place = { sourceId: page.id, module: id };
  let type = mapping.moduleType;
  let audience = mapping.audience;
  const facets = new Map<string, Set<string>>(
    Object.entries(mapping.facets).map(([k, v]) => [k, new Set(v)]),
  );
  const keywords: string[] = [];
  for (const label of page.labels ?? []) {
    const set = Object.hasOwn(mapping.labels, label)
      ? mapping.labels[label]
      : undefined;
    if (set) {
      type = set.type ?? type;
      audience = set.audience ?? audience;
      for (const [facet, values] of Object.entries(set.facets ?? {})) {
        const known = facets.get(facet) ?? new Set();
        for (const value of values) known.add(value);
        facets.set(facet, known);
      }
    } else if (
      mapping.labelsAsKeywords &&
      label.length <= MAX_KEYWORD_LENGTH &&
      !label.includes(',') &&
      keywords.length < MAX_KEYWORDS
    ) {
      keywords.push(label.trim());
    } else {
      context.report.add(
        place,
        'unmapped-label',
        `The page label ${quote(label)} is not in the mapping; it is not used.`,
      );
    }
  }
  const module: Module = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    id,
    meta: {
      title: oneLine(page.title) || page.id,
      type,
      lang: mapping.language,
      ...(audience && { audience }),
      facets: Object.fromEntries(
        [...facets].map(([k, v]) => [k, [...v].sort()]),
      ),
      ...(keywords.filter(Boolean).length > 0 && {
        keywords: keywords.filter(Boolean),
      }),
      source: { system: mapping.system, id: oneLine(page.id) || '-' },
    },
    blocks: [],
  };
  // The blocks get what the module's own members and its meta leave.
  const reserve = valuesIn(module);
  module.blocks = convertMarkup(
    page.markup,
    {
      sourceId: page.id,
      moduleId: id,
      mapping,
      ...(page.attachments && { attachments: page.attachments }),
      reserve,
    },
    context,
  );
  return module;
}

/** Module IDs for the pages, in order: slugs, unique, the clashes reported. */
function moduleIds(
  pages: readonly WikiPage[],
  mapping: WikiMapping,
  report: ConversionReport,
): string[] {
  const taken = new Set<string>();
  const suffixes = new Map<string, number>();
  const prefix = mapping.moduleIds.prefix;
  return pages.map((page, index) => {
    const from = mapping.moduleIds.from === 'title' ? page.title : page.id;
    const base =
      [prefix, slug(from)]
        .filter(Boolean)
        .join('-')
        .slice(0, 90)
        .replace(/-+$/, '') || `page-${index + 1}`;
    let id = base;
    if (taken.has(id)) {
      let n = suffixes.get(base) ?? 2;
      while (taken.has(`${base}-${n}`)) n++;
      id = `${base}-${n}`;
      suffixes.set(base, n + 1);
    }
    if (id !== base) {
      report.add(
        { sourceId: page.id, module: id },
        'duplicate-id',
        `Another page already has the module ID "${base}"; this one is "${id}".`,
      );
    }
    taken.add(id);
    return id;
  });
}

function containerNames(mapping: WikiMapping): Set<string> {
  return new Set([
    'quote',
    ...Object.keys(mapping.admonitions),
    ...Object.keys(mapping.safety),
    ...mapping.containers,
  ]);
}

/** Thrown by `PageConverter` once a page's blocks pass the module's limit: the page goes verbatim. */
class PageTooLarge extends Error {}

/** Block IDs within one module: unique, valid, derived from where a block is. */
class BlockIds {
  private readonly used = new Set<string>();
  private readonly counters = new Map<string, number>();

  constructor(private readonly prefix?: string) {}

  /** A section's: its title's slug. */
  section(title: string): string {
    const base = slug(title).slice(0, 40) || 'section';
    return this.unique(this.prefixed(/^[a-z]/.test(base) ? base : `s-${base}`));
  }

  /** The next of `kind` inside `scope` (a section's or a container's ID). */
  next(scope: string | undefined, kind: string): string {
    const key = `${scope ?? ''}:${kind}`;
    const n = (this.counters.get(key) ?? 0) + 1;
    this.counters.set(key, n);
    const id = scope ? `${scope}-${kind}${n}` : this.prefixed(`${kind}${n}`);
    return this.unique(id.length <= 60 ? id : this.prefixed(`${kind}${n}`));
  }

  private prefixed(id: string): string {
    return this.prefix ? `${this.prefix}-${id}` : id;
  }

  /** Where each base's suffixes go on from, so many equal titles stay linear. */
  private readonly suffixes = new Map<string, number>();

  private unique(base: string): string {
    let id = base.slice(0, 60);
    if (this.used.has(id)) {
      const stem = base.slice(0, 56);
      let n = this.suffixes.get(stem) ?? 2;
      while (this.used.has(`${stem}-${n}`)) n++;
      id = `${stem}-${n}`;
      this.suffixes.set(stem, n + 1);
    }
    this.used.add(id);
    return id;
  }
}

class PageConverter {
  /** The places the page's tables cover so far (rows × columns). */
  private tableCells = 0;
  /** At least the values the page's tables hold so far (`tableValues`). */
  private valuesSoFar = 0;
  /** The bundle's, or this page's alone when the caller shares none. */
  private readonly bundleTables: { values: number };
  /** The files this page added to `context.assets` (none an earlier page used), for a rollback. */
  readonly addedAssets: string[] = [];
  /**
   * At least the values the page's blocks hold so far, as `validateImport`
   * counts them (`holdsMoreThan`): exact for the blocks of every node done,
   * a lower bound for the one being converted. Past `maxValues` the page
   * cannot fit, and the conversion stops (`PageTooLarge`).
   */
  private spent = 0;
  /** The asset reference of each attachment used so far, hashed once. */
  private readonly hashes = new Map<Uint8Array, string>();

  constructor(
    private readonly place: FindingPlace & { module: string },
    private readonly mapping: WikiMapping,
    private readonly attachments: ReadonlyMap<string, Uint8Array>,
    private readonly context: MarkupContext,
    private readonly ids: BlockIds,
    private readonly maxValues: number,
  ) {
    this.bundleTables = context.tables ?? { values: 0 };
  }

  /** Counts `values` more (or fewer) in the page's blocks; past the limit, stops the conversion. */
  private charge(values: number): void {
    this.spent += values;
    if (this.spent > this.maxValues) throw new PageTooLarge();
  }

  /**
   * Sets what a node's blocks added to exactly `values`, in place of the
   * lower bound counted while they were made (from `before`).
   */
  private settle(before: number, values: number): void {
    this.spent = before;
    this.charge(values);
  }

  private note(
    block: string | undefined,
    code: WikiReportCode,
    message: string,
  ) {
    this.context.report.add(
      { ...this.place, ...(block !== undefined && { block }) },
      code,
      message,
    );
  }

  /** A page's (or a field's) blocks: headings open sections. */
  top(nodes: Iterable<WikiNode>): Block[] {
    const root: Block[] = [];
    const open: { level: number; section: Section }[] = [];
    const here = () => open[open.length - 1]?.section;
    for (const node of nodes) {
      const before = this.spent;
      if (node.kind !== 'heading') {
        const section = here();
        const blocks = this.block(node, section?.id, true);
        append(section ? section.blocks : root, blocks);
        this.settle(before, valuesIn(blocks));
        continue;
      }
      const title = this.title(node.text, here()?.id);
      if (title.length === 0) {
        this.note(
          here()?.id,
          'empty-heading',
          'A heading with no text is left out.',
        );
        continue;
      }
      while (
        open.length > 0 &&
        (open[open.length - 1]?.level ?? 0) >= node.level
      ) {
        open.pop();
      }
      if (open.length >= MAX_SECTION_DEPTH) {
        open.splice(MAX_SECTION_DEPTH - 1);
        this.note(
          here()?.id,
          'too-deep',
          `The heading ${quote(node.text)} is nested deeper than ${MAX_SECTION_DEPTH} levels; it is placed at level ${MAX_SECTION_DEPTH}.`,
        );
      }
      const section: Section = {
        type: 'section',
        id: this.ids.section(plain(title)),
        title,
        blocks: [],
      };
      const parent = here();
      (parent ? parent.blocks : root).push(section);
      open.push({ level: node.level, section });
      this.settle(before, valuesIn([section]));
    }
    return root;
  }

  /** Blocks inside a container: a heading there is a paragraph of strong text. */
  private inner(nodes: readonly WikiNode[], scope: string): Block[] {
    return nodes.flatMap((node) => {
      if (node.kind !== 'heading') return this.block(node, scope, false);
      const id = this.ids.next(scope, 'p');
      const content = this.inline(node.text, id).content;
      if (content.length === 0) return [];
      this.note(
        id,
        'macro-frame',
        `The heading ${quote(node.text)} inside a macro is kept as strong text (a section cannot be there).`,
      );
      return [{ type: 'paragraph', id, content: strong(content) } as Block];
    });
  }

  private block(
    node: WikiNode,
    scope: string | undefined,
    top: boolean,
  ): Block[] {
    switch (node.kind) {
      case 'paragraph':
        return this.paragraph(node.text, scope);
      case 'quote': {
        const blocks = this.paragraph(node.text, scope);
        this.note(
          blocks[0]?.id ?? scope,
          'quote',
          `The quotation ${quote(node.text)} is kept as a plain paragraph.`,
        );
        return blocks;
      }
      case 'list':
        return this.list(node.lines, scope, top);
      case 'table':
        return this.table(node.rows, scope);
      case 'code':
        return this.code(node, scope);
      case 'container':
        return this.container(node, scope);
      case 'macro': {
        const id = this.ids.next(scope, 'raw');
        this.note(
          id,
          'unknown-macro',
          `The macro {${node.name}} has no counterpart; it is kept verbatim (passthrough).`,
        );
        // Its place, type, ID, format and text.
        this.charge(5);
        return [
          {
            type: 'passthrough',
            id,
            format: WIKI_PASSTHROUGH_FORMAT,
            raw: node.raw,
          },
        ];
      }
      case 'rule':
        this.note(scope, 'rule', 'A horizontal rule is left out.');
        return [];
      case 'heading':
        return [];
    }
  }

  /**
   * `text`'s inline content, counted as it is made. With `keepsEmbeds`
   * (every image and attachment met becomes a block), each of those is
   * counted too, as at least 5 values (`embed`).
   */
  private inline(text: string, block: string, keepsEmbeds = false) {
    const context: InlineContext = {
      pageByTitle: this.context.pageByTitle,
      note: (code, message) => this.note(block, code, message),
      count: (values) => this.charge(values),
      ...(keepsEmbeds && { embedded: () => this.charge(5) }),
    };
    return parseInline(text, context);
  }

  /** Inline text for a title: one line, text nodes and cross-references only. */
  private title(text: string, block: string | undefined): Inline[] {
    const { content, embeds } = this.inline(text, block ?? this.place.module);
    for (const embed of embeds) {
      this.note(
        block,
        'moved-out-of-text',
        `${quote(embed.raw)} in a heading is left out of it; ${embed.kind === 'image' ? 'an image' : 'a file'} has no place in a title.`,
      );
    }
    return content.flatMap((n): Inline[] =>
      n.type === 'hardBreak' ? [{ type: 'text', text: ' ' }] : [n],
    );
  }

  private paragraph(text: string, scope: string | undefined): Block[] {
    const id = this.ids.next(scope, 'p');
    const { content, embeds } = this.inline(text, id, true);
    const blocks: Block[] =
      content.length > 0 ? [{ type: 'paragraph', id, content }] : [];
    append(
      blocks,
      this.embeds(embeds, scope, content.length > 0 ? id : undefined),
    );
    return blocks;
  }

  /** The blocks of images and attachments met in text; `from`: the text block they were in, if it stays. */
  private embeds(
    embeds: readonly Embed[],
    scope: string | undefined,
    from: string | undefined,
  ): Block[] {
    return embeds.map((embed) => {
      const block = this.embed(embed, scope);
      if (from !== undefined) {
        this.note(
          block.id,
          'moved-out-of-text',
          `${quote(embed.raw)} stood inside the text of block "${from}"; it is placed after it.`,
        );
      }
      return block;
    });
  }

  private embed(embed: Embed, scope: string | undefined): Block {
    const bytes =
      this.attachments.get(embed.file) ??
      this.attachments.get(safeDecode(embed.file));
    if (!bytes) {
      const id = this.ids.next(scope, 'raw');
      this.note(
        id,
        'missing-file',
        `The file "${embed.file}" is not in the export; ${quote(embed.raw)} is kept verbatim (passthrough).`,
      );
      return {
        type: 'passthrough',
        id,
        format: WIKI_PASSTHROUGH_FORMAT,
        raw: embed.raw,
      };
    }
    let asset = this.hashes.get(bytes);
    if (asset === undefined) {
      asset = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
      this.hashes.set(bytes, asset);
    }
    if (!this.context.assets.has(asset)) {
      this.context.assets.set(asset, bytes);
      this.addedAssets.push(asset);
    }
    if (embed.kind === 'attachment') {
      const fileName = toFileName(embed.file) ?? 'file';
      return {
        type: 'attachment',
        id: this.ids.next(scope, 'file'),
        asset,
        name: (oneLine(embed.text ?? '') || fileName).slice(0, 200),
        fileName,
        mediaType: mediaTypeOf(fileName),
        size: bytes.length,
      };
    }
    const id = this.ids.next(scope, 'img');
    const settings = new Map(embed.settings);
    let alt =
      oneLine(settings.get('alt') ?? '') ||
      oneLine(settings.get('title') ?? '');
    if (!alt) {
      alt = oneLine(embed.file.replace(/\.[^.]+$/, '')) || embed.file;
      this.note(
        id,
        'no-alt',
        `The image "${embed.file}" has no alternative text; its file name is used. Write one.`,
      );
    }
    const title = oneLine(settings.get('title') ?? '');
    const width = /^(\d{1,3})%$/.exec(settings.get('width') ?? '');
    settings.delete('alt');
    settings.delete('title');
    const percent = width ? Number(width[1]) : undefined;
    if (percent !== undefined && percent > 0 && percent <= 100)
      settings.delete('width');
    if (settings.size > 0) {
      this.note(
        id,
        'image-setting',
        `The image settings ${[...settings.keys()].map((k) => `"${k}"`).join(', ')} of "${embed.file}" have no counterpart; they are left out.`,
      );
    }
    return {
      type: 'image',
      id,
      asset,
      alt: alt.slice(0, 1000),
      ...(title && { title: [{ type: 'text', text: title } as TextNode] }),
      ...(percent !== undefined &&
        percent > 0 &&
        percent <= 100 && { width: percent }),
    };
  }

  private list(
    lines: readonly ListLine[],
    scope: string | undefined,
    top: boolean,
  ): Block[] {
    const result: Block[] = [];
    const open: { depth: number; ordered: boolean; list: List }[] = [];
    for (const line of lines) {
      let depth = line.markers.length;
      if (depth > MAX_LIST_DEPTH) {
        depth = MAX_LIST_DEPTH;
        this.note(
          open[open.length - 1]?.list.id ?? scope,
          'too-deep',
          `The list item ${quote(line.text)} is nested deeper than ${MAX_LIST_DEPTH} levels; it is placed at level ${MAX_LIST_DEPTH}.`,
        );
      }
      const ordered = line.markers.endsWith('#');
      while (open.length > 0 && (open[open.length - 1]?.depth ?? 0) > depth)
        open.pop();
      const last = open[open.length - 1];
      if (last && last.depth === depth && last.ordered !== ordered) open.pop();
      let current = open[open.length - 1];
      if (!current || current.depth < depth) {
        const parentItem = current?.list.items[current.list.items.length - 1];
        const list: List = {
          type: 'list',
          id: this.ids.next(parentItem?.id ?? scope, 'l'),
          ordered,
          items: [],
        };
        if (parentItem) parentItem.blocks.push(list);
        else result.push(list);
        current = { depth, ordered, list };
        open.push(current);
      }
      const id = this.ids.next(current.list.id, 'i');
      const { content, embeds } = this.inline(line.text, id);
      const blocks = this.embeds(
        embeds,
        current.list.id,
        content.length > 0 ? id : undefined,
      );
      const fallback = embeds[0] ? oneLine(embeds[0].file) : '';
      if (content.length === 0 && !fallback) continue;
      const item: Item = {
        id,
        content:
          content.length > 0 ? content : [{ type: 'text', text: fallback }],
        blocks,
      };
      current.list.items.push(item);
      // Its place, ID, content and blocks, and at least 5 values a block
      // in it (its content was counted as it was made).
      this.charge(4 + 5 * blocks.length);
    }
    // A nested list whose items all came out empty is left out with them.
    const prune = (item: Item) => {
      item.blocks = item.blocks.filter(
        (b) =>
          b.type !== 'list' || (b.items.forEach(prune), b.items.length > 0),
      );
    };
    for (const block of result)
      if (block.type === 'list') block.items.forEach(prune);
    return result
      .filter((block) => block.type !== 'list' || block.items.length > 0)
      .map((block) =>
        top &&
        block.type === 'list' &&
        block.ordered &&
        this.mapping.orderedLists === 'procedure'
          ? { type: 'procedure', id: block.id, steps: block.items }
          : block,
      );
  }

  private table(
    rows: readonly { cells: readonly { header: boolean; text: string }[] }[],
    scope: string | undefined,
  ): Block[] {
    const width = rows.reduce((w, r) => Math.max(w, r.cells.length), 0);
    if (width === 0) return [];
    // Padding every row to the widest could multiply a page many times over:
    // a table, or the page's tables together, past the content model's caps
    // stays as written.
    const cells = width * rows.length;
    const values = tableValues(rows, width);
    const tooLarge =
      tableTooLarge(width, rows.length) ??
      tablesTooLarge(this.tableCells + cells) ??
      (this.valuesSoFar + values > MAX_MODULE_TABLE_VALUES
        ? `the tables of one module hold at most about ${MAX_MODULE_TABLE_VALUES.toLocaleString('en')} values here, within the import's limit on one module`
        : undefined) ??
      (this.bundleTables.values + values > MAX_BUNDLE_TABLE_VALUES
        ? `the tables of one bundle hold at most about ${MAX_BUNDLE_TABLE_VALUES.toLocaleString('en')} values together, within the import's limit on a bundle`
        : undefined);
    if (tooLarge) {
      const raw = rows
        .map(
          (row) =>
            `${row.cells.map((c) => `${c.header ? '||' : '|'}${c.text || ' '}`).join('')}${row.cells[row.cells.length - 1]?.header ? '||' : '|'}`,
        )
        .join('\n');
      const id = this.ids.next(scope, 'raw');
      this.note(
        id,
        'table-too-large',
        `A table of ${rows.length} rows and ${width} columns is past what the content model holds (${tooLarge}); it is kept verbatim (passthrough), any files in it as written.`,
      );
      return [
        { type: 'passthrough', id, format: WIKI_PASSTHROUGH_FORMAT, raw },
      ];
    }
    this.tableCells += cells;
    this.valuesSoFar += values;
    this.bundleTables.values += values;
    const id = this.ids.next(scope, 't');
    const header = rows[0]?.cells.every((c) => c.header) ?? false;
    const after: Block[] = [];
    const padded: number[] = [];
    let headerCells = 0;
    const table: Table = {
      type: 'table',
      id,
      columns: Array.from({ length: width }, () => ({ width: 1 })),
      header,
      rows: rows.map((row, r) => {
        if (row.cells.length < width) padded.push(r + 1);
        const inHeader = header && r === 0;
        const cells = Array.from({ length: width }, (_, c) => {
          const cell = row.cells[c];
          if (!cell) return { blocks: [] as Block[] };
          if (cell.header && !inHeader) headerCells += 1;
          const cellId = this.ids.next(id, 'c');
          const { content, embeds } = this.inline(cell.text, cellId, true);
          const blocks: Block[] =
            content.length > 0
              ? [{ type: 'paragraph', id: cellId, content }]
              : [];
          const embedded = this.embeds(
            embeds,
            id,
            content.length > 0 ? cellId : undefined,
          );
          // A header cell holds one paragraph at most: its files go after the table.
          append(inHeader ? after : blocks, embedded);
          return { blocks };
        });
        return { cells };
      }),
    };
    if (headerCells > 0) {
      this.note(
        id,
        'header-cell',
        `${headerCells} header cell${headerCells === 1 ? '' : 's'} outside the first row ${headerCells === 1 ? 'is' : 'are'} kept as ordinary cells.`,
      );
    }
    if (padded.length > 0) {
      this.note(
        id,
        'row-padded',
        `Row${padded.length === 1 ? '' : 's'} ${padded.join(', ')} had fewer cells than the table's ${width} columns; padded with empty cells.`,
      );
    }
    return [table, ...after];
  }

  private code(
    node: Extract<WikiNode, { kind: 'code' }>,
    scope: string | undefined,
  ): Block[] {
    const settings = macroSettings(node.settings);
    const language =
      node.name === 'code'
        ? (settings.get('language') ?? settings.get(''))
        : undefined;
    const blocks: Block[] = [];
    const title = oneLine(settings.get('title') ?? '');
    if (title) {
      blocks.push({
        type: 'paragraph',
        id: this.ids.next(scope, 'p'),
        content: [{ type: 'text', text: title, marks: [{ type: 'strong' }] }],
      });
    }
    const id = this.ids.next(scope, 'code');
    const validLanguage =
      language && /^[A-Za-z0-9][A-Za-z0-9+#._-]*$/.test(language)
        ? language
        : undefined;
    const ignored = [...settings.keys()].filter(
      (k) => k !== 'title' && k !== 'language' && k !== '',
    );
    if (ignored.length > 0 || (language && !validLanguage)) {
      this.note(
        id,
        'macro-frame',
        `The settings of {${node.name}:${node.settings}} other than its language and title are left out.`,
      );
    }
    // Its place, type, ID and text, at least.
    this.charge(4);
    blocks.push({
      type: 'literal',
      id,
      text: node.text,
      ...(validLanguage && { language: validLanguage.toLowerCase() }),
    });
    return blocks;
  }

  private container(
    node: Extract<WikiNode, { kind: 'container' }>,
    scope: string | undefined,
  ): Block[] {
    const settings = macroSettings(node.settings);
    const safety = this.mapping.safety[node.name];
    const kind = this.mapping.admonitions[node.name];
    if (safety) {
      const id = this.ids.next(scope, 'safety');
      let blocks = this.inner(node.children, id);
      let hazard = settings.get('title')
        ? this.title(settings.get('title') as string, id)
        : [];
      if (hazard.length === 0 && blocks[0]?.type === 'paragraph') {
        hazard = blocks[0].content.map((n): Inline =>
          n.type === 'hardBreak' ? { type: 'text', text: ' ' } : n,
        );
        blocks = blocks.slice(1);
      }
      if (hazard.length === 0) {
        hazard = [{ type: 'text', text: node.name }];
        this.note(
          id,
          'macro-frame',
          `The {${node.name}} notice names no hazard (no title, no first paragraph); "${node.name}" stands in for it. Write one.`,
        );
      }
      return [
        {
          type: 'safety',
          id,
          severity: safety.severity,
          hazard,
          symbols: safety.symbols,
          blocks,
        },
      ];
    }
    if (kind) {
      const id = this.ids.next(scope, 'note');
      const title = oneLine(settings.get('title') ?? '');
      const titleId = title ? this.ids.next(id, 'p') : undefined;
      const blocks = [
        ...(titleId
          ? [
              {
                type: 'paragraph',
                id: titleId,
                content: strong(this.title(title, titleId)),
              } as Block,
            ]
          : []),
        ...this.inner(node.children, id),
      ];
      return blocks.length > 0
        ? [{ type: 'admonition', id, kind, blocks }]
        : [];
    }
    // A quotation, a panel, an expandable section: the content without its frame.
    const id = this.ids.next(scope, 'part');
    const title = oneLine(settings.get('title') ?? '');
    const titleId = title ? this.ids.next(id, 'p') : undefined;
    const blocks = this.inner(node.children, id);
    if (node.name === 'quote') {
      this.note(
        blocks[0]?.id ?? scope,
        'quote',
        'A quotation is kept as plain paragraphs.',
      );
    } else {
      this.note(
        blocks[0]?.id ?? scope,
        'macro-frame',
        `The frame of {${node.name}${node.settings ? `:${node.settings}` : ''}} is left out; its content is kept${title ? ', its title as strong text' : ''}.`,
      );
    }
    return [
      ...(titleId
        ? [
            {
              type: 'paragraph',
              id: titleId,
              content: strong(this.title(title, titleId)),
            } as Block,
          ]
        : []),
      ...blocks,
    ];
  }
}

/** `title=Text|language=yaml` (or a bare first word, under ""). */
function macroSettings(text: string): Map<string, string> {
  const settings = new Map<string, string>();
  for (const part of text.split('|')) {
    if (!part.trim()) continue;
    const eq = part.indexOf('=');
    if (eq === -1) settings.set('', part.trim());
    else
      settings.set(
        part.slice(0, eq).trim().toLowerCase(),
        part.slice(eq + 1).trim(),
      );
  }
  return settings;
}

function strong(nodes: readonly Inline[]): Inline[] {
  return nodes.map((n) =>
    n.type === 'text' && !n.marks?.some((m) => m.type === 'strong')
      ? {
          ...n,
          marks: [...(n.marks ?? []), { type: 'strong' as const }].sort(
            markOrder,
          ),
        }
      : n,
  );
}

function markOrder(a: Mark, b: Mark): number {
  return MARK_ORDER.indexOf(a.type) - MARK_ORDER.indexOf(b.type);
}

function plain(nodes: readonly Inline[]): string {
  return textOnly(nodes)
    .map((n) => n.text)
    .join('');
}

const MEDIA_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  zip: 'application/zip',
  json: 'application/json',
  xml: 'application/xml',
  txt: 'text/plain',
  csv: 'text/csv',
  md: 'text/markdown',
  html: 'text/html',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  webp: 'image/webp',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

function mediaTypeOf(fileName: string): string {
  const extension =
    /\.([A-Za-z0-9]+)$/.exec(fileName)?.[1]?.toLowerCase() ?? '';
  return MEDIA_TYPES[extension] ?? 'application/octet-stream';
}

/** A lowercase slug: letters and digits, words joined by "-". */
export function slug(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function titleKey(title: string): string {
  return oneLine(title).toLowerCase();
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function safeDecode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/** Appends one by one: a spread of a very long list overflows the stack. */
function append<T>(out: T[], items: readonly T[]): void {
  for (const item of items) out.push(item);
}
