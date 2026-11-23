import { z } from 'zod';
import { Condition } from './condition.js';
import {
  AssetRef,
  BlockId,
  ConfigKey,
  FileName,
  MediaType,
  ModuleId,
  SingleLine,
} from './ids.js';
import { Inline, InlineContent, InlineTitle } from './inline.js';
import { SAFETY_SEVERITIES } from './safety.js';
import { TABLE_TOO_LARGE, tableTooLarge } from './table-limits.js';
import {
  CALLOUT_LEGENDS,
  CALLOUT_ORDERS,
  type CalloutLegend,
  type CalloutOrder,
  MAX_CALLOUTS,
} from './callouts.js';

/**
 * Every block carries a stable `id`. Containers hold `blocks`; text-bearing
 * blocks hold `content` (inline). Types are written out by hand because the
 * tree is recursive; each schema below is checked against its type.
 */
export interface Paragraph {
  type: 'paragraph';
  id: string;
  content: Inline[];
}

export interface Section {
  type: 'section';
  id: string;
  title: Inline[];
  blocks: Block[];
}

/** A list item or procedure step: its own text, plus optional attached blocks (a note, an image, a sub-list). */
export interface Item {
  id: string;
  content: Inline[];
  blocks: Block[];
}

export interface List {
  type: 'list';
  id: string;
  ordered: boolean;
  items: Item[];
}

/** Numbered task steps. Rendered differently from an ordered list and exported as its own chunk type. */
export interface Procedure {
  type: 'procedure';
  id: string;
  title?: Inline[];
  steps: Item[];
}

export interface TableColumn {
  /** Relative width (a whole number); columns share the table width proportionally. */
  width: number;
  align?: 'left' | 'center' | 'right';
}

/** Cells carry no ID of their own; the blocks inside them do. */
export interface TableCell {
  colspan?: number;
  rowspan?: number;
  /** One paragraph prints as a plain cell; anything else as an AsciiDoc `a|` cell. */
  blocks: Block[];
}

export interface TableRow {
  cells: TableCell[];
}

export interface Table {
  type: 'table';
  id: string;
  title?: Inline[];
  columns: TableColumn[];
  /** Whether the first row is the header row. */
  header: boolean;
  rows: TableRow[];
}

export interface Image {
  type: 'image';
  id: string;
  asset: string;
  /** Translatable alternative text; required for accessibility. */
  alt: string;
  title?: Inline[];
  /** Display width as a percentage of the text column. */
  width?: number;
  /**
   * Numbered markers on this use of the image (#498), not on the asset: the
   * same picture can carry other callouts in another module. Absent: none
   * (never an empty list).
   */
  callouts?: Callout[];
  /** How the callouts are numbered (`CALLOUT_ORDERS`); absent: `reading`. */
  calloutOrder?: CalloutOrder;
  /** Where the legend is printed (`CALLOUT_LEGENDS`); absent: `below`. */
  calloutLegend?: CalloutLegend;
}

/** A point on an image, normalised to it: 0 to 1 from the left and from the top edge. */
export interface CalloutPoint {
  x: number;
  y: number;
}

/**
 * One numbered marker on an image, with its legend entry. Its number is
 * derived (`numberCallouts`), never stored.
 */
export interface Callout {
  /** Unique among the module's block IDs. */
  id: string;
  /** The point it marks. */
  anchor: CalloutPoint;
  /** Where its number is drawn, with a leader line to the anchor; absent: at the anchor. */
  label?: CalloutPoint;
  /** The legend text: one line of inline content, translated with the module. */
  legend: Inline[];
  /** Shown only in variants that match (the conditions of variant blocks). */
  when?: Condition;
  /** One of the configured callout styles (`calloutStyles`); absent: the default style. */
  style?: string;
}

/**
 * A file of any kind readers download from the module (a ZIP of
 * configuration files, a JSON sample, a datasheet). Content-addressed like
 * an image; `name` and `description` are translated per language like alt
 * text, while `fileName`, `mediaType` and `size` describe the stored file
 * (filled in from it when the file is attached, the same in every language).
 */
export interface Attachment {
  type: 'attachment';
  id: string;
  asset: string;
  /** What readers see as the link text; required. */
  name: string;
  /** An optional sentence on what the file is for. */
  description?: string;
  /** The file name a download is saved under, e.g. `config.zip`. */
  fileName: string;
  /** The stored file's media type, e.g. `application/zip`. */
  mediaType: string;
  /** The stored file's size in bytes. */
  size: number;
}

/** A safety message's hazard level (`SAFETY_SEVERITIES`, most severe first). */
export type SafetySeverity = (typeof SAFETY_SEVERITIES)[number];

/**
 * A safety message (ISO 3864-2 / ANSI Z535.6 style): signal word from
 * `severity`, the hazard as its headline, standard symbols from the
 * configured symbol set, and the consequences and measures as blocks.
 */
export interface Safety {
  type: 'safety';
  id: string;
  severity: SafetySeverity;
  hazard: Inline[];
  symbols: string[];
  blocks: Block[];
}

/** Non-safety call-outs. Anything about injury or damage is a `safety` block instead. */
export interface Admonition {
  type: 'admonition';
  id: string;
  kind: 'note' | 'tip' | 'important';
  blocks: Block[];
}

/**
 * A frequently asked question with its answer: the question is one line of
 * inline content, the answer the blocks below it (paragraphs, lists,
 * images, notices). Rendered as a disclosure in HTML, as a bold question
 * over its answer in the PDF, and chunked one entry per chunk.
 */
export interface Faq {
  type: 'faq';
  id: string;
  question: Inline[];
  /** The answer. */
  blocks: Block[];
}

/** Content included only for variants that match `when`. */
export interface Variant {
  type: 'variant';
  id: string;
  when: Condition;
  blocks: Block[];
}

/**
 * Reuse: the referenced module's blocks are placed here at build time, kept in sync. With
 * `block` (#223), only that one block of it (at any depth, its variants applied), not the whole
 * module.
 */
export interface ModuleRef {
  type: 'moduleRef';
  id: string;
  module: string;
  /** The one block of `module` placed here; absent: the whole module. */
  block?: string;
}

/** Preformatted text, e.g. console output or configuration. Not translated. */
export interface Literal {
  type: 'literal';
  id: string;
  text: string;
  language?: string;
}

/**
 * Escape hatch for content an importer could not map. Kept verbatim so
 * nothing is lost, reported by validation, and meant to be cleaned up.
 */
export interface Passthrough {
  type: 'passthrough';
  id: string;
  /** Source format, e.g. "xml" or "asciidoc". */
  format: string;
  raw: string;
}

/**
 * A page break in the PDF: the next block starts a new page (never an empty
 * one). Layout is otherwise the design's job; this is the one place authors
 * choose it. Only at module level or directly in a section, where a page
 * can break; the HTML shows it in the editor's preview only.
 */
export interface PageBreak {
  type: 'pageBreak';
  id: string;
}

export type Block =
  | Paragraph
  | Section
  | List
  | Procedure
  | Table
  | Image
  | Attachment
  | Safety
  | Admonition
  | Faq
  | Variant
  | ModuleRef
  | Literal
  | Passthrough
  | PageBreak;

export const Block: z.ZodType<Block, Block> = z.lazy(() =>
  z.discriminatedUnion('type', [
    ParagraphSchema,
    SectionSchema,
    ListSchema,
    ProcedureSchema,
    TableSchema,
    ImageSchema,
    AttachmentSchema,
    SafetySchema,
    AdmonitionSchema,
    FaqSchema,
    VariantSchema,
    ModuleRefSchema,
    LiteralSchema,
    PassthroughSchema,
    PageBreakSchema,
  ]),
);

/** A bare word such as a source language ("yaml", "c++") or format ("xml"). */
export const Token = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9+#._-]*$/, 'a single word, e.g. "yaml"');

const Blocks = z.array(Block);
const NonEmptyBlocks = z.array(Block).min(1);

const ItemSchema = z.object({
  id: BlockId,
  content: InlineContent,
  blocks: Blocks,
});

const ParagraphSchema = z.object({
  type: z.literal('paragraph'),
  id: BlockId,
  content: InlineContent,
});

const SectionSchema = z.object({
  type: z.literal('section'),
  id: BlockId,
  title: InlineTitle,
  blocks: Blocks,
});

const ListSchema = z.object({
  type: z.literal('list'),
  id: BlockId,
  ordered: z.boolean(),
  items: z.array(ItemSchema).min(1),
});

const ProcedureSchema = z.object({
  type: z.literal('procedure'),
  id: BlockId,
  title: InlineTitle.optional(),
  steps: z.array(ItemSchema).min(1),
});

/** 1 is accepted (importers often write it) and means the same as leaving it out. */
const Span = z.int().min(1).max(100).optional();

const TableSchema = z
  .object({
    type: z.literal('table'),
    id: BlockId,
    title: InlineTitle.optional(),
    columns: z
      .array(
        z.object({
          width: z.int().positive(),
          align: z.enum(['left', 'center', 'right']).optional(),
        }),
      )
      .min(1),
    header: z.boolean(),
    rows: z
      .array(
        z.object({
          cells: z
            .array(
              z.object({
                colspan: Span,
                rowspan: Span,
                // An empty cell has no blocks (a table being filled in, an empty column).
                blocks: z.array(Block),
              }),
            )
            .min(1),
        }),
      )
      .min(1),
  })
  // At most `MAX_TABLE_COLUMNS` columns and `MAX_TABLE_CELLS` places (#686), one issue coded
  // `table-too-large` (`params.code`); `checkStructure` lays out no grid of such a table.
  .superRefine((table, ctx) => {
    const problem = tableTooLarge(table.columns.length, table.rows.length);
    if (problem) {
      ctx.addIssue({
        code: 'custom',
        message: `table "${table.id}": ${problem}`,
        params: { code: TABLE_TOO_LARGE },
      });
    }
  });

/** 0 to 1, a share of the image's width or height. */
const Coordinate = z.number().min(0).max(1);
const CalloutPointSchema = z.object({ x: Coordinate, y: Coordinate });

const CalloutSchema = z.object({
  id: BlockId,
  anchor: CalloutPointSchema,
  label: CalloutPointSchema.optional(),
  legend: InlineTitle,
  when: Condition.optional(),
  style: ConfigKey.optional(),
});

const ImageSchema = z.object({
  type: z.literal('image'),
  id: BlockId,
  asset: AssetRef,
  alt: SingleLine,
  title: InlineTitle.optional(),
  width: z.number().positive().max(100).optional(),
  callouts: z
    .array(CalloutSchema)
    .min(1, 'no callouts: leave the list out')
    .max(MAX_CALLOUTS, `at most ${MAX_CALLOUTS} callouts on an image`)
    .optional(),
  calloutOrder: z.enum(CALLOUT_ORDERS).optional(),
  calloutLegend: z.enum(CALLOUT_LEGENDS).optional(),
});

const AttachmentSchema = z.object({
  type: z.literal('attachment'),
  id: BlockId,
  asset: AssetRef,
  name: SingleLine.max(200),
  description: SingleLine.max(1000).optional(),
  fileName: FileName,
  mediaType: MediaType,
  size: z.int().min(0).max(Number.MAX_SAFE_INTEGER),
});

const SafetySchema = z.object({
  type: z.literal('safety'),
  id: BlockId,
  severity: z.enum(SAFETY_SEVERITIES),
  hazard: InlineTitle,
  symbols: z.array(ConfigKey),
  blocks: Blocks,
});

const AdmonitionSchema = z.object({
  type: z.literal('admonition'),
  id: BlockId,
  kind: z.enum(['note', 'tip', 'important']),
  blocks: NonEmptyBlocks,
});

const FaqSchema = z.object({
  type: z.literal('faq'),
  id: BlockId,
  question: InlineTitle,
  blocks: NonEmptyBlocks,
});

const VariantSchema = z.object({
  type: z.literal('variant'),
  id: BlockId,
  when: Condition,
  blocks: NonEmptyBlocks,
});

const ModuleRefSchema = z.object({
  type: z.literal('moduleRef'),
  id: BlockId,
  module: ModuleId,
  block: BlockId.optional(),
});

const LiteralSchema = z.object({
  type: z.literal('literal'),
  id: BlockId,
  text: z.string().regex(/^[^\r]*$/, 'no carriage returns'),
  language: Token.optional(),
});

const PassthroughSchema = z.object({
  type: z.literal('passthrough'),
  id: BlockId,
  format: Token,
  raw: z.string().regex(/^[^\r]*$/, 'no carriage returns'),
});

const PageBreakSchema = z.object({
  type: z.literal('pageBreak'),
  id: BlockId,
});
