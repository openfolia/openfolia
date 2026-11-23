import { HttpEventType } from '@angular/common/http';
import { inject, Injectable, signal } from '@angular/core';

import { translated } from '@openfolia/ui/i18n';
import { ToastService } from '@openfolia/ui/toast';

import { ApiClient, toApiError } from '../api';
import { MeService } from '../permissions/me';
import { injectFailureText } from '../session/failure-text';
import { uploadKind } from './media-model';
import { MediaDeletion } from './media-deletion';

/** A file being uploaded from the media library. */
export interface UploadRow {
  readonly key: number;
  readonly name: string;
  readonly size: number;
  /** The share of its bytes sent, from 0 to 1. */
  readonly progress: number;
  readonly changeSetId: string;
}

/**
 * Uploads files into a change set from the media library, with their progress: a PNG or JPEG as
 * an image (`POST /change-sets/{id}/assets`), anything else as an attachment
 * (`?kind=attachment`, the server's type rules apply). Each upload is a row until the API
 * answers; then a toast says it is there (and the list reads again, `changed`), or why it was
 * refused, with Retry. Root-provided, so an upload under way outlives the page.
 */
@Injectable({ providedIn: 'root' })
export class MediaUploads {
  private readonly api = inject(ApiClient);
  private readonly toast = inject(ToastService);
  private readonly me = inject(MeService);
  private readonly deletion = inject(MediaDeletion);
  private readonly failureText = injectFailureText();
  private keys = 0;

  private readonly list = signal<readonly UploadRow[]>([]);
  /** The uploads under way, newest first. */
  readonly rows = this.list.asReadonly();
  /** Counts finished uploads: lists read again when it changes. */
  readonly changed = signal(0);

  upload(files: readonly File[], changeSetId: string): void {
    for (const file of files) this.send(file, changeSetId);
  }

  private send(file: File, changeSetId: string): void {
    const key = ++this.keys;
    const person = this.me.me().id;
    const row: UploadRow = {
      key,
      name: file.name,
      size: file.size,
      progress: 0,
      changeSetId,
    };
    this.list.update((rows) => [row, ...rows]);
    const update = (progress: number) =>
      this.list.update((rows) =>
        rows.map((r) => (r.key === key ? { ...r, progress } : r)),
      );
    const remove = () =>
      this.list.update((rows) => rows.filter((r) => r.key !== key));
    this.api
      .uploadWithProgress(
        '/change-sets/{changeSetId}/assets',
        { path: { changeSetId }, kind: uploadKind(file) },
        file,
      )
      .subscribe({
        next: (event) => {
          if (event.type === HttpEventType.UploadProgress) {
            const total = event.total ?? file.size;
            if (total > 0) update(Math.min(1, event.loaded / total));
          } else if (event.type === HttpEventType.Response) {
            remove();
            const reference = event.body?.data.attributes.reference;
            if (reference)
              this.deletion.uploaded(reference.replace(/^sha256:/, ''));
            this.changed.update((n) => n + 1);
            this.toast.success(
              translated('editor.media.upload.done', { name: file.name }),
            );
          }
        },
        error: (error: unknown) => {
          remove();
          this.toast.error(
            this.failureText(
              translated('editor.media.upload.failed', { name: file.name }),
              toApiError(error),
            ),
            {
              actionLabel: translated('editor.session.retry'),
              // Only for whoever uploaded it.
              onAction: () => {
                if (this.me.me().id === person) this.send(file, changeSetId);
              },
            },
          );
        },
      });
  }
}
