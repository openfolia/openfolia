import type {
  Block,
  Callout,
  Item,
  TableCell,
  TableColumn,
  TableRow,
} from '../blocks.js';
import type { Inline } from '../inline.js';
import { CURRENT_SCHEMA_VERSION, Module, type ModuleMeta } from '../module.js';
import { CALLOUT_LEGENDS, type CalloutLegend } from '../callouts.js';
import {
  TABLE_TOO_LARGE,
  tableTooLarge,
  tablesTooLarge,
} from '../table-limits.js';
import { parseCondition } from './condition-syntax.js';
import { parseInline } from './inline.js';
import {
  AsciidocParseError,
  type AttrList,
  namedAttr,
  parseAttrList,
} from './syntax.js';

export interface ParseOptions {
  /** The module ID, taken from the file name (`battery-charging.adoc` → `battery-charging`). */
  id: string;
}

interface Context {
  sectionDepth: number;
  listDepth: number;
}

const CELL_SPEC = /^((?:\d+(?:\.\d+)?|\.\d+)\+)?(a)?\|/;
const LIST_MARKER = /^(\*{1,5}|\.{1,5}) /;
const FENCE = /^(?:={4,}|-{4,}|\+{4,}|\|===)$/;

/** Lines that can never continue a paragraph or a simple table cell. */
function isStructural(line: string): boolean {
  return (
    line === '' ||
    line === '+' ||
    line.startsWith('[') ||
    LIST_MARKER.test(line) ||
    CELL_SPEC.test(line) ||
    FENCE.test(line) ||
    /^={2,6} /.test(line)
  );
}

class Reader {
  private readonly lines: string[];
  pos = 0;
  /** The places of the tables read so far (#686, `MAX_MODULE_TABLE_CELLS`). */
  tableCells = 0;

  constructor(source: string) {
    const lines = source.replace(/\r\n?/g, '\n').split('\n');
    if (lines.at(-1) === '') lines.pop();
    this.lines = lines;
  }

  peek(offset = 0): string | undefined {
    return this.lines[this.pos + offset];
  }

  next(): string {
    const line = this.lines[this.pos];
    if (line === undefined) throw this.error('unexpected end of file');
    this.pos++;
    return line;
  }

  eof(): boolean {
    return this.pos >= this.lines.length;
  }

  /** 1-based number of the next line. */
  get lineNo(): number {
    return this.pos + 1;
  }

  skipBlank(): void {
    while (this.peek() === '') this.pos++;
  }

  error(message: string, line = this.lineNo): AsciidocParseError {
    return new AsciidocParseError(message, line);
  }
}

/**
 * Parses a module from canonical AsciiDoc. Accepts what `printModule`
 * writes (and a little more, such as soft-wrapped paragraphs); rejects
 * anything that would not map cleanly to the model, with a line number.
 */
export function parseModule(source: string, options: ParseOptions): Module {
  const r = new Reader(source);
  const meta = parseHeader(r);
  const blocks = parseBlocks(r, { sectionDepth: 0, listDepth: 0 }, () => false);
  r.skipBlank();
  if (!r.eof()) throw r.error(`unexpected "${r.peek()}"`);

  const result = Module.safeParse({
    schemaVersion: meta.schemaVersion,
    id: options.id,
    meta: meta.meta,
    blocks,
  });
  if (!result.success) {
    throw new AsciidocParseError(
      `invalid module: ${result.error.issues.map((i) => i.message).join('; ')}`,
    );
  }
  return result.data;
}

/**
 * Parses blocks without a module header (what `printBlocksSource` writes): a page design's
 * region text (#390). Only the syntax is checked here; the blocks' schema is the caller's.
 */
export function parseBlocksSource(source: string): Block[] {
  const r = new Reader(source);
  const blocks = parseBlocks(r, { sectionDepth: 0, listDepth: 0 }, () => false);
  r.skipBlank();
  if (!r.eof()) throw r.error(`unexpected "${r.peek()}"`);
  return blocks;
}

function parseHeader(r: Reader): {
  schemaVersion: number;
  meta: Partial<ModuleMeta>;
} {
  const titleLine = r.next();
  const title = /^= (.+)$/.exec(titleLine);
  if (!title)
    throw r.error(
      'expected the module title, e.g. "= Charging the battery"',
      1,
    );

  const attrs = new Map<string, string>();
  while (r.peek()?.startsWith(':')) {
    const line = r.lineNo;
    const attr = /^:([a-z0-9-]+):(?: (.*))?$/.exec(r.next());
    if (!attr) throw r.error('invalid header attribute', line);
    attrs.set(attr[1] as string, (attr[2] ?? '').trim());
  }
  if (!r.eof() && r.peek() !== '')
    throw r.error('expected a blank line after the header');

  const take = (name: string) => {
    const value = attrs.get(name);
    attrs.delete(name);
    return value;
  };
  const schemaVersion = Number(take('schema-version') ?? NaN);
  if (schemaVersion !== CURRENT_SCHEMA_VERSION) {
    throw r.error(
      `unsupported or missing :schema-version: (expected ${CURRENT_SCHEMA_VERSION})`,
      2,
    );
  }

  const meta: Partial<ModuleMeta> = {
    title: plainText(parseInline(title[1] as string, 1), 1),
    type: take('module-type'),
    lang: take('lang'),
    facets: {},
  };
  const audience = take('audience');
  if (audience !== undefined) meta.audience = audience;
  const keywords = take('keywords');
  if (keywords) meta.keywords = keywords.split(',').map((k) => k.trim());
  const system = take('source-system');
  const sourceId = take('source-id');
  if ((system === undefined) !== (sourceId === undefined)) {
    throw r.error(':source-system: and :source-id: must be given together', 2);
  }
  if (system !== undefined && sourceId !== undefined)
    meta.source = { system, id: sourceId };
  const reason = take('deprecated');
  const replacedBy = take('replaced-by');
  if (replacedBy !== undefined && reason === undefined) {
    throw r.error(':replaced-by: needs :deprecated: (the reason)', 2);
  }
  if (reason !== undefined) {
    meta.deprecated = {
      reason,
      ...(replacedBy !== undefined && { replacedBy }),
    };
  }
  for (const [name, value] of [...attrs]) {
    if (!name.startsWith('facet-'))
      throw r.error(`unknown header attribute :${name}:`, 2);
    (meta.facets as Record<string, string[]>)[name.slice('facet-'.length)] =
      value.split(',').map((v) => v.trim());
  }
  return { schemaVersion, meta };
}

function plainText(nodes: Inline[], line: number): string {
  if (nodes.some((n) => n.type !== 'text' || n.marks)) {
    throw new AsciidocParseError('the module title must be plain text', line);
  }
  return nodes.map((n) => (n.type === 'text' ? n.text : '')).join('');
}

function parseBlocks(
  r: Reader,
  ctx: Context,
  stop: (r: Reader) => boolean,
): Block[] {
  const blocks: Block[] = [];
  for (;;) {
    r.skipBlank();
    if (r.eof() || stop(r)) return blocks;
    blocks.push(...parseBlockGroup(r, ctx));
  }
}

/** The style of the attribute line ahead, without reading it. */
function styleAhead(r: Reader): string | undefined {
  const head = /^\[(?!\[)(.*)\]$/.exec(r.peek() ?? '');
  if (!head) return undefined;
  try {
    return parseAttrList(head[1] as string, r.lineNo).style;
  } catch {
    return undefined; // parseBlock reports it
  }
}

/** One block, or the FAQ entries of a Q&A list (`[qanda]`), which stands for several. */
function parseBlockGroup(r: Reader, ctx: Context): Block[] {
  return styleAhead(r) === 'qanda' ? parseQanda(r) : [parseBlock(r, ctx)];
}

function parseBlock(r: Reader, ctx: Context): Block {
  const attrLine = r.lineNo;
  const head = /^\[(?!\[)(.*)\]$/.exec(r.next());
  if (!head)
    throw r.error('expected a block attribute line such as [#my-id]', attrLine);
  const attrs = parseAttrList(head[1] as string, attrLine);
  const id = attrs.id;
  if (!id) throw r.error('block has no id; add one like [#my-id]', attrLine);

  let title: Inline[] | undefined;
  if (/^\.[^.\s]/.test(r.peek() ?? '')) {
    const line = r.lineNo;
    title = parseInline(r.next().slice(1), line);
  }
  const noTitle = (kind: string) => {
    if (title) throw r.error(`a ${kind} cannot have a title`, attrLine + 1);
  };

  const line = r.peek() ?? '';
  switch (attrs.style) {
    case undefined: {
      const heading = /^(={2,6}) (.*)$/.exec(line);
      if (heading) {
        noTitle('section');
        return parseSection(
          r,
          ctx,
          id,
          (heading[1] as string).length - 1,
          heading[2] as string,
        );
      }
      if (line === '|===') return parseTable(r, attrs, id, title);
      if (line.startsWith('image::')) return parseImage(r, id, title);
      if (line.startsWith('attachment::')) {
        noTitle('attachment');
        return parseAttachment(r, id);
      }
      if (line === '<<<') {
        noTitle('page break');
        r.next();
        return { type: 'pageBreak', id };
      }
      if (line.startsWith('module::')) {
        noTitle('module reference');
        const ref =
          /^module::([a-z0-9-]+)\[(?:block=([a-z_][a-z0-9_-]*))?\]$/.exec(
            r.next(),
          );
        if (!ref)
          throw r.error(
            'expected module::<module-id>[] or module::<module-id>[block=<block-id>]',
            attrLine + 1,
          );
        return {
          type: 'moduleRef',
          id,
          module: ref[1] as string,
          ...(ref[2] !== undefined && { block: ref[2] }),
        };
      }
      const marker = LIST_MARKER.exec(line);
      if (marker) {
        noTitle('list');
        const ordered = (marker[1] as string).startsWith('.');
        return {
          type: 'list',
          id,
          ordered,
          items: parseItems(r, ctx, ordered),
        };
      }
      noTitle('paragraph');
      return { type: 'paragraph', id, content: parseTextLines(r) };
    }
    case 'procedure':
      if (!LIST_MARKER.test(line) || !line.startsWith('.'))
        throw r.error('a procedure must be an ordered list (". ")');
      return {
        type: 'procedure',
        id,
        ...(title ? { title } : {}),
        steps: parseItems(r, ctx, true),
      };
    case 'safety': {
      if (!title)
        throw r.error(
          'a safety block needs its hazard as a title line (".Hazard")',
          attrLine + 1,
        );
      const severity = namedAttr(attrs, 'severity');
      if (!severity)
        throw r.error('a safety block needs severity=...', attrLine);
      const symbols = namedAttr(attrs, 'symbols');
      return {
        type: 'safety',
        id,
        severity: severity as 'warning',
        hazard: title,
        symbols: symbols ? symbols.split(',').map((s) => s.trim()) : [],
        blocks: parseDelimited(r),
      };
    }
    case 'faq':
      if (!title)
        throw r.error(
          'an FAQ entry needs its question as a title line (".Question")',
          attrLine + 1,
        );
      return {
        type: 'faq',
        id,
        question: title,
        blocks: parseDelimited(r),
      };
    case 'NOTE':
    case 'TIP':
    case 'IMPORTANT':
      noTitle('note');
      return {
        type: 'admonition',
        id,
        kind: attrs.style.toLowerCase() as 'note',
        blocks: parseDelimited(r),
      };
    case 'variant': {
      noTitle('variant');
      const when = namedAttr(attrs, 'when');
      if (!when) throw r.error('a variant needs when="..."', attrLine);
      return {
        type: 'variant',
        id,
        when: parseCondition(when, attrLine),
        blocks: parseDelimited(r),
      };
    }
    case 'source': {
      noTitle('source block');
      const [language] = attrs.positional;
      return {
        type: 'literal',
        id,
        ...(language ? { language } : {}),
        text: parseVerbatim(r, '-'),
      };
    }
    case 'passthrough': {
      noTitle('passthrough block');
      const format = namedAttr(attrs, 'format');
      if (!format)
        throw r.error('a passthrough block needs format=...', attrLine);
      return { type: 'passthrough', id, format, raw: parseVerbatim(r, '+') };
    }
    default:
      throw r.error(`unknown block style "${attrs.style}"`, attrLine);
  }
}

/** Paragraph text: the first line plus any continuation lines (hard breaks or soft wraps). */
function parseTextLines(
  r: Reader,
  first?: { text: string; line: number },
): Inline[] {
  const line = first?.line ?? r.lineNo;
  const lines = [first ? first.text : r.next()];
  while (r.peek() !== undefined && !isStructural(r.peek() as string))
    lines.push(r.next());
  return parseInline(lines.join('\n'), line);
}

function parseSection(
  r: Reader,
  ctx: Context,
  id: string,
  level: number,
  titleText: string,
): Block {
  const line = r.lineNo;
  if (level !== ctx.sectionDepth + 1) {
    throw r.error(
      `expected a level ${ctx.sectionDepth + 1} heading (${'='.repeat(ctx.sectionDepth + 2)}), found level ${level}`,
    );
  }
  r.next();
  const title = parseInline(titleText, line);
  const headingAhead = (reader: Reader) => {
    const next = /^(={2,6}) /.exec(reader.peek(1) ?? '');
    return (
      (reader.peek() ?? '').startsWith('[') &&
      next !== null &&
      (next[1] as string).length - 1 <= level
    );
  };
  const blocks = parseBlocks(r, { ...ctx, sectionDepth: level }, headingAhead);
  return { type: 'section', id, title, blocks };
}

function parseDelimited(r: Reader): Block[] {
  const line = r.lineNo;
  const fence = r.next();
  if (!/^={4,}$/.test(fence))
    throw r.error('expected a "====" block delimiter', line);
  const blocks = parseBlocks(
    r,
    { sectionDepth: 0, listDepth: 0 },
    (reader) => reader.peek() === fence,
  );
  if (r.peek() !== fence)
    throw r.error(`block opened on line ${line} is not closed with "${fence}"`);
  r.next();
  return blocks;
}

function parseVerbatim(r: Reader, fenceChar: '-' | '+'): string {
  const line = r.lineNo;
  const fence = r.next();
  if (!new RegExp(`^\\${fenceChar}{4,}$`).test(fence)) {
    throw r.error(`expected a "${fenceChar.repeat(4)}" block delimiter`, line);
  }
  const lines: string[] = [];
  while (r.peek() !== fence) {
    if (r.eof())
      throw r.error(
        `block opened on line ${line} is not closed with "${fence}"`,
      );
    lines.push(r.next());
  }
  r.next();
  return lines.join('\n');
}

function parseItems(r: Reader, ctx: Context, ordered: boolean): Item[] {
  const depth = ctx.listDepth + 1;
  const marker = new RegExp(`^${ordered ? '\\.' : '\\*'}{${depth}} `);
  const items: Item[] = [];

  while (marker.test(r.peek() ?? '')) {
    const line = r.lineNo;
    const rest = r.next().slice(depth + 1);
    const anchor = /^\[\[([a-z_][a-z0-9_-]*)\]\]/.exec(rest);
    if (!anchor)
      throw r.error('list item has no id; start it with [[my-id]]', line);
    const content = parseTextLines(r, {
      text: rest.slice(anchor[0].length),
      line,
    });
    const blocks: Block[] = [];

    for (;;) {
      if (r.peek() === '+') {
        r.next();
        blocks.push(...parseBlockGroup(r, { ...ctx, listDepth: depth }));
        continue;
      }
      if (r.peek() === '') {
        let blanks = 0;
        while (r.peek(blanks) === '') blanks++;
        const after = r.peek(blanks);
        if (after === '+') {
          // Blank lines before "+" attach to an outer item: this list ends, using up one blank line.
          r.pos++;
          items.push({ id: anchor[1] as string, content, blocks });
          return items;
        }
        if (after !== undefined && marker.test(after)) r.pos += blanks;
      }
      break;
    }
    items.push({ id: anchor[1] as string, content, blocks });
  }
  if (items.length === 0)
    throw r.error(
      `expected a list item starting with "${(ordered ? '.' : '*').repeat(depth)} "`,
    );
  return items;
}

/** A Q&A list entry's question line: `[[id]]Question::`, its answer optionally after `:: `. */
const QANDA_ENTRY =
  /^(?:\[\[([a-z_][a-z0-9_-]*)\]\])?(?!\[)(.+?)::(?: +(.*))?$/;
const ANCHOR = /^\[\[([a-z_][a-z0-9_-]*)\]\]/;

/**
 * A Q&A list, as AsciiDoc writes one (`[qanda]`, entries `Question::`),
 * read as one FAQ entry per question. An entry takes its ID from a
 * `[[id]]` anchor before the question; the first one may instead take the
 * list's own `[qanda#id]`. The answer is a paragraph, after the `::` or on
 * the next lines, starting with its own `[[id]]` anchor, then any blocks
 * attached with `+`, as in a list item. The printer writes FAQ entries as
 * `[faq#id]` blocks, so a Q&A list is read, never written.
 */
function parseQanda(r: Reader): Block[] {
  const attrLine = r.lineNo;
  const attrs = parseAttrList(
    (/^\[(.*)\]$/.exec(r.next()) as RegExpExecArray)[1] as string,
    attrLine,
  );
  if (/^\.[^.\s]/.test(r.peek() ?? ''))
    throw r.error('a Q&A list cannot have a title', attrLine + 1);
  const entries: Block[] = [];

  for (;;) {
    const line = r.lineNo;
    const entry = QANDA_ENTRY.exec(r.peek() ?? '');
    if (!entry) break;
    r.next();
    const id =
      entry[1] ?? (entries.length === 0 && attrs.id ? attrs.id : undefined);
    if (!id)
      throw r.error('a Q&A entry has no id; start it with [[my-id]]', line);
    const question = parseInline(entry[2] as string, line);

    const blocks: Block[] = [];
    let text: { text: string; line: number } | undefined;
    if (entry[3] !== undefined) text = { text: entry[3], line };
    else if (answerAhead(r.peek())) {
      const at = r.lineNo;
      text = { text: r.next(), line: at };
    }
    if (text) {
      const anchor = ANCHOR.exec(text.text);
      if (!anchor)
        throw r.error(
          "a Q&A entry's answer has no id; start it with [[my-id]]",
          text.line,
        );
      blocks.push({
        type: 'paragraph',
        id: anchor[1] as string,
        content: parseAnswerLines(r, {
          text: text.text.slice(anchor[0].length),
          line: text.line,
        }),
      });
    }
    while (r.peek() === '+') {
      r.next();
      blocks.push(parseBlock(r, { sectionDepth: 0, listDepth: 0 }));
    }
    entries.push({ type: 'faq', id, question, blocks });

    // Blank lines between entries; anything else after them ends the list.
    let blanks = 0;
    while (r.peek(blanks) === '') blanks++;
    if (!QANDA_ENTRY.test(r.peek(blanks) ?? '')) break;
    r.pos += blanks;
  }
  if (entries.length === 0)
    throw r.error('expected a Q&A entry such as "[[my-id]]Question?::"');
  return entries;
}

/** Whether a line starts an answer's text: plain text, or text after its `[[id]]` anchor. */
function answerAhead(line: string | undefined): boolean {
  if (line === undefined || QANDA_ENTRY.test(line)) return false;
  return ANCHOR.test(line) || !isStructural(line);
}

/** An answer's text: like a paragraph's, but a question line starts the next entry. */
function parseAnswerLines(
  r: Reader,
  first: { text: string; line: number },
): Inline[] {
  const lines = [first.text];
  for (;;) {
    const next = r.peek();
    if (next === undefined || isStructural(next) || QANDA_ENTRY.test(next))
      break;
    lines.push(r.next());
  }
  return parseInline(lines.join('\n'), first.line);
}

function parseImage(r: Reader, id: string, title: Inline[] | undefined): Block {
  const line = r.lineNo;
  const macro = /^image::(\S+?)\[(.*)\]$/.exec(r.next());
  if (!macro) throw r.error('expected image::<asset>["alt text"]', line);
  const attrs = parseAttrList(macro[2] as string, line);
  const alt = attrs.positional[0] ?? attrs.style;
  if (!alt) throw r.error('image needs alt text', line);
  const width = namedAttr(attrs, 'width');
  if (width !== undefined && !/^\d+(?:\.\d+)?%$/.test(width))
    throw r.error('image width must be a percentage', line);
  const order = namedAttr(attrs, 'callout-order');
  if (order !== undefined && order !== 'reading' && order !== 'manual')
    throw r.error('callout-order is "reading" or "manual"', line);
  const legend = namedAttr(attrs, 'callout-legend');
  if (
    legend !== undefined &&
    !(CALLOUT_LEGENDS as readonly string[]).includes(legend)
  )
    throw r.error('callout-legend is "below", "beside" or "none"', line);
  const callouts: Callout[] = [];
  while (CALLOUT_ITEM.test(r.peek() ?? '')) callouts.push(parseCallout(r));
  return {
    type: 'image',
    id,
    asset: macro[1] as string,
    alt,
    ...(title ? { title } : {}),
    ...(width !== undefined ? { width: Number(width.slice(0, -1)) } : {}),
    ...(callouts.length > 0 ? { callouts } : {}),
    ...(order !== undefined ? { calloutOrder: order } : {}),
    ...(legend !== undefined ? { calloutLegend: legend as CalloutLegend } : {}),
  };
}

/** An item of a callout list: `<.>`, or a number (which the parser refuses: numbers are derived). */
const CALLOUT_ITEM = /^<(?:\.|\d+)> /;
const CALLOUT_ATTRS = new Set([
  'x',
  'y',
  'label-x',
  'label-y',
  'style',
  'when',
]);
const COORDINATE = /^\d+(?:\.\d+)?$/;

/**
 * One callout below its image: `<.> [callout#id,x=…,y=…] legend`, with
 * `label-x` and `label-y` (both or neither), `style` and `when` optional.
 */
function parseCallout(r: Reader): Callout {
  const line = r.lineNo;
  const text = r.next();
  if (!text.startsWith('<.> '))
    throw r.error(
      'callout numbers are derived, never written: start the callout with "<.>"',
      line,
    );
  if (text.charAt(4) !== '[')
    throw r.error(
      'a callout starts with its attribute list: <.> [callout#id,x=…,y=…] legend',
      line,
    );
  const end = attributeListEnd(text, 5);
  if (end < 0)
    throw r.error('missing "]" after the callout\'s attributes', line);
  const attrs = parseAttrList(text.slice(5, end), line);
  if (attrs.style !== 'callout' || !attrs.id || attrs.positional.length > 0)
    throw r.error('expected [callout#<id>,x=…,y=…]', line);
  for (const [name] of attrs.named) {
    if (!CALLOUT_ATTRS.has(name))
      throw r.error(`unknown callout attribute "${name}"`, line);
  }
  const coordinate = (name: string, required: boolean): number | undefined => {
    const value = namedAttr(attrs, name);
    if (value === undefined) {
      if (required) throw r.error(`a callout needs ${name}=`, line);
      return undefined;
    }
    if (!COORDINATE.test(value))
      throw r.error(`callout ${name} must be a number from 0 to 1`, line);
    return Number(value);
  };
  const x = coordinate('x', true) as number;
  const y = coordinate('y', true) as number;
  const labelX = coordinate('label-x', false);
  const labelY = coordinate('label-y', false);
  if ((labelX === undefined) !== (labelY === undefined))
    throw r.error('a callout label needs both label-x= and label-y=', line);
  const legend = text.slice(end + 1);
  if (!legend.startsWith(' ') || legend.length < 2)
    throw r.error('a callout needs its legend text after its attributes', line);
  const style = namedAttr(attrs, 'style');
  const when = namedAttr(attrs, 'when');
  return {
    id: attrs.id,
    anchor: { x, y },
    ...(labelX !== undefined && labelY !== undefined
      ? { label: { x: labelX, y: labelY } }
      : {}),
    legend: parseInline(legend.slice(1), line),
    ...(when !== undefined ? { when: parseCondition(when, line) } : {}),
    ...(style !== undefined ? { style } : {}),
  };
}

/** The index of the `]` closing an attribute list that starts at `from`, quotes respected; -1 if none. */
function attributeListEnd(text: string, from: number): number {
  let quoted = false;
  for (let i = from; i < text.length; i++) {
    const ch = text.charAt(i);
    if (quoted && ch === '\\') i++;
    else if (ch === '"') quoted = !quoted;
    else if (ch === ']' && !quoted) return i;
  }
  return -1;
}

function parseAttachment(r: Reader, id: string): Block {
  const line = r.lineNo;
  const macro = /^attachment::(\S+?)\[(.*)\]$/.exec(r.next());
  if (!macro)
    throw r.error(
      'expected attachment::<asset>["name",file=…,type=…,size=…]',
      line,
    );
  const attrs = parseAttrList(macro[2] as string, line);
  const name = attrs.positional[0] ?? attrs.style;
  if (!name || attrs.id !== undefined)
    throw r.error('an attachment needs its name', line);
  const fileName = namedAttr(attrs, 'file');
  const mediaType = namedAttr(attrs, 'type');
  const size = namedAttr(attrs, 'size');
  if (!fileName || !mediaType || size === undefined)
    throw r.error('an attachment needs file=, type= and size=', line);
  if (!/^(?:0|[1-9]\d{0,15})$/.test(size))
    throw r.error('an attachment size is a whole number of bytes', line);
  const description = namedAttr(attrs, 'description');
  return {
    type: 'attachment',
    id,
    asset: macro[1] as string,
    name,
    ...(description !== undefined ? { description } : {}),
    fileName,
    mediaType,
    size: Number(size),
  };
}

function parseTable(
  r: Reader,
  attrs: AttrList,
  id: string,
  title: Inline[] | undefined,
): Block {
  const cols = namedAttr(attrs, 'cols');
  if (!cols) throw r.error('a table needs cols="..."');
  const specs = cols.split(',');
  const wide = tableTooLarge(specs.length, 0);
  if (wide) throw tooLarge(id, wide, r.lineNo);
  const columns: TableColumn[] = specs.map((spec) => {
    const col = /^([<^>])?(\d+)$/.exec(spec.trim());
    if (!col) throw r.error(`invalid column spec "${spec}"`);
    const align = { '<': 'left', '^': 'center', '>': 'right' } as const;
    return {
      width: Number(col[2]),
      ...(col[1] ? { align: align[col[1] as '<'] } : {}),
    };
  });
  const options = namedAttr(attrs, 'options') ?? '';
  const header = options
    .split(',')
    .map((o) => o.trim())
    .includes('header');

  const open = r.lineNo;
  r.next(); // |===
  const cells: TableCell[] = [];
  const cellCtx: Context = { sectionDepth: 0, listDepth: 0 };

  rows: for (;;) {
    if (r.eof())
      throw r.error(`table opened on line ${open} is not closed with "|==="`);
    if (r.peek() === '|===') {
      r.next();
      break;
    }
    if (r.peek() === '') {
      r.next();
      continue;
    }
    let lineNo = r.lineNo;
    let text = r.next();
    let p = 0;
    for (;;) {
      const spec = CELL_SPEC.exec(text.slice(p));
      if (!spec)
        throw r.error('expected a table cell starting with "|"', lineNo);
      p += spec[0].length;
      const span = parseSpan(spec[1]);

      if (spec[2] === 'a') {
        if (text.slice(p) !== '')
          throw r.error(
            'put the content of an "a|" cell on the following lines',
            lineNo,
          );
        const blocks = parseBlocks(
          r,
          cellCtx,
          (reader) =>
            CELL_SPEC.test(reader.peek() ?? '') || reader.peek() === '|===',
        );
        cells.push({ ...span, blocks });
        continue rows;
      }

      // Simple cell: text up to the next unescaped "|" (possibly on a continuation line).
      const startLine = lineNo;
      let content = '';
      for (;;) {
        const pipe = findPipe(text, p);
        if (pipe >= 0) {
          const segment = text.slice(p, pipe);
          const nextSpec = /(?:^| )((?:\d+(?:\.\d+)?|\.\d+)\+)?(a)?$/.exec(
            segment,
          );
          const specText = nextSpec
            ? `${nextSpec[1] ?? ''}${nextSpec[2] ?? ''}`
            : '';
          let cellText = segment.slice(0, segment.length - specText.length);
          if (cellText.endsWith(' ')) cellText = cellText.slice(0, -1);
          cells.push(simpleCell(content + cellText, span, startLine, r));
          p = pipe - specText.length;
          break;
        }
        content += text.slice(p);
        const next = r.peek();
        if (next !== undefined && !isStructural(next)) {
          content += '\n';
          lineNo = r.lineNo;
          text = r.next();
          p = 0;
          continue;
        }
        cells.push(simpleCell(content, span, startLine, r));
        continue rows;
      }
    }
  }

  const rows = toRows(cells, columns.length, r, open, id);
  // Each table is laid out within its own caps first, so this stops a file of many tables at
  // most one table's grid past the cap.
  r.tableCells += rows.length * columns.length;
  const together = tablesTooLarge(r.tableCells);
  if (together) throw tooLarge(id, together, open);
  return {
    type: 'table',
    id,
    ...(title ? { title } : {}),
    columns,
    header,
    rows,
  };
}

/** A table past the caps (#686): an `AsciidocParseError` coded `table-too-large`. */
const tooLarge = (id: string, problem: string, line: number) =>
  new AsciidocParseError(`table "${id}": ${problem}`, line, TABLE_TOO_LARGE);

function parseSpan(
  spec: string | undefined,
): Pick<TableCell, 'colspan' | 'rowspan'> {
  if (!spec) return {};
  const [, col, row] = /^(\d+)?(?:\.(\d+))?\+$/.exec(spec) ?? [];
  return {
    ...(col && Number(col) > 1 ? { colspan: Number(col) } : {}),
    ...(row && Number(row) > 1 ? { rowspan: Number(row) } : {}),
  };
}

function findPipe(text: string, from: number): number {
  for (let i = from; i < text.length; i++) {
    if (text.charAt(i) === '\\') i++;
    else if (text.charAt(i) === '|') return i;
  }
  return -1;
}

function simpleCell(
  text: string,
  span: Pick<TableCell, 'colspan' | 'rowspan'>,
  line: number,
  r: Reader,
): TableCell {
  // A bare "|": an empty cell.
  if (text.trim() === '') return { ...span, blocks: [] };
  const anchor = /^\[\[([a-z_][a-z0-9_-]*)\]\]/.exec(text);
  if (!anchor)
    throw r.error('table cell has no id; start it with [[my-id]]', line);
  const content = parseInline(text.slice(anchor[0].length), line);
  return {
    ...span,
    blocks: [{ type: 'paragraph', id: anchor[1] as string, content }],
  };
}

/**
 * Groups cells into rows the way AsciiDoc does: by filling the column grid, counting spans.
 * Each row costs its width, so a table past the caps (#686) is refused before a row past them
 * is laid out: wider than `MAX_TABLE_COLUMNS` before any, else at the row that would take the
 * grid past `MAX_TABLE_CELLS`. Exported for its spec.
 */
export function toRows(
  cells: readonly TableCell[],
  width: number,
  r: Pick<Reader, 'error'>,
  line: number,
  id = 'table',
): TableRow[] {
  const wide = tableTooLarge(width, 0);
  if (wide) throw tooLarge(id, wide, line);
  const rows: TableRow[] = [];
  let carried = new Array<number>(width).fill(0);
  let occupied = carried.map(() => false);
  let current: TableCell[] = [];
  let col = 0;

  for (const cell of cells) {
    if (current.length === 0) {
      const large = tableTooLarge(width, rows.length + 1);
      if (large) throw tooLarge(id, large, line);
    }
    while (col < width && occupied[col]) col++;
    const colspan = cell.colspan ?? 1;
    if (col + colspan > width)
      throw r.error(
        `table row ${rows.length + 1} has more cells than columns`,
        line,
      );
    for (let c = col; c < col + colspan; c++) {
      occupied[c] = true;
      carried[c] = Math.max(carried[c] ?? 0, cell.rowspan ?? 1);
    }
    col += colspan;
    current.push(cell);
    if (occupied.every(Boolean)) {
      rows.push({ cells: current });
      current = [];
      carried = carried.map((n) => Math.max(0, n - 1));
      occupied = carried.map((n) => n > 0);
      col = 0;
    }
  }
  if (current.length > 0)
    throw r.error(`table row ${rows.length + 1} is incomplete`, line);
  return rows;
}
