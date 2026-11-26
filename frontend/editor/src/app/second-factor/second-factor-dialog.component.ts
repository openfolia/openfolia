import { Location } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideShieldCheck, lucideTriangleAlert } from '@ng-icons/lucide';

import {
  type ZardAlertDialogRef,
  ZardAlertDialogService,
} from '@openfolia/ui/alert-dialog';
import { ZardBadgeComponent } from '@openfolia/ui/badge';
import { ZardButtonComponent } from '@openfolia/ui/button';
import { ZardDialogImports } from '@openfolia/ui/dialog';
import { ZardDropdownImports } from '@openfolia/ui/dropdown-menu';
import { injectTranslate, LanguageService } from '@openfolia/ui/i18n';
import { ZardInputComponent } from '@openfolia/ui/input';
import { FadeInDirective } from '@openfolia/ui/smooth';
import { ToastService, translated } from '@openfolia/ui/startup';
import {
  ErrorStateComponent,
  SkeletonRowsComponent,
} from '@openfolia/ui/states';

import { toApiError, type ApiError } from '../api';
import { isUnconfirmed, MeService } from '../permissions/me';
import { SecondFactorCodeComponent } from './code-field.component';
import { FocusOnShowDirective } from './focus-on-show.directive';
import { RecoveryCodesComponent } from './recovery-codes.component';
import {
  codeOf,
  isAppCode,
  type OwnSecondFactor,
  type Proof,
  SECOND_FACTOR_LINK,
  SecondFactorSession,
  secondFactorProblem,
  type SetUpBegun,
} from './second-factor-session';
import { SecondFactorDialogState } from './second-factor-dialog-state';
import { SecondFactorSetUpComponent } from './set-up-steps.component';

/** Fewer recovery codes left than this: say so. */
const FEW_CODES = 3;

type View =
  | 'loading'
  | 'failed'
  | 'off'
  | 'set-up'
  | 'codes'
  | 'on'
  | 'prove-codes'
  | 'prove-off';

/**
 * "Two-factor sign-in" in the account menu (#611), projected into `of-account-menu`. The caller
 * shows it only for a session that began here: with a password or a code by email.
 */
@Component({
  selector: 'of-second-factor-menu-item',
  imports: [ZardDropdownImports, NgIcon, TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [provideIcons({ lucideShieldCheck })],
  host: { class: 'block' },
  template: `
    <z-dropdown-menu-item
      data-testid="second-factor"
      (click)="dialog.open.set(true)"
    >
      <ng-icon
        name="lucideShieldCheck"
        class="text-foreground size-4 shrink-0"
        aria-hidden="true"
      />
      {{ 'editor.secondFactor.menu' | transloco }}
    </z-dropdown-menu-item>
  `,
})
export class SecondFactorMenuItemComponent {
  protected readonly dialog = inject(SecondFactorDialogState);
}

/**
 * One's own second factor (#611): set up with an authenticator app (the password first, when
 * there is one), its recovery codes shown once, new ones made and the whole turned off with the
 * password or a current code again. Nothing of it outlives the open dialog. The codes are shown
 * this once: while they are not put away, every way to close it (the X, Escape, Back) asks first,
 * and they are shown only to the person who asked for them.
 */
@Component({
  selector: 'of-second-factor-dialog',
  imports: [
    ZardDialogImports,
    ZardBadgeComponent,
    ZardButtonComponent,
    ZardInputComponent,
    TranslocoPipe,
    NgIcon,
    FadeInDirective,
    FocusOnShowDirective,
    ErrorStateComponent,
    SkeletonRowsComponent,
    SecondFactorCodeComponent,
    SecondFactorSetUpComponent,
    RecoveryCodesComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [provideIcons({ lucideShieldCheck, lucideTriangleAlert })],
  template: `
    <z-dialog
      [(zVisible)]="state.open"
      [zMaskClosable]="false"
      [zCanClose]="canClose"
      [zCloseOnNavigation]="false"
      class="sm:max-w-[34rem]"
    >
      <z-dialog-header>
        <z-dialog-title>{{ titleKey() | transloco }}</z-dialog-title>
        <z-dialog-description>{{
          descriptionKey() | transloco
        }}</z-dialog-description>
      </z-dialog-header>
      @if (state.open()) {
        <div
          class="min-w-0"
          data-testid="second-factor-dialog"
          [attr.data-view]="view()"
          [attr.aria-busy]="view() === 'loading' || busy()"
        >
          @switch (view()) {
            @case ('loading') {
              <of-skeleton-rows [count]="3" />
            }
            @case ('failed') {
              <of-error-state
                class="py-4"
                [kind]="failure()?.kind ?? 'unknown'"
                [retryable]="true"
                (retry)="load()"
              />
            }
            @case ('off') {
              @if (own()?.meta?.available) {
                <form
                  ofFadeIn
                  id="second-factor-form"
                  class="flex flex-col gap-4"
                  novalidate
                  (submit)="begin($event)"
                >
                  @if (own()?.meta?.required) {
                    <p [class]="noteClass">
                      <ng-icon
                        name="lucideTriangleAlert"
                        class="text-warning mt-0.5 shrink-0"
                        aria-hidden="true"
                      />
                      <span>{{
                        'editor.secondFactor.dialog.required' | transloco
                      }}</span>
                    </p>
                  }
                  @if (own()?.meta?.hasPassword) {
                    <div class="flex flex-col gap-1.5">
                      <label class="text-sm" for="second-factor-password">{{
                        'editor.secondFactor.dialog.password' | transloco
                      }}</label>
                      <input
                        id="second-factor-password"
                        z-input
                        ofFocusOnShow
                        type="password"
                        autocomplete="current-password"
                        maxlength="1024"
                        required
                        [attr.aria-invalid]="error() ? 'true' : null"
                        [value]="password()"
                        (input)="password.set($any($event.target).value)"
                      />
                    </div>
                  }
                  @if (error(); as message) {
                    <p role="alert" [class]="alertClass">{{ message }}</p>
                  }
                </form>
              } @else {
                <p [class]="noteClass" data-testid="second-factor-unavailable">
                  <ng-icon
                    name="lucideTriangleAlert"
                    class="text-warning mt-0.5 shrink-0"
                    aria-hidden="true"
                  />
                  <span>{{
                    'editor.apiErrors.codes.second-factor-unavailable'
                      | transloco
                  }}</span>
                </p>
              }
            }
            @case ('set-up') {
              @if (setUp(); as begun) {
                <form
                  id="second-factor-form"
                  class="flex flex-col gap-4"
                  novalidate
                  (submit)="confirm($event)"
                >
                  <of-second-factor-set-up [setUp]="begun">
                    <of-second-factor-code
                      inputId="second-factor-own-code"
                      [invalid]="error() !== ''"
                      [(code)]="code"
                    />
                    @if (error(); as message) {
                      <p role="alert" [class]="alertClass">{{ message }}</p>
                    }
                  </of-second-factor-set-up>
                </form>
              }
            }
            @case ('codes') {
              <of-recovery-codes [codes]="codes()" />
            }
            @case ('on') {
              <div
                ofFadeIn
                ofFocusOnShow
                tabindex="-1"
                class="flex flex-col gap-4 outline-none"
              >
                <div
                  class="border-border flex min-w-0 items-start gap-3 rounded-xl border p-4"
                >
                  <span
                    class="bg-success-muted text-success flex size-9 shrink-0 items-center justify-center rounded-lg"
                    aria-hidden="true"
                  >
                    <ng-icon name="lucideShieldCheck" size="18" />
                  </span>
                  <div class="flex min-w-0 flex-1 flex-col gap-1 text-sm">
                    <p class="m-0 font-medium break-words">
                      {{
                        'editor.secondFactor.dialog.since'
                          | transloco: { date: since() }
                      }}
                    </p>
                    <p
                      class="text-muted-foreground m-0 flex flex-wrap items-center gap-x-2 gap-y-1 break-words"
                      data-testid="recovery-codes-left"
                    >
                      {{
                        'editor.secondFactor.dialog.codesLeft'
                          | transloco: { count: codesLeft() }
                      }}
                      @if (codesLeft() < few) {
                        <z-badge zType="warning">{{
                          'editor.secondFactor.dialog.few' | transloco
                        }}</z-badge>
                      }
                    </p>
                  </div>
                </div>
                @if (own()?.meta?.required) {
                  <p
                    class="text-muted-foreground m-0 text-xs break-words"
                    data-testid="second-factor-required"
                  >
                    {{ 'editor.secondFactor.dialog.requiredOn' | transloco }}
                  </p>
                }
              </div>
            }
            @default {
              <form
                ofFadeIn
                id="second-factor-form"
                class="flex flex-col gap-4"
                novalidate
                (submit)="prove($event)"
              >
                @if (byCode()) {
                  <!-- Another field for each, so the focus and the keyboard follow the choice. -->
                  @for (way of [recovery()]; track way) {
                    <of-second-factor-code
                      inputId="second-factor-own-code"
                      [recovery]="way"
                      [invalid]="error() !== ''"
                      [(code)]="code"
                    />
                  }
                } @else {
                  <div class="flex flex-col gap-1.5">
                    <label class="text-sm" for="second-factor-password">{{
                      'editor.secondFactor.dialog.password' | transloco
                    }}</label>
                    <input
                      id="second-factor-password"
                      z-input
                      ofFocusOnShow
                      type="password"
                      autocomplete="current-password"
                      maxlength="1024"
                      required
                      [attr.aria-invalid]="error() ? 'true' : null"
                      [value]="password()"
                      (input)="password.set($any($event.target).value)"
                    />
                  </div>
                }
                @if (error(); as message) {
                  <p role="alert" [class]="alertClass">{{ message }}</p>
                }
                @if (byCode()) {
                  <button
                    type="button"
                    data-testid="second-factor-other-code"
                    [class]="linkClass"
                    [disabled]="busy()"
                    (click)="otherCode()"
                  >
                    {{
                      (recovery()
                        ? 'editor.secondFactor.signIn.useApp'
                        : 'editor.secondFactor.signIn.useRecovery'
                      ) | transloco
                    }}
                  </button>
                }
                @if (own()?.meta?.hasPassword) {
                  <button
                    type="button"
                    data-testid="second-factor-other-proof"
                    [class]="linkClass"
                    [disabled]="busy()"
                    (click)="otherProof()"
                  >
                    {{
                      (byCode()
                        ? 'editor.secondFactor.dialog.usePassword'
                        : 'editor.secondFactor.dialog.useCode'
                      ) | transloco
                    }}
                  </button>
                }
              </form>
            }
          }
        </div>
      }
      <z-dialog-footer>
        @switch (view()) {
          @case ('on') {
            <button
              z-button
              zType="outline"
              type="button"
              data-testid="second-factor-turn-off"
              (click)="ask('prove-off')"
            >
              {{ 'editor.secondFactor.dialog.turnOff' | transloco }}
            </button>
            <button
              z-button
              zType="outline"
              type="button"
              data-testid="second-factor-new-codes"
              (click)="ask('prove-codes')"
            >
              {{ 'editor.secondFactor.dialog.newCodes' | transloco }}
            </button>
          }
          @case ('codes') {
            <button
              z-button
              type="button"
              data-testid="second-factor-done"
              (click)="state.open.set(false)"
            >
              {{ 'editor.secondFactor.dialog.done' | transloco }}
            </button>
          }
          @default {
            <button
              z-button
              zType="ghost"
              type="button"
              [zDisabled]="busy()"
              (click)="back()"
            >
              {{ 'editor.admin.cancel' | transloco }}
            </button>
            @if (submitKey(); as key) {
              <button
                z-button
                type="submit"
                form="second-factor-form"
                data-testid="second-factor-submit"
                [zType]="view() === 'prove-off' ? 'destructive' : 'default'"
                [zDisabled]="busy()"
                [zLoading]="busy()"
              >
                {{ key | transloco }}
              </button>
            }
          }
        }
      </z-dialog-footer>
    </z-dialog>
  `,
})
export class SecondFactorDialogComponent {
  protected readonly state = inject(SecondFactorDialogState);
  private readonly session = inject(SecondFactorSession);
  private readonly me = inject(MeService);
  private readonly dialogs = inject(ZardAlertDialogService);
  private readonly toast = inject(ToastService);
  private readonly language = inject(LanguageService);
  private readonly t = injectTranslate();
  private readonly codeField = viewChild(SecondFactorCodeComponent);

  protected readonly few = FEW_CODES;
  protected readonly alertClass = 'text-destructive m-0 text-sm break-words';
  protected readonly noteClass =
    'border-warning/40 bg-warning-muted m-0 flex items-start gap-2 rounded-lg border px-3 py-2 text-sm break-words';

  protected readonly linkClass = SECOND_FACTOR_LINK;

  protected readonly view = signal<View>('loading');
  protected readonly own = signal<OwnSecondFactor | null>(null);
  protected readonly failure = signal<ApiError | null>(null);
  protected readonly setUp = signal<SetUpBegun | null>(null);
  protected readonly codes = signal<readonly string[]>([]);
  protected readonly password = signal('');
  protected readonly code = signal('');
  protected readonly byCode = signal(false);
  protected readonly recovery = signal(false);
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  /** Just turned on: said once the dialog is closed, as it would cover the message. */
  private sessionsEnded: number | null = null;
  /** Codes that came after the dialog was closed: it opens again for them, as they come once. */
  private late: readonly string[] | null = null;
  /** Codes the API answered, until it is known who acts here now (another tab may have signed in). */
  private readonly arrived = signal<{
    readonly askedBy: string | null;
    readonly opening: number;
    readonly codes: readonly string[];
    readonly sessionsEnded: number | null;
  } | null>(null);
  /** Whose second factor the open dialog is about; null until that is known. */
  private person: string | null = null;
  /** The question before unseen codes go, and who waits for its answer. */
  private readonly question = signal<ZardAlertDialogRef | null>(null);
  private leaving: {
    readonly answer: Promise<boolean>;
    readonly resolve: (leave: boolean) => void;
  } | null = null;
  /** An answer that comes after the dialog closed is not shown in the next one. */
  private opening = 0;

  protected readonly codesLeft = computed(
    () => this.own()?.meta?.recoveryCodesLeft ?? 0,
  );
  protected readonly since = computed(() => {
    const at = this.own()?.attributes.enabledAt;
    return at
      ? new Intl.DateTimeFormat(this.language.locale(), {
          dateStyle: 'long',
        }).format(new Date(at))
      : '';
  });

  protected readonly titleKey = computed(() => {
    switch (this.view()) {
      case 'set-up':
        return 'editor.secondFactor.dialog.setUpTitle';
      case 'codes':
        return 'editor.secondFactor.recovery.title';
      case 'prove-codes':
        return 'editor.secondFactor.dialog.newCodes';
      case 'prove-off':
        return 'editor.secondFactor.dialog.turnOffTitle';
      default:
        return 'editor.secondFactor.menu';
    }
  });

  protected readonly descriptionKey = computed(() => {
    switch (this.view()) {
      case 'off':
        return 'editor.secondFactor.dialog.offDescription';
      case 'set-up':
        return 'editor.secondFactor.dialog.setUpDescription';
      case 'codes':
        return 'editor.secondFactor.recovery.intro';
      case 'prove-codes':
        return 'editor.secondFactor.dialog.newCodesDescription';
      case 'prove-off':
        return this.own()?.meta?.required
          ? 'editor.secondFactor.dialog.turnOffRequiredDescription'
          : 'editor.secondFactor.dialog.turnOffDescription';
      default:
        return 'editor.secondFactor.dialog.description';
    }
  });

  /** The submit button's text; null: nothing to submit. */
  protected readonly submitKey = computed(() => {
    switch (this.view()) {
      case 'off':
        return this.own()?.meta?.available
          ? 'editor.secondFactor.dialog.setUp'
          : null;
      case 'set-up':
        return 'editor.secondFactor.dialog.turnOn';
      case 'prove-codes':
        return 'editor.secondFactor.dialog.newCodes';
      case 'prove-off':
        return 'editor.secondFactor.dialog.turnOff';
      default:
        return null;
    }
  });

  constructor() {
    // Each opening reads it anew; closing forgets the password, the secret and the codes.
    effect(() => {
      const open = this.state.open();
      untracked(() => {
        this.opening++;
        const id = this.me.me().id;
        this.person = isUnconfirmed(id) ? null : id;
        this.clear();
        this.own.set(null);
        this.codes.set([]);
        if (open && this.late) {
          this.showCodes(this.late);
          this.late = null;
        } else if (open) void this.load();
        else if (this.sessionsEnded !== null) {
          this.toast.success(
            translated('editor.secondFactor.dialog.turnedOn', {
              count: this.sessionsEnded,
            }),
          );
          this.sessionsEnded = null;
        }
        // Closed by another way than the question's own buttons: nothing left to ask.
        if (!open) this.question()?.close();
      });
    });
    // Shown to the person who asked alone: who acts here may have changed meanwhile (a sign-in
    // in another tab), and while that is not known yet, they wait.
    effect(() => {
      const id = this.me.me().id;
      const arrived = this.arrived();
      if (!arrived || isUnconfirmed(id)) return;
      untracked(() => {
        this.arrived.set(null);
        if (id !== arrived.askedBy) return;
        this.sessionsEnded = arrived.sessionsEnded;
        if (arrived.opening === this.opening && this.state.open()) {
          this.showCodes(arrived.codes);
        } else {
          this.showLate(arrived.codes);
        }
      });
    });
    // Someone else now, or nobody (the session ended): nothing of the person before stays on the
    // screen, and nobody is asked.
    effect(() => {
      const id = this.me.me().id;
      if (isUnconfirmed(id)) return;
      untracked(() => {
        if (!this.state.open() || id === this.person) return;
        if (this.person === null) {
          this.person = id;
          return;
        }
        this.late = null;
        this.sessionsEnded = null;
        this.state.open.set(false);
      });
    });
    effect(() => {
      if (!this.question()?.isClosing()) return;
      untracked(() => {
        this.question.set(null);
        this.leaving?.resolve(!this.state.open());
        this.leaving = null;
      });
    });
    const ask = () => this.askBeforeLeaving();
    this.state.asksBeforeLeaving = ask;
    // Back and Forward: closed at once, so codes still under way come as late ones.
    const pops = inject(Location).subscribe(() => {
      if (this.state.open() && this.canClose()) this.state.open.set(false);
    });
    inject(DestroyRef).onDestroy(() => {
      pops.unsubscribe();
      this.question()?.close();
      this.leaving?.resolve(true);
      if (this.state.asksBeforeLeaving === ask) {
        this.state.asksBeforeLeaving = null;
      }
    });
  }

  /** Closes at once, but with codes shown: those ask first. */
  protected readonly canClose = (): boolean => {
    if (this.view() !== 'codes') return true;
    void this.askBeforeLeaving();
    return false;
  };

  private askBeforeLeaving(): Promise<boolean> {
    if (!this.state.open() || this.view() !== 'codes') {
      return Promise.resolve(true);
    }
    // Asked once, however many wait for it (the dialog on Back, and the router).
    if (this.leaving) return this.leaving.answer;
    let resolve!: (leave: boolean) => void;
    const answer = new Promise<boolean>((done) => (resolve = done));
    this.leaving = { answer, resolve };
    this.question.set(
      this.dialogs.confirm({
        zTitle: this.t('editor.secondFactor.recovery.leaveTitle'),
        zDescription: this.t('editor.secondFactor.recovery.leaveDescription'),
        zOkText: this.t('editor.secondFactor.recovery.leave'),
        zCancelText: this.t('editor.secondFactor.recovery.stay'),
        zOkDestructive: true,
        zOnOk: () => this.state.open.set(false),
      }) as ZardAlertDialogRef,
    );
    return answer;
  }

  protected async load(): Promise<void> {
    const opening = this.opening;
    this.view.set('loading');
    try {
      const own = await this.session.own();
      if (opening !== this.opening) return;
      this.own.set(own);
      this.view.set(own.attributes.enabledAt === null ? 'off' : 'on');
    } catch (error) {
      if (opening !== this.opening) return;
      this.failure.set(toApiError(error));
      this.view.set('failed');
    }
  }

  protected async begin(event: Event): Promise<void> {
    event.preventDefault();
    const hasPassword = this.own()?.meta?.hasPassword ?? false;
    if (hasPassword && this.password() === '') {
      this.error.set(this.t('editor.secondFactor.dialog.passwordMissing'));
      return;
    }
    await this.send(
      () => this.session.begin(hasPassword ? this.password() : null),
      (begun) => {
        this.clear();
        this.setUp.set(begun);
        this.view.set('set-up');
      },
    );
  }

  protected async confirm(event: Event): Promise<void> {
    event.preventDefault();
    if (!this.hasCode()) return;
    const askedBy = this.person;
    const opening = this.opening;
    await this.send(
      () => this.session.confirm(codeOf(this.code())),
      (on) =>
        this.arrived.set({
          askedBy,
          opening,
          codes: on.recoveryCodes,
          sessionsEnded: on.sessionsEnded,
        }),
      true,
    );
  }

  protected async prove(event: Event): Promise<void> {
    event.preventDefault();
    let proof: Proof;
    if (this.byCode()) {
      if (!this.hasCode()) return;
      proof = { code: codeOf(this.code()) };
    } else {
      if (this.password() === '') {
        this.error.set(this.t('editor.secondFactor.dialog.passwordMissing'));
        return;
      }
      proof = { password: this.password() };
    }
    if (this.view() === 'prove-codes') {
      const askedBy = this.person;
      const opening = this.opening;
      await this.send(
        () => this.session.newRecoveryCodes(proof),
        (codes) =>
          this.arrived.set({ askedBy, opening, codes, sessionsEnded: null }),
        true,
      );
    } else {
      await this.send(
        () => this.session.turnOff(proof),
        () => {
          this.state.open.set(false);
          this.toast.success(
            translated('editor.secondFactor.dialog.turnedOff'),
          );
        },
      );
    }
  }

  protected ask(view: 'prove-codes' | 'prove-off'): void {
    this.clear();
    this.byCode.set(!(this.own()?.meta?.hasPassword ?? false));
    this.recovery.set(false);
    this.view.set(view);
  }

  protected otherCode(): void {
    this.recovery.update((on) => !on);
    this.code.set('');
    this.error.set('');
  }

  private showCodes(codes: readonly string[]): void {
    this.clear();
    this.codes.set(codes);
    this.view.set('codes');
  }

  private showLate(codes: readonly string[]): void {
    if (this.state.open()) {
      // Opened again meanwhile: in place of what it was loading.
      this.opening++;
      this.showCodes(codes);
    } else {
      this.late = codes;
      this.state.open.set(true);
    }
  }

  protected otherProof(): void {
    this.byCode.update((on) => !on);
    this.password.set('');
    this.code.set('');
    this.error.set('');
  }

  /** Back to what it was before a question; elsewhere the dialog closes. */
  protected back(): void {
    const view = this.view();
    if (view === 'prove-codes' || view === 'prove-off') {
      this.clear();
      this.view.set('on');
    } else {
      this.state.open.set(false);
    }
  }

  private hasCode(): boolean {
    const recovery = this.view() !== 'set-up' && this.recovery();
    if (recovery ? codeOf(this.code()) !== '' : isAppCode(this.code())) {
      return true;
    }
    this.error.set(
      this.t(
        recovery
          ? 'editor.secondFactor.code.recoveryMissing'
          : 'editor.secondFactor.code.appMissing',
      ),
    );
    this.codeField()?.focus();
    return false;
  }

  private async send<T>(
    call: () => Promise<T>,
    done: (answer: T) => void,
    /** Also when the dialog was closed (and perhaps opened again) meanwhile. */
    late = false,
  ): Promise<void> {
    if (this.busy()) return;
    const opening = this.opening;
    this.busy.set(true);
    this.error.set('');
    try {
      const answer = await call();
      if (late || opening === this.opening) done(answer);
    } catch (error) {
      if (opening !== this.opening) return;
      const failure = toApiError(error);
      this.code.set('');
      if (failure.code === 'second-factor-not-begun') {
        // Its ten minutes are over: from the start, saying why.
        this.clear();
        this.view.set('off');
      }
      const problem = secondFactorProblem(
        failure,
        this.byCode() && this.recovery(),
      );
      this.error.set(this.t(problem.key, problem.params));
      this.codeField()?.focus();
    } finally {
      if (opening === this.opening) this.busy.set(false);
    }
  }

  private clear(): void {
    this.busy.set(false);
    this.password.set('');
    this.code.set('');
    this.setUp.set(null);
    this.error.set('');
  }
}
