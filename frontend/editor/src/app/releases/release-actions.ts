import { inject, Injectable, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { translated } from '@openfolia/ui/i18n';
import { ToastService } from '@openfolia/ui/toast';

import { ApiClient, toApiError } from '../api';
import { apiErrorText } from '../i18n';
import { injectFailureText } from '../session/failure-text';
import { ArchiveTooLargeForPage, ReleaseFiles } from './release-files';
import type { ReleaseItem, RetriedOutput } from './releases-model';

/** Archive errors that trying again at once does not cure. */
const FINAL_ARCHIVE_CODES = new Set([
  'release-archive-empty',
  'release-archive-too-large',
]);

/**
 * What a publisher (and, for downloads, a reader) does to a release, shared by the list's panel
 * and the release's page: withdraw it (final, with the reason), retry a failed file, plan the
 * files again, save a file. Each says how it went in a toast; none offers Undo (withdrawing is
 * final, #331, and a retry is a new render).
 */
@Injectable({ providedIn: 'root' })
export class ReleaseActions {
  private readonly api = inject(ApiClient);
  private readonly toast = inject(ToastService);
  private readonly files = inject(ReleaseFiles);
  private readonly failureText = injectFailureText();

  /** Withdraws the release; resolves to it as withdrawn, or rejects with the text to show. */
  async withdraw(
    release: ReleaseItem,
    name: string,
    reason: string,
  ): Promise<ReleaseItem> {
    try {
      const doc = await firstValueFrom(
        this.api.act(
          '/releases/{releaseId}/withdraw',
          { path: { releaseId: release.id } },
          { meta: { reason } },
        ),
      );
      this.toast.success(translated('editor.releases.withdraw.done', { name }));
      return doc.data;
    } catch (error) {
      throw apiErrorText(toApiError(error));
    }
  }

  /** Queues a failed file again; resolves to what the answer tells of it, null when it failed. */
  async retry(
    releaseId: string,
    outputId: string,
  ): Promise<RetriedOutput | null> {
    try {
      const doc = await firstValueFrom(
        this.api.act('/releases/{releaseId}/outputs/{outputId}/retry', {
          path: { releaseId, outputId },
        }),
      );
      this.toast.success(translated('editor.releases.files.retried'));
      return doc.data;
    } catch (error) {
      this.toast.error(apiErrorText(toApiError(error)));
      return null;
    }
  }

  /** Plans the release's files again (a planning that failed for good, or was cut off). */
  async replan(releaseId: string): Promise<boolean> {
    try {
      const doc = await firstValueFrom(
        this.api.act('/releases/{releaseId}/outputs/plan', {
          path: { releaseId },
        }),
      );
      this.toast.success(
        translated(
          doc.meta.queued
            ? 'editor.releases.files.planQueued'
            : 'editor.releases.files.planRunning',
        ),
      );
      return true;
    } catch (error) {
      const failure = toApiError(error);
      // Over the limit of files per release (#477): its own text, here rather than among the
      // shared API error texts, which load with the first screen.
      this.toast.error(
        failure.code === 'too-many-outputs'
          ? translated('editor.releases.files.tooMany.refused', {
              ...failure.errors[0]?.meta,
            })
          : apiErrorText(failure),
      );
      return false;
    }
  }

  private readonly archivingState = signal<{
    releaseId: string;
    share: number;
  } | null>(null);
  /** The release whose ZIP is downloading and the share received (0 to 1); null for none. */
  readonly archiving = this.archivingState.asReadonly();

  /**
   * Saves all of the release's ready files as one ZIP (one at a time: a second while one comes is
   * ignored), its share received in `archiving`; says how it went (and how many files were left
   * out, not ready), a failure with Retry.
   */
  async downloadAll(releaseId: string, name: string): Promise<void> {
    if (this.archivingState()) return;
    this.archivingState.set({ releaseId, share: 0 });
    try {
      const { files, leftOut } = await this.files.saveArchive(
        releaseId,
        (share) => this.archivingState.set({ releaseId, share }),
      );
      this.toast.success(
        leftOut > 0
          ? translated('editor.releases.files.archive.savedPartly', {
              files,
              leftOut,
            })
          : translated('editor.releases.files.archive.saved', { files }),
      );
    } catch (error) {
      if (error instanceof ArchiveTooLargeForPage) {
        this.toast.error(translated('editor.releases.files.archive.tooLarge'));
        return;
      }
      const apiError = toApiError(error);
      // Trying again changes nothing while none is ready, or past the size the API serves.
      const lasting = FINAL_ARCHIVE_CODES.has(apiError.code);
      this.toast.error(
        this.failureText(
          translated('editor.releases.files.archive.failed', { name }),
          apiError,
        ),
        lasting
          ? undefined
          : {
              actionLabel: translated('editor.releases.retry'),
              onAction: () => void this.downloadAll(releaseId, name),
            },
      );
    } finally {
      this.archivingState.set(null);
    }
  }

  /** Saves a file; a failure says so, with Retry. */
  async download(
    releaseId: string,
    outputId: string,
    name: string,
  ): Promise<void> {
    try {
      await this.files.save(releaseId, outputId);
    } catch (error) {
      this.toast.error(
        this.failureText(
          translated('editor.releases.files.downloadFailed', { name }),
          toApiError(error),
        ),
        {
          actionLabel: translated('editor.releases.retry'),
          onAction: () => void this.download(releaseId, outputId, name),
        },
      );
    }
  }

  /** Saves one version of a download (#139); a failure says so in a toast that can try again. */
  async saveDownload(
    id: string,
    releaseId: string,
    name: string,
  ): Promise<void> {
    try {
      await this.files.saveDownload(id, releaseId);
    } catch (error) {
      this.toast.error(
        this.failureText(
          translated('editor.releases.files.downloadFailed', { name }),
          toApiError(error),
        ),
        {
          actionLabel: translated('editor.releases.retry'),
          onAction: () => void this.saveDownload(id, releaseId, name),
        },
      );
    }
  }
}
