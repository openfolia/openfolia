/**
 * A small syntax highlighter for the code editor (`of-code-editor`): it splits a file's text into
 * lines of tokens, each with a kind the editor colours. Line by line, carrying what spans lines
 * (a block comment, a raw block), so a line's tokens are computed once for its text and the state
 * before it. Approximate by design: it colours, it never parses or refuses anything.
 */

/** What a token is, for its colour. `text` is everything else. */
export type CodeTokenKind =
  | 'text'
  | 'comment'
  | 'string'
  | 'keyword'
  | 'function'
  | 'number'
  | 'heading'
  | 'key'
  | 'tag';

export interface CodeToken {
  readonly kind: CodeTokenKind;
  readonly text: string;
}

/** The languages the editor colours; `plain` colours nothing. */
export type CodeLanguage = 'typst' | 'yaml' | 'json' | 'xml' | 'plain';

/** What carries over from one line to the next. */
type LineState = 'none' | 'block-comment' | 'raw';

/** The language of a file by its name's extension: Typst, YAML, JSON, XML/SVG, else plain. */
export function languageOf(path: string): CodeLanguage {
  const extension = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  if (extension === 'typ') return 'typst';
  if (extension === 'yaml' || extension === 'yml') return 'yaml';
  if (extension === 'json') return 'json';
  if (extension === 'xml' || extension === 'svg') return 'xml';
  return 'plain';
}

const TYPST_KEYWORDS = new Set([
  'let',
  'set',
  'show',
  'import',
  'include',
  'if',
  'else',
  'for',
  'in',
  'while',
  'return',
  'context',
  'break',
  'continue',
  'and',
  'or',
  'not',
  'none',
  'auto',
  'true',
  'false',
  'as',
]);

const JSON_WORDS = new Set(['true', 'false', 'null']);
const YAML_WORDS = new Set(['true', 'false', 'null', 'yes', 'no', '~']);

const NUMBER = /^-?\d+(?:\.\d+)?(?:pt|mm|cm|in|em|fr|%|deg|rad)?/;
const IDENT = /^[A-Za-z_][A-Za-z0-9_-]*/;

/** Pushes `text` as `kind`, joined to the token before when it is of the same kind. */
function push(tokens: CodeToken[], kind: CodeTokenKind, text: string): void {
  if (text === '') return;
  const last = tokens[tokens.length - 1];
  if (last && last.kind === kind) {
    tokens[tokens.length - 1] = { kind, text: last.text + text };
  } else {
    tokens.push({ kind, text });
  }
}

/** A quoted string from `at` (its quote there) to its closing quote or the line's end. */
function quoted(line: string, at: number): number {
  const quote = line[at];
  let i = at + 1;
  while (i < line.length) {
    if (line[i] === '\\') {
      i += 2;
      continue;
    }
    if (line[i] === quote) return i + 1;
    i++;
  }
  return line.length;
}

function typstLine(
  line: string,
  state: LineState,
): { tokens: CodeToken[]; state: LineState } {
  const tokens: CodeToken[] = [];
  let i = 0;
  if (state === 'block-comment') {
    const end = line.indexOf('*/');
    if (end < 0) return { tokens: [{ kind: 'comment', text: line }], state };
    push(tokens, 'comment', line.slice(0, end + 2));
    i = end + 2;
    state = 'none';
  } else if (state === 'raw') {
    const end = line.indexOf('```');
    if (end < 0) return { tokens: [{ kind: 'string', text: line }], state };
    push(tokens, 'string', line.slice(0, end + 3));
    i = end + 3;
    state = 'none';
  }
  // A heading in markup: `= Title` at the line's start.
  if (i === 0) {
    const heading = /^\s*=+\s.*/.exec(line);
    if (heading) return { tokens: [{ kind: 'heading', text: line }], state };
  }
  while (i < line.length) {
    const rest = line.slice(i);
    if (rest.startsWith('//')) {
      push(tokens, 'comment', rest);
      break;
    }
    if (rest.startsWith('/*')) {
      const end = rest.indexOf('*/', 2);
      if (end < 0) {
        push(tokens, 'comment', rest);
        state = 'block-comment';
        break;
      }
      push(tokens, 'comment', rest.slice(0, end + 2));
      i += end + 2;
      continue;
    }
    if (rest.startsWith('```')) {
      const end = rest.indexOf('```', 3);
      if (end < 0) {
        push(tokens, 'string', rest);
        state = 'raw';
        break;
      }
      push(tokens, 'string', rest.slice(0, end + 3));
      i += end + 3;
      continue;
    }
    const c = line[i] as string;
    if (c === '"') {
      const end = quoted(line, i);
      push(tokens, 'string', line.slice(i, end));
      i = end;
      continue;
    }
    if (c === '`') {
      const end = line.indexOf('`', i + 1);
      const stop = end < 0 ? line.length : end + 1;
      push(tokens, 'string', line.slice(i, stop));
      i = stop;
      continue;
    }
    if (c === '#') {
      const ident = IDENT.exec(line.slice(i + 1));
      if (ident) {
        const word = ident[0];
        push(
          tokens,
          TYPST_KEYWORDS.has(word) ? 'keyword' : 'function',
          `#${word}`,
        );
        i += 1 + word.length;
        continue;
      }
    }
    const number = /[0-9]/.test(c) ? NUMBER.exec(rest) : null;
    if (number && !/[A-Za-z0-9_]/.test(line[i - 1] ?? '')) {
      push(tokens, 'number', number[0]);
      i += number[0].length;
      continue;
    }
    const ident = /[A-Za-z_]/.test(c) ? IDENT.exec(rest) : null;
    if (ident && !/[A-Za-z0-9_-]/.test(line[i - 1] ?? '')) {
      const word = ident[0];
      const next = line[i + word.length];
      push(
        tokens,
        TYPST_KEYWORDS.has(word)
          ? 'keyword'
          : next === '(' || next === '['
            ? 'function'
            : 'text',
        word,
      );
      i += word.length;
      continue;
    }
    push(tokens, 'text', c);
    i++;
  }
  return { tokens, state };
}

function yamlLine(line: string): CodeToken[] {
  const tokens: CodeToken[] = [];
  const key =
    /^(\s*(?:-\s+)?)([^\s#:"'][^:#]*?|"[^"]*"|'[^']*')(\s*:)(?=\s|$)/.exec(
      line,
    );
  let i = 0;
  if (key) {
    push(tokens, 'text', key[1] as string);
    push(tokens, 'key', key[2] as string);
    push(tokens, 'text', key[3] as string);
    i = key[0].length;
  }
  while (i < line.length) {
    const c = line[i] as string;
    if (c === '#' && (i === 0 || /\s/.test(line[i - 1] as string))) {
      push(tokens, 'comment', line.slice(i));
      break;
    }
    if (c === '"' || c === "'") {
      const end = quoted(line, i);
      push(tokens, 'string', line.slice(i, end));
      i = end;
      continue;
    }
    const word = /^[A-Za-z0-9_.~+-]+/.exec(line.slice(i));
    if (word && !/[A-Za-z0-9_]/.test(line[i - 1] ?? '')) {
      const text = word[0];
      push(
        tokens,
        /^-?\d+(?:\.\d+)?$/.test(text)
          ? 'number'
          : YAML_WORDS.has(text.toLowerCase())
            ? 'keyword'
            : 'text',
        text,
      );
      i += text.length;
      continue;
    }
    push(tokens, 'text', c);
    i++;
  }
  return tokens;
}

function jsonLine(line: string): CodeToken[] {
  const tokens: CodeToken[] = [];
  let i = 0;
  while (i < line.length) {
    const c = line[i] as string;
    if (c === '"') {
      const end = quoted(line, i);
      const isKey = /^\s*:/.test(line.slice(end));
      push(tokens, isKey ? 'key' : 'string', line.slice(i, end));
      i = end;
      continue;
    }
    const word = /^-?[A-Za-z0-9_.+-]+/.exec(line.slice(i));
    if (word) {
      const text = word[0];
      push(
        tokens,
        JSON_WORDS.has(text)
          ? 'keyword'
          : /^-?\d/.test(text)
            ? 'number'
            : 'text',
        text,
      );
      i += text.length;
      continue;
    }
    push(tokens, 'text', c);
    i++;
  }
  return tokens;
}

function xmlLine(
  line: string,
  state: LineState,
): { tokens: CodeToken[]; state: LineState } {
  const tokens: CodeToken[] = [];
  let i = 0;
  if (state === 'block-comment') {
    const end = line.indexOf('-->');
    if (end < 0) return { tokens: [{ kind: 'comment', text: line }], state };
    push(tokens, 'comment', line.slice(0, end + 3));
    i = end + 3;
    state = 'none';
  }
  while (i < line.length) {
    const rest = line.slice(i);
    if (rest.startsWith('<!--')) {
      const end = rest.indexOf('-->');
      if (end < 0) {
        push(tokens, 'comment', rest);
        state = 'block-comment';
        break;
      }
      push(tokens, 'comment', rest.slice(0, end + 3));
      i += end + 3;
      continue;
    }
    const tag = /^<\/?[A-Za-z_][\w:.-]*/.exec(rest);
    if (tag) {
      push(tokens, 'tag', tag[0]);
      i += tag[0].length;
      continue;
    }
    const c = line[i] as string;
    if (c === '"' || c === "'") {
      const end = quoted(line, i);
      push(tokens, 'string', line.slice(i, end));
      i = end;
      continue;
    }
    const attribute = /^[A-Za-z_][\w:.-]*(?==)/.exec(rest);
    if (attribute) {
      push(tokens, 'key', attribute[0]);
      i += attribute[0].length;
      continue;
    }
    push(tokens, c === '>' || c === '/' ? 'tag' : 'text', c);
    i++;
  }
  return { tokens, state };
}

/** A file's lines, each as its tokens (an empty line has none). */
export function highlightCode(
  text: string,
  language: CodeLanguage,
): CodeToken[][] {
  const lines = text.split('\n');
  let state: LineState = 'none';
  return lines.map((line) => {
    switch (language) {
      case 'typst': {
        const out = typstLine(line, state);
        state = out.state;
        return out.tokens;
      }
      case 'xml': {
        const out = xmlLine(line, state);
        state = out.state;
        return out.tokens;
      }
      case 'yaml':
        return yamlLine(line);
      case 'json':
        return jsonLine(line);
      default:
        return line === '' ? [] : [{ kind: 'text', text: line }];
    }
  });
}
