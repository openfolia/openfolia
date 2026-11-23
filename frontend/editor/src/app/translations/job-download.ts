import { DOCUMENT, Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { ApiClient } from '../api';
import { saveResponse } from '../reports/report-download';

/**
 * Saves a translation job's file to the person's device: one language's XLIFF when the job has
 * one language, else a ZIP with one per language. Read through the API (the demo identity
 * applies), then handed to the browser only as a file to save. Rejects when it could not be read.
 * Or the job as a COTI package for a translation management system (#140).
 */
@Injectable({ providedIn: 'root' })
export class TranslationJobDownload {
  private readonly api = inject(ApiClient);
  private readonly document = inject(DOCUMENT);

  async save(job: {
    readonly id: string;
    readonly languages: readonly string[];
  }): Promise<void> {
    const [only] = job.languages;
    const lang = job.languages.length === 1 ? only : undefined;
    const response = await firstValueFrom(
      this.api.translationJobFile(job.id, lang),
    );
    saveResponse(
      this.document,
      response,
      `translation-${job.id}${lang ? `-${lang}.xlf` : '.zip'}`,
    );
  }

  /**
   * Saves the job as a COTI package (#140), named as the server names it
   * (`<time>_translation-<job>.coti`). Rejects when it could not be read.
   */
  async savePackage(job: { readonly id: string }): Promise<void> {
    const response = await firstValueFrom(
      this.api.translationJobPackage(job.id),
    );
    saveResponse(this.document, response, `translation-${job.id}.coti`);
  }
}
