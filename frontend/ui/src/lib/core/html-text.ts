import type { HashMap } from '../i18n/text.pipe';

/** `text` as HTML text: `<`, `&` and quotes show as they are, never as markup. */
export function htmlText(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function escaped(value: unknown): unknown {
  if (typeof value === 'string') return htmlText(value);
  if (Array.isArray(value)) return value.map(escaped);
  // Plain objects only: a Date or another class instance is a value the message formats itself.
  if (
    value !== null &&
    typeof value === 'object' &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, escaped(v)]),
    );
  }
  return value;
}

/**
 * The parameters of a translation shown as HTML: every string in them (in nested plain objects
 * and arrays too) as HTML text (`htmlText`), other values as they are.
 */
export function htmlParams(params: HashMap): HashMap {
  return escaped(params) as HashMap;
}
