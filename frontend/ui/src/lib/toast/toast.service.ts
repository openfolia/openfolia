import { Injectable, signal } from '@angular/core';

import type { Translatable } from '../i18n/text.pipe';

export type ToastKind = 'success' | 'info' | 'warning' | 'error';

export interface ToastOptions {
  kind?: ToastKind;
  /** An action on the toast, typically "Undo" (`translated('ui.toast.undo')`). */
  actionLabel?: Translatable;
  onAction?: () => void;
  /** Milliseconds before it goes away; 0 keeps it until dismissed. Errors default to 0. */
  duration?: number;
  /**
   * Runs once when the toast goes, with why: its action ran (`action`), its time ran out
   * (`timeout`) or it was closed (`dismissed`, also by its close button). A deferred action (a
   * delete sent once its Undo is no longer offered) goes on here unless the action ran.
   */
  onClose?: (reason: ToastCloseReason) => void;
}

/** Why a toast went: its action ran, its time ran out, or it was closed. */
export type ToastCloseReason = 'action' | 'timeout' | 'dismissed';

export interface Toast {
  readonly id: number;
  /** A key (`translated(…)`), translated where it shows, so it follows a language switch. */
  readonly message: Translatable;
  readonly kind: ToastKind;
  readonly actionLabel?: Translatable;
  readonly onAction?: () => void;
}

const DEFAULT_DURATION = 6000;
/** A toast with an action (Undo) stays longer: keyboard users need time to reach it. */
const ACTION_DURATION = 20000;

/**
 * Toasts: confirm an action, and offer undo where it is safe. `ToasterComponent` (mounted once
 * in the app shell) renders them. This is our own small service, in the role of Zard's Sonner,
 * so the library carries no extra dependency; the API is the same shape (message, action).
 */
@Injectable({ providedIn: 'root' })
export class ToastService {
  private nextId = 1;
  private readonly timers = new Map<number, ReturnType<typeof setTimeout>>();
  private readonly closers = new Map<
    number,
    (reason: ToastCloseReason) => void
  >();
  private readonly state = signal<readonly Toast[]>([]);
  readonly toasts = this.state.asReadonly();

  show(message: Translatable, options: ToastOptions = {}): number {
    const kind = options.kind ?? 'info';
    const id = this.nextId++;
    this.state.update((list) => [
      ...list,
      {
        id,
        message,
        kind,
        actionLabel: options.actionLabel,
        onAction: options.onAction,
      },
    ]);
    const duration =
      options.duration ??
      (kind === 'error'
        ? 0
        : options.actionLabel
          ? ACTION_DURATION
          : DEFAULT_DURATION);
    if (options.onClose) this.closers.set(id, options.onClose);
    if (duration > 0) {
      this.timers.set(
        id,
        setTimeout(() => this.close(id, 'timeout'), duration),
      );
    }
    return id;
  }

  success(
    message: Translatable,
    options: Omit<ToastOptions, 'kind'> = {},
  ): number {
    return this.show(message, { ...options, kind: 'success' });
  }

  error(
    message: Translatable,
    options: Omit<ToastOptions, 'kind'> = {},
  ): number {
    return this.show(message, { ...options, kind: 'error' });
  }

  /** Runs the toast's action once, then closes it. */
  runAction(id: number): void {
    const toast = this.state().find((t) => t.id === id);
    if (!toast) return;
    this.close(id, 'action');
    toast.onAction?.();
  }

  dismiss(id: number): void {
    this.close(id, 'dismissed');
  }

  private close(id: number, reason: ToastCloseReason): void {
    const timer = this.timers.get(id);
    if (timer !== undefined) clearTimeout(timer);
    this.timers.delete(id);
    this.state.update((list) => list.filter((t) => t.id !== id));
    const closer = this.closers.get(id);
    this.closers.delete(id);
    closer?.(reason);
  }
}
