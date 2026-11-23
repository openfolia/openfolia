import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DOCUMENT,
  inject,
  signal,
} from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { TranslocoPipe } from '@jsverse/transloco';

import { ZardButtonComponent } from '@openfolia/ui/button';
import { injectTranslate } from '@openfolia/ui/i18n';
import { ZardInputComponent } from '@openfolia/ui/input';
import { FadeInDirective } from '@openfolia/ui/smooth';
import {
  ErrorStateComponent,
  SkeletonRowsComponent,
} from '@openfolia/ui/states';

import { toApiError, type ApiError } from '../api';
import { apiErrorText } from '../i18n';
import { MeService } from '../permissions/me';
import {
  LINK_TOKEN,
  PasswordSession,
  type SignInLinkInfo,
} from '../session/password-session';
import { SignInFrameComponent } from './sign-in-frame.component';

/** The fewest characters a password has (the API's rule; it checks the rest). */
const MIN_LENGTH = 12;

type View = 'loading' | 'missing' | 'invalid' | 'expired' | 'failed' | 'ready';

/**
 * The page an invite or a reset link opens (#610): `set-password#<token>`. The token is in the
 * fragment, which no server sees; the page takes it and drops it from the address at once. It
 * asks the API what the link is for, then takes a new password (twice) and signs the person in:
 * every other session of theirs ends. A used, replaced or withdrawn link says so; one that ran
 * out says to ask for a new one.
 */
@Component({
  selector: 'of-set-password-page',
  imports: [
    TranslocoPipe,
    RouterLink,
    ZardButtonComponent,
    ZardInputComponent,
    FadeInDirective,
    SkeletonRowsComponent,
    ErrorStateComponent,
    SignInFrameComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    <of-sign-in-frame
      [heading]="heading()"
      [intro]="intro()"
      [busy]="view() === 'loading' || busy()"
    >
      <div [attr.data-view]="view()" class="contents">
        @switch (view()) {
          @case ('loading') {
            <of-skeleton-rows [count]="3" />
          }
          @case ('failed') {
            <of-error-state
              class="py-4"
              [kind]="failure()?.kind ?? 'unknown'"
              [retryable]="true"
              (retry)="open()"
            />
          }
          @case ('ready') {
            <form
              ofFadeIn
              class="flex flex-col gap-4"
              novalidate
              (submit)="submit($event)"
            >
              <!-- For the browser's password manager: whose password this is. -->
              <input
                type="email"
                name="username"
                autocomplete="username"
                class="hidden"
                tabindex="-1"
                aria-hidden="true"
                readonly
                [value]="link()?.email ?? ''"
              />
              <div class="flex flex-col gap-1.5">
                <label class="text-sm" for="new-password">{{
                  'editor.signIn.setPassword.password' | transloco
                }}</label>
                <input
                  id="new-password"
                  z-input
                  type="password"
                  autocomplete="new-password"
                  maxlength="1024"
                  required
                  aria-describedby="new-password-rules"
                  [attr.aria-invalid]="problem() === 'short' ? 'true' : null"
                  [value]="password()"
                  (input)="password.set($any($event.target).value)"
                />
                <p
                  id="new-password-rules"
                  class="text-muted-foreground m-0 text-xs break-words"
                >
                  {{ 'editor.signIn.setPassword.rules' | transloco }}
                </p>
              </div>
              <div class="flex flex-col gap-1.5">
                <label class="text-sm" for="new-password-again">{{
                  'editor.signIn.setPassword.confirm' | transloco
                }}</label>
                <input
                  id="new-password-again"
                  z-input
                  type="password"
                  autocomplete="new-password"
                  maxlength="1024"
                  required
                  [attr.aria-invalid]="problem() === 'mismatch' ? 'true' : null"
                  [value]="again()"
                  (input)="again.set($any($event.target).value)"
                />
              </div>
              @if (error(); as message) {
                <p
                  role="alert"
                  data-testid="set-password-error"
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
                    ? 'editor.signIn.setPassword.saving'
                    : 'editor.signIn.setPassword.submit'
                  ) | transloco
                }}
              </button>
            </form>
          }
          @default {
            <a z-button zType="outline" routerLink="/sign-in" class="w-fit">{{
              'editor.signIn.setPassword.back' | transloco
            }}</a>
          }
        }
      </div>
    </of-sign-in-frame>
  `,
})
export class SetPasswordPage {
  private readonly session = inject(PasswordSession);
  private readonly me = inject(MeService);
  private readonly router = inject(Router);
  private readonly t = injectTranslate();
  private readonly token: string | null;

  protected readonly view = signal<View>('loading');
  protected readonly link = signal<SignInLinkInfo | null>(null);
  protected readonly failure = signal<ApiError | null>(null);
  protected readonly password = signal('');
  protected readonly again = signal('');
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  protected readonly problem = signal<'short' | 'mismatch' | null>(null);

  protected readonly heading = computed(() => {
    const link = this.link();
    switch (this.view()) {
      case 'missing':
        return this.t('editor.signIn.setPassword.missingTitle');
      case 'invalid':
        return this.t('editor.signIn.setPassword.invalidTitle');
      case 'expired':
        return this.t('editor.signIn.setPassword.expiredTitle');
      default:
        return link?.kind === 'invite'
          ? this.t('editor.signIn.setPassword.inviteTitle', { name: link.name })
          : this.t('editor.signIn.setPassword.resetTitle');
    }
  });

  protected readonly intro = computed(() => {
    const link = this.link();
    switch (this.view()) {
      case 'missing':
        return this.t('editor.signIn.setPassword.missingHint');
      case 'invalid':
        return this.t('editor.signIn.setPassword.invalidHint');
      case 'expired':
        return this.t('editor.signIn.setPassword.expiredHint');
      case 'ready':
        return link?.kind === 'invite'
          ? this.t('editor.signIn.setPassword.inviteIntro')
          : this.t('editor.signIn.setPassword.resetIntro', {
              name: link?.name ?? '',
            });
      default:
        return '';
    }
  });

  constructor() {
    const location = inject(DOCUMENT).location;
    const raw = location.hash.replace(/^#/, '');
    this.token = LINK_TOKEN.test(raw) ? raw : null;
    // Out of the address (and the history) at once: the link works once, and is a secret.
    if (location.hash) {
      history.replaceState(history.state, '', location.pathname);
    }
    void this.open();
  }

  protected async open(): Promise<void> {
    if (this.token === null) {
      this.view.set('missing');
      return;
    }
    this.view.set('loading');
    try {
      this.link.set(await this.session.readLink(this.token));
      this.view.set('ready');
    } catch (error) {
      this.refused(toApiError(error));
    }
  }

  protected async submit(event: Event): Promise<void> {
    event.preventDefault();
    if (this.busy() || this.token === null) return;
    const password = this.password();
    if ([...password.normalize('NFC')].length < MIN_LENGTH) {
      this.problem.set('short');
      this.error.set(this.t('editor.signIn.setPassword.tooShort'));
      return;
    }
    if (password !== this.again()) {
      this.problem.set('mismatch');
      this.error.set(this.t('editor.signIn.setPassword.mismatch'));
      return;
    }
    this.problem.set(null);
    this.error.set('');
    this.busy.set(true);
    try {
      await this.session.setPassword(this.token, password);
      await this.me.refresh(true).catch(() => false);
      await this.router.navigateByUrl('/');
    } catch (error) {
      const failure = toApiError(error);
      if (failure.code === 'link-invalid' || failure.code === 'link-expired') {
        this.refused(failure);
      } else {
        const text = apiErrorText(failure);
        this.error.set(this.t(text.key, text.params));
      }
    } finally {
      this.busy.set(false);
    }
  }

  private refused(failure: ApiError): void {
    if (failure.code === 'link-expired') this.view.set('expired');
    else if (failure.code === 'link-invalid') this.view.set('invalid');
    else {
      this.failure.set(failure);
      this.view.set('failed');
    }
  }
}
