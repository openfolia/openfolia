import { z } from 'zod';
import { LanguageTag } from './ids.js';

/** The most languages one text is written in. */
export const MAX_TEXT_LANGUAGES = 100;

/** A language as a key: a language tag in its canonical case. */
export const LanguageKey = z
  .string()
  .max(35)
  .refine(
    (tag) => LanguageTag.safeParse(tag).data === tag,
    'a language tag in its canonical case, e.g. "en" or "pt-BR"',
  );

/**
 * The schema of a `LocalizedText` (#731) whose every version is `single`: one text for every
 * language, or one per language by language tag in its canonical case (1 to
 * `MAX_TEXT_LANGUAGES`). Which languages are configured, and that the source language's is
 * there, is the validation's to say (it needs the configuration).
 */
export function localizedText<T extends z.ZodType<string, string>>(single: T) {
  return z.union([
    single,
    z
      .record(LanguageKey, single)
      .refine(
        (langs) => Object.keys(langs).length >= 1,
        'at least one language',
      )
      .refine(
        (langs) => Object.keys(langs).length <= MAX_TEXT_LANGUAGES,
        `at most ${MAX_TEXT_LANGUAGES} languages`,
      ),
  ]);
}
