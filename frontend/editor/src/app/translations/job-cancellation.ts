import { inject, Injectable, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { injectTranslate, translated } from '@openfolia/ui/i18n';
import { ToastService, type ToastCloseReason } from '@openfolia/ui/toast';

import { ApiClient, toApiError } from '../api';
import { apiErrorText } from '../i18n';
import { MeService } from '../permissions/me';
import { TranslationsChanges } from './translations-view';

/** A cancel waiting for its Undo window to end. */
interface Pending {
  readonly name: string;
  /** Who asked for it: sent only while they are still the one acting. */
  readonly person: string;
  readonly toast: number;
}

/**
 * Cancels translation jobs with Undo instead of a confirm (#87): the job shows as cancelled at
 * once and a toast offers Undo; `POST /translations/exports/{id}/cancel` goes only when the toast
 * ends (its time ran out, or it was closed), since the API cannot take a cancel back. Undo just
 * keeps the job at the agency. A cancel that fails comes back as it was, with a toast saying why.
 * Root-provided, so a cancel waiting outlives the page; a tab closed within the window sends
 * nothing.
 */
@Injectable({ providedIn: 'root' })
export class TranslationJobCancellation {
  private readonly api = inject(ApiClient);
  private readonly toast = inject(ToastService);
  private readonly me = inject(MeService);
  private readonly changes = inject(TranslationsChanges);
  private readonly t = injectTranslate();

  private readonly waiting = signal<ReadonlyMap<string, Pending>>(new Map());
  private readonly sending = signal<ReadonlySet<string>>(new Set());
  /** Cancelled here: shown so until the list reads it back, never flashing back to "sent". */
  private readonly done = signal<ReadonlySet<string>>(new Set());

  /** The job shows as cancelled: waiting for its Undo window, being cancelled, or cancelled. */
  isCancelling(id: string): boolean {
    return (
      this.waiting().has(id) || this.sending().has(id) || this.done().has(id)
    );
  }

  cancel(id: string, name: string): void {
    if (this.isCancelling(id)) return;
    const person = this.me.me().id;
    const toast = this.toast.success(
      translated('editor.translations.jobs.cancel.done', { name }),
      {
        actionLabel: translated('ui.toast.undo'),
        onAction: () => this.undo(id),
        onClose: (reason: ToastCloseReason) => {
          if (reason !== 'action') void this.send(id);
        },
      },
    );
    this.waiting.update((map) => new Map(map).set(id, { name, person, toast }));
  }

  /** Undo: the job stays at the agency. */
  undo(id: string): void {
    const pending = this.waiting().get(id);
    if (!pending) return;
    this.forget(id);
    this.toast.dismiss(pending.toast);
  }

  private forget(id: string): void {
    this.waiting.update((map) => {
      const next = new Map(map);
      next.delete(id);
      return next;
    });
  }

  private async send(id: string): Promise<void> {
    const pending = this.waiting().get(id);
    if (!pending) return;
    this.forget(id);
    // Someone else acting now (a demo switch): not theirs to cancel.
    if (this.me.me().id !== pending.person) return;
    this.sending.update((set) => new Set(set).add(id));
    try {
      await firstValueFrom(
        this.api.act('/translations/exports/{jobId}/cancel', {
          path: { jobId: id },
        }),
      );
      this.done.update((set) => new Set(set).add(id));
    } catch (error) {
      const text = apiErrorText(toApiError(error));
      this.toast.error(
        translated('editor.translations.jobs.cancel.failed', {
          name: pending.name,
          reason: this.t(text.key, text.params),
        }),
      );
    } finally {
      this.sending.update((set) => {
        const next = new Set(set);
        next.delete(id);
        return next;
      });
      this.changes.notify();
    }
  }
}
