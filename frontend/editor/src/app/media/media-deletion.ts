import { computed, inject, Injectable, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { injectTranslate, translated } from '@openfolia/ui/i18n';
import { ToastService, type ToastCloseReason } from '@openfolia/ui/toast';

import { ApiClient, toApiError } from '../api';
import { MeService } from '../permissions/me';
import { injectFailureText } from '../session/failure-text';
import { inUsePlaces, PLACE_KEYS } from './media-model';

/** A delete waiting for its Undo window to end. */
interface Pending {
  readonly hash: string;
  readonly name: string;
  /** Who asked for it: sent only while they are still the one acting. */
  readonly person: string;
  readonly toast: number;
}

/**
 * Deletes unused files, Undo instead of a confirm afterwards: the file leaves the list at once
 * and a toast offers Undo; the request (`DELETE /assets/{hash}`) is sent only when the toast ends
 * (its time ran out, or it was closed). Undo just keeps the file. The API checks again that
 * nobody uses it, and keeps a file used meanwhile (409 `asset-in-use`): it comes back into the
 * list with a toast naming where it is used. Root-provided, so a delete waiting outlives the page.
 * A tab closed within the window sends nothing: the file stays.
 */
@Injectable({ providedIn: 'root' })
export class MediaDeletion {
  private readonly api = inject(ApiClient);
  private readonly toast = inject(ToastService);
  private readonly me = inject(MeService);
  private readonly failureText = injectFailureText();
  private readonly t = injectTranslate();

  private readonly waiting = signal<ReadonlyMap<string, Pending>>(new Map());
  private readonly sending = signal<ReadonlySet<string>>(new Set());
  /** Files deleted here: left out while a list read from before may still name them. */
  private readonly deleted = signal<ReadonlySet<string>>(new Set());
  /** Files waiting for their delete, being deleted or deleted: the list leaves them out. */
  readonly hidden = computed(
    () =>
      new Set([...this.waiting().keys(), ...this.sending(), ...this.deleted()]),
  );
  /** Counts finished deletes (and files kept): lists read again when it changes. */
  readonly changed = signal(0);

  /** Takes the file out of the list and offers Undo; the delete is sent when the toast ends. */
  delete(hash: string, name: string): void {
    if (this.hidden().has(hash)) return;
    const person = this.me.me().id;
    const toast = this.toast.success(
      translated('editor.media.delete.done', { name }),
      {
        actionLabel: translated('ui.toast.undo'),
        onAction: () => this.undo(hash),
        onClose: (reason: ToastCloseReason) => {
          if (reason !== 'action') void this.send(hash);
        },
      },
    );
    this.waiting.update((map) =>
      new Map(map).set(hash, { hash, name, person, toast }),
    );
  }

  /** Undo: the file stays, back in the list. */
  undo(hash: string): void {
    const pending = this.waiting().get(hash);
    if (!pending) return;
    this.forget(hash);
    this.toast.dismiss(pending.toast);
  }

  /** The same bytes uploaded again: listed again. */
  uploaded(hash: string): void {
    if (!this.deleted().has(hash)) return;
    this.deleted.update((set) => {
      const next = new Set(set);
      next.delete(hash);
      return next;
    });
  }

  private gone(hash: string): void {
    this.deleted.update((set) => new Set(set).add(hash));
  }

  private forget(hash: string): void {
    this.waiting.update((map) => {
      const next = new Map(map);
      next.delete(hash);
      return next;
    });
  }

  private async send(hash: string): Promise<void> {
    const pending = this.waiting().get(hash);
    if (!pending) return;
    this.forget(hash);
    // Someone else acting now (a demo switch): not theirs to delete.
    if (this.me.me().id !== pending.person) return;
    this.sending.update((set) => new Set(set).add(hash));
    try {
      await firstValueFrom(
        this.api.delete('/assets/{hash}', { path: { hash } }),
      );
      this.gone(hash);
    } catch (error) {
      const failure = toApiError(error);
      // Gone already (another tab, another person): what was asked for.
      if (failure.status === 404) this.gone(hash);
      else this.failed(pending, failure);
    } finally {
      this.sending.update((set) => {
        const next = new Set(set);
        next.delete(hash);
        return next;
      });
      this.changed.update((n) => n + 1);
    }
  }

  private failed(
    pending: Pending,
    failure: ReturnType<typeof toApiError>,
  ): void {
    const { name } = pending;
    if (failure.code === 'asset-in-use') {
      const places = inUsePlaces(failure.errors[0]?.meta)
        .map((place) => {
          const key = PLACE_KEYS[place.in];
          return key ? this.t(key, { ref: place.ref ?? '' }) : place.in;
        })
        .join(', ');
      this.toast.error(
        places
          ? translated('editor.media.delete.inUse', { name, places })
          : translated('editor.media.delete.inUseSomewhere', { name }),
      );
      return;
    }
    this.toast.error(
      this.failureText(
        translated('editor.media.delete.failed', { name }),
        failure,
      ),
    );
  }
}
