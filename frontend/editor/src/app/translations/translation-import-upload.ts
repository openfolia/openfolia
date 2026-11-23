import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import type { Observable } from 'rxjs';

import { API_BASE_URL, JSON_API } from '../api/api-config';
import type { ImportDoc } from './import-model';

/**
 * `POST /translations/imports`: a translated XLIFF document (or a ZIP of them) as
 * `multipart/form-data` (one part `file`, with its name), checked as a dry run (`dryRun=true`)
 * against the server's default branch. Answers the import with the first page of its report.
 * `stateChangeInterceptor` adds `X-Ccms-Request`, which the API asks of a form. Kept with the
 * import screen, so its code loads only with it.
 */
@Injectable({ providedIn: 'root' })
export class TranslationImportUpload {
  private readonly http = inject(HttpClient);
  private readonly base = inject(API_BASE_URL);

  validate(file: Blob, name: string, pageSize: number): Observable<ImportDoc> {
    const form = new FormData();
    form.append('file', file, name);
    form.append('dryRun', 'true');
    return this.http.post<ImportDoc>(
      `${this.base}/translations/imports`,
      form,
      {
        headers: { Accept: JSON_API },
        params: { 'page[size]': pageSize },
      },
    );
  }
}
