/**
 * The block structure of a page of the markup, before anything is mapped:
 * `h1.`–`h6.` headings, paragraphs, `*`/`-`/`#` lists, `||`/`|` tables,
 * `bq.` quotations, `----` rules, `{code}`/`{noformat}` blocks and block
 * macros (`{name}` or `{name:settings}` alone on a line, with or without a
 * closing `{name}`). Inline text is left as it stands, for `parseInline`.
 */
export type WikiNode =
  | { readonly kind: 'heading'; readonly level: number; readonly text: string }
  | { readonly kind: 'paragraph'; readonly text: string }
  | { readonly kind: 'quote'; readonly text: string }
  | { readonly kind: 'list'; readonly lines: readonly ListLine[] }
  | { readonly kind: 'table'; readonly rows: readonly TableRowText[] }
  | {
      readonly kind: 'code';
      readonly name: string;
      readonly settings: string;
      readonly text: string;
    }
  | {
      readonly kind: 'container';
      /** Lowercase. */
      readonly name: string;
      readonly settings: string;
      readonly children: readonly WikiNode[];
    }
  | { readonly kind: 'macro'; readonly name: string; readonly raw: string }
  | { readonly kind: 'rule' };

export interface ListLine {
  /** The markers, e.g. `#*` for a bullet inside a numbered item. */
  readonly markers: string;
  readonly text: string;
}

export interface TableRowText {
  readonly cells: readonly {
    readonly header: boolean;
    readonly text: string;
  }[];
}

export interface BlockSyntax {
  /** Macros whose body is markup of its own, parsed as blocks (lowercase). */
  readonly containers: ReadonlySet<string>;
}

/** Macros whose body is kept verbatim. */
const CODE_MACROS = new Set(['code', 'noformat']);
/** Macros only ever inline. */
const INLINE_MACROS = new Set(['color', 'colour', 'anchor']);
/**
 * How many characters the searches for unknown macros' closing tags may
 * read in one page, together: the page several times over for any written
 * page, and a bound on hostile ones (an opener without a close rescans the
 * rest of the page). Past it, an unknown macro is taken without a body:
 * still kept verbatim and reported, its would-be body read as markup.
 */
const MAX_MACRO_SCAN = 32 * 1024 * 1024;
/** How deep container macros nest before the rest is kept verbatim. */
const MAX_CONTAINER_DEPTH = 16;

const MACRO_TAG = /^\{([A-Za-z][\w-]*)(?::([^{}\n]*))?\}/;
const HEADING = /^h([1-6])\.\s*(.*)$/;
const RULE = /^-{4,}\s*$/;
const QUOTE = /^bq\.\s+(.*)$/;
const LIST = /^([*#]+|-)\s+(.*)$/;
const IMAGE = /^!([^\s!|][^!\n]*?)!/;

/** Parses a page's markup into its blocks. */
export function parseBlocks(markup: string, syntax: BlockSyntax): WikiNode[] {
  return [...blockNodes(markup, syntax)];
}

/**
 * `parseBlocks`, one top-level block at a time, as it is read: a caller
 * that stops early (a page too large) never holds them all.
 */
export function blockNodes(
  markup: string,
  syntax: BlockSyntax,
): Generator<WikiNode, void, undefined> {
  const text = markup.replace(/\r\n?/g, '\n');
  return new BlockParser(text, syntax, 0).nodes();
}

class BlockParser {
  private pos = 0;
  /** Tags left for unknown macros' closing searches, shared by the page's parsers. */
  private readonly budget: { left: number };
  private readonly out: WikiNode[] = [];
  private paragraph: string[] = [];

  constructor(
    private readonly src: string,
    private readonly syntax: BlockSyntax,
    private readonly depth: number,
    budget?: { left: number },
  ) {
    this.budget = budget ?? { left: MAX_MACRO_SCAN };
  }

  parse(): WikiNode[] {
    return [...this.nodes()];
  }

  /** The blocks, each yielded once read. */
  *nodes(): Generator<WikiNode, void, undefined> {
    while (this.pos < this.src.length) {
      yield* this.take();
      const end = this.lineEnd(this.pos);
      const line = this.src.slice(this.pos, end);
      const trimmed = line.trim();
      if (trimmed === '') {
        this.flush();
        this.pos = end + 1;
        continue;
      }
      if (this.macro(line, trimmed)) continue;
      const heading = HEADING.exec(trimmed);
      if (heading) {
        this.push({
          kind: 'heading',
          level: Number(heading[1]),
          text: (heading[2] ?? '').trim(),
        });
        this.pos = end + 1;
        continue;
      }
      if (RULE.test(trimmed)) {
        this.push({ kind: 'rule' });
        this.pos = end + 1;
        continue;
      }
      const quote = QUOTE.exec(trimmed);
      if (quote) {
        this.push({ kind: 'quote', text: (quote[1] ?? '').trim() });
        this.pos = end + 1;
        continue;
      }
      if (LIST.test(trimmed)) {
        this.list();
        continue;
      }
      if (trimmed.startsWith('|')) {
        this.table();
        continue;
      }
      this.paragraph.push(trimmed);
      this.pos = end + 1;
    }
    this.flush();
    yield* this.take();
  }

  /** The blocks read since the last call, handed over. */
  private take(): WikiNode[] {
    return this.out.splice(0);
  }

  private lineEnd(from: number): number {
    const end = this.src.indexOf('\n', from);
    return end === -1 ? this.src.length : end;
  }

  private push(node: WikiNode): void {
    this.flush();
    this.out.push(node);
  }

  private flush(): void {
    if (this.paragraph.length === 0) return;
    this.out.push({ kind: 'paragraph', text: this.paragraph.join('\n') });
    this.paragraph = [];
  }

  /** Whether a line starting a block other than a paragraph's continues it. */
  private startsBlock(trimmed: string): boolean {
    if (
      HEADING.test(trimmed) ||
      RULE.test(trimmed) ||
      QUOTE.test(trimmed) ||
      LIST.test(trimmed) ||
      trimmed.startsWith('|')
    ) {
      return true;
    }
    const tag = MACRO_TAG.exec(trimmed);
    if (!tag) return false;
    const name = (tag[1] as string).toLowerCase();
    if (INLINE_MACROS.has(name)) return false;
    return (
      CODE_MACROS.has(name) ||
      this.syntax.containers.has(name) ||
      trimmed === tag[0]
    );
  }

  /** A block macro starting this line, if it is one; then past it. */
  private macro(line: string, trimmed: string): boolean {
    const tag = MACRO_TAG.exec(trimmed);
    if (!tag) return false;
    const written = tag[1] as string;
    const name = written.toLowerCase();
    if (INLINE_MACROS.has(name)) return false;
    const start = this.pos + line.indexOf('{');
    const afterTag = start + tag[0].length;
    const settings = tag[2] ?? '';
    if (CODE_MACROS.has(name)) {
      const close = this.closeOf(name, afterTag, false);
      const bodyEnd = close?.at ?? this.src.length;
      this.push({
        kind: 'code',
        name,
        settings,
        text: trimNewlines(this.src.slice(afterTag, bodyEnd)),
      });
      this.pos = close?.after ?? this.src.length;
      return true;
    }
    if (this.syntax.containers.has(name) && this.depth < MAX_CONTAINER_DEPTH) {
      const close = this.closeOf(name, afterTag, true);
      const bodyEnd = close?.at ?? this.src.length;
      const children = new BlockParser(
        this.src.slice(afterTag, bodyEnd),
        this.syntax,
        this.depth + 1,
        this.budget,
      ).parse();
      this.push({ kind: 'container', name, settings, children });
      this.pos = close?.after ?? this.src.length;
      return true;
    }
    // Any other macro alone on its line: verbatim, with its body when a
    // closing tag stands alone on a later line.
    if (trimmed !== tag[0]) return false;
    const close = this.closeOf(name, afterTag, true, true, this.budget);
    const end = close?.after ?? afterTag;
    this.push({ kind: 'macro', name, raw: this.src.slice(start, end) });
    this.pos = end;
    return true;
  }

  /**
   * Where the tag closing macro `name` opened before `from` is (`at`) and
   * where the text after it starts (`after`). With `nests`, a tag of the
   * same name with settings opens another level. With `ownLine`, only a
   * closing tag alone on its line counts.
   */
  private closeOf(
    name: string,
    from: number,
    nests: boolean,
    ownLine = false,
    budget?: { left: number },
  ): { at: number; after: number } | undefined {
    const pattern = new RegExp(`\\{${escape(name)}(:[^{}\\n]*)?\\}`, 'gi');
    pattern.lastIndex = from;
    let depth = 0;
    // Every character a search reads is charged to the budget.
    const exec = () => {
      if (budget && budget.left <= 0) return undefined;
      const start = pattern.lastIndex;
      const m = pattern.exec(this.src) ?? undefined;
      if (budget) {
        budget.left -= (m ? m.index + m[0].length : this.src.length) - start;
      }
      return m;
    };
    // The line a match is on, found once per line: where it starts and its
    // first and last characters other than whitespace.
    let line = { start: -1, end: -1, first: -1, last: -1 };
    const lineOf = (at: number) => {
      if (at >= line.start && at < line.end) return line;
      const start = this.src.lastIndexOf('\n', at - 1) + 1;
      const end = this.lineEnd(at);
      let first = start;
      while (first < end && /\s/.test(this.src[first] as string)) first++;
      let last = end - 1;
      while (last >= first && /\s/.test(this.src[last] as string)) last--;
      if (budget) budget.left -= end - start;
      line = { start, end, first, last };
      return line;
    };
    for (let m = exec(); m; m = exec()) {
      if (m[1] !== undefined) {
        if (nests) depth += 1;
        continue;
      }
      if (depth > 0) {
        depth -= 1;
        continue;
      }
      const after = m.index + m[0].length;
      if (ownLine) {
        const { first, last } = lineOf(m.index);
        if (first !== m.index || last !== after - 1) continue;
      }
      return { at: m.index, after };
    }
    return undefined;
  }

  /** Consecutive list lines; a line that starts no block continues the item before it. */
  private list(): void {
    this.flush();
    const lines: { markers: string; text: string }[] = [];
    while (this.pos < this.src.length) {
      const end = this.lineEnd(this.pos);
      const trimmed = this.src.slice(this.pos, end).trim();
      if (trimmed === '') break;
      const item = LIST.exec(trimmed);
      if (item) {
        lines.push({
          markers: item[1] as string,
          text: (item[2] ?? '').trim(),
        });
      } else if (this.startsBlock(trimmed)) {
        break;
      } else {
        const last = lines[lines.length - 1] as { text: string };
        last.text += `\n${trimmed}`;
      }
      this.pos = end + 1;
    }
    this.out.push({ kind: 'list', lines });
  }

  /** Consecutive table rows; a line that starts no block continues the last cell. */
  private table(): void {
    this.flush();
    const rows: {
      cells: { header: boolean; text: string }[];
      open: boolean;
    }[] = [];
    while (this.pos < this.src.length) {
      const end = this.lineEnd(this.pos);
      const trimmed = this.src.slice(this.pos, end).trim();
      if (trimmed === '') break;
      const last = rows[rows.length - 1];
      if (trimmed.startsWith('|')) {
        rows.push(parseRow(trimmed));
      } else if (last?.open && !this.startsBlock(trimmed)) {
        const cell = last.cells[last.cells.length - 1] as { text: string };
        cell.text += `\n${trimmed}`;
      } else break;
      this.pos = end + 1;
    }
    this.out.push({
      kind: 'table',
      rows: rows
        .map(({ cells }) => ({
          cells: cells.map((c) => ({ ...c, text: c.text.trim() })),
        }))
        .filter((row) => row.cells.length > 0),
    });
  }
}

/** One row: cells after `||` are header cells, after `|` ordinary ones. */
function parseRow(line: string): {
  cells: { header: boolean; text: string }[];
  open: boolean;
} {
  const cells: { header: boolean; text: string }[] = [];
  let current: { header: boolean; text: string } | undefined;
  const next = nextOf(line);
  let i = 0;
  const append = (text: string) => {
    if (current) current.text += text;
  };
  while (i < line.length) {
    const c = line[i] as string;
    if (c === '\\' && i + 1 < line.length) {
      append(line.slice(i, i + 2));
      i += 2;
      continue;
    }
    // A link, monospace, a macro tag or an image may hold a `|` of its own.
    const span = spanAt(line, i, next);
    if (span > i) {
      append(line.slice(i, span));
      i = span;
      continue;
    }
    if (c === '|') {
      const header = line[i + 1] === '|';
      if (current) cells.push(current);
      current = { header, text: '' };
      i += header ? 2 : 1;
      continue;
    }
    append(c);
    i += 1;
  }
  // The row's closing delimiter leaves an empty last cell behind.
  if (current && current.text.trim() !== '') {
    cells.push(current);
    return { cells, open: true };
  }
  return { cells, open: false };
}

/** `line.indexOf(needle, from)`, for one line. */
type NextOf = (needle: string, from: number) => number;

/**
 * `indexOf` over one line that keeps its answers: an occurrence found from
 * `from` is the answer for any start up to it, none found for any later
 * start. So a row of openers without a close is read once.
 */
function nextOf(line: string): NextOf {
  const known = new Map<string, { from: number; at: number }>();
  return (needle, from) => {
    const k = known.get(needle);
    if (k && k.from <= from && (k.at === -1 || from <= k.at)) return k.at;
    const at = line.indexOf(needle, from);
    known.set(needle, { from, at });
    return at;
  };
}

/** The end of a link, monospace run, macro tag or image starting at `i`, or `i`. */
function spanAt(line: string, i: number, next: NextOf): number {
  const rest = line.slice(i);
  if (rest.startsWith('{{')) {
    const end = next('}}', i + 2);
    return end === -1 ? i : end + 2;
  }
  if (rest.startsWith('[')) {
    const end = next(']', i + 1);
    return end === -1 ? i : end + 1;
  }
  if (rest.startsWith('{')) {
    const tag = MACRO_TAG.exec(rest);
    return tag ? i + tag[0].length : i;
  }
  if (rest.startsWith('!')) {
    const image = IMAGE.exec(rest);
    return image && /\.\w{2,5}(\||!)/.test(image[0]) ? i + image[0].length : i;
  }
  return i;
}

function trimNewlines(text: string): string {
  return text.replace(/^[ \t]*\n/, '').replace(/\n[ \t]*$/, '');
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
