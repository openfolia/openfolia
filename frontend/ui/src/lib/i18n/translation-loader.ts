import { HttpBackend, HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import type { Translation, TranslocoLoader } from '@jsverse/transloco';
import { forkJoin, map, type Observable } from 'rxjs';

import { I18N_CONFIG } from './i18n-config';
import { PSEUDO_LANGUAGE, SOURCE_LANGUAGE } from './languages';
import { pseudoTranslation } from './pseudo-locale';

/**
 * Loads one language: every scope's file (`<baseUrl><scope>/<language>.json`), merged under the
 * scope's name, so `ui.toast.dismiss` and `editor.nav.content` come from one load. The
 * pseudo-locale is made from the source language. It goes straight to the HTTP backend: the
 * app's interceptors (the API's base URL, its token and error mapping) are not for static files.
 */
@Injectable()
export class TranslationLoader implements TranslocoLoader {
  private readonly config = inject(I18N_CONFIG);
  private readonly http = new HttpClient(inject(HttpBackend));

  getTranslation(language: string): Observable<Translation> {
    const pseudo = language === PSEUDO_LANGUAGE.id;
    const source = pseudo ? SOURCE_LANGUAGE : language;
    const scopes = this.config.scopes;
    return forkJoin(
      scopes.map((scope) =>
        this.http.get<Translation>(
          `${this.config.baseUrl}${scope}/${source}.json`,
        ),
      ),
    ).pipe(
      map((files) => {
        const merged: Translation = {};
        scopes.forEach((scope, index) => {
          merged[scope] = files[index];
        });
        return pseudo ? pseudoTranslation(merged) : merged;
      }),
    );
  }
}
