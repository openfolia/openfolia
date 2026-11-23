import {
  BlockId,
  isLinkHref,
  isTermId,
  placeholderText,
} from '@openfolia/content-model';
import {
  type EditorDoc,
  type EditorMark,
  type EditorNode,
  isRecord,
  plainJson,
} from './json.js';
import {
  MAX_EDITOR_DEPTH,
  MAX_EDITOR_NODES,
  TooManyNodesError,
  assertWithinLimits,
} from './limits.js';
import {
  BLOCK_NODES,
  ID_NODES,
  MARK_ATTRS,
  MARK_NAMES,
  NODE_ATTRS,
  type NodeName,
  defaultAttrs,
} from './spec.js';

export interface NormalizeOptions {
  /**
   * A new block ID, not in `taken`, for a block that has none, an invalid
   * one or a duplicate. Defaults to `b` and ten random letters and digits.
   * A result that isn't a valid, unused ID is replaced by the default.
   */
  newId?: (taken: ReadonlySet<string>) => string;
}

/**
 * Repairs any JSON value into a document the editor schema accepts, in the
 * exact form ProseMirror's `Node.toJSON()` writes. It throws nothing but the
 * named `EditorLimitError`s: for input over a cap, and for input the repair
 * would take over one (line breaks become nodes). It never returns less than
 * it was given to hide that. Its result is a fixed point: `normalizeEditorDoc(normalizeEditorDoc(x))` equals
 * `normalizeEditorDoc(x)`. A document `toEditor` made (from a module in
 * normal form) comes back unchanged.
 *
 * What it changes, and nothing else:
 * - every block and list item gets a valid ID of its own: a missing,
 *   invalid or repeated one (the later in document order) is replaced;
 * - attributes get their schema type: a value of another type becomes the
 *   attribute's default, unknown attributes go;
 * - nodes stand where the schema allows them: a node of an unknown type or in
 *   the wrong place is unwrapped (its content stays, as blocks or as text), a
 *   block inside a line of text (a paragraph, title, hazard, question or item text)
 *   moves out to just after that line's block (into its blocks where it has
 *   some), an inline atom inside a literal becomes its text there, a
 *   block after a section moves into that section, a title, hazard, question
 *   or item text is put in where one is required (empty), and an admonition,
 *   an FAQ answer, a variant or a table cell with no blocks gets an empty
 *   paragraph;
 * - text: line breaks become `hardBreak` nodes (spaces in a title), empty
 *   runs go, marks are sorted into the model's order with one of each type,
 *   unknown marks, marks on anything but text and links to an address the
 *   model refuses (`isLinkHref`: only absolute http, https and mailto) go,
 *   and neighbouring runs with the same marks merge.
 *
 * What it drops, because nothing in it could be kept: values that are
 * neither nodes nor hold any, nodes of an unknown type with no content, and a list, procedure or
 * table with no items or rows (a title they had stays, as a paragraph).
 * Formatting on anything but text, and attribute values of the wrong type,
 * as above.
 *
 * What it leaves to `fromEditor`: everything the model checks beyond the
 * schema (an empty paragraph, a value outside the model's range, table
 * geometry, section depth). Those come back as errors naming the block.
 */
export function normalizeEditorDoc(
  input: unknown,
  options: NormalizeOptions = {},
): EditorDoc {
  assertWithinLimits(input);
  const attrs = repairAttrs(
    'doc',
    isRecord(input) ? input['attrs'] : undefined,
  ) as EditorDoc['attrs'];
  budget = MAX_EDITOR_NODES;
  // A list of nodes (a document's `content` handed over alone) is the content.
  const content = repairBlocks(
    Array.isArray(input) ? input : isRecord(input) ? input['content'] : [],
    true,
    1,
  );
  const doc: EditorDoc = { type: 'doc', attrs, ...wrap(content) };
  assignIds(doc, options.newId);
  // The repair can add nodes (line breaks, required titles) and depth: the result must fit too.
  assertWithinLimits(doc);
  return doc;
}

type Raw = Record<string, unknown>;

/**
 * Inline nodes the current repair may still make. Splitting text at line
 * breaks can make more nodes than the input had, so a document of line breaks
 * is stopped here (with `TooManyNodesError`) instead of after building it.
 */
let budget = MAX_EDITOR_NODES;

function spend(): void {
  if (--budget < 0) throw new TooManyNodesError();
}

function wrap(content: EditorNode[]): { content?: EditorNode[] } {
  return content.length > 0 ? { content } : {};
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function childrenOf(raw: Raw): unknown[] {
  return list(raw['content']);
}

function typeOf(raw: unknown): string | undefined {
  return isRecord(raw) && typeof raw['type'] === 'string'
    ? raw['type']
    : undefined;
}

// ---------------------------------------------------------------------------
// Attributes

function repairAttrs(name: NodeName, raw: unknown): Record<string, unknown> {
  const given = isRecord(raw) ? raw : {};
  const out: Record<string, unknown> = {};
  for (const [key, def] of Object.entries(NODE_ATTRS[name])) {
    out[key] = repairValue(def.kind, def.default, given[key]);
  }
  return out;
}

function repairValue(kind: string, fallback: unknown, value: unknown): unknown {
  switch (kind) {
    case 'id':
    case 'string?':
      return typeof value === 'string' ? value : null;
    case 'string':
      return typeof value === 'string' ? value : fallback;
    case 'number':
    case 'number?': {
      // Through plain JSON, so -0 becomes 0 as it would on the wire.
      const copy = plainJson(value, 1);
      return typeof copy === 'number'
        ? copy
        : kind === 'number'
          ? fallback
          : null;
    }
    case 'boolean':
      return typeof value === 'boolean' ? value : fallback;
    case 'array': {
      const copy = plainJson(value, MAX_EDITOR_DEPTH);
      return Array.isArray(copy) ? copy : [];
    }
    case 'array?': {
      const copy = plainJson(value, MAX_EDITOR_DEPTH);
      return Array.isArray(copy) ? copy : null;
    }
    case 'object?': {
      const copy = plainJson(value, MAX_EDITOR_DEPTH);
      return isRecord(copy) ? copy : null;
    }
    default:
      return fallback;
  }
}

function withAttrs(
  name: NodeName,
  raw: Raw,
  extra: Partial<EditorNode> = {},
): EditorNode {
  return { type: name, attrs: repairAttrs(name, raw['attrs']), ...extra };
}

// ---------------------------------------------------------------------------
// Inline content

const INLINE_TYPES: ReadonlySet<string> = new Set([
  'text',
  'attribute',
  'xref',
  'kbd',
  'calloutRef',
  'hardBreak',
  'placeholder',
]);

/** Inline atoms: a node without content, whose attributes are what it says. */
const INLINE_ATOMS: ReadonlySet<string> = new Set([
  'attribute',
  'xref',
  'kbd',
  'calloutRef',
  'placeholder',
]);

const MARK_RANK = new Map<string, number>(
  MARK_NAMES.map((name, i) => [name, i]),
);

function repairMarks(raw: unknown): EditorMark[] {
  const byType = new Map<string, EditorMark>();
  for (const m of list(raw)) {
    const type = typeOf(m);
    if (type === undefined || !MARK_RANK.has(type) || byType.has(type))
      continue;
    const defs = MARK_ATTRS[type as keyof typeof MARK_ATTRS];
    const given = isRecord((m as Raw)['attrs'])
      ? ((m as Raw)['attrs'] as Raw)
      : {};
    const entries = Object.entries(defs);
    // A link to an address the model refuses (`javascript:`, a relative one…) is no link: its
    // text stays, unlinked.
    if (type === 'link' && !isLinkHref(given['href'])) continue;
    // Likewise a term link naming no term ID, and one on a link's text
    // (a link and a term link never mark the same text: the link stays).
    if (type === 'term' && !isTermId(given['termId'])) continue;
    byType.set(
      type,
      entries.length === 0
        ? { type }
        : {
            type,
            attrs: Object.fromEntries(
              entries.map(([key, def]) => [
                key,
                repairValue(def.kind, def.default, given[key]),
              ]),
            ),
          },
    );
  }
  if (byType.has('link')) byType.delete('term');
  return [...byType.values()].sort(
    (a, b) => (MARK_RANK.get(a.type) ?? 0) - (MARK_RANK.get(b.type) ?? 0),
  );
}

/** A bare string, or a record with text but no type, as the text node it stands for. */
function asText(value: unknown): Raw | null {
  if (typeof value === 'string') return { type: 'text', text: value };
  if (
    isRecord(value) &&
    value['type'] === undefined &&
    typeof value['text'] === 'string'
  )
    return { ...value, type: 'text' };
  return null;
}

/** A line of text, and the blocks found inside it, which go after it. */
interface Line {
  inline: EditorNode[];
  hoisted: EditorNode[];
}

/** `title`: a line of a title, hazard or question, which holds no line breaks. */
function repairInline(raw: unknown, title: boolean, depth: number): Line {
  const out: EditorNode[] = [];
  const hoisted: EditorNode[] = [];
  /** The marks of the last node pushed, as JSON, when it is text: computed once per given text node. */
  let lastKey: string | null = null;
  const pushText = (text: string, marks: EditorMark[], key: string) => {
    if (text === '') return;
    const last = out.at(-1);
    if (last?.type === 'text' && lastKey === key) {
      last.text = (last.text ?? '') + text;
      return;
    }
    spend();
    lastKey = key;
    out.push(
      marks.length > 0 ? { type: 'text', text, marks } : { type: 'text', text },
    );
  };
  const visit = (nodes: unknown) => {
    for (const given of list(nodes)) {
      const node = asText(given) ?? given;
      if (!isRecord(node)) continue;
      const type = node['type'];
      if (type === 'text' && typeof node['text'] === 'string') {
        const marks = repairMarks(node['marks']);
        const key = JSON.stringify(marks);
        node['text'].split(/\r\n|\r|\n/).forEach((line, i) => {
          if (i > 0) {
            if (title) pushText(' ', marks, key);
            else {
              spend();
              out.push({ type: 'hardBreak' });
            }
          }
          pushText(line, marks, key);
        });
        visit(node['content']);
      } else if (type === 'hardBreak') {
        if (title) pushText(' ', [], '[]');
        else out.push({ type: 'hardBreak' });
        visit(node['content']);
      } else if (typeof type === 'string' && INLINE_ATOMS.has(type)) {
        out.push(withAttrs(type as NodeName, node));
        // An atom holds nothing: anything given inside it follows it.
        visit(node['content']);
      } else if (typeof type === 'string' && BLOCK_TYPES.has(type)) {
        // A block can't stand in a line of text: it moves out, whole.
        hoisted.push(...repairBlocks([node], false, depth + 1));
      } else {
        // Anything else (a list item, an unknown wrapper): its content stays.
        visit(node['content']);
      }
    }
  };
  visit(raw);
  return { inline: out, hoisted };
}

/** The text an inline atom shows, for a literal, which holds nothing but text. */
function atomText(node: Raw): string {
  const attrs = repairAttrs(
    node['type'] as 'attribute' | 'xref' | 'kbd' | 'calloutRef' | 'placeholder',
    node['attrs'],
  );
  switch (node['type']) {
    case 'attribute':
      return `{${String(attrs['name'])}}`;
    case 'calloutRef':
      return `(${String(attrs['callout'])})`;
    case 'kbd':
      return (attrs['keys'] as unknown[]).map(String).join('+');
    case 'placeholder':
      return placeholderText(String(attrs['key']));
    default: {
      const runs = Array.isArray(attrs['text']) ? attrs['text'] : [];
      const text = runs
        .map((run: unknown) =>
          isRecord(run) && typeof run['text'] === 'string' ? run['text'] : '',
        )
        .join('');
      return text || String(attrs['module']);
    }
  }
}

/** The text of a literal (all text inside, line breaks as `\n`), and the blocks inside it. */
function literalText(
  raw: unknown,
  depth: number,
): { text: string; hoisted: EditorNode[] } {
  let text = '';
  const hoisted: EditorNode[] = [];
  const visit = (nodes: unknown) => {
    for (const node of list(nodes)) {
      if (!isRecord(node)) continue;
      const type = node['type'];
      if (type === 'text' && typeof node['text'] === 'string') {
        text += node['text'];
        visit(node['content']);
      } else if (type === 'hardBreak') {
        text += '\n';
        visit(node['content']);
      } else if (typeof type === 'string' && INLINE_ATOMS.has(type)) {
        text += atomText(node);
        visit(node['content']);
      } else if (typeof type === 'string' && BLOCK_TYPES.has(type))
        hoisted.push(...repairBlocks([node], false, depth + 1));
      else visit(node['content']);
    }
  };
  visit(raw);
  return { text: text.replace(/\r\n?/g, '\n'), hoisted };
}

// ---------------------------------------------------------------------------
// Blocks

const BLOCK_TYPES: ReadonlySet<string> = new Set(Object.values(BLOCK_NODES));

function paragraph(id: unknown, inline: EditorNode[]): EditorNode {
  return {
    type: 'paragraph',
    attrs: { id: typeof id === 'string' ? id : null },
    ...wrap(inline),
  };
}

/** A paragraph of `inline`, or nothing when there is no text. */
function paragraphIfAny(id: unknown, inline: EditorNode[]): EditorNode[] {
  return inline.length > 0 ? [paragraph(id, inline)] : [];
}

/** `sections`: whether sections may stand here (the document, a section). */
function repairBlocks(
  raw: unknown,
  sections: boolean,
  depth: number,
): EditorNode[] {
  const out: EditorNode[] = [];
  let pending: unknown[] = [];
  const flush = () => {
    if (pending.length > 0) {
      const line = repairInline(pending, false, depth);
      out.push(...paragraphIfAny(null, line.inline), ...line.hoisted);
    }
    pending = [];
  };
  for (const node of list(raw)) {
    const type = typeOf(node);
    if (asText(node) !== null) {
      pending.push(asText(node));
      continue;
    }
    if (type === undefined) {
      // Not a node, but it may hold some.
      if (isRecord(node) && Array.isArray(node['content'])) {
        flush();
        out.push(...repairBlocks(node['content'], sections, depth + 1));
      }
      continue;
    }
    if (INLINE_TYPES.has(type)) {
      pending.push(node);
      continue;
    }
    flush();
    out.push(...repairBlockish(node as Raw, type, sections, depth));
  }
  flush();
  return sections ? sectionsLast(out) : out;
}

/** `block* section*`: a block after a section belongs at the end of that section. */
function sectionsLast(nodes: EditorNode[]): EditorNode[] {
  const out: EditorNode[] = [];
  for (const node of nodes) {
    const last = out.at(-1);
    if (node.type !== 'section' && last?.type === 'section')
      appendToSection(last, node);
    else out.push(node);
  }
  return out;
}

function appendToSection(section: EditorNode, node: EditorNode): void {
  const content = (section.content ??= []);
  const last = content.at(-1);
  if (last?.type === 'section') appendToSection(last, node);
  else content.push(node);
}

function repairBlockish(
  raw: Raw,
  type: string,
  sections: boolean,
  depth: number,
): EditorNode[] {
  // A page break stands only where a page can break (the document, a section): elsewhere it
  // goes, and anything inside it stays.
  if (type === 'pageBreak' && !sections)
    return repairBlocks(raw['content'], false, depth + 1);
  if (BLOCK_TYPES.has(type) && type !== 'section')
    return repairBlock(raw, type, depth);
  switch (type) {
    case 'section': {
      const [head, rest] = takeHead(childrenOf(raw), 'title');
      if (sections) {
        const line = repairInline(head, true, depth);
        return [
          withAttrs('section', raw, {
            content: [
              { type: 'title', ...wrap(line.inline) },
              ...line.hoisted,
              ...repairBlocks(rest, true, depth + 1),
            ],
          }),
        ];
      }
      // A section can't stand here: its title becomes a paragraph with the section's ID.
      const line = repairInline(head, false, depth);
      return [
        ...paragraphIfAny(attrOf(raw, 'id'), line.inline),
        ...line.hoisted,
        ...repairBlocks(rest, false, depth + 1),
      ];
    }
    case 'title':
    case 'hazard':
    case 'question':
    case 'itemText': {
      const line = repairInline(raw['content'], false, depth);
      return [...paragraphIfAny(null, line.inline), ...line.hoisted];
    }
    default:
      // A list item, row or cell out of place, a nested document, an unknown node: its content stays.
      return repairBlocks(raw['content'], sections, depth + 1);
  }
}

function attrOf(raw: Raw, name: string): unknown {
  const attrs = raw['attrs'];
  return isRecord(attrs) ? attrs[name] : undefined;
}

/** The inline content of a leading `type` node (empty without one), and the nodes after it. */
function takeHead(children: unknown[], type: string): [unknown[], unknown[]] {
  const [first, ...rest] = children;
  if (typeOf(first) === type) return [list((first as Raw)['content']), rest];
  return [[], children];
}

/** A leading `title` node, if there is one, and the nodes after it. */
function optionalTitle(
  children: unknown[],
  depth: number,
): [Line | null, unknown[]] {
  const [first, ...rest] = children;
  if (typeOf(first) !== 'title') return [null, children];
  return [repairInline((first as Raw)['content'], true, depth), rest];
}

function titleNode(line: Line | null): EditorNode[] {
  return line === null ? [] : [{ type: 'title', ...wrap(line.inline) }];
}

function blocksOrParagraph(nodes: EditorNode[]): EditorNode[] {
  return nodes.length > 0 ? nodes : [paragraph(null, [])];
}

function repairBlock(raw: Raw, type: string, depth: number): EditorNode[] {
  const inner = depth + 1;
  const children = childrenOf(raw);
  switch (type) {
    case 'paragraph': {
      const line = repairInline(children, false, depth);
      return [withAttrs('paragraph', raw, wrap(line.inline)), ...line.hoisted];
    }
    case 'list': {
      const items = repairItems(children, inner);
      return items.length > 0
        ? [withAttrs('list', raw, { content: items })]
        : [];
    }
    case 'procedure': {
      const [title, rest] = optionalTitle(children, depth);
      const items = repairItems(rest, inner);
      const after = title?.hoisted ?? [];
      if (items.length === 0)
        return [...paragraphIfAny(null, title?.inline ?? []), ...after];
      return [
        withAttrs('procedure', raw, {
          content: [...titleNode(title), ...items],
        }),
        ...after,
      ];
    }
    case 'table': {
      const [title, rest] = optionalTitle(children, depth);
      const rows = repairRows(rest, inner);
      const after = title?.hoisted ?? [];
      if (rows.length === 0)
        return [...paragraphIfAny(null, title?.inline ?? []), ...after];
      return [
        withAttrs('table', raw, { content: [...titleNode(title), ...rows] }),
        ...after,
      ];
    }
    case 'image': {
      const [title, rest] = optionalTitle(children, depth);
      // Its callouts stay, in their order; anything else in it moves out after it.
      const callouts: EditorNode[] = [];
      const hoisted: EditorNode[] = [...(title?.hoisted ?? [])];
      const others: unknown[] = [];
      for (const child of rest) {
        if (typeOf(child) !== 'callout') {
          others.push(child);
          continue;
        }
        const line = repairInline(childrenOf(child as Raw), true, depth);
        callouts.push(withAttrs('callout', child as Raw, wrap(line.inline)));
        hoisted.push(...line.hoisted);
      }
      return [
        withAttrs('image', raw, wrap([...titleNode(title), ...callouts])),
        ...hoisted,
        ...repairBlocks(others, false, inner),
      ];
    }
    case 'safety': {
      const [head, rest] = takeHead(children, 'hazard');
      const line = repairInline(head, true, depth);
      return [
        withAttrs('safety', raw, {
          content: [
            { type: 'hazard', ...wrap(line.inline) },
            ...line.hoisted,
            ...repairBlocks(rest, false, inner),
          ],
        }),
      ];
    }
    case 'faq': {
      const [head, rest] = takeHead(children, 'question');
      const line = repairInline(head, true, depth);
      return [
        withAttrs('faq', raw, {
          content: [
            { type: 'question', ...wrap(line.inline) },
            ...blocksOrParagraph([
              ...line.hoisted,
              ...repairBlocks(rest, false, inner),
            ]),
          ],
        }),
      ];
    }
    case 'admonition':
    case 'variant':
      return [
        withAttrs(type, raw, {
          content: blocksOrParagraph(repairBlocks(children, false, inner)),
        }),
      ];
    case 'attachment':
    case 'moduleRef':
    case 'passthrough':
    case 'pageBreak':
      // Atoms: anything inside is kept after them.
      return [withAttrs(type, raw), ...repairBlocks(children, false, inner)];
    case 'literal': {
      const { text, hoisted } = literalText(children, depth);
      return [
        withAttrs(
          'literal',
          raw,
          text === '' ? {} : { content: [{ type: 'text', text }] },
        ),
        ...hoisted,
      ];
    }
    default:
      return repairBlocks(children, false, inner);
  }
}

function repairItems(children: unknown[], depth: number): EditorNode[] {
  return children.flatMap((child): EditorNode[] => {
    const type = typeOf(child);
    if (type === 'listItem') {
      const [head, rest] = takeHead(childrenOf(child as Raw), 'itemText');
      const line = repairInline(head, false, depth);
      return [
        withAttrs('listItem', child as Raw, {
          content: [
            { type: 'itemText', ...wrap(line.inline) },
            ...line.hoisted,
            ...repairBlocks(rest, false, depth + 1),
          ],
        }),
      ];
    }
    // Anything else in a list becomes an item of its own; a leading paragraph is its text.
    const blocks = repairBlocks([child], false, depth + 1);
    if (blocks.length === 0) return [];
    const [first, ...rest] = blocks;
    const isText = first?.type === 'paragraph';
    return [
      {
        type: 'listItem',
        attrs: { id: isText ? (first.attrs?.['id'] ?? null) : null },
        content: [
          {
            type: 'itemText',
            ...(isText && first.content ? { content: first.content } : {}),
          },
          ...(isText ? rest : blocks),
        ],
      },
    ];
  });
}

function repairRows(children: unknown[], depth: number): EditorNode[] {
  const rows: EditorNode[] = [];
  let loose: unknown[] = [];
  const flush = () => {
    const cells = repairCells(loose, depth + 1);
    if (cells.length > 0) rows.push({ type: 'tableRow', content: cells });
    loose = [];
  };
  for (const child of children) {
    if (typeOf(child) === 'tableRow') {
      flush();
      const cells = repairCells(childrenOf(child as Raw), depth + 1);
      if (cells.length > 0) rows.push({ type: 'tableRow', content: cells });
    } else {
      loose.push(child);
    }
  }
  flush();
  return rows;
}

function repairCells(children: unknown[], depth: number): EditorNode[] {
  const cells: EditorNode[] = [];
  let loose: unknown[] = [];
  const flush = () => {
    const blocks = repairBlocks(loose, false, depth + 1);
    if (blocks.length > 0)
      cells.push({
        type: 'tableCell',
        attrs: defaultAttrs('tableCell'),
        content: blocks,
      });
    loose = [];
  };
  for (const child of children) {
    if (typeOf(child) === 'tableCell') {
      flush();
      cells.push(
        withAttrs('tableCell', child as Raw, {
          content: blocksOrParagraph(
            repairBlocks(childrenOf(child as Raw), false, depth + 1),
          ),
        }),
      );
    } else {
      loose.push(child);
    }
  }
  flush();
  return cells;
}

// ---------------------------------------------------------------------------
// IDs

function randomId(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = new Uint8Array(10);
  globalThis.crypto.getRandomValues(bytes);
  return `b${Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('')}`;
}

function isBlockId(value: unknown): value is string {
  return typeof value === 'string' && BlockId.safeParse(value).success;
}

/** Keeps the first valid occurrence of each ID in document order; gives every other block a new one. */
function assignIds(doc: EditorDoc, newId: NormalizeOptions['newId']): void {
  const holders: EditorNode[] = [];
  const collect = (node: EditorNode) => {
    if (ID_NODES.has(node.type)) holders.push(node);
    node.content?.forEach(collect);
  };
  collect(doc);
  const taken = new Set<string>();
  for (const node of holders) {
    const id = node.attrs?.['id'];
    if (isBlockId(id)) taken.add(id);
  }
  const used = new Set<string>();
  for (const node of holders) {
    const attrs = (node.attrs ??= {});
    const id = attrs['id'];
    if (isBlockId(id) && !used.has(id)) {
      used.add(id);
      continue;
    }
    let next = newId?.(taken);
    while (!isBlockId(next) || taken.has(next)) next = randomId();
    taken.add(next);
    used.add(next);
    attrs['id'] = next;
  }
}
