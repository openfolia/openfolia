import type { HttpResponse } from '@angular/common/http';
import { DOCUMENT, Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { ApiClient } from '../api';
import { servedName } from '../attachments/attachment-files';

/** How long a saved file's object URL lives: the browser has taken the bytes by then. */
const KEEP_URL_MS = 30_000;

/** The reports that download as CSV, by their API route. */
export type ReportCsvPath =
  '/reports/translations/csv' | '/reports/module-usage/csv';

/**
 * Saves a report's CSV to the person's device (#56). The file is read through the API (so the
 * demo identity and the chosen branch apply), then handed to the browser only as a file to save:
 * a `blob:` URL typed `application/octet-stream` behind a link with `download`, under the name
 * the API serves it under. Rejects when it could not be read.
 */
@Injectable({ providedIn: 'root' })
export class ReportDownload {
  private readonly api = inject(ApiClient);
  private readonly document = inject(DOCUMENT);

  async save(
    path: ReportCsvPath,
    query: Readonly<Record<string, string | undefined>>,
    fallbackName: string,
  ): Promise<void> {
    const response = await firstValueFrom(this.api.csv(path, query));
    saveResponse(this.document, response, fallbackName);
  }
}

/**
 * Hands a file read through the API to the browser only as a file to save: a `blob:` URL typed
 * `application/octet-stream` behind a link with `download`, under the name the API serves it
 * under (`Content-Disposition`), else `fallbackName`.
 */
export function saveResponse(
  document: Document,
  response: HttpResponse<Blob>,
  fallbackName: string,
): void {
  const bytes = response.body ?? new Blob([]);
  const name =
    servedName(response.headers.get('Content-Disposition')) ?? fallbackName;
  const url = URL.createObjectURL(
    new Blob([bytes], { type: 'application/octet-stream' }),
  );
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.rel = 'noopener';
  link.hidden = true;
  document.body.append(link);
  try {
    link.click();
  } finally {
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), KEEP_URL_MS);
  }
}
