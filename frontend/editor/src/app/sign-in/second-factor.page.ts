import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { TranslocoPipe } from '@jsverse/transloco';
import { map } from 'rxjs';

import { ZardButtonComponent } from '@openfolia/ui/button';
import { injectTranslate } from '@openfolia/ui/i18n';
import { FadeInDirective } from '@openfolia/ui/smooth';
import {
  ErrorStateComponent,
  SkeletonRowsComponent,
} from '@openfolia/ui/states';

import { toApiError, type ApiError } from '../api';
import { apiErrorText } from '../i18n/api-error-text';
import { MeService } from '../permissions/me';
import { SecondFactorCodeComponent } from '../second-factor/code-field.component';
import { FocusOnShowDirective } from '../second-factor/focus-on-show.directive';
import { RecoveryCodesComponent } from '../second-factor/recovery-codes.component';
import {
  codeOf,
  isAppCode,
  SECOND_FACTOR_LINK,
  SecondFactorSession,
  secondFactorProblem,
  type SetUpBegun,
  waitMinutes,
} from '../second-factor/second-factor-session';
import { SecondFactorSetUpComponent } from '../second-factor/set-up-steps.component';
import { SignInFrameComponent } from './sign-in-frame.component';
import { RETURN_PARAM, safeReturnUrl } from './sign-in.guards';

type View =
  'loading' | 'failed' | 'expired' | 'locked' | 'verify' | 'set-up' | 'codes';

/**
 * The second step of a sign-in (#611), after a password, a link or a code by email: the code of
 * the authenticator app, or a recovery code. Where the installation requires one and the person
 * has none, they set it up here first and see their recovery codes; only then are they signed
 * in. The open step is the API's HttpOnly cookie, so the page knows it only by asking; one that
 * ran out, was used, or never was starts again at the sign-in page.
 */
@Component({
  selector: 'of-second-factor-page',
  imports: [
    TranslocoPipe,
    RouterLink,
    ZardButtonComponent,
    FadeInDirective,
    FocusOnShowDirective,
    ErrorStateComponent,
    SkeletonRowsComponent,
    SecondFactorCodeComponent,
    SecondFactorSetUpComponent,
    RecoveryCodesComponent,
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
      <div class="contents" [attr.data-view]="view()">
        @switch (view()) {
          @case ('loading') {
            <of-skeleton-rows [count]="3" />
          }
          @case ('failed') {
            <of-error-state
              class="py-4"
              [kind]="failure()?.kind ?? 'unknown'"
              [message]="failureText()"
              [retryable]="canRetry()"
              (retry)="open()"
            />
          }
          @case ('verify') {
            <form
              ofFadeIn
              class="flex flex-col gap-4"
              novalidate
              data-testid="second-factor-verify"
              (submit)="verify($event)"
            >
              <!-- Another field for each, so the focus and the keyboard follow the choice. -->
              @for (way of [recovery()]; track way) {
                <of-second-factor-code
                  inputId="second-factor-code"
                  [recovery]="way"
                  [invalid]="error() !== ''"
                  [(code)]="code"
                />
              }
              @if (error(); as message) {
                <p
                  role="alert"
                  data-testid="second-factor-error"
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
                    ? 'editor.signIn.password.signingIn'
                    : 'editor.signIn.password.submit'
                  ) | transloco
                }}
              </button>
              <button
                type="button"
                [class]="linkClass"
                data-testid="second-factor-other-way"
                [disabled]="busy()"
                (click)="otherWay()"
              >
                {{
                  (recovery()
                    ? 'editor.secondFactor.signIn.useApp'
                    : 'editor.secondFactor.signIn.useRecovery'
                  ) | transloco
                }}
              </button>
            </form>
          }
          @case ('set-up') {
            <form
              ofFadeIn
              class="flex flex-col gap-4"
              novalidate
              data-testid="second-factor-set-up"
              (submit)="confirm($event)"
            >
              @if (setUp(); as begun) {
                <of-second-factor-set-up [setUp]="begun">
                  <of-second-factor-code
                    inputId="second-factor-code"
                    [invalid]="error() !== ''"
                    [(code)]="code"
                  />
                  @if (error(); as message) {
                    <p
                      role="alert"
                      data-testid="second-factor-error"
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
                    {{ 'editor.secondFactor.signIn.turnOn' | transloco }}
                  </button>
                </of-second-factor-set-up>
              }
            </form>
          }
          @case ('codes') {
            <div ofFadeIn class="flex flex-col gap-4">
              <of-recovery-codes [codes]="codes()" />
              <button
                z-button
                type="button"
                class="w-full"
                data-testid="second-factor-continue"
                [zLoading]="busy()"
                [zDisabled]="busy()"
                (click)="signedIn()"
              >
                {{ 'editor.secondFactor.recovery.continue' | transloco }}
              </button>
            </div>
          }
          @default {
            <a
              z-button
              zType="outline"
              ofFocusOnShow
              aria-describedby="sign-in-frame-title"
              class="w-fit"
              data-testid="second-factor-again"
              [routerLink]="['/sign-in']"
              [queryParams]="returnParams()"
              >{{ 'editor.secondFactor.signIn.again' | transloco }}</a
            >
          }
        }
      </div>
      @if (view() === 'verify' || view() === 'set-up' || view() === 'failed') {
        <a
          [routerLink]="['/sign-in']"
          [queryParams]="returnParams()"
          [class]="linkClass"
          >{{ 'editor.signIn.emailCode.back' | transloco }}</a
        >
      }
    </of-sign-in-frame>
  `,
})
export class SecondFactorPage {
  private readonly session = inject(SecondFactorSession);
  private readonly me = inject(MeService);
  private readonly router = inject(Router);
  private readonly t = injectTranslate();
  private readonly codeField = viewChild(SecondFactorCodeComponent);

  protected readonly alertClass =
    'border-destructive/40 bg-destructive/10 text-destructive m-0 rounded-md border px-3 py-2 text-sm break-words';

  protected readonly linkClass = SECOND_FACTOR_LINK;

  protected readonly view = signal<View>('loading');
  protected readonly email = signal('');
  protected readonly failure = signal<ApiError | null>(null);
  /** Why, when the API said so (deactivated, not allowed, no secret key). */
  protected readonly failureText = computed(() => {
    const failure = this.failure();
    if (!failure || this.canRetry()) return '';
    const text = apiErrorText(failure);
    return this.t(text.key, text.params);
  });
  /** A refusal stays one; only what may pass is worth another try. */
  protected readonly canRetry = computed(() => {
    const code = this.failure()?.code;
    return (
      code !== 'user-deactivated' &&
      code !== 'sign-in-not-allowed' &&
      code !== 'second-factor-unavailable'
    );
  });
  protected readonly recovery = signal(false);
  protected readonly code = signal('');
  protected readonly setUp = signal<SetUpBegun | null>(null);
  protected readonly codes = signal<readonly string[]>([]);
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  protected readonly lockedMinutes = signal(0);

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
    switch (this.view()) {
      case 'set-up':
        return this.t('editor.secondFactor.signIn.setUpTitle');
      case 'codes':
        return this.t('editor.secondFactor.recovery.title');
      case 'expired':
        return this.t('editor.secondFactor.signIn.expiredTitle');
      case 'locked':
        return this.t('editor.secondFactor.signIn.lockedTitle');
      default:
        return this.t('editor.secondFactor.signIn.title');
    }
  });

  protected readonly intro = computed(() => {
    const email = this.email();
    switch (this.view()) {
      case 'verify':
        return email === ''
          ? ''
          : this.t('editor.secondFactor.signIn.intro', { email });
      case 'set-up':
        return this.t('editor.secondFactor.signIn.setUpIntro');
      case 'codes':
        return this.t('editor.secondFactor.recovery.intro');
      case 'expired':
        return this.t('editor.secondFactor.signIn.expiredHint');
      case 'locked':
        return this.t('editor.secondFactor.signIn.lockedHint', {
          minutes: this.lockedMinutes(),
        });
      default:
        return '';
    }
  });

  constructor() {
    void this.open();
  }

  protected async open(): Promise<void> {
    this.view.set('loading');
    this.error.set('');
    try {
      const step = await this.session.step();
      this.email.set(step.email ?? '');
      if (step.secondFactor === 'set-up') {
        this.setUp.set(await this.session.beginRequired());
      }
      this.view.set(step.secondFactor);
    } catch (error) {
      const failure = toApiError(error);
      if (this.ended(failure)) return;
      this.failure.set(failure);
      this.view.set('failed');
    }
  }

  protected otherWay(): void {
    this.recovery.update((on) => !on);
    this.code.set('');
    this.error.set('');
  }

  protected async verify(event: Event): Promise<void> {
    event.preventDefault();
    const recovery = this.recovery();
    await this.send(recovery, async (code) => {
      await this.session.verify(code);
      await this.signedIn();
    });
  }

  protected async confirm(event: Event): Promise<void> {
    event.preventDefault();
    await this.send(false, async (code) => {
      // Signed in from here on; where they were going waits until the codes are put away.
      this.codes.set(await this.session.confirmRequired(code));
      this.setUp.set(null);
      this.view.set('codes');
      // Already someone else than before: the other tabs are told now, not once the codes are
      // put away.
      await this.me.refresh(true).catch(() => false);
    });
  }

  /** Who is acting now, then on to where they were going. */
  protected async signedIn(): Promise<void> {
    this.busy.set(true);
    try {
      await this.me.refresh(true).catch(() => false);
      await this.router.navigateByUrl(this.returnUrl());
    } finally {
      this.busy.set(false);
    }
  }

  private async send(
    recovery: boolean,
    work: (code: string) => Promise<void>,
  ): Promise<void> {
    if (this.busy()) return;
    const code = codeOf(this.code());
    if (recovery ? code === '' : !isAppCode(code)) {
      this.refuse(
        this.t(
          recovery
            ? 'editor.secondFactor.code.recoveryMissing'
            : 'editor.secondFactor.code.appMissing',
        ),
      );
      return;
    }
    this.busy.set(true);
    this.error.set('');
    try {
      await work(code);
    } catch (error) {
      const failure = toApiError(error);
      if (!this.ended(failure)) {
        this.code.set('');
        const problem = secondFactorProblem(failure, recovery);
        this.refuse(this.t(problem.key, problem.params));
      }
    } finally {
      this.busy.set(false);
    }
  }

  private refuse(message: string): void {
    this.error.set(message);
    this.codeField()?.focus();
  }

  /** The step is over, or locked: the page says so in place of the form. */
  private ended(failure: ApiError): boolean {
    if (
      failure.code === 'second-factor-expired' ||
      failure.code === 'second-factor-not-begun'
    ) {
      this.setUp.set(null);
      this.view.set('expired');
      return true;
    }
    if (failure.code === 'too-many-failed-attempts') {
      this.lockedMinutes.set(waitMinutes(failure));
      this.setUp.set(null);
      this.view.set('locked');
      return true;
    }
    return false;
  }
}
