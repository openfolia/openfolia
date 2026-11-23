import { isXmlChar } from '@openfolia/xml';

/**
 * The code points of `text`, a lone surrogate as itself (iterating a
 * string by code point does that already).
 */
function codePoints(text: string): number[] {
  return Array.from(text, (c) => c.codePointAt(0) as number);
}

/**
 * `text` as XLIFF inline text: `&`, `<` and `>` escaped, a carriage return
 * as `&#13;` (a parser would turn a literal one into a line feed), and
 * every code point XML cannot carry as XLIFF's `<cp hex="…"/>`, so the
 * text reads back exactly.
 */
export function inlineText(text: string): string {
  let out = '';
  for (const cp of codePoints(text)) {
    if (!isXmlChar(cp) || cp === 0xd) {
      out +=
        cp === 0xd
          ? '&#13;'
          : `<cp hex="${cp.toString(16).toUpperCase().padStart(4, '0')}"/>`;
      continue;
    }
    const c = String.fromCodePoint(cp);
    out += c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c;
  }
  return out;
}

/**
 * `text` as element content outside inline content (a note), where
 * `<cp>` is not allowed: a code point XML cannot carry becomes U+FFFD.
 */
export function plainText(text: string): string {
  let out = '';
  for (const cp of codePoints(text)) {
    const c = isXmlChar(cp) ? String.fromCodePoint(cp) : '�';
    out +=
      c === '&'
        ? '&amp;'
        : c === '<'
          ? '&lt;'
          : c === '>'
            ? '&gt;'
            : c === '\r'
              ? '&#13;'
              : c;
  }
  return out;
}

/**
 * `value` as a double-quoted attribute value: `&`, `<`, `"` escaped, and
 * tab, line feed and carriage return as character references (a parser
 * would turn literal ones into spaces); a code point XML cannot carry
 * becomes U+FFFD.
 */
export function attributeValue(value: string): string {
  let out = '';
  for (const cp of codePoints(value)) {
    const c = isXmlChar(cp) ? String.fromCodePoint(cp) : '�';
    switch (c) {
      case '&':
        out += '&amp;';
        break;
      case '<':
        out += '&lt;';
        break;
      case '>':
        out += '&gt;';
        break;
      case '"':
        out += '&quot;';
        break;
      case '\t':
        out += '&#9;';
        break;
      case '\n':
        out += '&#10;';
        break;
      case '\r':
        out += '&#13;';
        break;
      default:
        out += c;
    }
  }
  return out;
}

/** ` name="value"` for each attribute whose value is defined, in the given order. */
export function attributes(
  list: readonly (readonly [string, string | undefined])[],
): string {
  return list
    .filter(
      (entry): entry is readonly [string, string] => entry[1] !== undefined,
    )
    .map(([name, value]) => ` ${name}="${attributeValue(value)}"`)
    .join('');
}
