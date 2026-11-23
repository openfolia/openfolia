import { HttpClient, type HttpEvent } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import type { Observable } from 'rxjs';

import { API_BASE_URL, JSON_API } from '../../api/api-config';
import type { ImportDoc } from './import-model';

/** What one check sends besides the file. */
export interface ImportForm {
  readonly importer: string;
  readonly options: Record<string, unknown>;
  readonly updateExisting: boolean;
}

/**
 * `POST /imports` (#256): the file as `multipart/form-data` (the part `file`, with its name) with
 * the importer, its options and "update existing", with the request's events, so the screen shows
 * the upload's progress (`HttpEventType.UploadProgress`) before the answer. The check is stored
 * (`dryRun=false`): the server keeps the upload and its report for an hour, so the report survives
 * a reload of the screen and Import applies exactly what was checked. Nothing is written to the
 * content until it is applied. `stateChangeInterceptor` adds `X-Ccms-Request`, which the API asks
 * of a form. Kept with the import screen, so its code loads only with it.
 */
@Injectable({ providedIn: 'root' })
export class ImportUpload {
  private readonly http = inject(HttpClient);
  private readonly base = inject(API_BASE_URL);

  check(
    file: Blob,
    name: string,
    form: ImportForm,
  ): Observable<HttpEvent<ImportDoc>> {
    const body = new FormData();
    body.append('file', file, name);
    body.append('importer', form.importer);
    body.append('options', JSON.stringify(form.options));
    body.append('updateExisting', String(form.updateExisting));
    body.append('dryRun', 'false');
    return this.http.post<ImportDoc>(`${this.base}/imports`, body, {
      headers: { Accept: JSON_API },
      reportProgress: true,
      observe: 'events',
    });
  }
}
