import { inject, Pipe, type PipeTransform } from '@angular/core';
import { TranslocoService } from '@jsverse/transloco';

import { LanguageService } from './language.service';

/** Parameters of a message (`{ count: 3 }`). */
export type HashMap = Record<string, unknown>;

/** A translation key and its parameters, translated where it is shown. */
export interface TranslatedText {
  readonly key: string;
  readonly params?: HashMap;
}

/**
 * A text made in code (a toast, a label in a list of options): a translation key, translated
 * when it is shown so it follows a language switch, or a string that is already in the person's
 * language (a name, a value from the API).
 */
export type Translatable = string | TranslatedText;

/** `translated('ui.toast.undo')`: a `TranslatedText`. Keep the key literal (README). */
export function translated(key: string, params?: HashMap): TranslatedText {
  return params ? { key, params } : { key };
}

/**
 * Shows a `Translatable`: a key in the active language, a string as it is. Impure, like
 * Transloco's own pipe, so a language switch re-renders it.
 */
@Pipe({ name: 'ofText', pure: false })
export class TextPipe implements PipeTransform {
  private readonly transloco = inject(TranslocoService);
  private readonly language = inject(LanguageService);

  transform(text: Translatable | null | undefined): string {
    if (text === null || text === undefined) return '';
    if (typeof text === 'string') return text;
    // Read the language so a template that shows this re-renders when it changes.
    this.language.active();
    return this.transloco.translate(text.key, text.params ?? {});
  }
}

/**
 * A translate function for code (a `computed`, a service): `t('ui.toast.dismiss')`. It reads the
 * active language, so a `computed` that calls it follows a language switch. Call it in an
 * injection context.
 */
export function injectTranslate(): (key: string, params?: HashMap) => string {
  const transloco = inject(TranslocoService);
  const language = inject(LanguageService);
  return (key, params) => {
    language.active();
    return transloco.translate(key, params ?? {});
  };
}
