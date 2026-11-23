import {
  ChangeDetectionStrategy,
  Component,
  inject,
  signal,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslocoPipe } from '@jsverse/transloco';

import { ZardButtonComponent } from '@openfolia/ui/button';
import { injectTranslate } from '@openfolia/ui/i18n';
import { ZardInputComponent } from '@openfolia/ui/input';
import { FadeInDirective } from '@openfolia/ui/smooth';

import { toApiError } from '../api';
import { apiErrorText } from '../i18n';
import { PasswordSession } from '../session/password-session';
import { SignInFrameComponent } from './sign-in-frame.component';

/**
 * "Forgot password" (#610): an email address, then always the same answer, "If the address is
 * known, an email is on its way" (the API answers so whatever the address). The sign-in page
 * links here only when email can carry the link.
 */
@Component({
  selector: 'of-forgot-password-page',
  imports: [
    TranslocoPipe,
    RouterLink,
    ZardButtonComponent,
    ZardInputComponent,
    FadeInDirective,
    SignInFrameComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    <of-sign-in-frame
      [heading]="'editor.signIn.forgot.title' | transloco"
      [intro]="sent() ? '' : ('editor.signIn.forgot.intro' | transloco)"
      [busy]="busy()"
    >
      @if (sent()) {
        <div ofFadeIn class="flex flex-col gap-2" data-testid="forgot-sent">
          <p role="status" class="m-0 text-sm font-medium break-words">
            {{ 'editor.signIn.forgot.sent' | transloco }}
          </p>
          <p class="text-muted-foreground m-0 text-sm break-words">
            {{ 'editor.signIn.forgot.sentHint' | transloco }}
          </p>
        </div>
      } @else {
        <form class="flex flex-col gap-4" novalidate (submit)="submit($event)">
          <div class="flex flex-col gap-1.5">
            <label class="text-sm" for="forgot-email">{{
              'editor.signIn.forgot.email' | transloco
            }}</label>
            <input
              id="forgot-email"
              z-input
              type="email"
              autocomplete="username"
              autocapitalize="none"
              spellcheck="false"
              maxlength="320"
              required
              [value]="email()"
              (input)="email.set($any($event.target).value)"
            />
          </div>
          @if (error(); as message) {
            <p
              role="alert"
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
            [zDisabled]="busy() || email().trim() === ''"
          >
            {{
              (busy()
                ? 'editor.signIn.forgot.sending'
                : 'editor.signIn.forgot.submit'
              ) | transloco
            }}
          </button>
        </form>
      }
      <a
        routerLink="/sign-in"
        class="text-muted-foreground hover:text-foreground focus-visible:ring-ring w-fit rounded-sm text-sm underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:outline-none"
        >{{ 'editor.signIn.forgot.back' | transloco }}</a
      >
    </of-sign-in-frame>
  `,
})
export class ForgotPasswordPage {
  private readonly session = inject(PasswordSession);
  private readonly t = injectTranslate();

  protected readonly email = signal('');
  protected readonly busy = signal(false);
  protected readonly sent = signal(false);
  protected readonly error = signal('');

  protected async submit(event: Event): Promise<void> {
    event.preventDefault();
    const email = this.email().trim();
    if (this.busy() || email === '') return;
    this.busy.set(true);
    this.error.set('');
    try {
      await this.session.forgot(email);
      this.sent.set(true);
    } catch (error) {
      const text = apiErrorText(toApiError(error));
      this.error.set(this.t(text.key, text.params));
    } finally {
      this.busy.set(false);
    }
  }
}
