import {
  ChangeDetectionStrategy,
  Component,
  computed,
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
import { LanguageService, translated } from '@openfolia/ui/i18n';
import { ToastService } from '@openfolia/ui/toast';

/** A one-time link just made for a person (#610), shown this once. */
export interface ShownSignInLink {
  readonly name: string;
  readonly email: string | null;
  readonly kind: 'invite' | 'reset';
  readonly url: string;
  readonly expiresAt: string;
  readonly emailed: boolean;
}

/**
 * An invite or a password reset link, shown **once** (#610), for the admin to copy and give the
 * person; it says whether it was emailed too. Like a webhook's secret, it lives only in this
 * dialog while it is open; closing drops it. A click outside does not close it.
 */
@Component({
  selector: 'of-sign-in-link-dialog',
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
          (shown()?.kind === 'reset'
            ? 'editor.admin.users.link.resetTitle'
            : 'editor.admin.users.link.inviteTitle'
          ) | transloco: { name: shown()?.name ?? '' }
        }}</z-dialog-title>
        <z-dialog-description>{{
          'editor.admin.users.link.description'
            | transloco: { name: shown()?.name ?? '', date: until() }
        }}</z-dialog-description>
      </z-dialog-header>
      @if (open() && shown(); as once) {
        <section
          class="border-warning/40 bg-warning-muted flex min-w-0 flex-col gap-3 rounded-xl border p-4"
        >
          <code
            id="sign-in-link"
            data-testid="sign-in-link"
            class="bg-background border-border block rounded-md border p-3 font-mono text-xs break-all select-all"
            [attr.aria-label]="'editor.admin.users.link.label' | transloco"
            >{{ once.url }}</code
          >
          <div class="flex flex-wrap items-center gap-2">
            <button
              z-button
              type="button"
              data-testid="sign-in-link-copy"
              (click)="copy()"
            >
              <ng-icon
                [name]="copied() ? 'lucideCheck' : 'lucideCopy'"
                data-icon="inline-start"
                aria-hidden="true"
              />
              {{
                (copied()
                  ? 'editor.admin.users.link.copied'
                  : 'editor.admin.users.link.copy'
                ) | transloco
              }}
            </button>
            <span class="sr-only" aria-live="polite">{{
              copied() ? ('editor.admin.users.link.copied' | transloco) : ''
            }}</span>
          </div>
          <p
            class="text-muted-foreground m-0 flex items-start gap-2 text-xs break-words"
          >
            @if (!once.emailed) {
              <ng-icon
                name="lucideTriangleAlert"
                class="text-warning mt-0.5 shrink-0"
                aria-hidden="true"
              />
            }
            {{
              once.emailed
                ? ('editor.admin.users.link.emailed'
                  | transloco: { email: once.email ?? '' })
                : ('editor.admin.users.link.notEmailed' | transloco)
            }}
          </p>
        </section>
      }
      <z-dialog-footer>
        <button
          z-button
          type="button"
          data-testid="sign-in-link-done"
          (click)="open.set(false)"
        >
          {{ 'editor.admin.users.link.close' | transloco }}
        </button>
      </z-dialog-footer>
    </z-dialog>
  `,
})
export class SignInLinkDialogComponent {
  private readonly toast = inject(ToastService);
  private readonly language = inject(LanguageService);

  readonly open = model(false);
  readonly shown = input<ShownSignInLink | null>(null);
  protected readonly copied = signal(false);

  protected readonly until = computed(() => {
    const at = this.shown()?.expiresAt;
    return at
      ? new Intl.DateTimeFormat(this.language.locale(), {
          dateStyle: 'medium',
          timeStyle: 'short',
        }).format(new Date(at))
      : '';
  });

  constructor() {
    effect(() => {
      this.shown();
      untracked(() => this.copied.set(false));
    });
  }

  protected async copy(): Promise<void> {
    const once = this.shown();
    if (!once) return;
    try {
      await navigator.clipboard.writeText(once.url);
      this.copied.set(true);
    } catch {
      const code = document.getElementById('sign-in-link');
      const selection = window.getSelection();
      if (code && selection) selection.selectAllChildren(code);
      this.toast.error(translated('editor.admin.webhooks.secret.copyFailed'));
    }
  }
}
