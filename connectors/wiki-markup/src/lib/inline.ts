import {
  type Inline,
  isLinkHref,
  MARK_ORDER,
  type Mark,
  type TextNode,
} from '@openfolia/content-model';
import { quote, type WikiReportCode } from './report.js';

/** A file a line of text shows or links to, placed as a block of its own. */
export type Embed =
  | {
      readonly kind: 'image';
      readonly file: string;
      /** Its settings (`alt=…`, `width=…`, a bare `thumbnail`), by name. */
      readonly settings: ReadonlyMap<string, string>;
      readonly raw: string;
    }
  | {
      readonly kind: 'attachment';
      readonly file: string;
      /** The link text, if the link had one. */
      readonly text?: string;
      readonly raw: string;
    };

/** What the inline parser needs from the conversion around it. */
export interface InlineContext {
  /** The module of the exported page titled `title` (ignoring case), if the export has one. */
  pageByTitle(title: string): string | undefined;
  /** Records a finding at the block being converted. */
  note(code: WikiReportCode, message: string): void;
  /**
   * Hears the values (array elements and object members, as the import
   * counts them) each node adds to the text's content once it is placed
   * (a merged one adds none): so a caller can stop a parse
   * past a limit by throwing, before the whole text is converted. A
   * link's text inside a cross-reference, made plain, is not counted.
   */
  count?(values: number): void;
  /** Hears each image or attachment as it is met; not those in a cross-reference's text (not counted, as `count`). */
  embedded?(): void;
}

export interface InlineResult {
  readonly content: Inline[];
  /** Images and attachments met in the text, in order. */
  readonly embeds: Embed[];
}

/** Delimiters of inline formatting: the mark each gives, or what is reported instead. */
const DELIMITERS: readonly {
  readonly open: string;
  readonly mark?: Mark['type'];
  readonly lost?: WikiReportCode;
  readonly what?: string;
  /** Opens and closes inside a word too (`x^2^`, `H~2~O`). */
  readonly tight?: boolean;
}[] = [
  { open: '??', mark: 'emphasis' },
  { open: '*', mark: 'strong' },
  { open: '_', mark: 'emphasis' },
  { open: '^', mark: 'sup', tight: true },
  { open: '~', mark: 'sub', tight: true },
  { open: '-', lost: 'strikethrough', what: 'struck-through text' },
  { open: '+', lost: 'underline', what: 'underlined text' },
];

const MACRO = /^\{([A-Za-z][\w-]*)(?::([^{}\n]*))?\}/;
const WORD = /[\p{L}\p{N}]/u;

/**
 * Parses one paragraph's (or cell's, or heading's) text of the markup into
 * the content model's inline nodes: `*strong*`, `_emphasis_`, `??citation??`
 * (emphasis), `{{monospace}}`, `^superscript^`, `~subscript~`, `[links]`,
 * `\\` line breaks (a line break in the text is one too) and `\` escapes.
 * What has no counterpart is reported through `context.note` and its text
 * kept: struck-through and underlined text, colours, unknown inline macros,
 * anchors, mentions, links to pages outside the export. Images (`!file!`)
 * and attachment links (`[^file]`) are returned as `embeds`.
 */
export function parseInline(
  text: string,
  context: InlineContext,
): InlineResult {
  const embeds: Embed[] = [];
  const content = new Sink(context.count);
  parseRuns(text, [], context, embeds, content);
  return { content: content.nodes, embeds };
}

/** Text nodes only (for an xref's text, a title): anything else becomes its text. */
export function textOnly(nodes: readonly Inline[]): TextNode[] {
  const out: TextNode[] = [];
  for (const node of nodes) {
    if (node.type === 'text') {
      const marks = node.marks?.filter(
        (m) => m.type !== 'link' && m.type !== 'term',
      );
      out.push({
        type: 'text',
        text: node.text,
        ...(marks && marks.length > 0 && { marks }),
      });
    } else if (node.type === 'hardBreak') {
      out.push({ type: 'text', text: ' ' });
    } else if (node.type === 'xref' && node.text) {
      append(out, textOnly(node.text));
    }
  }
  return normalise(out) as TextNode[];
}

/** Appends one by one: a spread of a very long run overflows the stack. */
function append<T>(out: T[], nodes: readonly T[]): void {
  for (const node of nodes) out.push(node);
}

/** What a backslash escapes; before anything else it is kept as written. */
const ESCAPABLE = new Set([...'*_?-+^~{}[]|!\\#']);

/** Parses `text` under `marks` into `out`. */
function parseRuns(
  text: string,
  marks: readonly Mark[],
  context: InlineContext,
  embeds: Embed[],
  out: Sink,
): void {
  let buffer = '';
  const flush = () => {
    if (buffer) out.push(textNode(buffer, marks));
    buffer = '';
  };
  const search = new Searches();
  /** Where the line holding `at` ends. */
  const lineEnd = (at: number) =>
    search.find('\n', at, () => {
      const end = text.indexOf('\n', at);
      return end === -1
        ? { at: text.length, until: text.length }
        : { at: end, until: end + 1 };
    });
  let i = 0;
  while (i < text.length) {
    const c = text[i] as string;
    const rest = text.slice(i);
    if (c === '\n' || rest.startsWith('\\\\')) {
      flush();
      out.push({ type: 'hardBreak' });
      i += c === '\n' ? 1 : 2;
      continue;
    }
    if (c === '\\' && ESCAPABLE.has(text[i + 1] as string)) {
      buffer += text[i + 1];
      i += 2;
      continue;
    }
    if (rest.startsWith('{{')) {
      const end = search.indexOf(text, '}}', i + 2);
      if (end > i + 2 && end < lineEnd(i)) {
        flush();
        out.push(textNode(text.slice(i + 2, end), withMark(marks, 'code')));
        i = end + 2;
        continue;
      }
    }
    if (c === '{') {
      const macro = MACRO.exec(rest);
      if (macro) {
        const [tag, name] = macro as unknown as [string, string];
        const lower = name.toLowerCase();
        if (lower === 'color' || lower === 'colour') {
          const close = search.indexOf(text, `{${name}}`, i + tag.length);
          if (close !== -1) {
            flush();
            const inner = text.slice(i + tag.length, close);
            context.note(
              'colour',
              `The colour of ${quote(inner)} is left out.`,
            );
            parseRuns(inner, marks, context, embeds, out);
            i = close + name.length + 2;
            continue;
          }
        }
        flush();
        if (lower === 'anchor') {
          context.note('anchor', `The anchor ${quote(tag)} is left out.`);
        } else {
          context.note(
            'inline-macro',
            `The inline macro ${quote(tag)} has no counterpart; its text is kept as it stood.`,
          );
          buffer += tag;
        }
        i += tag.length;
        continue;
      }
    }
    if (c === '[') {
      const end = search.find(']', i + 1, () => closing(text, i + 1, ']'));
      if (end > i + 1) {
        flush();
        link(
          text.slice(i + 1, end),
          text.slice(i, end + 1),
          marks,
          context,
          embeds,
          out,
        );
        i = end + 1;
        continue;
      }
    }
    if (c === '!') {
      const image = /^!([^\s!|][^!\n]*?)!/.exec(rest);
      const target = image?.[1]?.split('|')[0]?.trim() ?? '';
      if (image && (/^https?:/i.test(target) || /\.\w{2,5}$/.test(target))) {
        flush();
        const raw = image[0];
        const settings = imageSettings(image[1] as string);
        if (/^https?:/i.test(target)) {
          const label = settings.get('alt') ?? target;
          context.note(
            'external-image',
            `The image ${quote(raw)} is shown from an address; it is not fetched, but kept as a link.`,
          );
          out.push(
            isLinkHref(target)
              ? textNode(label, withMark(marks, 'link', target))
              : textNode(raw, marks),
          );
        } else {
          embeds.push({ kind: 'image', file: target, settings, raw });
          context.embedded?.();
        }
        i += raw.length;
        continue;
      }
    }
    const delimiter = DELIMITERS.find((d) => rest.startsWith(d.open));
    if (delimiter && opens(text, i, delimiter.open, delimiter.tight)) {
      const end = closes(
        text,
        i + delimiter.open.length,
        delimiter.open,
        delimiter.tight,
        search,
        lineEnd(i),
      );
      const already =
        delimiter.mark !== undefined &&
        marks.some((m) => m.type === delimiter.mark);
      if (end !== -1 && !already) {
        flush();
        const inner = text.slice(i + delimiter.open.length, end);
        if (delimiter.lost) {
          context.note(
            delimiter.lost,
            `The ${delimiter.what} ${quote(inner)} is kept, without its formatting.`,
          );
          parseRuns(inner, marks, context, embeds, out);
        } else {
          parseRuns(
            inner,
            withMark(marks, delimiter.mark as Mark['type']),
            context,
            embeds,
            out,
          );
        }
        i = end + delimiter.open.length;
        continue;
      }
    }
    buffer += c;
    i += 1;
  }
  flush();
}

/** `[inner]`: a link to an address, a page, an attachment, an anchor or a person; its text into `out`. */
function link(
  inner: string,
  raw: string,
  marks: readonly Mark[],
  context: InlineContext,
  embeds: Embed[],
  out: Sink,
): void {
  const parts = splitUnescaped(inner, '|');
  const [first = '', second, ...tips] = parts;
  const alias = second === undefined ? undefined : first.trim();
  const target = (second ?? first).trim();
  if (tips.length > 0) {
    context.note(
      'link-tip',
      `The tooltip of the link ${quote(raw)} is left out.`,
    );
  }
  const label = (fallback: string): void => {
    if (alias) parseRuns(alias, marks, context, embeds, out);
    else out.push(textNode(fallback, marks));
  };
  if (target.startsWith('^')) {
    const file = target.slice(1).trim();
    embeds.push({
      kind: 'attachment',
      file,
      raw,
      ...(alias && { text: alias }),
    });
    context.embedded?.();
    if (alias) label(file);
    return;
  }
  if (target.startsWith('#')) {
    context.note(
      'anchor-link',
      `The link to the anchor ${quote(target)} keeps its text, without the link.`,
    );
    label(target.slice(1));
    return;
  }
  if (target.startsWith('~')) {
    context.note(
      'mention',
      `The mention of ${quote(target.slice(1))} is kept as text.`,
    );
    label(target.slice(1));
    return;
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(target) || /^mailto:/i.test(target)) {
    if (isLinkHref(target)) {
      const linked = withMark(marks, 'link', target);
      // Straight into `out`, each node counted once it is placed: whether
      // the text gave a text node is seen from what it added or merged.
      const length = out.nodes.length;
      const last = out.nodes[length - 1];
      if (alias) parseRuns(alias, linked, context, embeds, out);
      const hasText =
        out.nodes[length - 1] !== last ||
        out.nodes.slice(length).some((n) => n.type === 'text');
      // A link around an image alone: the image is placed as a block, the
      // link kept as its address.
      if (!hasText) out.push(textNode(target, linked));
      return;
    }
    context.note(
      'invalid-link',
      `The link ${quote(raw)} is not one the content model keeps (http, https or mailto, a full address); its text is kept.`,
    );
    label(target);
    return;
  }
  // A page, by its title, perhaps in another space (`KEY:Title`) or at an anchor (`Title#anchor`).
  const [pageTitle = '', anchor] = target.split('#');
  const module =
    context.pageByTitle(pageTitle) ??
    context.pageByTitle(pageTitle.replace(/^[^:\s]+:/, ''));
  if (module === undefined) {
    context.note(
      'page-link-outside',
      `The link to ${quote(target)}, a page outside the export, keeps its text, without the link.`,
    );
    label(pageTitle || target);
    return;
  }
  if (anchor !== undefined) {
    context.note(
      'anchor-link',
      `The link ${quote(raw)} goes to the page, not to its anchor.`,
    );
  }
  // Made plain, its text may merge: it is not counted.
  const plain = new Sink();
  if (alias) {
    const uncounted: InlineContext = {
      pageByTitle: (title) => context.pageByTitle(title),
      note: (code, message) => context.note(code, message),
    };
    parseRuns(alias, marks, uncounted, embeds, plain);
  }
  const text = textOnly(plain.nodes);
  out.push({ type: 'xref', module, ...(text.length > 0 && { text }) });
}

/** An image's settings: `alt=Text,width=50%`, bare words as themselves. */
function imageSettings(body: string): Map<string, string> {
  const settings = new Map<string, string>();
  const [, ...rest] = body.split('|');
  for (const part of rest.join('|').split(',')) {
    const [key = '', ...value] = part.split('=');
    const name = key.trim().toLowerCase();
    if (name) settings.set(name, value.join('=').trim());
  }
  return settings;
}

/** Whether a delimiter at `at` opens formatting: after no letter or digit, before no space. */
function opens(text: string, at: number, open: string, tight = false): boolean {
  const before = at === 0 ? '' : (text[at - 1] as string);
  const after = text[at + open.length];
  if (after === undefined || /\s/.test(after) || after === open[0])
    return false;
  return tight || before === '' || !WORD.test(before);
}

/**
 * Where the delimiter closing formatting opened before `from` is, or -1.
 * Formatting never spans lines, so only the rest of the line is searched.
 */
function closes(
  text: string,
  from: number,
  open: string,
  tight: boolean | undefined,
  search: Searches,
  lineEnd: number,
): number {
  return search.find(`${open}${tight ? '!' : ''}`, from, () => {
    for (
      let j = text.indexOf(open, from + 1);
      j !== -1 && j < lineEnd;
      j = text.indexOf(open, j + 1)
    ) {
      const before = text[j - 1] as string;
      if (before === '\\' || /\s/.test(before)) continue;
      const after = text[j + open.length];
      if (tight || after === undefined || !WORD.test(after)) {
        return { at: j, until: j };
      }
    }
    return { at: -1, until: lineEnd };
  });
}

/**
 * Searches of one text that keep their answers, so that markup with many
 * openers and no closer (or a closer far away) is read in linear time. A
 * search's answer depends on where it starts only through which candidates
 * lie after it: one started at `from` that found `at` gives `at` for any
 * start in [`from`, `until`) (`until` is `at` for a find, where the search
 * stopped for none).
 */
class Searches {
  private readonly answers = new Map<
    string,
    { readonly from: number; readonly at: number; readonly until: number }
  >();

  find(
    key: string,
    from: number,
    run: () => { at: number; until: number },
  ): number {
    const known = this.answers.get(key);
    if (known && known.from <= from && from < known.until) return known.at;
    const { at, until } = run();
    this.answers.set(key, { from, at, until });
    return at;
  }

  indexOf(text: string, needle: string, from: number): number {
    return this.find(`=${needle}`, from, () => {
      const at = text.indexOf(needle, from);
      return at === -1 ? { at, until: text.length + 1 } : { at, until: at + 1 };
    });
  }
}

/**
 * The index of the next unescaped `close` from `from` on its line (`at`,
 * -1 for none), and where the scan stopped (`until`, past which another
 * scan may answer otherwise). Called just after an opening character, so
 * any later scan from just after another one walks the same characters.
 */
function closing(
  text: string,
  from: number,
  close: string,
): { at: number; until: number } {
  for (let j = from; j < text.length; j++) {
    const c = text[j];
    if (c === '\\' && ESCAPABLE.has(text[j + 1] as string)) j += 1;
    else if (c === '\n') return { at: -1, until: j + 1 };
    else if (c === close) return { at: j, until: j + 1 };
  }
  return { at: -1, until: text.length + 1 };
}

function splitUnescaped(text: string, separator: string): string[] {
  const parts: string[] = [];
  let current = '';
  for (let j = 0; j < text.length; j++) {
    const c = text[j] as string;
    if (c === '\\' && ESCAPABLE.has(text[j + 1] as string)) {
      current += c + text[j + 1];
      j += 1;
    } else if (c === separator) {
      parts.push(current);
      current = '';
    } else current += c;
  }
  parts.push(current);
  return parts;
}

function withMark(
  marks: readonly Mark[],
  type: Mark['type'],
  href?: string,
): Mark[] {
  if (marks.some((m) => m.type === type)) return [...marks];
  const mark =
    type === 'link' ? { type, href: href as string } : ({ type } as Mark);
  return [...marks, mark];
}

function textNode(text: string, marks: readonly Mark[]): TextNode {
  const sorted = [...marks].sort(
    (a, b) => MARK_ORDER.indexOf(a.type) - MARK_ORDER.indexOf(b.type),
  );
  return { type: 'text', text, ...(sorted.length > 0 && { marks: sorted }) };
}

/**
 * The inline nodes of one text as they are made, kept as `normalise` leaves
 * them: an empty text node is dropped, one with the same marks as the node
 * before it is merged into that one. `count` hears what each node adds.
 */
class Sink {
  readonly nodes: Inline[] = [];

  constructor(private readonly count?: (values: number) => void) {}

  push(node: Inline): void {
    const last = this.nodes[this.nodes.length - 1];
    if (node.type === 'text' && node.text === '') return;
    if (
      node.type === 'text' &&
      last?.type === 'text' &&
      sameMarks(last, node)
    ) {
      this.nodes[this.nodes.length - 1] = {
        ...last,
        text: last.text + node.text,
      };
    } else {
      this.nodes.push(node);
      this.count?.(valuesOf(node));
    }
  }
}

/** The values a node adds to its array: its place in it and what it holds, at any depth. */
function valuesOf(node: Inline): number {
  let values = 1;
  const stack: unknown[] = [node];
  while (stack.length > 0) {
    const next = stack.pop();
    if (typeof next !== 'object' || next === null) continue;
    const children = Object.values(next);
    values += children.length;
    for (const child of children) stack.push(child);
  }
  return values;
}

function sameMarks(a: TextNode, b: TextNode): boolean {
  return JSON.stringify(a.marks ?? []) === JSON.stringify(b.marks ?? []);
}

/** Merges neighbouring text nodes of the same marks; drops empty ones. */
function normalise(nodes: readonly Inline[]): Inline[] {
  const out: Inline[] = [];
  for (const node of nodes) {
    if (node.type === 'text' && node.text === '') continue;
    const last = out[out.length - 1];
    if (
      node.type === 'text' &&
      last?.type === 'text' &&
      sameMarks(last, node)
    ) {
      out[out.length - 1] = { ...last, text: last.text + node.text };
    } else out.push(node);
  }
  return out;
}
