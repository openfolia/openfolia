import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  effect,
  inject,
  input,
  model,
  signal,
  untracked,
} from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideCheck, lucideCopy, lucideTriangleAlert } from '@ng-icons/lucide';

import { ZardButtonComponent } from '@openfolia/ui/button';
import { ZardDialogImports } from '@openfolia/ui/dialog';
import { translated } from '@openfolia/ui/i18n';
import { ToastService } from '@openfolia/ui/toast';

/** A signing secret just made or rotated, shown this once. */
export interface ShownSecret {
  /** Whose: the subscriber's name as the list shows it. */
  readonly name: string;
  /** `created`: a new subscriber; `rotated`: a new secret, the old one signing for a day more. */
  readonly reason: 'created' | 'rotated';
  readonly secret: string;
}

/**
 * A webhook's signing secret, shown **once** (#254): when a subscriber is made and when its
 * secret is rotated. Copy puts it on the clipboard; the note says it cannot be shown again. It
 * lives only in the `secret` the page hands over and in this dialog while it is open: never in
 * the address, storage, a log or a toast. Closing (Done, Escape, the close button) drops it, and
 * the page forgets its copy too (`open` goes false). A click outside does not close it, so the
 * secret is not lost by a stray click.
 */
@Component({
  selector: 'of-webhook-secret-dialog',
  imports: [ZardDialogImports, ZardButtonComponent, NgIcon, TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [
    provideIcons({ lucideCheck, lucideCopy, lucideTriangleAlert }),
  ],
  template: `
    <z-dialog
      [(zVisible)]="open"
      [zMaskClosable]="false"
      class="sm:max-w-[34rem]"
    >
      <z-dialog-header>
        <z-dialog-title>{{
          (shown()?.reason === 'rotated'
            ? 'editor.admin.webhooks.secret.rotatedTitle'
            : 'editor.admin.webhooks.secret.createdTitle'
          ) | transloco: { name: shown()?.name ?? '' }
        }}</z-dialog-title>
        <z-dialog-description>{{
          (shown()?.reason === 'rotated'
            ? 'editor.admin.webhooks.secret.rotatedDescription'
            : 'editor.admin.webhooks.secret.createdDescription'
          ) | transloco
        }}</z-dialog-description>
      </z-dialog-header>
      @if (open() && shown(); as once) {
        <section
          class="border-warning/40 bg-warning-muted flex min-w-0 flex-col gap-3 rounded-xl border p-4"
          aria-labelledby="webhook-secret-once"
        >
          <p
            id="webhook-secret-once"
            class="text-foreground m-0 flex items-start gap-2 text-sm font-medium break-words"
          >
            <ng-icon
              name="lucideTriangleAlert"
              class="text-warning mt-0.5 shrink-0"
              aria-hidden="true"
            />
            {{ 'editor.admin.webhooks.secret.once' | transloco }}
          </p>
          <code
            id="webhook-secret"
            data-slot="webhook-secret"
            class="bg-background border-border block rounded-md border p-3 font-mono text-xs break-all select-all"
            [attr.aria-label]="'editor.admin.webhooks.secret.label' | transloco"
            >{{ once.secret }}</code
          >
          <div class="flex flex-wrap items-center gap-2">
            <button
              z-button
              type="button"
              data-slot="webhook-secret-copy"
              (click)="copy()"
            >
              <ng-icon
                [name]="copied() ? 'lucideCheck' : 'lucideCopy'"
                data-icon="inline-start"
                aria-hidden="true"
              />
              {{
                (copied()
                  ? 'editor.admin.webhooks.secret.copied'
                  : 'editor.admin.webhooks.secret.copy'
                ) | transloco
              }}
            </button>
            <span class="sr-only" aria-live="polite">{{
              copied()
                ? ('editor.admin.webhooks.secret.copied' | transloco)
                : ''
            }}</span>
          </div>
          <p class="text-muted-foreground m-0 text-xs break-words">
            {{ 'editor.admin.webhooks.secret.verify' | transloco }}
          </p>
        </section>
      }
      <z-dialog-footer>
        <button
          z-button
          type="button"
          data-slot="webhook-secret-done"
          (click)="open.set(false)"
        >
          {{ 'editor.admin.webhooks.secret.done' | transloco }}
        </button>
      </z-dialog-footer>
    </z-dialog>
  `,
})
export class WebhookSecretDialogComponent {
  private readonly toast = inject(ToastService);

  readonly open = model(false);
  readonly shown = input<ShownSecret | null>(null);
  protected readonly copied = signal(false);

  constructor() {
    // A new secret starts uncopied.
    effect(() => {
      this.shown();
      untracked(() => this.copied.set(false));
    });
    inject(DestroyRef).onDestroy(() => this.copied.set(false));
  }

  protected async copy(): Promise<void> {
    const once = this.shown();
    if (!once) return;
    try {
      await navigator.clipboard.writeText(once.secret);
      this.copied.set(true);
    } catch {
      // No clipboard (an insecure origin, a refused permission): select it for copying by hand.
      const code = document.getElementById('webhook-secret');
      const selection = window.getSelection();
      if (code && selection) selection.selectAllChildren(code);
      this.toast.error(translated('editor.admin.webhooks.secret.copyFailed'));
    }
  }
}
