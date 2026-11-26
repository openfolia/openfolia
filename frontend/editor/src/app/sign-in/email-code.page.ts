import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DOCUMENT,
  inject,
  signal,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { TranslocoPipe } from '@jsverse/transloco';
import { map } from 'rxjs';

import { ZardButtonComponent } from '@openfolia/ui/button';
import { injectTranslate, LanguageService } from '@openfolia/ui/i18n';
import { ZardInputComponent } from '@openfolia/ui/input';
import { FadeInDirective } from '@openfolia/ui/smooth';

import { toApiError } from '../api';
import { apiErrorText } from '../i18n';
import { MeService } from '../permissions/me';
import type { SecondStepKind } from '../second-factor/second-factor-session';
import { CODE_LINK_TOKEN, PasswordSession } from '../session/password-session';
import { SignInFrameComponent } from './sign-in-frame.component';
import { afterSignIn, RETURN_PARAM, safeReturnUrl } from './sign-in.guards';

/** Six digits, with spaces or dashes between them (the API reads them the same). */
const CODE = /^[0-9]{6}$/;

type Step = 'email' | 'code' | 'link' | 'link-invalid' | 'link-expired';

/**
 * "Email me a code" (#634): an email address, then always the same answer ("If the address is
 * known, a code is on its way"), then the six-digit code from the email, which signs in. A wrong
 * code says so and keeps the address; "Send a new code" asks again (the earlier code stops
 * working). The email's link opens this page too (`sign-in-code#<token>`): the token is taken out
 * of the address at once and signs in at a click, so a mail scanner opening the link signs
 * nobody in. A used or replaced link says so and offers a new code.
 */
@Component({
  selector: 'of-email-code-page',
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
    <of-sign-in-frame [heading]="heading()" [intro]="intro()" [busy]="busy()">
      <div class="contents" [attr.data-step]="step()">
        @switch (step()) {
          @case ('email') {
            <form
              ofFadeIn
              class="flex flex-col gap-4"
              novalidate
              data-testid="email-code-request"
              (submit)="request($event)"
            >
              <div class="flex flex-col gap-1.5">
                <label class="text-sm" for="email-code-email">{{
                  'editor.signIn.emailCode.email' | transloco
                }}</label>
                <input
                  id="email-code-email"
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
                <p role="alert" [class]="alertClass">{{ message }}</p>
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
                    ? 'editor.signIn.emailCode.sending'
                    : 'editor.signIn.emailCode.send'
                  ) | transloco
                }}
              </button>
            </form>
          }
          @case ('code') {
            <form
              ofFadeIn
              class="flex flex-col gap-4"
              novalidate
              data-testid="email-code-form"
              (submit)="signIn($event)"
            >
              <p
                role="status"
                data-testid="email-code-sent"
                class="m-0 text-sm font-medium break-words"
              >
                {{
                  (resent()
                    ? 'editor.signIn.emailCode.resent'
                    : 'editor.signIn.emailCode.sent'
                  ) | transloco: { email: sentTo() }
                }}
              </p>
              <div class="flex flex-col gap-1.5">
                <label class="text-sm" for="email-code-code">{{
                  'editor.signIn.emailCode.code' | transloco
                }}</label>
                <input
                  id="email-code-code"
                  z-input
                  type="text"
                  inputmode="numeric"
                  autocomplete="one-time-code"
                  autocapitalize="none"
                  spellcheck="false"
                  maxlength="11"
                  required
                  aria-describedby="email-code-hint"
                  class="font-mono text-lg tracking-[0.3em]"
                  [attr.aria-invalid]="error() ? 'true' : null"
                  [value]="code()"
                  (input)="code.set($any($event.target).value)"
                />
                <p
                  id="email-code-hint"
                  class="text-muted-foreground m-0 text-xs break-words"
                >
                  {{ 'editor.signIn.emailCode.codeHint' | transloco }}
                </p>
              </div>
              @if (error(); as message) {
                <p
                  role="alert"
                  data-testid="email-code-error"
                  [class]="alertClass"
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
                    ? 'editor.signIn.emailCode.signingIn'
                    : 'editor.signIn.emailCode.submit'
                  ) | transloco
                }}
              </button>
              <div class="flex flex-wrap items-center justify-between gap-2">
                <button
                  z-button
                  zType="ghost"
                  type="button"
                  class="h-auto px-0 py-1 whitespace-normal"
                  data-testid="email-code-resend"
                  [zDisabled]="busy()"
                  (click)="resend()"
                >
                  {{ 'editor.signIn.emailCode.resend' | transloco }}
                </button>
                <button
                  z-button
                  zType="ghost"
                  type="button"
                  class="h-auto px-0 py-1 whitespace-normal"
                  [zDisabled]="busy()"
                  (click)="otherAddress()"
                >
                  {{ 'editor.signIn.emailCode.otherAddress' | transloco }}
                </button>
              </div>
            </form>
          }
          @case ('link') {
            <div ofFadeIn class="flex flex-col gap-4">
              @if (error(); as message) {
                <p
                  role="alert"
                  data-testid="email-code-error"
                  [class]="alertClass"
                >
                  {{ message }}
                </p>
              }
              <button
                z-button
                type="button"
                class="w-full"
                data-testid="email-code-link"
                [zLoading]="busy()"
                [zDisabled]="busy()"
                (click)="followLink()"
              >
                {{
                  (busy()
                    ? 'editor.signIn.emailCode.signingIn'
                    : 'editor.signIn.emailCode.linkSubmit'
                  ) | transloco
                }}
              </button>
            </div>
          }
          @default {
            <div ofFadeIn class="flex flex-wrap gap-2">
              <button
                z-button
                type="button"
                data-testid="email-code-new"
                (click)="otherAddress()"
              >
                {{ 'editor.signIn.emailCode.newCode' | transloco }}
              </button>
            </div>
          }
        }
      </div>
      <a
        [routerLink]="['/sign-in']"
        [queryParams]="returnParams()"
        class="text-muted-foreground hover:text-foreground focus-visible:ring-ring w-fit rounded-sm text-sm underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:outline-none"
        >{{ 'editor.signIn.emailCode.back' | transloco }}</a
      >
    </of-sign-in-frame>
  `,
})
export class EmailCodePage {
  private readonly session = inject(PasswordSession);
  private readonly me = inject(MeService);
  private readonly router = inject(Router);
  private readonly language = inject(LanguageService);
  private readonly t = injectTranslate();
  private readonly linkToken: string | null;

  protected readonly alertClass =
    'border-destructive/40 bg-destructive/10 text-destructive m-0 rounded-md border px-3 py-2 text-sm break-words';

  protected readonly step = signal<Step>('email');
  protected readonly email = signal('');
  /** The address the last code was asked for: the one signed in with. */
  protected readonly sentTo = signal('');
  protected readonly code = signal('');
  protected readonly busy = signal(false);
  protected readonly resent = signal(false);
  protected readonly error = signal('');

  private readonly returnUrl = toSignal(
    inject(ActivatedRoute).queryParamMap.pipe(
      map((params) => safeReturnUrl(params.get(RETURN_PARAM))),
    ),
    { initialValue: '/' },
  );
  protected readonly returnParams = computed(() =>
    this.returnUrl() === '/' ? {} : { [RETURN_PARAM]: this.returnUrl() },
  );

  protected readonly heading = computed(() => {
    switch (this.step()) {
      case 'link':
        return this.t('editor.signIn.emailCode.linkTitle');
      case 'link-invalid':
        return this.t('editor.signIn.emailCode.linkInvalidTitle');
      case 'link-expired':
        return this.t('editor.signIn.emailCode.linkExpiredTitle');
      default:
        return this.t('editor.signIn.emailCode.title');
    }
  });

  protected readonly intro = computed(() => {
    switch (this.step()) {
      case 'email':
        return this.t('editor.signIn.emailCode.intro');
      case 'link':
        return this.t('editor.signIn.emailCode.linkIntro');
      case 'link-invalid':
        return this.t('editor.signIn.emailCode.linkInvalidHint');
      case 'link-expired':
        return this.t('editor.signIn.emailCode.linkExpiredHint');
      default:
        return '';
    }
  });

  constructor() {
    const location = inject(DOCUMENT).location;
    const raw = location.hash.replace(/^#/, '');
    this.linkToken = CODE_LINK_TOKEN.test(raw) ? raw : null;
    // Out of the address (and the history) at once: the link works once, and is a secret.
    if (location.hash) {
      history.replaceState(
        history.state,
        '',
        location.pathname + location.search,
      );
    }
    if (this.linkToken !== null) this.step.set('link');
  }

  protected async request(event: Event): Promise<void> {
    event.preventDefault();
    const email = this.email().trim();
    if (this.busy() || email === '') return;
    if (await this.ask(email)) {
      this.sentTo.set(email);
      this.resent.set(false);
      this.code.set('');
      this.step.set('code');
    }
  }

  protected async resend(): Promise<void> {
    if (this.busy()) return;
    if (await this.ask(this.sentTo())) {
      this.resent.set(true);
      this.code.set('');
    }
  }

  protected otherAddress(): void {
    this.error.set('');
    this.code.set('');
    this.step.set('email');
  }

  protected async signIn(event: Event): Promise<void> {
    event.preventDefault();
    if (this.busy()) return;
    const code = this.code().replace(/[\s-]/g, '');
    if (!CODE.test(code)) {
      this.error.set(this.t('editor.signIn.emailCode.missingCode'));
      return;
    }
    this.busy.set(true);
    this.error.set('');
    try {
      await this.signedIn(
        await this.session.signInWithCode(this.sentTo(), code),
      );
    } catch (error) {
      const text = apiErrorText(toApiError(error));
      this.error.set(this.t(text.key, text.params));
      this.code.set('');
    } finally {
      this.busy.set(false);
    }
  }

  protected async followLink(): Promise<void> {
    if (this.busy() || this.linkToken === null) return;
    this.busy.set(true);
    this.error.set('');
    try {
      await this.signedIn(await this.session.signInWithLink(this.linkToken));
    } catch (error) {
      const failure = toApiError(error);
      if (failure.code === 'link-invalid') this.step.set('link-invalid');
      else if (failure.code === 'link-expired') this.step.set('link-expired');
      else {
        const text = apiErrorText(failure);
        this.error.set(this.t(text.key, text.params));
      }
    } finally {
      this.busy.set(false);
    }
  }

  /** Asks for a code; whether the API took the request (it answers the same for any address). */
  private async ask(email: string): Promise<boolean> {
    this.busy.set(true);
    this.error.set('');
    try {
      await this.session.requestCode(email, this.language.locale());
      return true;
    } catch (error) {
      const text = apiErrorText(toApiError(error));
      this.error.set(this.t(text.key, text.params));
      return false;
    } finally {
      this.busy.set(false);
    }
  }

  /** The code is right: the second step (#611), or who is acting now and on. */
  private async signedIn(step: SecondStepKind): Promise<void> {
    if (!step) await this.me.refresh(true).catch(() => false);
    await afterSignIn(this.router, step, this.returnUrl());
  }
}
