import type { Translation } from '@jsverse/transloco';

const ACCENTED: Record<string, string> = {
  a: 'á',
  b: 'ƀ',
  c: 'ç',
  d: 'ḓ',
  e: 'é',
  f: 'ƒ',
  g: 'ğ',
  h: 'ĥ',
  i: 'í',
  j: 'ĵ',
  k: 'ķ',
  l: 'ļ',
  m: 'ɱ',
  n: 'ñ',
  o: 'ó',
  p: 'ƥ',
  r: 'ŕ',
  s: 'š',
  t: 'ţ',
  u: 'ú',
  v: 'ṽ',
  w: 'ŵ',
  y: 'ý',
  z: 'ž',
  A: 'Á',
  B: 'Ɓ',
  C: 'Ç',
  D: 'Ḓ',
  E: 'É',
  F: 'Ƒ',
  G: 'Ğ',
  H: 'Ĥ',
  I: 'Í',
  J: 'Ĵ',
  K: 'Ķ',
  L: 'Ļ',
  M: 'Ṁ',
  N: 'Ñ',
  O: 'Ó',
  P: 'Ƥ',
  R: 'Ŕ',
  S: 'Š',
  T: 'Ţ',
  U: 'Ú',
  V: 'Ṽ',
  W: 'Ŵ',
  Y: 'Ý',
  Z: 'Ž',
};

/** ICU argument types whose options are messages (`{n, plural, one {…} other {…}}`). */
const BRANCHING = new Set(['plural', 'select', 'selectordinal']);

/**
 * One message in the pseudo-locale: letters accented and the text padded by about a third
 * (German and French run that much longer than English), between `⟦` and `⟧` so a cut-off end
 * shows. ICU syntax stays intact: argument names, types and option keys are kept, the texts of
 * plural and select options are transformed too.
 */
export function pseudoMessage(message: string): string {
  const text = transform(message, 0, false).out;
  const letters = (message.match(/\p{L}/gu) ?? []).length;
  const padding = '·'.repeat(Math.ceil(letters * 0.35));
  return `⟦${text}${padding ? ' ' + padding : ''}⟧`;
}

/** Every message of a translation tree, in the pseudo-locale. */
export function pseudoTranslation(translation: Translation): Translation {
  const out: Translation = {};
  for (const [key, value] of Object.entries(translation)) {
    out[key] =
      typeof value === 'string'
        ? pseudoMessage(value)
        : value && typeof value === 'object'
          ? pseudoTranslation(value as Translation)
          : value;
  }
  return out;
}

/** Transforms text from `start` until the end, or until the `}` closing a nested message. */
function transform(
  message: string,
  start: number,
  nested: boolean,
): { out: string; end: number } {
  let out = '';
  let i = start;
  while (i < message.length) {
    const ch = message.charAt(i);
    if (ch === '}' && nested) return { out, end: i };
    if (ch === '{') {
      const argument = readArgument(message, i);
      out += argument.out;
      i = argument.end;
      continue;
    }
    if (ch === "'" && message.charAt(i + 1) === '{') {
      // An ICU-quoted literal: keep it as it is.
      const close = message.indexOf("'", i + 1);
      const end = close === -1 ? message.length : close + 1;
      out += message.slice(i, end);
      i = end;
      continue;
    }
    out += ACCENTED[ch] ?? ch;
    i++;
  }
  return { out, end: i };
}

/** An argument at `start` (`{name}`, `{n, number}`, `{n, plural, …}`), up to after its `}`. */
function readArgument(
  message: string,
  start: number,
): { out: string; end: number } {
  let i = start + 1;
  let header = '';
  while (i < message.length && !',}'.includes(message.charAt(i))) {
    header += message.charAt(i++);
  }
  if (message.charAt(i) === '}') return { out: `{${header}}`, end: i + 1 };
  // `, type`
  i++;
  let type = '';
  while (i < message.length && !',}'.includes(message.charAt(i))) {
    type += message.charAt(i++);
  }
  if (!BRANCHING.has(type.trim())) {
    // number, date, …: copy the rest of the argument unchanged.
    let depth = 1;
    let rest = '';
    while (i < message.length && depth > 0) {
      const ch = message.charAt(i++);
      if (ch === '{') depth++;
      if (ch === '}') depth--;
      if (depth > 0) rest += ch;
    }
    return { out: `{${header},${type}${rest}}`, end: i };
  }
  let out = `{${header},${type}`;
  // Options: `key {message}` pairs (and `offset:n`), then the closing `}`.
  while (i < message.length && message.charAt(i) !== '}') {
    const ch = message.charAt(i);
    if (ch === '{') {
      const inner = transform(message, i + 1, true);
      out += `{${inner.out}}`;
      i = inner.end + 1;
    } else {
      out += ch;
      i++;
    }
  }
  return { out: `${out}}`, end: i + 1 };
}
