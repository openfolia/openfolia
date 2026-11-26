import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  ElementRef,
  inject,
  Injector,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideKeyRound,
  lucideLifeBuoy,
  lucideLoaderCircle,
  lucideRotateCw,
  lucideTriangleAlert,
  lucideX,
} from '@ng-icons/lucide';
import { firstValueFrom } from 'rxjs';

import { ZardButtonComponent } from '@openfolia/ui/button';
import {
  ZardCommandComponent,
  ZardCommandImports,
} from '@openfolia/ui/command';
import { ZardAlertDialogService } from '@openfolia/ui/alert-dialog';
import { injectTranslate, LanguageService } from '@openfolia/ui/i18n';
import { ZardPopoverImports } from '@openfolia/ui/popover';
import { ZardSkeletonComponent } from '@openfolia/ui/skeleton';
import { ZardSelectImports } from '@openfolia/ui/select';
import { FadeInDirective, RefreshingDirective } from '@openfolia/ui/smooth';
import {
  SaveStatusComponent,
  type SaveStatus,
  SkeletonRowsComponent,
} from '@openfolia/ui/states';
import { ToastService } from '@openfolia/ui/toast';

import {
  ApiClient,
  pageQuery,
  toApiError,
  type ApiError,
  type Schema,
} from '../../api';
import { apiErrorText } from '../../i18n';
import { PasswordSession } from '../../session/password-session';
import type { UserItem } from '../admin-model';
import {
  type ShownSignInLink,
  SignInLinkDialogComponent,
} from '../sign-in-link-dialog.component';
import {
  InstallationChoiceComponent,
  type InstallationOption,
  type SettingsItem,
} from './installation-choice.component';
import {
  crosses,
  offeredFor,
  SESSION_LIMITS,
  type SessionLimit,
  spanText,
} from './session-limits';

/** How long typing pauses before people are searched, in ms, and how many are shown. */
const SEARCH_DEBOUNCE = 200;
const PEOPLE_SHOWN = 20;
/** The select's value for "the server's setting". */
const SERVER = 'server';

/** The refusals this page says where they belong. */
const SAID_HERE = [
  'single-sign-on-own-first',
  'single-sign-on-unavailable',
  'break-glass-not-usable',
] as const;

/** Why the emergency account cannot be used, said for the person choosing it. */
const PROBLEM_TEXT: Readonly<Record<string, string>> = {
  deactivated: 'editor.admin.settings.singleSignOn.problems.deactivated',
  'no-admin-role': 'editor.admin.settings.singleSignOn.problems.noAdminRole',
  'no-password': 'editor.admin.settings.singleSignOn.problems.noPassword',
  'password-sign-in-off':
    'editor.admin.settings.singleSignOn.problems.passwordSignInOff',
};

type Person = Pick<UserItem, 'id' | 'attributes'>;
type Changes = Schema<'UpdateInstallationSettingsDocument'>['data'];

/**
 * Admin › Settings › Installation › Single sign-on and sessions (#378): whether people must sign
 * in with an identity provider, the one account that may still use its password then, and how
 * long a session lasts. Each is saved at once. A refusal that keeps the admin from locking
 * themselves out is said where it happened.
 */
@Component({
  selector: 'of-settings-single-sign-on',
  imports: [
    TranslocoPipe,
    NgIcon,
    ZardButtonComponent,
    ZardCommandImports,
    ZardPopoverImports,
    ZardSelectImports,
    FadeInDirective,
    RefreshingDirective,
    SaveStatusComponent,
    SkeletonRowsComponent,
    ZardSkeletonComponent,
    SignInLinkDialogComponent,
    InstallationChoiceComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [
    provideIcons({
      lucideKeyRound,
      lucideLifeBuoy,
      lucideLoaderCircle,
      lucideRotateCw,
      lucideTriangleAlert,
      lucideX,
    }),
  ],
  host: { class: '@container flex max-w-4xl min-w-0 flex-col gap-8' },
  template: `
    <div class="flex min-w-0 flex-col gap-4">
      <of-installation-choice
        setting="singleSignOn"
        group="single-sign-on"
        legend="editor.admin.settings.singleSignOn.legend"
        [note]="
          available()
            ? 'editor.admin.settings.singleSignOn.note'
            : 'editor.admin.settings.singleSignOn.noProvider'
        "
        [saidByPage]="saidHere"
        [options]="options()"
        [ask]="askFirst"
        (refused)="refusedChoice($event)"
        (read)="show($event)"
      />
      @if (choiceRefusal(); as key) {
        <p
          ofFadeIn
          role="alert"
          data-testid="single-sign-on-refused"
          class="border-warning/40 bg-warning-muted m-0 flex min-w-0 items-start gap-2 rounded-lg border px-4 py-3 text-sm break-words"
        >
          <ng-icon
            name="lucideTriangleAlert"
            class="text-warning mt-0.5 shrink-0"
            aria-hidden="true"
          />
          <span class="min-w-0">{{ key | transloco }}</span>
        </p>
      }
    </div>

    @if (settings(); as s) {
      <section
        ofFadeIn
        class="flex min-w-0 flex-col gap-3"
        aria-labelledby="emergency-account-title"
        data-slot="emergency-account"
      >
        <div class="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1">
          <h3 id="emergency-account-title" class="m-0 text-sm font-medium">
            {{ 'editor.admin.settings.singleSignOn.account.title' | transloco }}
          </h3>
          @if (accountStatus(); as status) {
            <of-save-status class="ms-auto" [status]="status" />
          }
        </div>
        <div
          class="border-border flex min-w-0 flex-col gap-3 rounded-lg border px-4 py-3 @xl:flex-row @xl:items-center"
        >
          <span
            class="bg-muted text-muted-foreground hidden size-9 shrink-0 items-center justify-center rounded-full @xl:flex"
            aria-hidden="true"
          >
            <ng-icon name="lucideLifeBuoy" size="16" />
          </span>
          <div class="flex min-w-0 flex-1 flex-col gap-0.5">
            @if (accountId(); as id) {
              @if (person(); as p) {
                <span
                  ofFadeIn
                  class="text-sm font-medium break-words"
                  data-testid="emergency-account"
                  >{{ p.attributes.name }}</span
                >
                @if (p.attributes.email; as email) {
                  <span
                    ofFadeIn
                    class="text-muted-foreground text-xs break-all"
                    >{{ email }}</span
                  >
                }
              } @else if (personFailed()) {
                <span
                  class="text-sm font-medium break-words"
                  data-testid="emergency-account"
                  >{{ id }}</span
                >
              } @else {
                <span class="flex flex-col gap-1.5 py-0.5" aria-hidden="true">
                  <z-skeleton class="h-4 w-40 max-w-full" />
                  <z-skeleton class="h-3 w-56 max-w-full" />
                </span>
              }
            } @else {
              <span class="text-sm">{{
                'editor.admin.settings.singleSignOn.account.none' | transloco
              }}</span>
              @if (required()) {
                <span class="text-muted-foreground text-xs break-words">{{
                  'editor.admin.settings.singleSignOn.account.noneHint'
                    | transloco
                }}</span>
              }
            }
          </div>
          <div class="flex min-w-0 flex-wrap items-center gap-2">
            @if (accountId() && required() && !s.meta.breakGlassProblem) {
              <button
                z-button
                zType="outline"
                zSize="sm"
                type="button"
                data-testid="emergency-account-link"
                [disabled]="linking()"
                (click)="makeLink()"
              >
                <ng-icon
                  [name]="linking() ? 'lucideLoaderCircle' : 'lucideKeyRound'"
                  data-icon="inline-start"
                  [class]="
                    linking() ? 'animate-spin motion-reduce:animate-none' : ''
                  "
                  aria-hidden="true"
                />
                {{
                  'editor.admin.settings.singleSignOn.account.link' | transloco
                }}
              </button>
            }
            <button
              z-button
              zType="outline"
              zSize="sm"
              type="button"
              data-testid="emergency-account-choose"
              zPopover
              [zContent]="picker"
              zPlacement="bottom"
              zAlign="end"
              [zVisible]="choosing()"
              (zVisibleChange)="openPicker($event)"
            >
              {{
                (accountId()
                  ? 'editor.admin.settings.singleSignOn.account.change'
                  : 'editor.admin.settings.singleSignOn.account.choose'
                ) | transloco
              }}
            </button>
            @if (accountId()) {
              <button
                z-button
                zType="ghost"
                zSize="icon-sm"
                type="button"
                data-testid="emergency-account-remove"
                [attr.aria-label]="
                  'editor.admin.settings.singleSignOn.account.remove'
                    | transloco
                "
                (click)="removeAccount()"
              >
                <ng-icon name="lucideX" aria-hidden="true" />
              </button>
            }
          </div>
        </div>
        @if (accountProblem(); as key) {
          <p
            ofFadeIn
            role="alert"
            data-testid="emergency-account-problem"
            class="border-warning/40 bg-warning-muted m-0 flex min-w-0 items-start gap-2 rounded-lg border px-4 py-3 text-sm break-words"
          >
            <ng-icon
              name="lucideTriangleAlert"
              class="text-warning mt-0.5 shrink-0"
              aria-hidden="true"
            />
            <span class="min-w-0">{{ key | transloco }}</span>
          </p>
        }
        <p
          class="text-muted-foreground m-0 max-w-prose text-[0.8125rem] leading-5 break-words"
        >
          {{ 'editor.admin.settings.singleSignOn.account.hint' | transloco }}
        </p>
      </section>

      <section
        ofFadeIn
        class="flex min-w-0 flex-col gap-3"
        aria-labelledby="session-limits-title"
        data-slot="session-limits"
      >
        <div class="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1">
          <h3 id="session-limits-title" class="m-0 text-sm font-medium">
            {{ 'editor.admin.settings.singleSignOn.sessions' | transloco }}
          </h3>
          @if (limitStatus(); as status) {
            <of-save-status class="ms-auto" [status]="status" />
          }
        </div>
        <div class="border-border flex flex-col divide-y rounded-lg border">
          @for (limit of limits; track limit.setting) {
            <div
              class="flex min-w-0 flex-col gap-2 px-4 py-3 @xl:flex-row @xl:items-center @xl:justify-between @xl:gap-6"
            >
              <span class="flex min-w-0 flex-col gap-0.5">
                <span class="text-sm font-medium break-words">{{
                  limit.label | transloco
                }}</span>
                <span
                  class="text-muted-foreground text-[0.8125rem] leading-5 break-words"
                  >{{ limit.hint | transloco }}</span
                >
              </span>
              <z-select
                class="w-full shrink-0 @xl:w-72"
                zPosition="popper"
                [attr.data-slot]="limit.setting"
                [zAriaLabel]="limit.label | transloco"
                [zValue]="shownLimit(limit)"
                (zSelectionChange)="setLimit(limit, $any($event))"
              >
                <z-select-item
                  [zValue]="server"
                  [zDisabled]="crosses(limit, s, null)"
                  >{{
                    'editor.admin.settings.singleSignOn.serverSetting'
                      | transloco
                        : { span: span(s.meta[limit.server] * limit.minutes) }
                  }}</z-select-item
                >
                @for (value of offeredFor(limit, s); track value) {
                  <z-select-item
                    [zValue]="'' + value"
                    [zDisabled]="crosses(limit, s, value)"
                    >{{ span(value * limit.minutes) }}</z-select-item
                  >
                }
              </z-select>
            </div>
          }
        </div>
        <p
          class="text-muted-foreground m-0 max-w-prose text-[0.8125rem] leading-5 break-words"
        >
          {{ 'editor.admin.settings.singleSignOn.sessionsNote' | transloco }}
        </p>
      </section>
    }

    <ng-template #picker>
      <z-popover class="w-80 max-w-[calc(100vw-2rem)] p-0">
        <z-command
          class="rounded-md"
          zShouldFilter="false"
          (zCommandSelected)="choose($any($event).value)"
        >
          <z-command-input
            [label]="
              'editor.admin.settings.singleSignOn.account.search' | transloco
            "
            [placeholder]="
              'editor.admin.settings.singleSignOn.account.search' | transloco
            "
            (valueChange)="query.set($event)"
          />
          <z-command-list
            class="h-72 max-h-72"
            data-testid="emergency-account-people"
            [attr.aria-busy]="searching() || null"
          >
            @if (searchFailed()) {
              <p class="text-destructive m-0 px-2 py-1.5 text-sm" role="alert">
                {{
                  'editor.admin.settings.singleSignOn.account.failed'
                    | transloco
                }}
              </p>
              <z-command-option
                [zValue]="retryValue"
                [zLabel]="
                  'editor.admin.settings.singleSignOn.account.retry' | transloco
                "
                zIcon="lucideRotateCw"
              />
            } @else if (searching() && people().length === 0) {
              <of-skeleton-rows class="px-2 py-1" [count]="3" />
            } @else if (people().length === 0) {
              <p
                class="text-muted-foreground m-0 px-2 py-4 text-center text-sm"
              >
                {{
                  'editor.admin.settings.singleSignOn.account.nobody'
                    | transloco
                }}
              </p>
            }
            <div [ofRefreshing]="searching()">
              @for (p of people(); track p.id) {
                <z-command-option
                  [zValue]="p.id"
                  [zLabel]="p.attributes.name"
                  [zDisabled]="!usable(p)"
                >
                  <span
                    data-slot="command-option-label"
                    class="flex min-w-0 flex-col"
                  >
                    <span class="break-words">{{ p.attributes.name }}</span>
                    <span class="text-muted-foreground text-xs break-all">{{
                      usable(p)
                        ? (p.attributes.email ?? p.id)
                        : ((p.meta.signIn?.password
                            ? 'editor.admin.settings.singleSignOn.account.notAdmin'
                            : 'editor.admin.settings.singleSignOn.account.noPassword'
                          ) | transloco)
                    }}</span>
                  </span>
                </z-command-option>
              }
            </div>
            @if (more()) {
              <p class="text-muted-foreground m-0 px-2 py-1.5 text-xs">
                {{
                  'editor.admin.settings.singleSignOn.account.more' | transloco
                }}
              </p>
            }
          </z-command-list>
        </z-command>
      </z-popover>
    </ng-template>

    <of-sign-in-link-dialog [shown]="shownLink()" [(open)]="linkOpen" />
  `,
})
export class SingleSignOnTopicPage {
  private readonly api = inject(ApiClient);
  private readonly toast = inject(ToastService);
  private readonly dialogs = inject(ZardAlertDialogService);
  private readonly passwords = inject(PasswordSession);
  private readonly language = inject(LanguageService);
  private readonly t = injectTranslate();

  protected readonly saidHere = SAID_HERE;
  protected readonly limits = SESSION_LIMITS;
  protected readonly server = SERVER;
  protected readonly retryValue = ':retry';
  protected readonly offeredFor = offeredFor;
  protected readonly crosses = crosses;

  private readonly element = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);
  private readonly command = viewChild(ZardCommandComponent);
  /** The settings as the API last said; null until read. */
  protected readonly settings = signal<SettingsItem | null>(null);
  protected readonly accountStatus = signal<SaveStatus | null>(null);
  protected readonly limitStatus = signal<SaveStatus | null>(null);
  private readonly refusal = signal<ApiError | null>(null);
  private readonly accountRefusal = signal<ApiError | null>(null);
  /** Who the emergency account is, once read. */
  protected readonly person = signal<Person | null>(null);
  /** They could not be read: their ID is shown. */
  protected readonly personFailed = signal(false);
  /** A limit being saved, as its select shows it: the saved one again when that fails. */
  private readonly savingLimits = signal<
    Readonly<Partial<Record<SessionLimit['setting'], string>>>
  >({});

  protected readonly available = computed(
    () => this.settings()?.meta.singleSignOnAvailable !== false,
  );
  protected readonly required = computed(
    () => this.settings()?.attributes.singleSignOn === 'required',
  );
  protected readonly accountId = computed(
    () => this.settings()?.relationships.breakGlassAccount.data?.id ?? null,
  );
  protected readonly options = computed((): InstallationOption[] => [
    {
      value: 'optional',
      label: 'editor.admin.settings.singleSignOn.optional',
      hint: 'editor.admin.settings.singleSignOn.optionalHint',
    },
    {
      value: 'required',
      label: 'editor.admin.settings.singleSignOn.required',
      hint: 'editor.admin.settings.singleSignOn.requiredHint',
      disabled: !this.available(),
    },
  ]);
  protected readonly choiceRefusal = computed(() => {
    const error = this.refusal();
    if (!error) return null;
    return error.code === 'break-glass-not-usable'
      ? this.problemOf(error)
      : apiErrorText(error).key;
  });
  protected readonly accountProblem = computed(() => {
    const error = this.accountRefusal();
    if (error) {
      return error.code === 'break-glass-not-usable'
        ? this.problemOf(error)
        : apiErrorText(error).key;
    }
    const problem = this.settings()?.meta.breakGlassProblem;
    return problem ? (PROBLEM_TEXT[problem] ?? null) : null;
  });

  // The picker of people.
  protected readonly choosing = signal(false);
  protected readonly query = signal('');
  protected readonly people = signal<readonly UserItem[]>([]);
  protected readonly searching = signal(false);
  protected readonly searchFailed = signal(false);
  /** There are more people than are shown. */
  protected readonly more = signal(false);
  private searches = 0;

  // A link to set the emergency account's password.
  protected readonly linking = signal(false);
  protected readonly linkOpen = signal(false);
  protected readonly shownLink = signal<ShownSignInLink | null>(null);

  constructor() {
    effect((onCleanup) => {
      const query = this.query().trim();
      if (!this.choosing()) return;
      const timer = setTimeout(
        () => void this.search(query),
        query === '' ? 0 : SEARCH_DEBOUNCE,
      );
      onCleanup(() => clearTimeout(timer));
    });
    effect(() => {
      const id = this.accountId();
      untracked(() => {
        if (id !== this.person()?.id) this.person.set(null);
        this.personFailed.set(false);
        if (id !== null && !this.person()) void this.readPerson(id);
      });
    });
  }

  protected show(item: SettingsItem): void {
    const shown = this.settings();
    // Answers can overtake each other: the newest state stays.
    if (
      shown &&
      (item.attributes.updatedAt ?? '') < (shown.attributes.updatedAt ?? '')
    ) {
      return;
    }
    const before = shown?.attributes.singleSignOn;
    this.settings.set(item);
    // What the sign-in page and the users page offer follows it.
    if (before && before !== item.attributes.singleSignOn) {
      void this.passwords.reloadOptions();
    }
  }

  protected refusedChoice(error: ApiError | null): void {
    this.refusal.set(error && this.saidOnPage(error) ? error : null);
  }

  /** Requiring it signs people out: asked first. */
  protected readonly askFirst = (value: string, save: () => void): boolean => {
    if (value !== 'required') return false;
    this.refusal.set(null);
    this.dialogs.confirm({
      zTitle: this.t('editor.admin.settings.singleSignOn.confirm.title'),
      zDescription: this.t(
        this.accountId()
          ? 'editor.admin.settings.singleSignOn.confirm.description'
          : 'editor.admin.settings.singleSignOn.confirm.descriptionNoAccount',
      ),
      zOkText: this.t('editor.admin.settings.singleSignOn.confirm.ok'),
      zCancelText: this.t('editor.admin.cancel'),
      zOkDestructive: true,
      zOnOk: () => save(),
    });
    return true;
  };

  protected openPicker(open: boolean): void {
    this.choosing.set(open);
    if (!open) return;
    this.query.set('');
    this.people.set([]);
    this.more.set(false);
    this.searchFailed.set(false);
    this.searching.set(true);
    afterNextRender(() => this.command()?.focus(), { injector: this.injector });
  }

  /** Whether `person` can be the emergency account, as far as the list says: the API decides. */
  protected usable(person: UserItem): boolean {
    return (
      person.meta.signIn?.password !== false &&
      person.meta.permissions.includes('admin.roles')
    );
  }

  protected async choose(id: string): Promise<void> {
    if (id === this.retryValue) {
      await this.search(this.query().trim());
      return;
    }
    const person = this.people().find((p) => p.id === id);
    this.choosing.set(false);
    if (id === this.accountId()) return;
    if (await this.setAccount(id)) this.person.set(person ?? null);
  }

  protected async setAccount(id: string | null): Promise<boolean> {
    this.accountRefusal.set(null);
    return this.patch(this.accountStatus, this.accountRefusal, {
      relationships: {
        breakGlassAccount: { data: id === null ? null : { type: 'User', id } },
      },
    });
  }

  /** Removes the account; its button goes with it, so the one to choose another takes the focus. */
  protected async removeAccount(): Promise<void> {
    if (!(await this.setAccount(null))) return;
    afterNextRender(
      () => {
        // Only when the focus went with the button: not from where the person moved on to.
        const { activeElement } = document;
        if (activeElement !== null && activeElement !== document.body) return;
        this.element.nativeElement
          .querySelector<HTMLElement>(
            '[data-testid="emergency-account-choose"]',
          )
          ?.focus();
      },
      { injector: this.injector },
    );
  }

  protected shownLimit(limit: SessionLimit): string {
    return this.savingLimits()[limit.setting] ?? this.limitValue(limit);
  }

  private limitValue(limit: SessionLimit): string {
    const value = this.settings()?.attributes[limit.setting] ?? null;
    return value === null ? SERVER : String(value);
  }

  protected async setLimit(limit: SessionLimit, chosen: string): Promise<void> {
    const { setting } = limit;
    if (chosen === this.shownLimit(limit)) return;
    this.savingLimits.update((saving) => ({ ...saving, [setting]: chosen }));
    await this.patch(this.limitStatus, null, {
      attributes: { [setting]: chosen === SERVER ? null : Number(chosen) },
    });
    this.savingLimits.update((saving) =>
      // Chosen anew meanwhile: that one is being saved.
      saving[setting] === chosen ? { ...saving, [setting]: undefined } : saving,
    );
  }

  protected span(minutes: number): string {
    return spanText(minutes, this.language.locale());
  }

  protected async makeLink(): Promise<void> {
    const id = this.accountId();
    if (id === null || this.linking()) return;
    this.linking.set(true);
    try {
      const made = await this.passwords.makeLink(id, 'reset');
      this.shownLink.set({
        name: this.person()?.attributes.name ?? id,
        email: this.person()?.attributes.email ?? null,
        kind: 'reset',
        url: this.passwords.linkOf(made, location.origin),
        expiresAt: made.expiresAt,
        emailed: made.emailed,
      });
      this.linkOpen.set(true);
    } catch (error) {
      this.toast.error(apiErrorText(toApiError(error)));
    } finally {
      this.linking.set(false);
    }
  }

  /** Saves one change; true when the API took it. */
  private async patch(
    status: typeof this.accountStatus,
    refusal: typeof this.accountRefusal | null,
    changes: Partial<Pick<Changes, 'attributes' | 'relationships'>>,
  ): Promise<boolean> {
    status.set('saving');
    try {
      const doc = await firstValueFrom(
        this.api.patch(
          '/settings',
          { path: {} as never },
          {
            data: {
              type: 'InstallationSettings',
              id: 'installation',
              ...changes,
            },
          },
        ),
      );
      this.show(doc.data);
      status.set('saved');
      return true;
    } catch (e) {
      status.set('not-saved');
      const error = toApiError(e);
      if (refusal && this.saidOnPage(error)) refusal.set(error);
      else this.toast.error(apiErrorText(error));
      return false;
    }
  }

  private saidOnPage(error: ApiError): boolean {
    return (SAID_HERE as readonly string[]).includes(error.code);
  }

  private problemOf(error: ApiError): string {
    const problem = error.errors[0]?.meta?.['problem'];
    return (
      PROBLEM_TEXT[String(problem)] ??
      'editor.apiErrors.codes.break-glass-not-usable'
    );
  }

  private async search(query: string): Promise<void> {
    const run = ++this.searches;
    this.searching.set(true);
    this.searchFailed.set(false);
    try {
      const doc = await firstValueFrom(
        this.api.get('/users', {
          query: {
            'filter[status]': 'active',
            ...(query ? { 'filter[q]': query } : {}),
            ...pageQuery({ number: 1, size: PEOPLE_SHOWN }),
          },
        }),
      );
      if (run !== this.searches) return;
      this.people.set(doc.data);
      this.more.set(doc.meta.page.total > doc.data.length);
    } catch {
      if (run === this.searches) this.searchFailed.set(true);
    } finally {
      if (run === this.searches) this.searching.set(false);
    }
  }

  private async readPerson(id: string): Promise<void> {
    try {
      const doc = await firstValueFrom(
        this.api.get('/users/{userId}', { path: { userId: id } }),
      );
      if (this.accountId() === id) this.person.set(doc.data);
    } catch {
      if (this.accountId() === id) this.personFailed.set(true);
    }
  }
}
