import {
  ChangeDetectionStrategy,
  Component,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslocoPipe } from '@jsverse/transloco';

import { ZardButtonComponent } from '@openfolia/ui/button';
import { injectTranslate } from '@openfolia/ui/i18n';
import { ZardInputComponent } from '@openfolia/ui/input';

import { toApiError } from '../api';
import { apiErrorText } from '../i18n';
import type { SecondStepKind } from '../second-factor/second-factor-session';
import { PasswordSession } from '../session/password-session';

/**
 * The sign-in page's email and password form (#610). It signs in (the API sets the session
 * cookie) and says `signedIn`; a refusal ("The email address or the password is not right", the
 * lockout's wait) shows above the button and keeps what was typed but the password. "Forgot
 * password?" shows only when the API offers it (email can carry the link).
 */
@Component({
  selector: 'of-password-form',
  imports: [TranslocoPipe, RouterLink, ZardButtonComponent, ZardInputComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    <form
      class="flex flex-col gap-4"
      novalidate
      data-testid="password-form"
      [attr.aria-busy]="busy()"
      (submit)="submit($event)"
    >
      <div class="flex flex-col gap-1.5">
        <label class="text-sm" for="sign-in-email">{{
          'editor.signIn.password.email' | transloco
        }}</label>
        <input
          id="sign-in-email"
          z-input
          type="email"
          name="email"
          autocomplete="username"
          autocapitalize="none"
          spellcheck="false"
          maxlength="320"
          required
          [value]="email()"
          (input)="email.set($any($event.target).value)"
        />
      </div>
      <div class="flex flex-col gap-1.5">
        <div class="flex flex-wrap items-baseline justify-between gap-2">
          <label class="text-sm" for="sign-in-password">{{
            'editor.signIn.password.password' | transloco
          }}</label>
          @if (resetOffered()) {
            <a
              routerLink="/forgot-password"
              data-testid="forgot-password"
              class="text-muted-foreground hover:text-foreground focus-visible:ring-ring rounded-sm text-xs underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:outline-none"
              >{{ 'editor.signIn.password.forgot' | transloco }}</a
            >
          }
        </div>
        <input
          id="sign-in-password"
          z-input
          type="password"
          name="password"
          autocomplete="current-password"
          maxlength="1024"
          required
          [value]="password()"
          (input)="password.set($any($event.target).value)"
        />
      </div>
      @if (error(); as message) {
        <p
          role="alert"
          data-testid="password-error"
          class="border-destructive/40 bg-destructive/10 text-destructive m-0 rounded-md border px-3 py-2 text-sm break-words"
        >
          {{ message }}
        </p>
      }
      <button
        z-button
        type="submit"
        class="w-full"
        [zLoading]="busy()"
        [zDisabled]="busy()"
      >
        {{
          (busy()
            ? 'editor.signIn.password.signingIn'
            : 'editor.signIn.password.submit'
          ) | transloco
        }}
      </button>
    </form>
  `,
})
export class PasswordFormComponent {
  /** Whether "Forgot password?" is offered. */
  readonly resetOffered = input(false);
  /** The password is right: signed in (null), or the second step left to do (#611). */
  readonly signedIn = output<SecondStepKind>();

  private readonly session = inject(PasswordSession);
  private readonly t = injectTranslate();

  protected readonly email = signal('');
  protected readonly password = signal('');
  protected readonly busy = signal(false);
  protected readonly error = signal('');

  protected async submit(event: Event): Promise<void> {
    event.preventDefault();
    if (this.busy()) return;
    const email = this.email().trim();
    const password = this.password();
    if (email === '' || password === '') {
      this.error.set(this.t('editor.signIn.password.missing'));
      return;
    }
    this.busy.set(true);
    this.error.set('');
    try {
      this.signedIn.emit(await this.session.signIn(email, password));
    } catch (error) {
      const text = apiErrorText(toApiError(error));
      this.error.set(this.t(text.key, text.params));
      this.password.set('');
    } finally {
      this.busy.set(false);
    }
  }
}
