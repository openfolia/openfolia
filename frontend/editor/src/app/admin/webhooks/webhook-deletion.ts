import { computed, inject, Injectable, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { injectTranslate, translated } from '@openfolia/ui/i18n';
import { ToastService, type ToastCloseReason } from '@openfolia/ui/toast';

import { ApiClient, toApiError } from '../../api';
import { apiErrorText } from '../../i18n';
import { MeService } from '../../permissions/me';

/** A delete waiting for its Undo window to end. */
interface Pending {
  readonly id: string;
  readonly name: string;
  /** Who asked for it: sent only while they are still the one acting. */
  readonly person: string;
  readonly toast: number;
}

/**
 * Deletes webhook subscribers with Undo instead of a confirm (#254): the subscriber leaves the
 * list at once and a toast offers Undo; `DELETE /webhooks/{id}` (with its log; waiting
 * deliveries are not sent) goes only when the toast ends (its time ran out, or it was closed).
 * Undo just keeps it. Root-provided, so a delete waiting outlives the page. A tab closed within
 * the window sends nothing: the subscriber stays.
 */
@Injectable({ providedIn: 'root' })
export class WebhookDeletion {
  private readonly api = inject(ApiClient);
  private readonly toast = inject(ToastService);
  private readonly me = inject(MeService);
  private readonly t = injectTranslate();

  private readonly waiting = signal<ReadonlyMap<string, Pending>>(new Map());
  private readonly sending = signal<ReadonlySet<string>>(new Set());
  private readonly deleted = signal<ReadonlySet<string>>(new Set());
  /** Subscribers waiting for their delete, being deleted or deleted: the list leaves them out. */
  readonly hidden = computed(
    () =>
      new Set([...this.waiting().keys(), ...this.sending(), ...this.deleted()]),
  );
  /** Counts finished deletes (and those that failed): the list reads again when it changes. */
  readonly changed = signal(0);

  delete(id: string, name: string): void {
    if (this.hidden().has(id)) return;
    const person = this.me.me().id;
    const toast = this.toast.success(
      translated('editor.admin.webhooks.delete.done', { name }),
      {
        actionLabel: translated('ui.toast.undo'),
        onAction: () => this.undo(id),
        onClose: (reason: ToastCloseReason) => {
          if (reason !== 'action') void this.send(id);
        },
      },
    );
    this.waiting.update((map) =>
      new Map(map).set(id, { id, name, person, toast }),
    );
  }

  /** Undo: the subscriber stays, back in the list. */
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
    // Someone else acting now (a demo switch): not theirs to delete.
    if (this.me.me().id !== pending.person) return;
    this.sending.update((set) => new Set(set).add(id));
    try {
      await firstValueFrom(
        this.api.delete('/webhooks/{webhookId}', { path: { webhookId: id } }),
      );
      this.deleted.update((set) => new Set(set).add(id));
    } catch (error) {
      const failure = toApiError(error);
      // Gone already (another tab, another manager): what was asked for.
      if (failure.status === 404) {
        this.deleted.update((set) => new Set(set).add(id));
      } else {
        const text = apiErrorText(failure);
        this.toast.error(
          translated('editor.admin.webhooks.delete.failed', {
            name: pending.name,
            reason: this.t(text.key, text.params),
          }),
        );
      }
    } finally {
      this.sending.update((set) => {
        const next = new Set(set);
        next.delete(id);
        return next;
      });
      this.changed.update((n) => n + 1);
    }
  }
}
