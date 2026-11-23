import { HttpEventType } from '@angular/common/http';
import { DOCUMENT, inject, Injectable } from '@angular/core';
import { firstValueFrom, lastValueFrom, tap } from 'rxjs';

import { ApiClient } from '../api';
import { servedName } from '../attachments/attachment-files';

/**
 * The largest ZIP saved through the page (#469): its bytes are held in the tab until they are
 * handed over, so a larger one is refused as soon as its length is known, before it is read.
 */
export const ARCHIVE_IN_PAGE_MAX_BYTES = 512 * 1024 * 1024;

/** The archive is longer than the page saves (`ARCHIVE_IN_PAGE_MAX_BYTES`). */
export class ArchiveTooLargeForPage extends Error {
  constructor(readonly size: number) {
    super('The archive is too large to save from the page.');
  }
}

/** How long a saved file's object URL lives: the browser has taken the bytes by then. */
const KEEP_URL_MS = 30_000;

/**
 * Saves a release's file to the person's device. The bytes are read through the API (so the demo
 * identity applies) and handed to the browser only as a file to save, under the name the API
 * serves it under (`<manual>_<variant>_<lang>_<revision>.pdf`): a `blob:` URL typed
 * `application/octet-stream` behind a link with `download`, never opened in the page.
 */
@Injectable({ providedIn: 'root' })
export class ReleaseFiles {
  private readonly api = inject(ApiClient);
  private readonly document = inject(DOCUMENT);

  /**
   * Saves all of the release's ready files as one ZIP (`GET /releases/:id/outputs/archive`),
   * telling `progress` the share received so far (0 to 1, in whole percents) while it comes;
   * resolves to how many files it holds and how many were left out (not ready). One longer than
   * `ARCHIVE_IN_PAGE_MAX_BYTES` is cut off at its first bytes (`ArchiveTooLargeForPage`).
   */
  async saveArchive(
    releaseId: string,
    progress: (share: number) => void,
  ): Promise<{ files: number; leftOut: number }> {
    let shown = -1;
    const response = await lastValueFrom(
      this.api.releaseArchive(releaseId).pipe(
        tap((event) => {
          if (event.type !== HttpEventType.DownloadProgress) return;
          // Thrown here, the request is cancelled: nothing more is read. Its length when known,
          // else what came so far (a proxy may have dropped Content-Length).
          const length = Math.max(event.total ?? 0, event.loaded);
          if (length > ARCHIVE_IN_PAGE_MAX_BYTES) {
            throw new ArchiveTooLargeForPage(length);
          }
          if (!event.total) return;
          const share = Math.min(
            1,
            Math.floor((event.loaded / event.total) * 100) / 100,
          );
          if (share !== shown) progress((shown = share));
        }),
      ),
    );
    if (response.type !== HttpEventType.Response || !response.body) {
      throw new Error('The archive was empty.');
    }
    progress(1);
    this.hand(
      response.body,
      servedName(response.headers.get('Content-Disposition')) ??
        `${releaseId}.zip`,
    );
    return {
      files: Number(response.headers.get('X-Ccms-Archive-Files') ?? 0),
      leftOut: Number(response.headers.get('X-Ccms-Archive-Left-Out') ?? 0),
    };
  }

  async save(releaseId: string, outputId: string): Promise<void> {
    const response = await firstValueFrom(
      this.api.file('/releases/{releaseId}/outputs/{outputId}/file', {
        path: { releaseId, outputId },
      }),
    );
    const bytes = response.body;
    if (!bytes) throw new Error('The file was empty.');
    this.hand(
      bytes,
      servedName(response.headers.get('Content-Disposition')) ??
        `${outputId}.pdf`,
    );
  }

  /**
   * Saves one version of a download (#139: an attachment or a manual's PDF as a release holds it,
   * `GET /downloads/:id/versions/:releaseId/file`) under the name the API serves it under.
   */
  async saveDownload(id: string, releaseId: string): Promise<void> {
    const response = await firstValueFrom(
      this.api.file('/downloads/{id}/versions/{releaseId}/file', {
        path: { id, releaseId },
      }),
    );
    const bytes = response.body;
    if (!bytes) throw new Error('The file was empty.');
    this.hand(
      bytes,
      servedName(response.headers.get('Content-Disposition')) ?? 'download',
    );
  }

  /** Hands the bytes to the browser as a file to save under `name`, never opened in the page. */
  private hand(bytes: Blob, name: string): void {
    const url = URL.createObjectURL(
      new Blob([bytes], { type: 'application/octet-stream' }),
    );
    const link = this.document.createElement('a');
    link.href = url;
    link.download = name;
    link.rel = 'noopener';
    link.hidden = true;
    this.document.body.append(link);
    try {
      link.click();
    } finally {
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), KEEP_URL_MS);
    }
  }
}
