/**
 * The Postgres text search configuration (its stemmer) for a language
 * tag's primary language (`de-CH` is `de`): those every Postgres build
 * ships with (`pg_ts_config`). A language without one is `simple`: words
 * as they are, no stemming.
 */
const CONFIGS: Readonly<Record<string, string>> = {
  ar: 'arabic',
  ca: 'catalan',
  da: 'danish',
  de: 'german',
  el: 'greek',
  en: 'english',
  es: 'spanish',
  et: 'estonian',
  eu: 'basque',
  fi: 'finnish',
  fr: 'french',
  ga: 'irish',
  hi: 'hindi',
  hu: 'hungarian',
  hy: 'armenian',
  id: 'indonesian',
  it: 'italian',
  lt: 'lithuanian',
  nb: 'norwegian',
  ne: 'nepali',
  nl: 'dutch',
  nn: 'norwegian',
  no: 'norwegian',
  pt: 'portuguese',
  ro: 'romanian',
  ru: 'russian',
  sr: 'serbian',
  sv: 'swedish',
  ta: 'tamil',
  tr: 'turkish',
  yi: 'yiddish',
};

/** The configuration with no stemming, for a language without its own and for manuals. */
export const SIMPLE_CONFIG = 'simple';

/**
 * The text search configuration for `lang`, among `available` (the
 * database's `pg_ts_config` names): a name of the list above or `simple`,
 * so a value from content never reaches SQL as a configuration name.
 */
export function textSearchConfig(
  lang: string | undefined,
  available: ReadonlySet<string>,
): string {
  if (lang === undefined) return SIMPLE_CONFIG;
  const primary = lang.toLowerCase().split(/[-_]/)[0] ?? '';
  const config = Object.hasOwn(CONFIGS, primary) ? CONFIGS[primary] : undefined;
  return config !== undefined && available.has(config) ? config : SIMPLE_CONFIG;
}

/** Every configuration `textSearchConfig` may name. */
export const KNOWN_CONFIGS: ReadonlySet<string> = new Set([
  SIMPLE_CONFIG,
  ...Object.values(CONFIGS),
]);
