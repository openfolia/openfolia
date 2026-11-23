/**
 * A text people read that may be written per language (#731): a manual's title, a group's title,
 * a configured label (a module type's, an audience's, a variant value's, …). One text for every
 * language (`Operating manual`), or one per language by language tag
 * (`{ en: Operating manual, de: Betriebsanleitung }`), the source language's among them. A
 * language without its own takes the source language's. Schema-free (`@openfolia/content-model/core`);
 * the schema is `localizedText` (`localized-text-schema.ts`).
 */
export type LocalizedText = string | Readonly<Record<string, string>>;

/**
 * The text in the source language: the one for every language, else the source's own; undefined
 * for a map without it (`missing-source-text` reports that).
 */
export function sourceTextOf(
  text: LocalizedText,
  source: string,
): string | undefined {
  if (typeof text === 'string') return text;
  return Object.hasOwn(text, source) ? text[source] : undefined;
}

/**
 * The text's own version in `lang`: the one for every language when `lang` is the source
 * language, else the version written for `lang`; undefined where `lang` takes the source
 * language's.
 */
export function ownTextIn(
  text: LocalizedText,
  lang: string,
  source: string,
): string | undefined {
  if (typeof text === 'string') return lang === source ? text : undefined;
  return Object.hasOwn(text, lang) ? text[lang] : undefined;
}

/**
 * The text to show in `lang`: its own version there, else the source language's, else (a map
 * without the source language, which validation reports) its first version. Never empty for a
 * valid text.
 */
export function textIn(
  text: LocalizedText,
  lang: string,
  source: string,
): string {
  if (typeof text === 'string') return text;
  if (Object.hasOwn(text, lang)) return text[lang] as string;
  if (Object.hasOwn(text, source)) return text[source] as string;
  return Object.values(text)[0] ?? '';
}

/** The languages a text has a version of its own in: none for one text for every language. */
export function textLanguages(text: LocalizedText): string[] {
  return typeof text === 'string' ? [] : Object.keys(text);
}

/**
 * `text` with its version in `lang` set to `value`, or removed for `undefined` or an empty
 * value. Setting the source language's changes the one text for every language (a text that is
 * one for every language stays one); setting another language's turns one text into a map
 * (`{ [source]: text, [lang]: value }`). A map left holding only the source language becomes one
 * text again, so a text never translated prints as it was written.
 */
export function withTextIn(
  text: LocalizedText,
  lang: string,
  source: string,
  value: string | undefined,
): LocalizedText {
  const given = value === undefined || value === '' ? undefined : value;
  if (typeof text === 'string') {
    if (lang === source) return given ?? text;
    return given === undefined ? text : { [source]: text, [lang]: given };
  }
  const next: Record<string, string> = { ...text };
  if (given === undefined) {
    if (lang === source) return text;
    delete next[lang];
  } else next[lang] = given;
  const langs = Object.keys(next);
  if (langs.length === 1 && langs[0] === source) return next[source] as string;
  return next;
}

/**
 * Whether two texts are the same: the same one text, or the same versions in the same languages
 * (whatever their order).
 */
export function sameText(a: LocalizedText, b: LocalizedText): boolean {
  if (typeof a === 'string' || typeof b === 'string') return a === b;
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every((k) => Object.hasOwn(b, k) && a[k] === b[k])
  );
}

/** A text for printing: one text as it is, a map with its languages sorted. */
export function printableText(text: LocalizedText): LocalizedText {
  if (typeof text === 'string') return text;
  return Object.fromEntries(
    Object.keys(text)
      .sort()
      .map((k) => [k, text[k] as string]),
  );
}
