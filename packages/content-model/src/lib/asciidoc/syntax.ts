/**
 * Lexical rules shared by the printer and parser. Every character that could
 * start markup is backslash-escaped in text, so any unescaped markup in a
 * file is unambiguous.
 */

export class AsciidocParseError extends Error {
  constructor(
    message: string,
    /** 1-based line number in the source, when known. */
    readonly line?: number,
    /**
     * A stable code, for a refusal a reader names apart from any other parse error:
     * `table-too-large`, a table past `MAX_TABLE_COLUMNS` or `MAX_TABLE_CELLS` (#686).
     */
    readonly code?: 'table-too-large',
  ) {
    super(line === undefined ? message : `line ${line}: ${message}`);
    this.name = 'AsciidocParseError';
  }
}

/** Characters escaped with a backslash wherever they appear in text. */
export const ESCAPED_CHARS = new Set([
  '\\',
  '*',
  '_',
  '`',
  '#',
  '~',
  '^',
  '{',
  '}',
  '[',
  ']',
  '+',
  '|',
]);

/** Character sequences that start a macro or an autolink; escaped as `\link:` etc. */
export const ESCAPED_PREFIXES = [
  'https://',
  'http://',
  'mailto:',
  'link:',
  'xref:',
  'kbd:',
  'placeholder:',
  'callout:',
  'image:',
  'footnote:',
];

/** AsciiDoc's invisible placeholder, used to keep a line from being read as block syntax. */
export const EMPTY = '{empty}';

export function escapeText(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const prefix = ESCAPED_PREFIXES.find((p) => text.startsWith(p, i));
    if (prefix) {
      out += `\\${prefix}`;
      i += prefix.length;
      continue;
    }
    const ch = text.charAt(i);
    out += ESCAPED_CHARS.has(ch) ? `\\${ch}` : ch;
    i++;
  }
  return out;
}

/**
 * Prefixes `{empty}` to a line of text that AsciiDoc could otherwise read as
 * block syntax: anything not starting with a letter, digit or attribute
 * reference, list-like starts ("1. ", "a) "), admonition labels ("NOTE: ")
 * and block macros ("image::").
 */
export function guardLine(line: string): string {
  const risky =
    !/^[\p{L}\p{N}{]/u.test(line) ||
    /^[\p{L}\p{N}]{1,3}[.)](?:\s|$)/u.test(line) ||
    /^[A-Z]+:\s/.test(line) ||
    /^[\p{L}\p{N}_-]+::/u.test(line);
  return line !== '' && risky ? EMPTY + line : line;
}

// ---------------------------------------------------------------------------
// Block attribute lists: [style#id,positional,name=value]

export interface AttrList {
  style?: string;
  id?: string;
  positional: string[];
  named: [string, string][];
}

const BARE_VALUE = /^[A-Za-z0-9._%-]+$/;

export function quoteValue(value: string): string {
  return BARE_VALUE.test(value)
    ? value
    : `"${value.replace(/[\\"]/g, (c) => `\\${c}`)}"`;
}

export function formatAttrList({
  style,
  id,
  positional,
  named,
}: AttrList): string {
  const head = `${style ?? ''}${id ? `#${id}` : ''}`;
  const parts = [
    head,
    ...positional.map(quoteValue),
    ...named.map(([k, v]) => `${k}=${quoteValue(v)}`),
  ];
  return `[${parts.filter((p) => p !== '').join(',')}]`;
}

/** Splits on commas outside double quotes and unquotes values. */
function splitAttrs(
  inner: string,
  line?: number,
): { raw: string; value: string }[] {
  const parts: { raw: string; value: string }[] = [];
  let raw = '';
  let value = '';
  let quoted = false;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner.charAt(i);
    if (quoted) {
      if (ch === '\\' && (inner[i + 1] === '"' || inner[i + 1] === '\\')) {
        value += inner.charAt(i + 1);
        raw += ch + inner.charAt(i + 1);
        i++;
      } else if (ch === '"') {
        quoted = false;
        raw += ch;
      } else {
        value += ch;
        raw += ch;
      }
    } else if (ch === '"') {
      quoted = true;
      raw += ch;
    } else if (ch === ',') {
      parts.push({ raw, value });
      raw = '';
      value = '';
    } else {
      value += ch;
      raw += ch;
    }
  }
  if (quoted)
    throw new AsciidocParseError('unclosed quote in attribute list', line);
  parts.push({ raw, value });
  return parts;
}

export function parseAttrList(inner: string, line?: number): AttrList {
  const result: AttrList = { positional: [], named: [] };
  const parts = inner === '' ? [] : splitAttrs(inner, line);
  parts.forEach(({ raw, value }, index) => {
    const eq = raw.indexOf('=');
    const named = eq > 0 && /^[A-Za-z][\w-]*$/.test(raw.slice(0, eq));
    if (named) {
      // Unquote the part after "=": re-split just that value.
      const name = raw.slice(0, eq);
      const [only] = splitAttrs(raw.slice(eq + 1), line);
      result.named.push([name, only?.value ?? '']);
      return;
    }
    if (index === 0 && !raw.startsWith('"')) {
      const head = /^([A-Za-z][\w-]*)?(?:#([a-z_][a-z0-9_-]*))?$/.exec(raw);
      if (!head)
        throw new AsciidocParseError(`invalid style or id "${raw}"`, line);
      if (head[1]) result.style = head[1];
      if (head[2]) result.id = head[2];
      return;
    }
    result.positional.push(value);
  });
  return result;
}

export function namedAttr(attrs: AttrList, name: string): string | undefined {
  return attrs.named.find(([k]) => k === name)?.[1];
}
