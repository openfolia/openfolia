import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { TranslocoPipe } from '@jsverse/transloco';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideKeyRound,
  lucideLoaderCircle,
  lucideLogIn,
  lucideMail,
} from '@ng-icons/lucide';
import { map } from 'rxjs';

import { ZardButtonComponent } from '@openfolia/ui/button';
import { LanguageChoiceComponent } from '@openfolia/ui/i18n';
import { LogoComponent } from '@openfolia/ui/logo';
import { FadeInDirective } from '@openfolia/ui/smooth';
import {
  EmptyStateComponent,
  ErrorStateComponent,
  NoAccessStateComponent,
  SkeletonRowsComponent,
} from '@openfolia/ui/states';
import { ThemeChoiceComponent } from '@openfolia/ui/theme';
import { ToasterComponent } from '@openfolia/ui/toast';

import { BrandingService } from '../branding/branding.service';
import { AboutLinksComponent } from '../about/about-links.component';
import { MeService } from '../permissions/me';
import { DemoSession } from '../session/demo-session';
import {
  SIGN_IN_ERROR_TEXT,
  SignInSession,
  signInErrorOf,
} from '../session/sign-in-session';
import { PasswordSession } from '../session/password-session';
import { PasswordFormComponent } from './password-form.component';
import { RETURN_PARAM, safeReturnUrl } from './sign-in.guards';

/** What a local run needs for demo mode: shown as commands, never translated. */
const DEMO_SETTING = 'CCMS_AUTH_MODE=demo';
const SEED_COMMAND = 'pnpm nx run api:db-seed -- --example';
const TOKEN_SETTING = 'CCMS_API_TOKEN';

/** What the page shows, from the demo probe and `GET /me`. */
type View =
  | 'loading'
  | 'providers'
  | 'users'
  | 'empty'
  | 'failed'
  | 'refused'
  | 'not-configured';

/**
 * The sign-in page, outside the shell: where the editor sends you while nobody is acting
 * (`personActing`). In demo mode it lists the seeded users (the account menu's switcher, as a
 * page): choosing one signs in as them and goes back to where you were going. Outside demo mode
 * (the token's read-only service, or a refused token) it says sign-in is not set up on this
 * server and how to start a local run in demo mode. With sign-in set up (#37, OpenID Connect) it
 * offers a button per identity provider (`GET /auth/providers`), which leaves for the provider
 * and comes back signed in; a sign-in that came back refused (`?error=<code>`) says why above.
 * With password sign-in on (#610, `GET /auth/options`), the email and password form comes
 * first, with "Forgot password?" when email can carry the link, the providers' buttons below.
 * With email set up (#634), "Email me a code" sits under the form (or alone, without passwords)
 * and opens `/sign-in-code`.
 */
@Component({
  selector: 'of-sign-in-page',
  imports: [
    TranslocoPipe,
    NgIcon,
    LogoComponent,
    ZardButtonComponent,
    SkeletonRowsComponent,
    EmptyStateComponent,
    ErrorStateComponent,
    NoAccessStateComponent,
    FadeInDirective,
    ThemeChoiceComponent,
    LanguageChoiceComponent,
    ToasterComponent,
    AboutLinksComponent,
    PasswordFormComponent,
    RouterLink,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [
    provideIcons({
      lucideKeyRound,
      lucideLoaderCircle,
      lucideLogIn,
      lucideMail,
    }),
  ],
  host: { class: 'block' },
  template: `
    <main
      class="bg-background text-foreground flex min-h-dvh justify-center overflow-x-hidden px-4 py-10 sm:items-center"
    >
      <div class="flex w-full max-w-md min-w-0 flex-col gap-6">
        <div class="flex justify-center">
          <of-logo
            variant="full"
            [productName]="brand().productName"
            [small]="brand().logo.small"
            [smallDark]="brand().logo.smallDark"
            [full]="brand().logo.full"
            [fullDark]="brand().logo.fullDark"
          />
        </div>

        <section
          class="border-border bg-card text-card-foreground flex flex-col gap-4 rounded-xl border p-6 shadow-sm"
          aria-labelledby="sign-in-title"
          [attr.aria-busy]="view() === 'loading'"
          [attr.data-view]="view()"
        >
          <header class="flex flex-col gap-1">
            <h1 id="sign-in-title" class="text-xl/7 font-medium">
              {{ 'editor.signIn.title' | transloco }}
            </h1>
            @if (view() === 'users' || view() === 'empty') {
              <p class="text-muted-foreground m-0 text-sm break-words">
                {{ 'editor.signIn.demo.intro' | transloco }}
              </p>
            }
            @if (view() === 'providers') {
              <p class="text-muted-foreground m-0 text-sm break-words">
                {{
                  (passwordOffered()
                    ? 'editor.signIn.password.intro'
                    : emailCodeOffered() && oidc.providers().length === 0
                      ? 'editor.signIn.emailCode.signInIntro'
                      : 'editor.signIn.providers.intro'
                  ) | transloco
                }}
              </p>
            }
          </header>

          @if (signInError(); as code) {
            <p
              role="alert"
              data-testid="sign-in-error"
              class="border-destructive/40 bg-destructive/10 text-destructive m-0 rounded-md border px-3 py-2 text-sm break-words"
            >
              {{ errorText[code] | transloco }}
            </p>
          }

          @switch (view()) {
            @case ('loading') {
              <!-- Delayed: a quick answer never flashes it. -->
              <of-skeleton-rows [count]="3" />
            }
            @case ('providers') {
              @if (passwordOffered()) {
                <of-password-form
                  ofFadeIn
                  [resetOffered]="passwords.options()?.passwordReset ?? false"
                  (signedIn)="signedIn()"
                />
              }
              @if (emailCodeOffered()) {
                <a
                  ofFadeIn
                  z-button
                  zType="outline"
                  data-testid="email-code"
                  class="h-auto min-h-9 w-full py-2 whitespace-normal"
                  routerLink="/sign-in-code"
                  [queryParams]="returnParams()"
                >
                  <ng-icon
                    name="lucideMail"
                    data-icon="inline-start"
                    class="size-4 shrink-0"
                    aria-hidden="true"
                  />
                  <span class="break-words">{{
                    'editor.signIn.emailCode.offer' | transloco
                  }}</span>
                </a>
              }
              @if (
                (passwordOffered() || emailCodeOffered()) &&
                oidc.providers().length > 0
              ) {
                <div
                  class="text-muted-foreground flex items-center gap-3 text-xs"
                  aria-hidden="true"
                >
                  <span class="bg-border h-px flex-1"></span>
                  {{ 'editor.signIn.password.or' | transloco }}
                  <span class="bg-border h-px flex-1"></span>
                </div>
              }
              @if (oidc.providers().length > 0) {
                <ul
                  ofFadeIn
                  class="m-0 flex list-none flex-col gap-2 p-0"
                  [attr.aria-label]="
                    'editor.signIn.providers.label' | transloco
                  "
                >
                  @for (provider of oidc.providers(); track provider.id) {
                    <li>
                      <button
                        z-button
                        type="button"
                        class="h-auto min-h-9 w-full py-2 whitespace-normal"
                        [attr.data-provider]="provider.id"
                        [disabled]="oidc.busy()"
                        [attr.aria-busy]="oidc.busy()"
                        (click)="oidc.signIn(provider.id, returnUrl())"
                      >
                        @if (oidc.busy()) {
                          <ng-icon
                            name="lucideLoaderCircle"
                            data-icon="inline-start"
                            class="size-4 shrink-0 animate-spin motion-reduce:animate-none"
                            aria-hidden="true"
                          />
                        } @else {
                          <ng-icon
                            name="lucideLogIn"
                            data-icon="inline-start"
                            class="size-4 shrink-0"
                            aria-hidden="true"
                          />
                        }
                        <span class="break-words">{{
                          provider.name
                            ? ('editor.signIn.providers.with'
                              | transloco: { name: provider.name })
                            : ('editor.signIn.providers.continue' | transloco)
                        }}</span>
                      </button>
                    </li>
                  }
                </ul>
              }
            }
            @case ('users') {
              <ul
                ofFadeIn
                class="m-0 flex max-h-[min(24rem,50dvh)] list-none flex-col gap-1 overflow-y-auto p-0"
                [attr.aria-label]="'editor.signIn.demo.label' | transloco"
              >
                @for (user of demo.users(); track user.id) {
                  <li>
                    <button
                      z-button
                      zType="ghost"
                      type="button"
                      class="h-auto w-full justify-start gap-3 py-2 text-start whitespace-normal"
                      [disabled]="picking() !== null"
                      [attr.aria-busy]="picking() === user.id"
                      (click)="choose(user.id)"
                    >
                      <span
                        class="bg-foreground text-background flex size-7 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold"
                        aria-hidden="true"
                        >{{ initials(user.name) }}</span
                      >
                      <span class="flex min-w-0 flex-1 flex-col">
                        <span class="font-medium break-words">{{
                          user.name
                        }}</span>
                        @if (user.roleIds.length > 0) {
                          <span
                            class="text-muted-foreground text-xs font-normal break-words"
                            >{{ user.roleIds.join(', ') }}</span
                          >
                        }
                      </span>
                      @if (picking() === user.id) {
                        <ng-icon
                          name="lucideLoaderCircle"
                          class="size-4 shrink-0 animate-spin motion-reduce:animate-none"
                          aria-hidden="true"
                        />
                        <span class="sr-only">{{
                          'editor.signIn.demo.signingIn'
                            | transloco: { name: user.name }
                        }}</span>
                      }
                    </button>
                  </li>
                }
              </ul>
            }
            @case ('empty') {
              <of-empty-state
                class="py-6"
                [title]="'editor.signIn.demo.emptyTitle' | transloco"
                [description]="'editor.signIn.demo.emptyHint' | transloco"
              >
                <code [class]="codeClass">{{ seedCommand }}</code>
              </of-empty-state>
            }
            @case ('failed') {
              <of-error-state
                class="py-6"
                [kind]="failureKind()"
                [heading]="'editor.signIn.failed' | transloco"
                [retryable]="true"
                (retry)="retry()"
              />
            }
            @case ('refused') {
              <of-no-access
                class="py-6"
                [heading]="'editor.signIn.refused.title' | transloco"
                [message]="
                  'editor.signIn.refused.description'
                    | transloco: { setting: tokenSetting }
                "
              />
            }
            @case ('not-configured') {
              <div class="flex flex-col gap-3 text-sm" data-state="empty">
                <div class="flex items-start gap-3">
                  <span
                    class="bg-muted text-muted-foreground flex size-10 shrink-0 items-center justify-center rounded-xl"
                    aria-hidden="true"
                  >
                    <ng-icon
                      name="lucideKeyRound"
                      size="18"
                      strokeWidth="1.5"
                    />
                  </span>
                  <div class="flex min-w-0 flex-col gap-1">
                    <h2 class="m-0 text-base/6 font-medium">
                      {{ 'editor.signIn.notConfigured.title' | transloco }}
                    </h2>
                    <p class="text-muted-foreground m-0 break-words">
                      {{
                        'editor.signIn.notConfigured.description' | transloco
                      }}
                    </p>
                  </div>
                </div>
                <ol class="m-0 flex list-decimal flex-col gap-2 ps-5">
                  <li class="break-words">
                    {{ 'editor.signIn.notConfigured.setMode' | transloco }}
                    <code [class]="codeClass">{{ demoSetting }}</code>
                  </li>
                  <li class="break-words">
                    {{ 'editor.signIn.notConfigured.seed' | transloco }}
                    <code [class]="codeClass">{{ seedCommand }}</code>
                  </li>
                  <li class="break-words">
                    {{ 'editor.signIn.notConfigured.restart' | transloco }}
                  </li>
                </ol>
              </div>
            }
          }
        </section>

        <div class="grid gap-4 sm:grid-cols-2">
          <of-theme-choice />
          <of-language-choice />
        </div>

        <!-- The source code and the licence (AGPL-3.0 section 13), before signing in too. -->
        <of-about-links />
      </div>
    </main>
    <of-toaster />
  `,
})
export class SignInPage {
  protected readonly brand = inject(BrandingService).branding;
  protected readonly demo = inject(DemoSession);
  protected readonly oidc = inject(SignInSession);
  protected readonly passwords = inject(PasswordSession);
  /** Asked once, beside the providers: null until it answered (or when it could not). */
  private readonly optionsAsked = signal(false);
  protected readonly passwordOffered = computed(
    () => this.passwords.options()?.password === true,
  );
  /** "Email me a code" (#634): only when the API offers it (email is set up). */
  protected readonly emailCodeOffered = computed(
    () => this.passwords.options()?.emailCode === true,
  );
  protected readonly errorText = SIGN_IN_ERROR_TEXT;
  private readonly meService = inject(MeService);
  private readonly router = inject(Router);

  protected readonly demoSetting = DEMO_SETTING;
  protected readonly seedCommand = SEED_COMMAND;
  protected readonly tokenSetting = TOKEN_SETTING;
  protected readonly codeClass =
    'bg-muted text-foreground mt-1 block w-fit max-w-full rounded-md px-2 py-1 font-mono text-xs break-all';

  /** The user being signed in as, while the API has not confirmed them. */
  protected readonly picking = signal<string | null>(null);

  private readonly params = inject(ActivatedRoute).queryParamMap;

  protected readonly returnUrl = toSignal(
    this.params.pipe(map((params) => safeReturnUrl(params.get(RETURN_PARAM)))),
    { initialValue: '/' },
  );
  /** Where "Email me a code" comes back to: the same place as here. */
  protected readonly returnParams = computed(() =>
    this.returnUrl() === '/' ? {} : { [RETURN_PARAM]: this.returnUrl() },
  );

  /** Why the last sign-in came back without a session (`?error=`, from the API). */
  protected readonly signInError = toSignal(
    this.params.pipe(map((params) => signInErrorOf(params.get('error')))),
    { initialValue: null },
  );

  protected readonly view = computed((): View => {
    const presence = this.meService.presence();
    switch (this.demo.status()) {
      case 'checking':
        return 'loading';
      case 'failed':
        return 'failed';
      case 'on':
        if (this.demo.loading() && this.demo.users().length === 0) {
          return 'loading';
        }
        return this.demo.users().length === 0 ? 'empty' : 'users';
      case 'off':
        if (presence === 'pending') return 'loading';
        // Sign-in is set up: the password form (#610) and the providers' buttons, whatever the
        // token answered.
        if (this.oidc.status() === 'loading' || !this.optionsAsked()) {
          return 'loading';
        }
        if (
          this.oidc.providers().length > 0 ||
          this.passwordOffered() ||
          this.emailCodeOffered()
        ) {
          return 'providers';
        }
        if (presence === 'failed') return 'failed';
        return this.meService.error()?.kind === 'unauthorized'
          ? 'refused'
          : 'not-configured';
    }
  });

  protected readonly failureKind = computed(
    () =>
      this.demo.failure()?.kind ?? this.meService.error()?.kind ?? 'unknown',
  );

  constructor() {
    void this.oidc.load();
    void this.passwords
      .loadOptions()
      .finally(() => this.optionsAsked.set(true));
    // Someone is acting (a retry answered, another tab signed in): on to where they were going.
    effect(() => {
      if (this.meService.presence() !== 'person' || this.picking() !== null) {
        return;
      }
      untracked(() => void this.router.navigateByUrl(this.returnUrl()));
    });
  }

  protected async choose(id: string): Promise<void> {
    if (this.picking() !== null) return;
    this.picking.set(id);
    try {
      if (await this.demo.signIn(id)) {
        await this.router.navigateByUrl(this.returnUrl());
      }
    } finally {
      this.picking.set(null);
    }
  }

  /** Signed in with a password: who is acting now, then on to where they were going. */
  protected async signedIn(): Promise<void> {
    await this.meService.refresh(true).catch(() => false);
    await this.router.navigateByUrl(this.returnUrl());
  }

  /** Asks again whether this is demo mode, then who is acting. */
  protected async retry(): Promise<void> {
    void this.oidc.reload();
    void this.passwords.reloadOptions();
    await this.demo.probe();
    await this.demo.reload();
  }

  protected initials(name: string): string {
    return name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() ?? '')
      .join('');
  }
}
