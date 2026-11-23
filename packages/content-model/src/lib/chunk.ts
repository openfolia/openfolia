import type { Block, Faq, Item, Table } from './blocks.js';
import type { Condition } from './condition.js';
import type { ProjectConfig } from './config.js';
import type { Inline } from './inline.js';
import { resolveOutputLabels } from './labels.js';
import {
  codeBlock,
  codeSpan,
  escapeLineStart,
  escapeMarkdown,
  inlineMarkdown,
  type InlineContext,
} from './markdown.js';
import type { Module } from './module.js';
import { assertTableWithinLimits } from './table-limits.js';
import { printModule } from './asciidoc/print.js';
import { formatCondition } from './asciidoc/condition-syntax.js';
import { imagesById, numberCallouts } from './callouts.js';
import { plainTextOf } from './plain-text.js';
import { sha256Hex } from './sha256.js';
import { sourceHashes } from './translation.js';
import { walk } from './walk.js';
import { blockPlaces, type BlockPlace } from './block-places.js';
import { evaluateCondition, type VariantValues } from './variant.js';
import {
  Expansion,
  type ExpansionBudget,
  type ExpansionLimits,
  weightOf,
} from './expansion.js';

/**
 * A retrieval chunk: one module in one language as Markdown, with the
 * metadata a retrieval pipeline filters on and the hashes it re-embeds by;
 * or one FAQ entry of it (`entry`), which `toChunks` gives a chunk of its
 * own besides the module's.
 */
export interface Chunk {
  moduleId: string;
  lang: string;
  title: string;
  moduleType: string;
  /** Absent: the most restricted level applies. */
  audience?: string;
  facets: Record<string, string[]>;
  keywords: string[];
  /**
   * The conditions of the variant blocks in the text (the module's own and
   * those of the modules it includes), as `when` text, in document order,
   * each once.
   */
  conditions: string[];
  /** The module's text as Markdown, its title as the first heading. */
  text: string;
  /**
   * SHA-256 (64 lowercase hex) of the module's own source: of its
   * translatable units' source hashes (`sourceHashes`) by block ID, in
   * document order; for a module without any, of its canonical AsciiDoc.
   */
  sourceHash: string;
  /** SHA-256 (64 lowercase hex) of `text`: equal texts, equal hashes. */
  contentHash: string;
  /**
   * The module files the text was made from: this module first, then each
   * module it includes (by reference, also nested) once, in the language
   * read (a missing translation falls back to the source language).
   */
  sources: { moduleId: string; lang: string }[];
  /**
   * Every other module the text depends on, whether it was included or
   * not: each module a reference names (also one missing, outside the
   * scope or too restricted) and each cross-reference target showing its
   * title. Sorted; for telling which chunks a changed file may change.
   */
  dependsOn: string[];
  /**
   * Set on an FAQ entry's chunk: its text is that entry (the question as
   * `#` heading, then its answer), not the whole module, and its hashes,
   * sources, dependencies and conditions are the entry's. The metadata
   * above stays the module's.
   */
  entry?: ChunkEntry;
}

/** The FAQ entry a chunk holds. */
export interface ChunkEntry {
  /** The entry's block ID in the module. */
  blockId: string;
  /** The question as plain text (an attribute as `{name}`). */
  question: string;
  /**
   * The conditions of the variant blocks the entry stands in, outermost
   * first: the entry is in a variant's text only where all of them hold.
   * Also listed (as `when` text) in `conditions`.
   */
  within: Condition[];
}

export interface ChunkInput {
  module: Module;
  config: ProjectConfig;
  /**
   * Loads a module a reference names, in a language; undefined when there
   * is none, or the reader may not see it (the caller scopes it). One left
   * out is left out of the text, silently.
   */
  loadModule: (id: string, lang: string) => Module | undefined;
  /**
   * The variant to resolve variant blocks for: a block whose condition
   * does not hold (or tests an attribute the variant does not set) is left
   * out. Without one, every variant block is kept, headed by its condition.
   */
  variant?: VariantValues;
  /**
   * What a set of chunks may expand to together (#684): every count of this call is also spent
   * there, and `ExpansionBudgetError` is thrown once it is spent. Without one, only the limits
   * of #679 hold, on this call's own count.
   */
  budget?: ExpansionBudget;
  /**
   * The limits of #679 this call is held to: `EXPANSION_LIMITS` when absent, as everywhere
   * outside tests (#726: a test gives smaller ones to cross them with small content).
   */
  limits?: ExpansionLimits;
}

/**
 * One module in its language as a retrieval chunk. Module references are
 * inlined as `resolveManual` inlines them (a missing translation falls
 * back to the source language, cycles are not followed), leaving out a
 * module more restricted than this one (its audience is above this one's,
 * or not configured), so the chunk's audience holds for all of its text.
 * Text attributes stay `{name}` (a module has no values of its own; a
 * manual gives them). Block IDs take no part in the text, and the text is
 * made from the parsed module, so formatting of the file changes neither
 * the text nor `contentHash`.
 */
export function toChunk(input: ChunkInput): Chunk {
  return chunker(input).module();
}

/**
 * The module's chunk (`toChunk`) first, then one chunk per FAQ entry in
 * it, in document order (`Chunk.entry`): an entry in a section, a list, a
 * notice or another entry's answer too, never one a module reference
 * brings in (that one is its own module's). With `variant`, an entry in a
 * variant block whose condition does not hold has none, as it has no text.
 * The module's chunk keeps its entries in its text (the question as a
 * bold line, then the answer).
 */
export function toChunks(input: ChunkInput): Chunk[] {
  const chunks = chunker(input);
  return [chunks.module(), ...chunks.entries()];
}

/** The chunks of one module: its own, and its FAQ entries'. */
function chunker(input: ChunkInput): {
  module: () => Chunk;
  entries: () => Chunk[];
} {
  const { module, config, loadModule, variant, budget, limits } = input;
  const lang = module.meta.lang;
  const { labels } = resolveOutputLabels(lang, config.outputLabels);
  const versionAttributes = new Set(
    config.variantAttributes
      .filter((a) => a.kind === 'version')
      .map((a) => a.id),
  );
  const audienceRank = (id: string | undefined): number | undefined => {
    if (id === undefined) return config.audiences.length - 1;
    const rank = config.audiences.findIndex((a) => a.id === id);
    return rank === -1 ? undefined : rank;
  };
  const maxAudience = audienceRank(module.meta.audience) ?? -1;

  // What the chunk being written was made from; fresh for each chunk.
  let sources = new Map<string, { moduleId: string; lang: string }>();
  let conditions = new Set<string>();
  let dependsOn = new Set<string>();
  const start = (within: readonly Condition[]) => {
    sources = new Map([
      [`${lang}/${module.id}`, { moduleId: module.id, lang }],
    ]);
    conditions = new Set(within.map(formatCondition));
    dependsOn = new Set();
  };

  // What these chunks have expanded to (#681): held to the limits of #679, for this call only,
  // and spent from the set's budget when there is one (#684).
  const expansion = new Expansion(budget, limits);

  /** `load`'s answers, by module ID: each module is read once, however many paths lead to it. */
  const loaded = new Map<string, Module | undefined>();
  const load = (id: string): Module | undefined => {
    if (loaded.has(id)) return loaded.get(id);
    const found = lookup(id);
    loaded.set(id, found);
    return found;
  };
  const lookup = (id: string): Module | undefined => {
    const own = loadModule(id, lang);
    const found =
      own ??
      (lang === config.languages.source
        ? undefined
        : loadModule(id, config.languages.source));
    if (!found) return undefined;
    const rank = audienceRank(found.meta.audience);
    return rank !== undefined && rank <= maxAudience ? found : undefined;
  };

  const images = imagesById(module.blocks);
  // With a variant, only what it shows: no legend of a callout, or of an image in a variant
  // block, that it leaves out (the chunk leaves out their text too).
  const shown = (when: Condition | undefined) =>
    !variant || when === undefined || holds(when, variant, versionAttributes);
  for (const { kind, node } of walk(module.blocks)) {
    if (kind === 'block' && node.type === 'variant' && !shown(node.when)) {
      for (const id of imagesById(node.blocks).keys()) images.delete(id);
    }
  }
  const context: InlineContext = {
    attribute: (name) => `{${name}}`,
    xrefTitle: (id) => {
      if (id !== module.id) dependsOn.add(id);
      const title =
        id === module.id ? module.meta.title : (load(id)?.meta.title ?? id);
      // A title shown once per path the cross-reference is reached over.
      expansion.grow(0, title.length);
      return title;
    },
    // A chunk shows no image, so a number would say nothing: the callout's
    // legend in brackets instead (a callout on an image of the module itself,
    // shown in the variant).
    callout: (block, callout) => {
      const legend = images
        .get(block)
        ?.callouts?.find((c) => c.id === callout && shown(c.when))?.legend;
      const text = legend ? `(${plainTextOf(legend).text})` : '[callout]';
      expansion.grow(0, text.length);
      return text;
    },
  };
  const inline = (nodes: readonly Inline[]) => inlineMarkdown(nodes, context);

  // What the writer writes around nested blocks counts as text, once per level.
  const writer = new BlockWriter((chars) => expansion.grow(0, chars));

  const blocksOf = (
    blocks: readonly Block[],
    depth: number,
    stack: readonly string[],
  ): string[] => expansion.nested(() => blocksIn(blocks, depth, stack));

  /** Per module, its blocks by ID, for the references to one block of it (#223): once per call. */
  const placesByModule = new Map<Module, ReadonlyMap<string, BlockPlace>>();
  /**
   * The one block of `included` a module reference names (#223), as its module's inclusion
   * would write it: with a variant, nothing when a variant block around it is not shown; without,
   * inside those variant blocks' quotes. A block the module does not have writes nothing (its
   * check says so).
   */
  const oneBlockOf = (
    included: Module,
    id: string,
    depth: number,
    stack: readonly string[],
  ): string[] => {
    let places = placesByModule.get(included);
    if (!places) {
      places = blockPlaces(included.blocks);
      placesByModule.set(included, places);
      // Building the index walks the whole module: counted once per call.
      expansion.grow(places.size);
    }
    const place = places.get(id);
    if (!place) return [];
    if (variant && !place.within.every((v) => shown(v.when))) return [];
    // Its content, once for each path it is included over.
    expansion.weighBlock(place.block);
    sources.set(`${included.meta.lang}/${included.id}`, {
      moduleId: included.id,
      lang: included.meta.lang,
    });
    let written = blocksOf([place.block], depth, stack);
    if (!variant) {
      for (const around of [...place.within].reverse()) {
        const when = formatCondition(around.when);
        conditions.add(when);
        written = [writer.variant(when, written)];
      }
    }
    return written;
  };

  const blocksIn = (
    blocks: readonly Block[],
    depth: number,
    stack: readonly string[],
  ): string[] =>
    blocks.flatMap((block): string[] => {
      switch (block.type) {
        case 'variant': {
          const when = formatCondition(block.when);
          conditions.add(when);
          if (variant) {
            return holds(block.when, variant, versionAttributes)
              ? blocksOf(block.blocks, depth, stack)
              : [];
          }
          return [writer.variant(when, blocksOf(block.blocks, depth, stack))];
        }
        case 'moduleRef': {
          // Each reference met counts, a cycle's too (#679).
          expansion.grow(1);
          if (stack.includes(block.module)) return [];
          dependsOn.add(block.module);
          const included = load(block.module);
          if (!included) return [];
          if (block.block !== undefined) {
            return oneBlockOf(included, block.block, depth, [
              ...stack,
              included.id,
            ]);
          }
          // Its content, once for each path it is included over.
          expansion.weigh(included);
          sources.set(`${included.meta.lang}/${included.id}`, {
            moduleId: included.id,
            lang: included.meta.lang,
          });
          return blocksOf(included.blocks, depth, [...stack, included.id]);
        }
        case 'section':
          return [
            writer.heading(depth + 1, inline(block.title)),
            ...blocksOf(block.blocks, depth + 1, stack),
          ];
        case 'paragraph':
          return [writer.paragraph(inline(block.content))];
        case 'list':
          return [
            writer.list(
              block.items.map((item) => itemOf(item, depth, stack)),
              block.ordered,
            ),
          ];
        case 'procedure':
          return [
            ...(block.title ? [writer.caption(inline(block.title))] : []),
            writer.list(
              block.steps.map((item) => itemOf(item, depth, stack)),
              true,
            ),
          ];
        case 'table':
          return [
            ...(block.title ? [writer.caption(inline(block.title))] : []),
            writer.table(block, (cell) => blocksOf(cell, depth, stack)),
          ];
        case 'image': {
          // Its legend (#546), numbered as the variant shows it: only the callouts it shows.
          const legend = numberCallouts(block, (c) => shown(c.when))
            .map(({ callout, number }) => `${number} ${inline(callout.legend)}`)
            .join('; ');
          return [
            writer.labelled(
              labels.figure,
              [
                ...(block.title ? [inline(block.title)] : []),
                escapeMarkdown(block.alt),
                ...(legend ? [legend] : []),
              ].join(' — '),
            ),
          ];
        }
        case 'attachment':
          return [
            writer.labelled(
              labels.attachment,
              [block.name, ...(block.description ? [block.description] : [])]
                .map(escapeMarkdown)
                .join(' — '),
            ),
          ];
        case 'safety':
          return [
            writer.quote(
              `**${escapeMarkdown(labels[block.severity])}:** ${inline(block.hazard)}`,
              blocksOf(block.blocks, depth, stack),
            ),
          ];
        case 'admonition':
          return [
            writer.quote(
              `**${escapeMarkdown(labels[block.kind])}:**`,
              blocksOf(block.blocks, depth, stack),
            ),
          ];
        case 'faq':
          return [
            writer.caption(inline(block.question)),
            ...blocksOf(block.blocks, depth, stack),
          ];
        case 'literal':
          return [codeBlock(block.text, block.language)];
        case 'passthrough':
          return [codeBlock(block.raw, block.format)];
        case 'pageBreak':
          return [];
        default:
          return block satisfies never;
      }
    });

  const itemOf = (
    item: Item,
    depth: number,
    stack: readonly string[],
  ): string[] => [
    writer.paragraph(inline(item.content)),
    ...blocksOf(item.blocks, depth, stack),
  ];

  // The heading is rendered after `start()`, so a cross-reference in it counts for the chunk.
  const chunkOf = (
    heading: () => string,
    blocks: readonly Block[],
    sourceHash: string,
    entry?: ChunkEntry,
  ): Chunk => {
    start(entry?.within ?? []);
    // The module's own content, or the entry's, counts as an included module's does.
    if (entry) {
      const weight = weightOf(blocks);
      expansion.grow(weight.nodes, weight.chars, weight.cells);
    } else {
      expansion.weigh(module);
    }
    const text = [
      writer.heading(1, heading()),
      ...blocksOf(blocks, 1, [module.id]),
    ].join('\n\n');
    return {
      moduleId: module.id,
      lang,
      title: module.meta.title,
      moduleType: module.meta.type,
      ...(module.meta.audience !== undefined && {
        audience: module.meta.audience,
      }),
      facets: module.meta.facets,
      keywords: module.meta.keywords ?? [],
      conditions: [...conditions],
      text,
      sourceHash,
      contentHash: sha256Hex(text),
      sources: [...sources.values()],
      dependsOn: [...dependsOn].filter((id) => id !== module.id).sort(),
      ...(entry && { entry }),
    };
  };

  return {
    module: () =>
      chunkOf(
        () => escapeMarkdown(module.meta.title),
        module.blocks,
        moduleSourceHash(module),
      ),
    entries: () => {
      const hashes = sourceHashes(module);
      return faqEntries(module.blocks, []).flatMap(({ faq, within }) => {
        if (
          variant &&
          !within.every((when) => holds(when, variant, versionAttributes))
        )
          return [];
        // The entry's own source: its units' hashes, in document order.
        const own = [...walk([faq])].flatMap(({ kind, node }) =>
          // An image's callouts are units of their own (#548).
          [
            node.id,
            ...(kind === 'block' && node.type === 'image'
              ? (node.callouts ?? []).map((c) => c.id)
              : []),
          ].flatMap((id) => {
            const hash = hashes.get(id);
            return hash === undefined ? [] : [[id, hash]];
          }),
        );
        return [
          chunkOf(
            () => inline(faq.question),
            faq.blocks,
            sha256Hex(JSON.stringify(own)),
            {
              blockId: faq.id,
              question: plainTextOf(faq.question).text,
              within,
            },
          ),
        ];
      });
    },
  };
}

/** The FAQ entries in `blocks`, at any depth, with the conditions of the variant blocks around each. */
function faqEntries(
  blocks: readonly Block[],
  within: Condition[],
): { faq: Faq; within: Condition[] }[] {
  return blocks.flatMap((block) => {
    switch (block.type) {
      case 'faq':
        return [{ faq: block, within }, ...faqEntries(block.blocks, within)];
      case 'variant':
        return faqEntries(block.blocks, [...within, block.when]);
      case 'section':
      case 'safety':
      case 'admonition':
        return faqEntries(block.blocks, within);
      case 'list':
        return block.items.flatMap((item) => faqEntries(item.blocks, within));
      case 'procedure':
        return block.steps.flatMap((item) => faqEntries(item.blocks, within));
      case 'table':
        return block.rows.flatMap((row) =>
          row.cells.flatMap((cell) => faqEntries(cell.blocks, within)),
        );
      case 'paragraph':
      case 'image':
      case 'attachment':
      case 'moduleRef':
      case 'literal':
      case 'passthrough':
      case 'pageBreak':
        return [];
      default:
        return block satisfies never;
    }
  });
}

/** See `Chunk.sourceHash`. */
export function moduleSourceHash(module: Module): string {
  const hashes = [...sourceHashes(module)];
  return hashes.length > 0
    ? sha256Hex(JSON.stringify(hashes))
    : sha256Hex(printModule(module));
}

function holds(
  condition: Condition,
  variant: VariantValues,
  versionAttributes: ReadonlySet<string>,
): boolean {
  return evaluateCondition(condition, variant, { versionAttributes });
}

/** Markdown for blocks, each a string of one line or more, joined by blank lines. */
class BlockWriter {
  /**
   * `charge`: told the length of each quote, list and table written, which hold blocks written
   * before, and of a table's grid before it is made.
   */
  constructor(private readonly charge: (chars: number) => void) {}

  heading(level: number, text: string): string {
    return `${'#'.repeat(Math.min(level, 6))} ${oneLine(text)}`;
  }

  paragraph(text: string): string {
    return text.split('\n').map(escapeLineStart).join('\n');
  }

  /** A title of a procedure or table: a bold line. */
  caption(text: string): string {
    return `**${oneLine(text)}**`;
  }

  /** `*Label:* text`, for an image or an attachment. */
  labelled(label: string, text: string): string {
    return `*${escapeMarkdown(label)}:* ${text}`;
  }

  /** A variant block kept with its condition: a quote headed by it. */
  variant(when: string, body: string[]): string {
    return this.quote(`**when** ${codeSpan(when)}`, body);
  }

  quote(head: string, body: string[]): string {
    const quoted = [head, ...body]
      .join('\n\n')
      .split('\n')
      .map((line) => (line === '' ? '>' : `> ${line}`))
      .join('\n');
    this.charge(quoted.length);
    return quoted;
  }

  /** Items (each its own text, then its blocks), numbered or bulleted; loose when an item has blocks. */
  list(items: string[][], ordered: boolean): string {
    const loose = items.some((parts) => parts.length > 1);
    const rendered = items.map((parts, index) => {
      const marker = ordered ? `${index + 1}. ` : '- ';
      const indent = ' '.repeat(marker.length);
      return parts
        .join('\n\n')
        .split('\n')
        .map((line, i) =>
          i === 0 ? marker + line : line === '' ? '' : indent + line,
        )
        .join('\n');
    });
    const list = rendered.join(loose ? '\n\n' : '\n');
    this.charge(list.length);
    return list;
  }

  /**
   * A GFM table: the header row (empty cells when the table has none), a
   * cell's blocks on one line joined by `<br>`, a spanned cell's text in
   * its first column and row and the cells it covers empty.
   */
  table(table: Table, blocksOf: (blocks: Block[]) => string[]): string {
    // Never a table past the caps (#686): content that went through the schema has none.
    assertTableWithinLimits(table);
    const width = table.columns.length;
    // The grid is a cell per row and column, spanned or not, written as at least `| ` each:
    // counted before it is made, as a table of few cells may span a large area (#681).
    this.charge(table.rows.length * width * 3);
    const grid: string[][] = [];
    const taken: boolean[][] = [];
    table.rows.forEach((row, r) => {
      grid[r] ??= Array.from({ length: width }, () => '');
      taken[r] ??= Array.from({ length: width }, () => false);
      let c = 0;
      for (const cell of row.cells) {
        while (c < width && taken[r]?.[c]) c++;
        if (c >= width) break;
        const text = blocksOf(cell.blocks)
          .join('\n')
          .split('\n')
          .filter((line) => line !== '')
          // A hard break's backslash (an odd one at the end; an even run is
          // escaped text) would escape the `<br>`.
          .map((line) => line.replace(/(?<!\\)((?:\\\\)*)\\$/, '$1'))
          .join('<br>')
          .replace(/(?<!\\)\|/g, '\\|');
        (grid[r] as string[])[c] = text;
        const rows = cell.rowspan ?? 1;
        const cols = cell.colspan ?? 1;
        for (let dr = 0; dr < rows && r + dr < table.rows.length; dr++) {
          grid[r + dr] ??= Array.from({ length: width }, () => '');
          taken[r + dr] ??= Array.from({ length: width }, () => false);
          for (let dc = 0; dc < cols && c + dc < width; dc++) {
            (taken[r + dr] as boolean[])[c + dc] = true;
          }
        }
        c += cols;
      }
    });
    const rows = grid.slice(0, table.rows.length);
    const line = (cells: string[]) => `| ${cells.join(' | ')} |`;
    const header =
      table.header && rows.length > 0
        ? (rows.shift() as string[])
        : Array.from({ length: width }, () => '');
    const align = table.columns.map((column) =>
      column.align === 'center'
        ? ':---:'
        : column.align === 'right'
          ? '---:'
          : '---',
    );
    const written = [
      line(header),
      `| ${align.join(' | ')} |`,
      ...rows.map(line),
    ].join('\n');
    this.charge(written.length);
    return written;
  }
}

/** Text on one line: line breaks become spaces (a heading cannot hold them). */
function oneLine(text: string): string {
  return text.replace(/\\\n/g, ' ').replace(/\n/g, ' ');
}
