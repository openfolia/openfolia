import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
} from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideBellOff,
  lucideMailX,
  lucideTriangleAlert,
} from '@ng-icons/lucide';

import {
  injectTranslate,
  LanguageService,
  translated,
} from '@openfolia/ui/i18n';
import { ZardSelectImports } from '@openfolia/ui/select';
import { PageHeaderComponent } from '@openfolia/ui/shell';
import {
  ErrorStateComponent,
  SaveStatusComponent,
  SkeletonRowsComponent,
  type SaveStatus,
} from '@openfolia/ui/states';
import { ZardSwitchComponent } from '@openfolia/ui/switch';
import { ToastService } from '@openfolia/ui/toast';

import { toApiError, type ApiError, type Schema } from '../api';
import { apiErrorText } from '../i18n';
import {
  DELIVERY_CHOICES,
  hourLabel,
  CHOICE_LABELS,
  EMAIL_OFF_TEXTS,
  GROUP_TEXTS,
  KIND_GROUPS,
  KIND_TEXTS,
  missedAlerts,
  timeZones,
  type ChosenKind,
  type DeliveryChoice,
  type NotificationSettings,
} from './notification-settings-model';
import { NotificationSettingsService } from './notification-settings.service';

type Preferences = Schema<'PreferencesResource'>;
type Changes = NonNullable<
  Schema<'UpdatePreferencesDocument'>['data']['attributes']['notifications']
>;

const HOURS = Array.from({ length: 24 }, (_, h) => h);

/**
 * Account menu › Notifications (#884): how each kind of notification reaches the person (off, the
 * bell only, the bell and an email at once, the bell and the daily summary), by group; "Pause all
 * email" and "Turn off all notifications"; the summary's hour and time zone. Each change is sent
 * at once and shows as saved; a refused one goes back and says why. When no email can reach the
 * person, it says why (the server sends none, or they have no address); an admin alert turned off
 * says what they will miss. Only the person's own: nobody changes another's.
 */
@Component({
  selector: 'of-notification-settings-page',
  imports: [
    PageHeaderComponent,
    ErrorStateComponent,
    SkeletonRowsComponent,
    SaveStatusComponent,
    ZardSwitchComponent,
    ZardSelectImports,
    NgIcon,
    TranslocoPipe,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [
    provideIcons({ lucideBellOff, lucideMailX, lucideTriangleAlert }),
  ],
  host: {
    class: 'flex min-w-0 flex-col gap-4',
    'data-testid': 'notification-settings-page',
  },
  template: `
    <of-page-header [title]="'editor.notificationSettings.title' | transloco">
      @if (saveStatus(); as status) {
        <of-save-status
          ofTitleAside
          data-slot="settings-save-status"
          [status]="status"
          [detail]="
            status === 'not-saved'
              ? ('editor.notificationSettings.notSaved' | transloco)
              : ''
          "
        />
      }
    </of-page-header>
    <p class="text-muted-foreground m-0 max-w-[65ch] text-sm break-words">
      {{ 'editor.notificationSettings.lead' | transloco }}
    </p>

    @if (loadError(); as e) {
      <div class="rounded-xl border">
        <of-error-state
          [kind]="e.kind"
          [heading]="'editor.notificationSettings.loadFailed' | transloco"
          [message]="e.message"
          (retry)="load()"
        />
      </div>
    } @else if (settings(); as s) {
      <div class="of-settings-fade flex min-w-0 flex-col gap-4">
        @if (emailUnavailable(); as why) {
          <div
            role="status"
            class="bg-muted/40 flex min-w-0 items-start gap-3 rounded-xl border p-4 text-sm"
            data-slot="email-unavailable"
            [attr.data-reason]="why"
          >
            <ng-icon
              name="lucideMailX"
              aria-hidden="true"
              class="text-muted-foreground mt-0.5 size-4 shrink-0"
            />
            <div class="flex min-w-0 flex-col gap-1">
              <p class="m-0 font-medium break-words">
                {{ 'editor.notificationSettings.emailOff.title' | transloco }}
              </p>
              <p class="text-muted-foreground m-0 max-w-[65ch] break-words">
                {{ emailOffTexts[why] | transloco }}
              </p>
            </div>
          </div>
        }

        <section
          class="bg-card flex min-w-0 flex-col rounded-xl border"
          aria-labelledby="notif-everything"
          data-slot="switches"
        >
          <h2
            id="notif-everything"
            class="m-0 px-4 pt-4 pb-1 text-base font-semibold"
          >
            {{ 'editor.notificationSettings.everything' | transloco }}
          </h2>
          <div class="flex min-w-0 items-start justify-between gap-4 px-4 py-3">
            <div class="flex min-w-0 flex-col gap-0.5">
              <label
                class="text-sm font-medium break-words"
                for="notif-pause-email"
                >{{
                  'editor.notificationSettings.pauseEmail.label' | transloco
                }}</label
              >
              <p class="text-muted-foreground m-0 text-sm break-words">
                {{ 'editor.notificationSettings.pauseEmail.text' | transloco }}
              </p>
            </div>
            <!-- A class on the switch would also go to its track. -->
            <div class="shrink-0 pt-px">
              <z-switch
                zId="notif-pause-email"
                data-slot="pause-email"
                [zChecked]="s.emailPaused"
                [zDisabled]="s.allOff"
                (zCheckedChange)="change({ emailPaused: $event })"
                ><!-- Named by the visible label above (for=). --><span
                ></span
              ></z-switch>
            </div>
          </div>
          <div
            class="flex min-w-0 items-start justify-between gap-4 border-t px-4 py-3"
          >
            <div class="flex min-w-0 flex-col gap-0.5">
              <label
                class="text-sm font-medium break-words"
                for="notif-all-off"
                >{{
                  'editor.notificationSettings.allOff.label' | transloco
                }}</label
              >
              <p class="text-muted-foreground m-0 text-sm break-words">
                {{ 'editor.notificationSettings.allOff.text' | transloco }}
              </p>
            </div>
            <!-- A class on the switch would also go to its track. -->
            <div class="shrink-0 pt-px">
              <z-switch
                zId="notif-all-off"
                data-slot="all-off"
                [zChecked]="s.allOff"
                (zCheckedChange)="change({ allOff: $event })"
                ><!-- Named by the visible label above (for=). --><span
                ></span
              ></z-switch>
            </div>
          </div>
          @if (s.allOff) {
            <p
              role="status"
              class="border-warning bg-warning-muted of-settings-fade m-4 mt-1 flex min-w-0 items-start gap-2 rounded-lg border p-3 text-sm"
              data-slot="all-off-note"
            >
              <ng-icon
                name="lucideBellOff"
                aria-hidden="true"
                class="text-warning mt-0.5 shrink-0"
              />
              <span class="min-w-0 break-words">{{
                'editor.notificationSettings.allOff.note' | transloco
              }}</span>
            </p>
          }
        </section>

        @for (group of groups; track group.id) {
          <section
            class="bg-card @container flex min-w-0 flex-col rounded-xl border transition-opacity duration-200 motion-reduce:transition-none"
            [class.opacity-60]="s.allOff"
            [attr.aria-labelledby]="'notif-group-' + group.id"
            [attr.data-group]="group.id"
          >
            <div class="flex min-w-0 flex-col gap-0.5 px-4 pt-4 pb-1">
              <h2
                [id]="'notif-group-' + group.id"
                class="m-0 text-base font-semibold break-words"
              >
                {{ groupTexts[group.id].title | transloco }}
              </h2>
              <p class="text-muted-foreground m-0 text-sm break-words">
                {{ groupTexts[group.id].text | transloco }}
              </p>
            </div>
            <ul class="m-0 flex min-w-0 list-none flex-col p-0">
              @for (kind of group.kinds; track kind; let first = $first) {
                <li
                  class="grid min-w-0 gap-2 px-4 py-3 @xl:grid-cols-[minmax(0,1fr)_18rem] @xl:items-center @xl:gap-4"
                  [class.border-t]="!first"
                  [attr.data-kind]="kind"
                >
                  <div class="flex min-w-0 flex-col gap-0.5">
                    <span
                      class="text-sm font-medium break-words"
                      [id]="'notif-kind-' + kind"
                      >{{ kindTexts[kind].label | transloco }}</span
                    >
                    <span class="text-muted-foreground text-sm break-words">{{
                      kindTexts[kind].text | transloco
                    }}</span>
                  </div>
                  <z-select
                    zPosition="popper"
                    class="w-full min-w-0"
                    data-slot="kind-choice"
                    [zAriaLabel]="kindTexts[kind].label | transloco"
                    [zDisabled]="s.allOff"
                    [zValue]="s.choices[kind]"
                    (zSelectionChange)="choose(kind, $event)"
                  >
                    @for (choice of choices; track choice) {
                      <z-select-item [zValue]="choice">{{
                        choiceLabels[choice] | transloco
                      }}</z-select-item>
                    }
                  </z-select>
                </li>
              }
            </ul>
            @if (group.id === 'admin' && missed().length > 0) {
              <div
                role="status"
                class="border-warning bg-warning-muted of-settings-fade m-4 mt-1 flex min-w-0 items-start gap-2 rounded-lg border p-3 text-sm"
                data-slot="admin-missed"
              >
                <ng-icon
                  name="lucideTriangleAlert"
                  aria-hidden="true"
                  class="text-warning mt-0.5 shrink-0"
                />
                <div class="flex min-w-0 flex-col gap-1">
                  <p class="m-0 font-medium break-words">
                    {{
                      'editor.notificationSettings.adminMissed.title'
                        | transloco
                    }}
                  </p>
                  <ul class="m-0 flex list-disc flex-col gap-0.5 ps-5">
                    @for (kind of missed(); track kind) {
                      <li class="break-words">
                        {{ kindTexts[kind].missed ?? '' | transloco }}
                      </li>
                    }
                  </ul>
                </div>
              </div>
            }
          </section>
        }

        <section
          class="bg-card flex min-w-0 flex-col gap-3 rounded-xl border p-4 transition-opacity duration-200 motion-reduce:transition-none"
          [class.opacity-60]="s.allOff"
          aria-labelledby="notif-digest"
          data-slot="digest"
        >
          <div class="flex min-w-0 flex-col gap-0.5">
            <h2 id="notif-digest" class="m-0 text-base font-semibold">
              {{ 'editor.notificationSettings.digest.title' | transloco }}
            </h2>
            <p class="text-muted-foreground m-0 text-sm break-words">
              {{
                'editor.notificationSettings.digest.text'
                  | transloco: { hour: digestTime(), zone: zone() }
              }}
            </p>
          </div>
          <div class="grid min-w-0 gap-3 sm:grid-cols-[12rem_minmax(0,1fr)]">
            <div class="flex min-w-0 flex-col gap-1.5">
              <span
                class="text-muted-foreground text-xs"
                id="notif-digest-hour"
                >{{
                  'editor.notificationSettings.digest.hour' | transloco
                }}</span
              >
              <z-select
                zPosition="popper"
                class="w-full min-w-0"
                data-slot="digest-hour"
                [zAriaLabel]="
                  'editor.notificationSettings.digest.hour' | transloco
                "
                [zDisabled]="s.allOff"
                [zValue]="'' + hour()"
                (zSelectionChange)="change({ digestHour: +$event })"
              >
                @for (h of hours; track h) {
                  <z-select-item [zValue]="'' + h">{{
                    label(h)
                  }}</z-select-item>
                }
              </z-select>
            </div>
            <div class="flex min-w-0 flex-col gap-1.5">
              <span class="text-muted-foreground text-xs">{{
                'editor.notificationSettings.digest.zone' | transloco
              }}</span>
              <z-select
                zPosition="popper"
                zSearchable
                class="w-full min-w-0"
                data-slot="digest-zone"
                [zAriaLabel]="
                  'editor.notificationSettings.digest.zone' | transloco
                "
                [zDisabled]="s.allOff"
                [zValue]="zone()"
                (zSelectionChange)="change({ timeZone: '' + $event })"
              >
                @for (z of zones(); track z) {
                  <z-select-item [zValue]="z">{{ z }}</z-select-item>
                }
              </z-select>
            </div>
          </div>
        </section>
      </div>
    } @else {
      <div class="rounded-xl border p-4">
        <of-skeleton-rows
          [count]="6"
          [label]="'editor.notificationSettings.loading' | transloco"
        />
      </div>
    }
  `,
  styles: `
    .of-settings-fade {
      animation: of-settings-fade 160ms ease-out;
    }
    @keyframes of-settings-fade {
      from {
        opacity: 0;
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .of-settings-fade {
        animation: none;
      }
    }
  `,
})
export class NotificationSettingsPage {
  private readonly service = inject(NotificationSettingsService);
  private readonly toast = inject(ToastService);
  private readonly language = inject(LanguageService);
  private readonly t = injectTranslate();

  protected readonly groups = KIND_GROUPS;
  protected readonly choices = DELIVERY_CHOICES;
  protected readonly hours = HOURS;
  protected readonly kindTexts = KIND_TEXTS;
  protected readonly groupTexts = GROUP_TEXTS;
  protected readonly choiceLabels = CHOICE_LABELS;
  protected readonly emailOffTexts = EMAIL_OFF_TEXTS;

  private readonly prefs = signal<Preferences | null>(null);
  private readonly loadFailure = signal<ApiError | null>(null);
  protected readonly saveStatus = signal<SaveStatus | null>(null);
  /** Changes go out one after another, so the last one made is the last one the server keeps. */
  private queue: Promise<unknown> = Promise.resolve();
  private pending = 0;

  protected readonly settings = computed<NotificationSettings | null>(
    () => this.prefs()?.attributes.notifications ?? null,
  );
  protected readonly emailUnavailable = computed(
    () => this.prefs()?.meta.notifications.emailUnavailable ?? null,
  );
  protected readonly missed = computed(() => {
    const s = this.settings();
    return s ? missedAlerts(s) : [];
  });
  protected readonly hour = computed(
    () =>
      this.settings()?.digestHour ??
      this.prefs()?.meta.notifications.defaultDigestHour ??
      8,
  );
  protected readonly zone = computed(() => this.settings()?.timeZone ?? 'UTC');
  protected readonly zones = computed(() => timeZones(this.zone()));
  protected readonly digestTime = computed(() => this.label(this.hour()));

  protected readonly loadError = computed(() => {
    const failure = this.loadFailure();
    if (!failure) return null;
    const text = apiErrorText(failure);
    return { kind: failure.kind, message: this.t(text.key, text.params) };
  });

  constructor() {
    void this.load();
  }

  async load(): Promise<void> {
    this.loadFailure.set(null);
    this.prefs.set(null);
    try {
      this.prefs.set(await this.service.load());
    } catch (error) {
      this.loadFailure.set(toApiError(error));
    }
  }

  protected label(hour: number): string {
    return hourLabel(hour, this.language.active());
  }

  protected choose(kind: ChosenKind, value: string | string[]): void {
    const choice = value as DeliveryChoice;
    if (!DELIVERY_CHOICES.includes(choice)) return;
    if (this.settings()?.choices[kind] === choice) return;
    this.change({ choices: { [kind]: choice } });
  }

  /** Shows `changes` at once and sends them after the ones before; a refusal puts back what the server has. */
  protected change(changes: Changes): void {
    const current = this.prefs();
    if (!current) return;
    const n = current.attributes.notifications;
    this.prefs.set({
      ...current,
      attributes: {
        ...current.attributes,
        notifications: {
          ...n,
          ...changes,
          choices: { ...n.choices, ...changes.choices },
        } as NotificationSettings,
      },
    });
    this.pending++;
    this.saveStatus.set('saving');
    this.queue = this.queue.then(async () => {
      try {
        const saved = await this.service.change(changes);
        this.pending--;
        if (this.pending === 0) {
          this.prefs.set(saved);
          this.saveStatus.set('saved');
        }
      } catch (error) {
        this.pending--;
        const text = apiErrorText(toApiError(error));
        this.toast.error(translated(text.key, text.params));
        this.saveStatus.set(this.pending > 0 ? 'saving' : 'not-saved');
        // What the server holds now: the refused change goes back. Changes still queued after
        // it show on until they are answered; the last answer sets the page.
        if (this.pending > 0) return;
        try {
          const read = await this.service.load();
          if (this.pending === 0) this.prefs.set(read);
        } catch {
          if (this.pending === 0) this.prefs.set(current);
        }
      }
    });
  }
}
