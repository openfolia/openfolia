import { HttpClient } from '@angular/common/http';
import { DOCUMENT, inject, Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { API_BASE_URL, ReadRef } from '../api';
import { saveResponse } from '../reports/report-download';

export type TermExportFormat = 'tbx' | 'csv';

/**
 * Saves the terms as a file (`GET /terms/export`, #135): TBX-Basic or CSV, read at the chosen
 * change set's branch as `GET /terms` is, optionally one language only. Read through the API
 * (the demo identity applies), then handed to the browser only as a file to save, under the name
 * the API serves it under. Rejects when it could not be read.
 */
@Injectable({ providedIn: 'root' })
export class TermExport {
  private readonly http = inject(HttpClient);
  private readonly base = inject(API_BASE_URL);
  private readonly readRef = inject(ReadRef);
  private readonly document = inject(DOCUMENT);

  async save(format: TermExportFormat, lang?: string): Promise<void> {
    const params: Record<string, string> = { format };
    if (lang) params['lang'] = lang;
    const ref = this.readRef.ref();
    if (ref) params['ref'] = ref;
    const response = await firstValueFrom(
      this.http.get(`${this.base}/terms/export`, {
        params,
        headers: {
          Accept: format === 'tbx' ? 'application/x-tbx+xml' : 'text/csv',
        },
        responseType: 'blob',
        observe: 'response',
      }),
    );
    saveResponse(this.document, response, `terms.${format}`);
  }
}
