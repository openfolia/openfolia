/**
 * Text direction per language (#458): left to right or right to left. Schema-free (no zod), so
 * the browser's `@openfolia/content-model/core` has it too.
 */

/** The directions a language's text can run in. */
export const TEXT_DIRECTIONS = ['ltr', 'rtl'] as const;
export type TextDirection = (typeof TEXT_DIRECTIONS)[number];

/**
 * The scripts (ISO 15924) written right to left: those in Unicode today, the historic ones
 * included. A language's default direction is its script's.
 */
const RTL_SCRIPTS: ReadonlySet<string> = new Set([
  'Adlm', // Adlam
  'Arab', // Arabic (Arabic, Persian, Urdu, Pashto, Sorani, …)
  'Aran', // Arabic, Nastaliq variant
  'Armi', // Imperial Aramaic
  'Avst', // Avestan
  'Chrs', // Chorasmian
  'Cprt', // Cypriot syllabary
  'Elym', // Elymaic
  'Hatr', // Hatran
  'Hebr', // Hebrew (Hebrew, Yiddish, Ladino)
  'Hung', // Old Hungarian
  'Khar', // Kharoshthi
  'Lydi', // Lydian
  'Mand', // Mandaic
  'Mani', // Manichaean
  'Mend', // Mende Kikakui
  'Merc', // Meroitic cursive
  'Mero', // Meroitic hieroglyphs
  'Narb', // Old North Arabian
  'Nbat', // Nabataean
  'Nkoo', // N'Ko
  'Orkh', // Old Turkic
  'Ougr', // Old Uyghur
  'Palm', // Palmyrene
  'Phli', // Inscriptional Pahlavi
  'Phlp', // Psalter Pahlavi
  'Phnx', // Phoenician
  'Prti', // Inscriptional Parthian
  'Rohg', // Hanifi Rohingya
  'Samr', // Samaritan
  'Sarb', // Old South Arabian
  'Sogd', // Sogdian
  'Sogo', // Old Sogdian
  'Syrc', // Syriac
  'Thaa', // Thaana (Dhivehi)
  'Todr', // Todhri
  'Yezi', // Yezidi
]);

/**
 * A language's direction from its BCP 47 tag alone: its script's, the script being the tag's
 * own (`az-Arab`, `pa-Arab`) or the language's likely one (`ar` → Arab, `he` → Hebr, `ur` →
 * Arab, `ku` → Latn), as `Intl.Locale#maximize` gives it from CLDR's likely subtags. Left to
 * right for a tag `Intl` cannot read or whose script it does not know.
 */
export function defaultDirection(tag: string): TextDirection {
  try {
    const script = new Intl.Locale(tag).maximize().script;
    return script !== undefined && RTL_SCRIPTS.has(script) ? 'rtl' : 'ltr';
  } catch {
    return 'ltr';
  }
}

/** The part of the configuration a language's direction comes from. */
export interface DirectionConfig {
  readonly languages: {
    /** A direction set per language tag, over its script's (`openfolia.yaml`, `languages.direction`). */
    readonly direction?: Readonly<Record<string, TextDirection>>;
  };
}

/**
 * A language's direction: the configuration's for that tag (`languages.direction`), else the
 * one its script gives (`defaultDirection`). Without a configuration, the script's.
 */
export function languageDirection(
  tag: string,
  config?: DirectionConfig | null,
): TextDirection {
  return (
    ownDirection(config?.languages.direction, tag) ?? defaultDirection(tag)
  );
}

/** `map[tag]` when it is a direction of the map's own (never an inherited member). */
function ownDirection(
  map: Readonly<Record<string, unknown>> | undefined,
  tag: string,
): TextDirection | undefined {
  if (!map || !Object.hasOwn(map, tag)) return undefined;
  const dir = map[tag];
  return dir === 'ltr' || dir === 'rtl' ? dir : undefined;
}

/**
 * The direction of text in `lang` in a resolved manual: as the configuration set it for the
 * manual (`ResolvedManual.directions`), else the language's script's. Always `ltr` or `rtl`,
 * whatever a manual made elsewhere holds.
 */
export function directionOf(
  manual: { readonly directions?: Readonly<Record<string, TextDirection>> },
  lang: string,
): TextDirection {
  return ownDirection(manual.directions, lang) ?? defaultDirection(lang);
}

/** What `languageDirectionIssues` reports: a direction set for a language not configured. */
export interface LanguageDirectionIssue {
  readonly code: 'unknown-direction-language';
  /** Where in the configuration, e.g. `languages.direction.fa`. */
  readonly path: string;
  readonly message: string;
}

/**
 * The entries of `languages.direction` for a tag that is neither the source language nor a
 * target (#396): they do nothing, and `printConfig` leaves them out, so the next save of the
 * configuration drops them. Never refused, only reported, sorted by tag. Empty without any.
 */
export function languageDirectionIssues(config: {
  readonly languages: {
    readonly source: string;
    readonly targets: readonly string[];
    readonly direction?: Readonly<Record<string, TextDirection>>;
  };
}): LanguageDirectionIssue[] {
  return Object.keys(config.languages.direction ?? {})
    .filter((tag) => !isConfiguredLanguage(config.languages, tag))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((tag) => ({
      code: 'unknown-direction-language',
      path: `languages.direction.${tag}`,
      message: `Language "${tag}" has a direction but is not configured (neither the source nor a target): it is ignored, and left out when the configuration is next saved.`,
    }));
}

/** Whether `tag` is the source language or a target: the only tags `languages.direction` keeps. */
export function isConfiguredLanguage(
  languages: { readonly source: string; readonly targets: readonly string[] },
  tag: string,
): boolean {
  return tag === languages.source || languages.targets.includes(tag);
}
