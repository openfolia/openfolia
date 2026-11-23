import {
  type EnvironmentProviders,
  inject,
  isDevMode,
  makeEnvironmentProviders,
  provideAppInitializer,
  type Provider,
} from '@angular/core';
import {
  provideTransloco,
  type Translation,
  TRANSLOCO_LOADER,
  type TranslocoLoader,
} from '@jsverse/transloco';
import { provideTranslocoMessageformat } from '@jsverse/transloco-messageformat';
import { of } from 'rxjs';

import { I18N_CONFIG, type I18nConfig } from './i18n-config';
import { LanguageService } from './language.service';
import {
  PSEUDO_LANGUAGE,
  SOURCE_LANGUAGE,
  UI_LANGUAGES,
  type UiLanguage,
} from './languages';
import { TranslationLoader } from './translation-loader';

/** The scope of this library's texts (`frontend/ui/src/i18n/<language>.json`). */
export const UI_SCOPE = 'ui';

export interface ProvideI18nOptions {
  /** The app's own scopes, besides `ui` (the editor: `['editor']`). */
  readonly scopes?: readonly string[];
  readonly languages?: readonly UiLanguage[];
  /** Offer the pseudo-locale; default: in development builds. */
  readonly pseudo?: boolean;
  /** Default: `i18n/`, relative to the document's base URL. */
  readonly baseUrl?: string;
}

function setup(config: I18nConfig, loader: Provider): EnvironmentProviders[] {
  const languages = config.pseudo
    ? [...config.languages, PSEUDO_LANGUAGE]
    : config.languages;
  return [
    ...provideTransloco({
      config: {
        availableLangs: languages.map((l) => l.id),
        defaultLang: SOURCE_LANGUAGE,
        fallbackLang: SOURCE_LANGUAGE,
        // A key missing in a language shows the source language's text, never the key.
        missingHandler: { useFallbackTranslation: true, logMissingKey: true },
        reRenderOnLangChange: true,
        prodMode: !isDevMode(),
      },
    }),
    // ICU messages: plurals and selects by the active language's rules.
    provideTranslocoMessageformat(),
    makeEnvironmentProviders([
      loader,
      { provide: I18N_CONFIG, useValue: config },
    ]),
    // The first render waits for the starting language, so no key ever flashes.
    provideAppInitializer(() => inject(LanguageService).init()),
  ];
}

/**
 * Transloco with this library's conventions: the `ui` scope plus the app's, one file per scope
 * and language served at `i18n/<scope>/<language>.json`, ICU messages, the remembered choice or
 * the browser's language, the pseudo-locale in development builds (`README`,
 * "Internationalisation").
 */
export function provideI18n(
  options: ProvideI18nOptions = {},
): EnvironmentProviders[] {
  return setup(
    {
      scopes: [UI_SCOPE, ...(options.scopes ?? [])],
      languages: options.languages ?? UI_LANGUAGES,
      pseudo: options.pseudo ?? isDevMode(),
      baseUrl: options.baseUrl ?? 'i18n/',
    },
    { provide: TRANSLOCO_LOADER, useClass: TranslationLoader },
  );
}

/**
 * For tests: the same setup with the translations in memory, by language and scope
 * (`{ en: { ui: uiEn, editor: editorEn } }`), loaded synchronously, so a component shows its
 * texts on the first change detection. Languages without translations load empty.
 */
export function provideI18nTesting(
  translations: Readonly<Record<string, Readonly<Record<string, Translation>>>>,
): EnvironmentProviders[] {
  const loader: TranslocoLoader = {
    getTranslation: (language: string) =>
      of({ ...(translations[language] ?? {}) }),
  };
  return setup(
    {
      scopes: Object.keys(translations[SOURCE_LANGUAGE] ?? {}),
      languages: UI_LANGUAGES,
      pseudo: false,
      baseUrl: '',
    },
    { provide: TRANSLOCO_LOADER, useValue: loader },
  );
}
