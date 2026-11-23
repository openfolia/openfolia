import {
  ChangeDetectionStrategy,
  Component,
  effect,
  inject,
  Injectable,
  signal,
} from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideKeyRound } from '@ng-icons/lucide';

import { ZardButtonComponent } from '@openfolia/ui/button';
import { ZardDialogImports } from '@openfolia/ui/dialog';
import { ZardDropdownImports } from '@openfolia/ui/dropdown-menu';
import { injectTranslate } from '@openfolia/ui/i18n';
import { ZardInputComponent } from '@openfolia/ui/input';
import { ToastService, translated } from '@openfolia/ui/startup';

import { toApiError } from '../api';
import { apiErrorText } from '../i18n';
import { PasswordSession } from './password-session';

/** The fewest characters a password has (the API's rule; it checks the rest). */
const MIN_LENGTH = 12;

/** Whether the change-password dialog is open: the menu item opens it, the shell holds it. */
@Injectable({ providedIn: 'root' })
export class ChangePasswordDialogState {
  readonly open = signal(false);
}

/**
 * "Change password" in the account menu (#610), projected into `of-account-menu`. The caller
 * shows it only for a session begun with a password (`GET /me`'s `meta.session.provider`).
 * It opens the dialog the shell holds (`of-change-password-dialog`): the menu's content goes
 * when the menu closes.
 */
@Component({
  selector: 'of-change-password-menu-item',
  imports: [ZardDropdownImports, NgIcon, TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [provideIcons({ lucideKeyRound })],
  host: { class: 'block' },
  template: `
    <z-dropdown-menu-item
      data-testid="change-password"
      (click)="dialog.open.set(true)"
    >
      <ng-icon
        name="lucideKeyRound"
        class="text-foreground size-4 shrink-0"
        aria-hidden="true"
      />
      {{ 'editor.signIn.changePassword.menu' | transloco }}
    </z-dropdown-menu-item>
  `,
})
export class ChangePasswordMenuItemComponent {
  protected readonly dialog = inject(ChangePasswordDialogState);
}

/**
 * The change-password dialog (#610): the current password, the new one twice. The API checks
 * the current one and the rules; the person's other sessions end, this one goes on. A refusal
 * says why and keeps the dialog open.
 */
@Component({
  selector: 'of-change-password-dialog',
  imports: [
    ZardDialogImports,
    ZardButtonComponent,
    ZardInputComponent,
    TranslocoPipe,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <z-dialog [(zVisible)]="state.open" class="sm:max-w-[28rem]">
      <z-dialog-header>
        <z-dialog-title>{{
          'editor.signIn.changePassword.title' | transloco
        }}</z-dialog-title>
        <z-dialog-description>{{
          'editor.signIn.changePassword.description' | transloco
        }}</z-dialog-description>
      </z-dialog-header>
      @if (state.open()) {
        <form
          id="change-password-form"
          class="flex flex-col gap-4"
          novalidate
          (submit)="submit($event)"
        >
          <div class="flex flex-col gap-1.5">
            <label class="text-sm" for="current-password">{{
              'editor.signIn.changePassword.current' | transloco
            }}</label>
            <input
              id="current-password"
              z-input
              type="password"
              autocomplete="current-password"
              maxlength="1024"
              required
              [value]="current()"
              (input)="current.set($any($event.target).value)"
            />
          </div>
          <div class="flex flex-col gap-1.5">
            <label class="text-sm" for="changed-password">{{
              'editor.signIn.changePassword.new' | transloco
            }}</label>
            <input
              id="changed-password"
              z-input
              type="password"
              autocomplete="new-password"
              maxlength="1024"
              required
              aria-describedby="changed-password-rules"
              [value]="next()"
              (input)="next.set($any($event.target).value)"
            />
            <p
              id="changed-password-rules"
              class="text-muted-foreground m-0 text-xs break-words"
            >
              {{ 'editor.signIn.setPassword.rules' | transloco }}
            </p>
          </div>
          <div class="flex flex-col gap-1.5">
            <label class="text-sm" for="changed-password-again">{{
              'editor.signIn.changePassword.confirm' | transloco
            }}</label>
            <input
              id="changed-password-again"
              z-input
              type="password"
              autocomplete="new-password"
              maxlength="1024"
              required
              [value]="again()"
              (input)="again.set($any($event.target).value)"
            />
          </div>
          @if (error(); as message) {
            <p
              role="alert"
              data-testid="change-password-error"
              class="text-destructive m-0 text-sm break-words"
            >
              {{ message }}
            </p>
          }
        </form>
      }
      <z-dialog-footer>
        <button z-button zType="ghost" type="button" z-dialog-close>
          {{ 'editor.admin.cancel' | transloco }}
        </button>
        <button
          z-button
          type="submit"
          form="change-password-form"
          [zDisabled]="busy()"
          [zLoading]="busy()"
        >
          {{ 'editor.signIn.changePassword.submit' | transloco }}
        </button>
      </z-dialog-footer>
    </z-dialog>
  `,
})
export class ChangePasswordDialogComponent {
  protected readonly state = inject(ChangePasswordDialogState);
  private readonly session = inject(PasswordSession);
  private readonly toast = inject(ToastService);
  private readonly t = injectTranslate();

  protected readonly current = signal('');
  protected readonly next = signal('');
  protected readonly again = signal('');
  protected readonly busy = signal(false);
  protected readonly error = signal('');

  constructor() {
    // Each opening starts empty: no password stays in memory longer than the dialog.
    effect(() => {
      if (this.state.open()) return;
      this.current.set('');
      this.next.set('');
      this.again.set('');
      this.error.set('');
    });
  }

  protected async submit(event: Event): Promise<void> {
    event.preventDefault();
    if (this.busy()) return;
    if ([...this.next().normalize('NFC')].length < MIN_LENGTH) {
      this.error.set(this.t('editor.signIn.setPassword.tooShort'));
      return;
    }
    if (this.next() !== this.again()) {
      this.error.set(this.t('editor.signIn.setPassword.mismatch'));
      return;
    }
    this.busy.set(true);
    this.error.set('');
    try {
      const ended = await this.session.changePassword(
        this.current(),
        this.next(),
      );
      this.state.open.set(false);
      this.toast.success(
        translated('editor.signIn.changePassword.done', { count: ended }),
      );
    } catch (error) {
      const text = apiErrorText(toApiError(error));
      this.error.set(this.t(text.key, text.params));
    } finally {
      this.busy.set(false);
    }
  }
}
