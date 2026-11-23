import type { Condition } from '../condition.js';
import { AsciidocParseError } from './syntax.js';

/**
 * Text form of a variant condition, as stored in `when="..."`:
 *
 *   model in (l-200, l-400) && !(market in (us)) || software >= 2.3
 *
 * `&&` binds tighter than `||`. Nested groups are always parenthesised, so
 * the text maps back to exactly the same tree.
 */
export function formatCondition(condition: Condition): string {
  switch (condition.op) {
    case 'all':
      return condition.of.map(group).join(' && ');
    case 'any':
      return condition.of.map(group).join(' || ');
    case 'not':
      return `!(${formatCondition(condition.of)})`;
    case 'in':
      return `${condition.attr} in (${condition.values.map(formatValue).join(', ')})`;
    case 'cmp':
      return `${condition.attr} ${condition.cmp} ${condition.value}`;
  }
}

function group(condition: Condition): string {
  const text = formatCondition(condition);
  return condition.op === 'all' || condition.op === 'any' ? `(${text})` : text;
}

function formatValue(value: string): string {
  return /^[A-Za-z0-9._-]+$/.test(value)
    ? value
    : `'${value.replace(/[\\']/g, (c) => `\\${c}`)}'`;
}

type Token =
  | { kind: 'word'; text: string }
  | { kind: 'string'; text: string }
  | {
      kind: 'op';
      text: '&&' | '||' | '!' | '(' | ')' | ',' | '<' | '<=' | '>' | '>=';
    };

function tokenize(source: string, line?: number): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source.charAt(i);
    if (/\s/.test(ch)) {
      i++;
    } else if (
      source.startsWith('&&', i) ||
      source.startsWith('||', i) ||
      source.startsWith('<=', i) ||
      source.startsWith('>=', i)
    ) {
      tokens.push({ kind: 'op', text: source.slice(i, i + 2) as '&&' });
      i += 2;
    } else if ('!(),<>'.includes(ch)) {
      tokens.push({ kind: 'op', text: ch as '!' });
      i++;
    } else if (ch === "'") {
      let text = '';
      i++;
      while (i < source.length && source.charAt(i) !== "'") {
        if (source.charAt(i) === '\\' && i + 1 < source.length) i++;
        text += source.charAt(i);
        i++;
      }
      if (i >= source.length)
        throw new AsciidocParseError(
          `unclosed quote in condition "${source}"`,
          line,
        );
      i++;
      tokens.push({ kind: 'string', text });
    } else {
      const match = /^[A-Za-z0-9._-]+/.exec(source.slice(i));
      if (!match)
        throw new AsciidocParseError(
          `unexpected "${ch}" in condition "${source}"`,
          line,
        );
      tokens.push({ kind: 'word', text: match[0] });
      i += match[0].length;
    }
  }
  return tokens;
}

export function parseCondition(source: string, line?: number): Condition {
  const tokens = tokenize(source, line);
  let pos = 0;
  const fail = (what: string): never => {
    throw new AsciidocParseError(`${what} in condition "${source}"`, line);
  };
  const peek = () => tokens[pos];
  const isOp = (text: string) => {
    const t = peek();
    return t?.kind === 'op' && t.text === text;
  };
  const expectOp = (text: string) => {
    if (!isOp(text)) fail(`expected "${text}"`);
    pos++;
  };

  const parseOr = (): Condition => {
    const terms = [parseAnd()];
    while (isOp('||')) {
      pos++;
      terms.push(parseAnd());
    }
    return terms.length === 1
      ? (terms[0] as Condition)
      : { op: 'any', of: terms };
  };
  const parseAnd = (): Condition => {
    const terms = [parseUnary()];
    while (isOp('&&')) {
      pos++;
      terms.push(parseUnary());
    }
    return terms.length === 1
      ? (terms[0] as Condition)
      : { op: 'all', of: terms };
  };
  const parseUnary = (): Condition => {
    if (isOp('!')) {
      pos++;
      expectOp('(');
      const inner = parseOr();
      expectOp(')');
      return { op: 'not', of: inner };
    }
    if (isOp('(')) {
      pos++;
      const inner = parseOr();
      expectOp(')');
      return inner;
    }
    const attr = peek();
    if (attr?.kind !== 'word') return fail('expected an attribute name');
    pos++;
    const next = peek();
    if (next?.kind === 'word' && next.text === 'in') {
      pos++;
      expectOp('(');
      const values: string[] = [];
      do {
        const value = peek();
        if (value?.kind !== 'word' && value?.kind !== 'string')
          return fail('expected a value');
        values.push(value.text);
        pos++;
      } while (isOp(',') && ++pos);
      expectOp(')');
      return { op: 'in', attr: attr.text, values };
    }
    if (next?.kind === 'op' && ['<', '<=', '>', '>='].includes(next.text)) {
      pos++;
      const value = peek();
      if (value?.kind !== 'word') return fail('expected a version');
      pos++;
      return {
        op: 'cmp',
        attr: attr.text,
        cmp: next.text as '<',
        value: value.text,
      };
    }
    return fail(`expected "in" or a comparison after "${attr.text}"`);
  };

  const result = parseOr();
  if (pos < tokens.length) fail('unexpected text at the end');
  return result;
}
