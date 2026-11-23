/** A UI language: its BCP 47 tag and its name in that language (so a person finds their own). */
export interface UiLanguage {
  readonly id: string;
  readonly label: string;
}

/**
 * The shipped UI languages, English first (the source and the fallback). Adding a language is
 * its translation files (one per scope: `frontend/ui/src/i18n/<id>.json`, the app's
 * `src/i18n/<id>.json`) and its line here (`frontend/ui/README.md`, "Adding a UI language").
 */
export const UI_LANGUAGES: readonly UiLanguage[] = [
  { id: 'en', label: 'English' },
  { id: 'de', label: 'Deutsch' },
];

/** The source language: every key exists in it, and a missing translation falls back to it. */
export const SOURCE_LANGUAGE = 'en';

/**
 * The pseudo-locale (development builds only): English with accents and padding, so a text
 * that does not go through a translation, or that overflows when it grows, stands out.
 * `en-XA` is the tag reserved for it.
 */
export const PSEUDO_LANGUAGE: UiLanguage = { id: 'en-XA', label: 'Ƥşḗŭḓǿ' };

/** Where the choice is remembered in the browser. */
export const LANGUAGE_STORAGE_KEY = 'of-language';

/**
 * The language for a person who has not chosen one: the first of the browser's languages we
 * ship (`de-AT` matches `de`), else the source language.
 */
export function preferredLanguage(
  browser: readonly string[],
  available: readonly UiLanguage[],
): string {
  for (const tag of browser) {
    const exact = available.find(
      (l) => l.id.toLowerCase() === tag.toLowerCase(),
    );
    if (exact) return exact.id;
    const primary = tag.split('-')[0]?.toLowerCase();
    const match = available.find((l) => l.id.toLowerCase() === primary);
    if (match) return match.id;
  }
  return SOURCE_LANGUAGE;
}
