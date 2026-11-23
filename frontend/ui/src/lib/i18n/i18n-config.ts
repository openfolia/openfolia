import { InjectionToken } from '@angular/core';

import type { UiLanguage } from './languages';

/** How an app's translations are found and which languages it offers. */
export interface I18nConfig {
  /**
   * The scopes the app loads, one translation file per scope and language; `ui` (this library)
   * is always among them. A scope's keys start with its name (`ui.toast.dismiss`).
   */
  readonly scopes: readonly string[];
  /** The languages offered, the source language first. */
  readonly languages: readonly UiLanguage[];
  /** Offer the pseudo-locale (development builds). */
  readonly pseudo: boolean;
  /** Where the files are served: `<baseUrl><scope>/<language>.json`. */
  readonly baseUrl: string;
}

export const I18N_CONFIG = new InjectionToken<I18nConfig>('I18N_CONFIG');
