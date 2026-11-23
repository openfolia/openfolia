import { inject, Injectable, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { translated, type TranslatedText } from '@openfolia/ui/i18n';
import { ToastService } from '@openfolia/ui/toast';

import { ApiClient, toApiError, type ApiError } from '../api';
import { injectFailureText } from '../session/failure-text';
import {
  MaintenanceLines,
  type MaintenanceLine,
} from '../session/maintenance-lines';
import type { ReleaseItem } from './releases-model';

/** A failure trying again at once may cure: offered a Retry. */
const retryable = (failure: ApiError): boolean =>
  failure.kind === 'unavailable' ||
  failure.kind === 'network' ||
  failure.code === 'database-timeout';

/**
 * What a publisher does to maintenance lines on the Releases page (#250): start one from a release
 * (`POST /maintenance-lines`, `release.publish`) and close one (`POST …/close`). Both are final in
 * Git (a line's branch stays), so neither offers Undo: closing asks first, the page shows the line
 * closed at once and puts it back if the API refuses. Trying a start again is safe: the API
 * starts one line per release (`maintenance-line-exists`).
 */
@Injectable({ providedIn: 'root' })
export class MaintenanceActions {
  private readonly api = inject(ApiClient);
  private readonly toast = inject(ToastService);
  private readonly lines = inject(MaintenanceLines);
  private readonly failureText = injectFailureText();

  private readonly starting = signal<ReadonlySet<string>>(new Set());

  /** A line is being started from this release. */
  startingFrom(releaseId: string): boolean {
    return this.starting().has(releaseId);
  }

  /**
   * Starts a line from the release ("North 2.1"). Resolves the line, or null with a toast saying
   * why; `show` is the toast's way to the Maintenance tab.
   */
  async start(
    release: ReleaseItem,
    name: string,
    show: () => void,
  ): Promise<MaintenanceLine | null> {
    if (this.starting().has(release.id)) return null;
    this.starting.update((s) => new Set(s).add(release.id));
    try {
      const doc = await firstValueFrom(
        this.api.post('/maintenance-lines', {
          data: {
            type: 'MaintenanceLine',
            relationships: {
              baseRelease: { data: { type: 'Release', id: release.id } },
            },
          },
        }),
      );
      await this.lines.refresh();
      this.toast.success(
        translated('editor.releases.maintenance.started', { name }),
        {
          actionLabel: translated('editor.releases.maintenance.show'),
          onAction: show,
        },
      );
      return doc.data;
    } catch (error) {
      const failure = toApiError(error);
      if (failure.code === 'maintenance-line-exists') {
        // Started meanwhile (another tab, someone else): there it is.
        await this.lines.refresh();
        this.toast.show(
          translated('editor.releases.maintenance.exists', { name }),
          {
            kind: 'info',
            actionLabel: translated('editor.releases.maintenance.show'),
            onAction: show,
          },
        );
        return null;
      }
      this.fail(
        translated('editor.releases.maintenance.startFailed', { name }),
        failure,
        () => void this.start(release, name, show),
      );
      return null;
    } finally {
      this.starting.update((s) => {
        const next = new Set(s);
        next.delete(release.id);
        return next;
      });
    }
  }

  /** Closes the line ("North 2.1"); resolves it as closed, or null with a toast saying why. */
  async close(
    line: MaintenanceLine,
    name: string,
    retry: () => void,
  ): Promise<MaintenanceLine | null> {
    try {
      const doc = await firstValueFrom(
        this.api.act('/maintenance-lines/{maintenanceLineId}/close', {
          path: { maintenanceLineId: line.id },
        }),
      );
      void this.lines.refresh();
      this.toast.success(
        translated('editor.releases.maintenance.closed', { name }),
      );
      return doc.data;
    } catch (error) {
      this.fail(
        translated('editor.releases.maintenance.closeFailed', { name }),
        toApiError(error),
        retry,
      );
      return null;
    }
  }

  private fail(
    what: TranslatedText,
    failure: ApiError,
    again: () => void,
  ): void {
    this.toast.error(
      this.failureText(what, failure),
      retryable(failure)
        ? { actionLabel: translated('editor.session.retry'), onAction: again }
        : {},
    );
  }
}
