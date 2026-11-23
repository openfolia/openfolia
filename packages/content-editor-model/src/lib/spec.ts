import type { Block, Inline, Mark } from '@openfolia/content-model';
import { CURRENT_SCHEMA_VERSION, MARK_ORDER } from '@openfolia/content-model';

/**
 * The editor schema in one table: every node and mark type, and the type of
 * each of its attributes. The TipTap extensions (`extensions.ts`), the
 * converters and the repair step all read it, and `schema.spec.ts` holds it
 * equal to the content model.
 */

/**
 * - `id`: a block ID, `null` until one is assigned; never copied on split.
 * - `string` / `number` / `boolean`: always set, with the default below.
 * - `string?` / `number?`: `null` when the model leaves the field out.
 * - `array` / `object?`: plain JSON, validated against the model by `fromEditor`.
 */
export type AttrKind =
  | 'id'
  | 'string'
  | 'string?'
  | 'number'
  | 'number?'
  | 'boolean'
  | 'array'
  | 'array?'
  | 'object?';

export interface AttrDef {
  kind: AttrKind;
  /** The value when none is given. `null` for `id`, `string?`, `number?`, `array?` and `object?`. */
  default: unknown;
}

const id: AttrDef = { kind: 'id', default: null };
const str = (value: string): AttrDef => ({ kind: 'string', default: value });
const optionalString: AttrDef = { kind: 'string?', default: null };
const optionalNumber: AttrDef = { kind: 'number?', default: null };
const bool: AttrDef = { kind: 'boolean', default: false };
const array: AttrDef = { kind: 'array', default: [] };

/** Node types that stand for a block of the model, by the block's `type`. */
export const BLOCK_NODES = {
  paragraph: 'paragraph',
  section: 'section',
  list: 'list',
  procedure: 'procedure',
  table: 'table',
  image: 'image',
  attachment: 'attachment',
  safety: 'safety',
  admonition: 'admonition',
  faq: 'faq',
  variant: 'variant',
  moduleRef: 'moduleRef',
  literal: 'literal',
  passthrough: 'passthrough',
  pageBreak: 'pageBreak',
} as const satisfies { [K in Block['type']]: string };

/** Node types for inline content, by the inline node's `type`. */
export const INLINE_NODES = {
  text: 'text',
  attribute: 'attribute',
  xref: 'xref',
  kbd: 'kbd',
  calloutRef: 'calloutRef',
  hardBreak: 'hardBreak',
  placeholder: 'placeholder',
} as const satisfies { [K in Inline['type']]: string };

/**
 * Nodes with no block of their own in the model: the document, the inline
 * titles, the hazard and an FAQ entry's question, list items with their text, table rows and
 * cells, and an image's callouts (each holding its legend).
 */
export const STRUCTURAL_NODES = [
  'doc',
  'title',
  'hazard',
  'question',
  'listItem',
  'itemText',
  'tableRow',
  'tableCell',
  'callout',
] as const;

export type NodeName =
  | (typeof BLOCK_NODES)[keyof typeof BLOCK_NODES]
  | (typeof INLINE_NODES)[keyof typeof INLINE_NODES]
  | (typeof STRUCTURAL_NODES)[number];

/** Every node type with its attributes. A node type not listed has none. */
export const NODE_ATTRS: { [K in NodeName]: Record<string, AttrDef> } = {
  doc: {
    moduleId: str(''),
    schemaVersion: { kind: 'number', default: CURRENT_SCHEMA_VERSION },
    meta: { kind: 'object?', default: null },
  },
  paragraph: { id },
  section: { id },
  title: {},
  hazard: {},
  list: { id, ordered: bool },
  listItem: { id },
  itemText: {},
  procedure: { id },
  table: { id, header: bool, columns: array },
  tableRow: {},
  tableCell: { colspan: optionalNumber, rowspan: optionalNumber },
  image: {
    id,
    asset: str(''),
    alt: str(''),
    width: optionalNumber,
    calloutOrder: optionalString,
    calloutLegend: optionalString,
  },
  callout: {
    id,
    anchor: { kind: 'object?', default: null },
    label: { kind: 'object?', default: null },
    when: { kind: 'object?', default: null },
    style: optionalString,
  },
  attachment: {
    id,
    asset: str(''),
    name: str(''),
    description: optionalString,
    fileName: str(''),
    mediaType: str(''),
    size: { kind: 'number', default: 0 },
  },
  safety: { id, severity: str('warning'), symbols: array },
  admonition: { id, kind: str('note') },
  faq: { id },
  question: {},
  variant: { id, when: { kind: 'object?', default: null } },
  moduleRef: { id, module: str(''), block: optionalString },
  literal: { id, language: optionalString },
  passthrough: { id, format: str(''), raw: str('') },
  pageBreak: { id },
  text: {},
  attribute: { name: str('') },
  xref: {
    module: str(''),
    block: optionalString,
    text: { kind: 'array?', default: null },
  },
  kbd: { keys: array },
  calloutRef: { block: str(''), callout: str('') },
  hardBreak: {},
  placeholder: { key: str('') },
};

/** Mark types in the model's canonical order, which is also their rank in the schema. */
export const MARK_NAMES = MARK_ORDER;
export type MarkName = (typeof MARK_NAMES)[number];

export const MARK_ATTRS: { [K in Mark['type']]: Record<string, AttrDef> } = {
  link: { href: str('') },
  term: { termId: str('') },
  ui: {},
  strong: {},
  emphasis: {},
  code: {},
  sub: {},
  sup: {},
};

/** Node types that carry a block ID: every block, and list items and procedure steps. */
export const ID_NODES: ReadonlySet<string> = new Set(
  Object.entries(NODE_ATTRS)
    .filter(([, attrs]) => attrs['id']?.kind === 'id')
    .map(([name]) => name),
);

/** The default attributes of a node type, as ProseMirror fills them in. */
export function defaultAttrs(name: NodeName): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, def] of Object.entries(NODE_ATTRS[name])) {
    out[key] = def.default;
  }
  return out;
}
