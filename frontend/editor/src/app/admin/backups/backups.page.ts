import {
  afterRenderEffect,
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
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
  lucideCircleCheck,
  lucideCircleX,
  lucideDatabaseBackup,
  lucideKeyRound,
  lucidePlugZap,
  lucideTriangleAlert,
} from '@ng-icons/lucide';
import { firstValueFrom } from 'rxjs';

import { formatFileSize } from '@openfolia/content-model/core';
import { ZardAlertDialogService } from '@openfolia/ui/alert-dialog';
import { ZardBadgeComponent } from '@openfolia/ui/badge';
import { ZardButtonComponent } from '@openfolia/ui/button';
import { CollapseComponent } from '@openfolia/ui/collapse';
import {
  DatePipe,
  injectTranslate,
  LanguageService,
  translated,
  type TranslatedText,
} from '@openfolia/ui/i18n';
import { ZardInputComponent } from '@openfolia/ui/input';
import {
  ListFrameComponent,
  ListItemDirective,
  ListTableDirective,
} from '@openfolia/ui/list-frame';
import {
  SegmentedComponent,
  type SegmentedOption,
} from '@openfolia/ui/segmented';
import { ZardSelectImports } from '@openfolia/ui/select';
import { ZardSkeletonComponent } from '@openfolia/ui/skeleton';
import { ErrorStateComponent } from '@openfolia/ui/states';
import { ZardSwitchComponent } from '@openfolia/ui/switch';
import { ZardTableImports } from '@openfolia/ui/table';
import { ToastService } from '@openfolia/ui/toast';

import {
  ApiClient,
  pageQuery,
  toApiError,
  type ApiError,
  type Response,
} from '../../api';
import { apiErrorText } from '../../i18n';
import { injectQueryState, intParam } from '../../view-state';
import {
  BackupKeyDialogComponent,
  type ShownBackupKey,
} from './backup-key-dialog.component';
import {
  backupErrorText,
  type BackupRequestItem,
  type BackupRunItem,
  type BackupSettingsResource,
  type BackupStatusMeta,
  changesOf,
  draftOf,
  rebaseDraft,
  durationOf,
  EMPTY_DRAFT,
  fieldOfError,
  fixedVariable,
  formatDuration,
  type FrequencyKind,
  type LocationKind,
  REQUEST_POLL_MS,
  RUN_ERRORS,
  RUN_PAGE_SIZES,
  type SettingsDraft,
  statusSummary,
  timeZones,
  WEEKDAYS,
  weekdayName,
} from './backups-model';
import { SandboxOffStateComponent } from '../../sandbox/sandbox-off-state.component';
import { SandboxSession } from '../../sandbox/sandbox-session';

type RunsDoc = Response<'/backup-runs'>;

/** What a finished or waiting request says, per kind and state. */
const OUTCOME_KEYS: Readonly<
  Record<RequestKind, Readonly<Record<RequestOutcome['state'], string>>>
> = {
  run: {
    waiting: 'editor.admin.backups.outcome.run.waiting',
    done: 'editor.admin.backups.outcome.run.done',
    failed: 'editor.admin.backups.outcome.run.failed',
  },
  'test-location': {
    waiting: 'editor.admin.backups.outcome.test.waiting',
    done: 'editor.admin.backups.outcome.test.done',
    failed: 'editor.admin.backups.outcome.test.failed',
  },
};

/** How a run was started, in words. */
const TRIGGER_KEYS: Readonly<
  Record<BackupRunItem['attributes']['trigger'], string>
> = {
  schedule: 'editor.admin.backups.history.trigger.schedule',
  manual: 'editor.admin.backups.history.trigger.manual',
  command: 'editor.admin.backups.history.trigger.command',
};
type RequestKind = BackupRequestItem['attributes']['kind'];

/** Space kept below the history's frame: the page's bottom padding. */
const BELOW_FRAME_PX = 32;

/** A request's outcome, shown beside its button until the next one. */
interface RequestOutcome {
  readonly kind: RequestKind;
  readonly state: 'waiting' | 'done' | 'failed';
  readonly detail: string | null;
}

/**
 * The Backups tab of Admin (#529, `admin.backups`): how the last backup went; the backup key (made
 * here and shown once, rotated on purpose, each backup naming its key by fingerprint); the
 * settings (on or off, the schedule with its next three runs, the time zone, the retention, the
 * location: a subfolder of the backup volume or an S3 bucket whose secret is write-only, and the
 * check); "Test location" and "Back up now", which the backup service answers; and the history,
 * paged in its own scroller. A setting the backup service's environment fixes shows read-only,
 * naming its variable. Saving sends only what changed (`PATCH /backup-settings`); a refusal says
 * why under its field.
 */
@Component({
  selector: 'of-backups-page',
  imports: [
    SandboxOffStateComponent,
    TranslocoPipe,
    NgIcon,
    DatePipe,
    BackupKeyDialogComponent,
    CollapseComponent,
    ErrorStateComponent,
    ListFrameComponent,
    ListItemDirective,
    ListTableDirective,
    SegmentedComponent,
    ZardBadgeComponent,
    ZardButtonComponent,
    ZardInputComponent,
    ZardSelectImports,
    ZardSkeletonComponent,
    ZardSwitchComponent,
    ZardTableImports,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [
    provideIcons({
      lucideCircleCheck,
      lucideCircleX,
      lucideDatabaseBackup,
      lucideKeyRound,
      lucidePlugZap,
      lucideTriangleAlert,
    }),
  ],
  host: { class: 'flex min-w-0 flex-col gap-4' },
  template: `
    @if (sandbox.on()) {
      <!-- A public sandbox sends nothing out and keeps nothing (issue 826): the screen says why. -->
      <of-sandbox-off-state
        [title]="'editor.sandbox.backupsOff.title' | transloco"
        [description]="'editor.sandbox.backupsOff.description' | transloco"
      />
    } @else {
      @if (loadError(); as e) {
        <of-error-state
          [kind]="e.kind"
          [heading]="'editor.admin.backups.loadFailed' | transloco"
          [message]="e.message"
          (retry)="load()"
        />
      } @else if (!saved()) {
        <div class="flex flex-col gap-4" data-slot="backups-loading">
          <div class="grid gap-4 lg:grid-cols-2">
            <z-skeleton class="h-32 w-full rounded-xl" />
            <z-skeleton class="h-32 w-full rounded-xl" />
          </div>
          <z-skeleton class="h-96 w-full rounded-xl" />
        </div>
      } @else {
        @let s = saved()!;
        <div class="grid min-w-0 gap-4 lg:grid-cols-2 lg:items-stretch">
          <section
            class="bg-card flex min-w-0 flex-col gap-3 rounded-xl border p-4"
            data-slot="backup-status"
            [attr.data-tone]="summary()?.tone ?? null"
            aria-labelledby="backup-status-heading"
          >
            <h2 id="backup-status-heading" class="m-0 text-base font-semibold">
              {{ 'editor.admin.backups.status.heading' | transloco }}
            </h2>
            @if (summary(); as sum) {
              <div class="flex min-w-0 items-start gap-3">
                <ng-icon
                  aria-hidden="true"
                  class="mt-0.5 shrink-0"
                  [name]="
                    sum.tone === 'ok'
                      ? 'lucideCircleCheck'
                      : sum.tone === 'destructive'
                        ? 'lucideCircleX'
                        : 'lucideTriangleAlert'
                  "
                  [class.text-success]="sum.tone === 'ok'"
                  [class.text-warning]="sum.tone === 'warning'"
                  [class.text-destructive]="sum.tone === 'destructive'"
                  [class.text-muted-foreground]="sum.tone === 'muted'"
                />
                <div class="flex min-w-0 flex-col gap-1">
                  <p
                    class="m-0 font-medium break-words"
                    data-slot="backup-status-title"
                  >
                    {{ sum.title.key | transloco: sum.title.params }}
                  </p>
                  @if (sum.detail; as d) {
                    <p class="text-muted-foreground m-0 text-sm break-words">
                      {{ d.key | transloco: d.params }}
                    </p>
                  }
                </div>
              </div>
            } @else {
              <z-skeleton class="h-10 w-full" />
            }
            <p
              class="text-muted-foreground m-0 text-xs break-words"
              data-slot="backup-service"
              [attr.data-running]="s.meta.service.running"
            >
              @if (s.meta.service.running) {
                {{ 'editor.admin.backups.service.running' | transloco }}
              } @else {
                {{ 'editor.admin.backups.service.notRunning' | transloco }}
              }
            </p>
          </section>

          <section
            class="bg-card flex min-w-0 flex-col gap-3 rounded-xl border p-4"
            data-slot="backup-key-card"
            aria-labelledby="backup-key-heading"
          >
            <h2
              id="backup-key-heading"
              class="m-0 flex items-center gap-2 text-base font-semibold"
            >
              <ng-icon name="lucideKeyRound" aria-hidden="true" />
              {{ 'editor.admin.backups.key.heading' | transloco }}
            </h2>
            @if (s.meta.key; as k) {
              <dl class="m-0 flex min-w-0 flex-col gap-2 text-sm">
                <div class="min-w-0">
                  <dt class="text-muted-foreground text-xs">
                    {{ 'editor.admin.backups.key.fingerprint' | transloco }}
                  </dt>
                  <dd
                    class="m-0 font-mono text-[0.8125rem] [overflow-wrap:anywhere]"
                    data-slot="backup-key-fingerprint"
                  >
                    {{ k.fingerprint }}
                  </dd>
                </div>
                @if (k.createdAt) {
                  <div class="min-w-0">
                    <dt class="text-muted-foreground text-xs">
                      {{ 'editor.admin.backups.key.created' | transloco }}
                    </dt>
                    <dd class="m-0">{{ k.createdAt | ofDate: dateFormat }}</dd>
                  </div>
                }
              </dl>
              @if (k.fixedBy; as variable) {
                <p class="text-muted-foreground m-0 text-xs break-words">
                  {{ 'editor.admin.backups.fixedBy' | transloco: { variable } }}
                </p>
              } @else {
                <p class="text-muted-foreground m-0 text-xs break-words">
                  {{ 'editor.admin.backups.key.rotateHint' | transloco }}
                </p>
                <button
                  z-button
                  zType="outline"
                  type="button"
                  class="w-fit"
                  data-slot="backup-key-rotate"
                  [zDisabled]="makingKey()"
                  (click)="confirmRotate()"
                >
                  {{ 'editor.admin.backups.key.rotate' | transloco }}
                </button>
              }
            } @else {
              <p class="text-muted-foreground m-0 text-sm break-words">
                {{ 'editor.admin.backups.key.none' | transloco }}
              </p>
              <button
                z-button
                type="button"
                class="w-fit"
                data-slot="backup-key-create"
                [zDisabled]="makingKey()"
                (click)="makeKey(false)"
              >
                {{ 'editor.admin.backups.key.create' | transloco }}
              </button>
            }
          </section>
        </div>

        <form
          class="bg-card flex min-w-0 flex-col gap-5 rounded-xl border p-4"
          data-slot="backup-settings"
          aria-labelledby="backup-settings-heading"
          (submit)="save($event)"
        >
          <div
            class="flex min-w-0 flex-wrap items-center justify-between gap-3"
          >
            <h2
              id="backup-settings-heading"
              class="m-0 text-base font-semibold"
            >
              {{ 'editor.admin.backups.settings.heading' | transloco }}
            </h2>
            <z-switch
              class="text-sm"
              data-slot="backup-enabled"
              [zChecked]="draft().enabled"
              [zDisabled]="!!fixedOf('enabled')"
              (zCheckedChange)="set({ enabled: $event })"
              >{{
                'editor.admin.backups.settings.enabled' | transloco
              }}</z-switch
            >
          </div>
          @if (fixedOf('enabled'); as variable) {
            <p class="text-muted-foreground -mt-3 m-0 text-xs break-words">
              {{ 'editor.admin.backups.fixedBy' | transloco: { variable } }}
            </p>
          }

          <fieldset
            class="m-0 flex min-w-0 flex-col gap-3 border-0 p-0"
            data-slot="backup-schedule"
            [disabled]="!!fixedOf('frequency')"
          >
            <legend class="mb-2 p-0 text-sm font-medium">
              {{ 'editor.admin.backups.settings.schedule' | transloco }}
            </legend>
            @if (fixedOf('frequency'); as variable) {
              <p class="text-muted-foreground m-0 text-xs break-words">
                {{ 'editor.admin.backups.fixedBy' | transloco: { variable } }}
                <code class="font-mono">{{ s.meta.schedule }}</code>
              </p>
            } @else {
              <of-segmented
                data-slot="backup-frequency"
                [options]="frequencyOptions()"
                [label]="'editor.admin.backups.settings.frequency' | transloco"
                [value]="draft().frequency"
                (valueChange)="set({ frequency: asFrequency($event) })"
              />
              <div class="flex min-w-0 flex-wrap items-end gap-3">
                @switch (draft().frequency) {
                  @case ('weekly') {
                    <div class="flex min-w-0 flex-col gap-1.5">
                      <span class="text-sm" id="backup-weekday-label">{{
                        'editor.admin.backups.settings.weekday' | transloco
                      }}</span>
                      <z-select
                        class="w-48"
                        zPosition="popper"
                        data-slot="backup-weekday"
                        [zAriaLabel]="
                          'editor.admin.backups.settings.weekday' | transloco
                        "
                        [zValue]="'' + draft().weekday"
                        (zSelectionChange)="set({ weekday: +$event })"
                      >
                        @for (day of weekdays; track day) {
                          <z-select-item [zValue]="'' + day">{{
                            dayName(day)
                          }}</z-select-item>
                        }
                      </z-select>
                    </div>
                  }
                  @case ('hours') {
                    <div class="flex min-w-0 flex-col gap-1.5">
                      <label class="text-sm" for="backup-every">{{
                        'editor.admin.backups.settings.every' | transloco
                      }}</label>
                      <input
                        z-input
                        id="backup-every"
                        type="number"
                        min="1"
                        max="23"
                        class="w-28"
                        [value]="draft().every"
                        [attr.aria-invalid]="!!errors()['every']"
                        (input)="set({ every: number($event) })"
                      />
                    </div>
                  }
                  @case ('cron') {
                    <div class="flex min-w-0 flex-1 flex-col gap-1.5">
                      <label class="text-sm" for="backup-cron">{{
                        'editor.admin.backups.settings.cron' | transloco
                      }}</label>
                      <input
                        z-input
                        id="backup-cron"
                        class="max-w-80 font-mono"
                        spellcheck="false"
                        autocomplete="off"
                        placeholder="0 2 * * *"
                        [value]="draft().expression"
                        [attr.aria-invalid]="!!errors()['expression']"
                        (input)="set({ expression: text($event) })"
                      />
                      <span class="text-muted-foreground text-xs break-words">{{
                        'editor.admin.backups.settings.cronHint' | transloco
                      }}</span>
                    </div>
                  }
                }
                @if (draft().frequency !== 'cron') {
                  <div class="flex min-w-0 flex-col gap-1.5">
                    <label class="text-sm" for="backup-time">{{
                      (draft().frequency === 'hours'
                        ? 'editor.admin.backups.settings.from'
                        : 'editor.admin.backups.settings.time'
                      ) | transloco
                    }}</label>
                    <input
                      z-input
                      id="backup-time"
                      type="time"
                      class="w-32"
                      [value]="draft().time"
                      [attr.aria-invalid]="!!errors()['time']"
                      (input)="set({ time: text($event) })"
                    />
                  </div>
                }
              </div>
              @for (field of scheduleFields; track field) {
                @if (errors()[field]; as message) {
                  <p
                    class="text-destructive m-0 text-xs break-words"
                    role="alert"
                  >
                    {{ message }}
                  </p>
                }
              }
            }
            <div class="flex min-w-0 flex-col gap-1.5">
              <label class="text-sm" for="backup-time-zone">{{
                'editor.admin.backups.settings.timeZone' | transloco
              }}</label>
              <input
                z-input
                id="backup-time-zone"
                class="max-w-80"
                list="backup-time-zones"
                autocomplete="off"
                spellcheck="false"
                [disabled]="!!fixedOf('timeZone')"
                [value]="draft().timeZone"
                [attr.aria-invalid]="!!errors()['timeZone']"
                (input)="set({ timeZone: text($event) })"
              />
              <datalist id="backup-time-zones">
                @for (zone of zones; track zone) {
                  <option [value]="zone"></option>
                }
              </datalist>
              @if (fixedOf('timeZone'); as variable) {
                <span class="text-muted-foreground text-xs break-words">{{
                  'editor.admin.backups.fixedBy' | transloco: { variable }
                }}</span>
              }
              @if (errors()['timeZone']; as message) {
                <span
                  class="text-destructive text-xs break-words"
                  role="alert"
                  >{{ message }}</span
                >
              }
            </div>
            <div class="min-w-0" data-slot="backup-next-runs">
              <p class="text-muted-foreground m-0 text-xs">
                {{ 'editor.admin.backups.settings.nextRuns' | transloco }}
              </p>
              @if (!s.attributes.enabled) {
                <p class="m-0 text-sm">
                  {{ 'editor.admin.backups.settings.off' | transloco }}
                </p>
              } @else {
                <ul
                  class="m-0 flex list-none flex-wrap gap-x-4 gap-y-1 p-0 text-sm"
                >
                  @for (at of s.meta.nextRuns; track at) {
                    <li class="tabular-nums">
                      <time [attr.datetime]="at">{{
                        at | ofDate: dateFormat
                      }}</time>
                    </li>
                  }
                </ul>
              }
              @if (dirty()) {
                <p class="text-muted-foreground m-0 text-xs break-words">
                  {{
                    'editor.admin.backups.settings.nextRunsAfterSave'
                      | transloco
                  }}
                </p>
              }
            </div>
          </fieldset>

          <fieldset
            class="m-0 flex min-w-0 flex-col gap-3 border-0 p-0"
            data-slot="backup-retention"
          >
            <legend class="mb-2 p-0 text-sm font-medium">
              {{ 'editor.admin.backups.settings.retention' | transloco }}
            </legend>
            <div class="flex min-w-0 flex-wrap gap-3">
              @for (r of retentionFields; track r.field) {
                <div class="flex min-w-0 flex-col gap-1.5">
                  <label class="text-sm" [for]="'backup-keep-' + r.field">{{
                    r.label | transloco
                  }}</label>
                  <input
                    z-input
                    type="number"
                    min="0"
                    class="w-28"
                    [id]="'backup-keep-' + r.field"
                    [attr.data-slot]="'backup-keep-' + r.field"
                    [disabled]="!!fixedOf(r.field)"
                    [value]="draft()[r.field]"
                    [attr.aria-invalid]="!!errors()[r.field]"
                    (input)="setRetention(r.field, $event)"
                  />
                  @if (fixedOf(r.field); as variable) {
                    <span
                      class="text-muted-foreground max-w-40 text-xs break-words"
                      >{{
                        'editor.admin.backups.fixedBy' | transloco: { variable }
                      }}</span
                    >
                  }
                </div>
              }
            </div>
            <p class="text-muted-foreground m-0 text-xs break-words">
              {{ 'editor.admin.backups.settings.retentionHint' | transloco }}
            </p>
          </fieldset>

          <fieldset
            class="m-0 flex min-w-0 flex-col gap-3 border-0 p-0"
            data-slot="backup-location"
            [disabled]="!!fixedOf('location')"
          >
            <legend class="mb-2 p-0 text-sm font-medium">
              {{ 'editor.admin.backups.settings.location' | transloco }}
            </legend>
            @if (fixedOf('location'); as variable) {
              <p class="text-muted-foreground m-0 text-xs break-words">
                {{ 'editor.admin.backups.fixedBy' | transloco: { variable } }}
              </p>
            }
            <of-segmented
              data-slot="backup-location-kind"
              [options]="locationOptions()"
              [label]="'editor.admin.backups.settings.location' | transloco"
              [value]="draft().location"
              (valueChange)="set({ location: asLocation($event) })"
            />
            @if (draft().location === 'local') {
              <div class="flex min-w-0 flex-col gap-1.5">
                <label class="text-sm" for="backup-subfolder">{{
                  'editor.admin.backups.settings.subfolder' | transloco
                }}</label>
                <input
                  z-input
                  id="backup-subfolder"
                  class="max-w-96 font-mono"
                  spellcheck="false"
                  autocomplete="off"
                  [value]="draft().subfolder"
                  [attr.aria-invalid]="!!errors()['subfolder']"
                  (input)="set({ subfolder: text($event) })"
                />
                <span class="text-muted-foreground text-xs break-words">{{
                  'editor.admin.backups.settings.subfolderHint' | transloco
                }}</span>
                @if (errors()['subfolder']; as message) {
                  <span
                    class="text-destructive text-xs break-words"
                    role="alert"
                    data-slot="backup-subfolder-error"
                    >{{ message }}</span
                  >
                }
              </div>
            } @else {
              <div class="grid min-w-0 gap-3 sm:grid-cols-2">
                @for (f of s3Fields; track f.field) {
                  <div class="flex min-w-0 flex-col gap-1.5">
                    <label class="text-sm" [for]="'backup-s3-' + f.field">{{
                      f.label | transloco
                    }}</label>
                    <input
                      z-input
                      spellcheck="false"
                      autocomplete="off"
                      [id]="'backup-s3-' + f.field"
                      [attr.data-slot]="'backup-s3-' + f.field"
                      [placeholder]="f.placeholder"
                      [value]="draft()[f.field]"
                      [attr.aria-invalid]="!!errors()[f.field]"
                      (input)="setText(f.field, $event)"
                    />
                    @if (errors()[f.field]; as message) {
                      <span
                        class="text-destructive text-xs break-words"
                        role="alert"
                        >{{ message }}</span
                      >
                    }
                  </div>
                }
              </div>
              <div
                class="flex min-w-0 flex-col gap-1.5"
                data-slot="backup-s3-secret"
              >
                <span class="text-sm" id="backup-s3-secret-label">{{
                  'editor.admin.backups.settings.secret' | transloco
                }}</span>
                @if (secretShown() === 'set') {
                  <div class="flex min-w-0 flex-wrap items-center gap-2">
                    <z-badge
                      zType="secondary"
                      data-slot="backup-s3-secret-set"
                      >{{
                        'editor.admin.backups.settings.secretSet' | transloco
                      }}</z-badge
                    >
                    <button
                      z-button
                      zType="outline"
                      zSize="sm"
                      type="button"
                      data-slot="backup-s3-secret-replace"
                      (click)="set({ secret: { kind: 'replace', value: '' } })"
                    >
                      {{
                        'editor.admin.backups.settings.secretReplace'
                          | transloco
                      }}
                    </button>
                    <button
                      z-button
                      zType="ghost"
                      zSize="sm"
                      type="button"
                      data-slot="backup-s3-secret-remove"
                      (click)="set({ secret: { kind: 'remove' } })"
                    >
                      {{
                        'editor.admin.backups.settings.secretRemove' | transloco
                      }}
                    </button>
                  </div>
                } @else if (secretShown() === 'removed') {
                  <div class="flex min-w-0 flex-wrap items-center gap-2">
                    <span class="text-muted-foreground text-sm">{{
                      'editor.admin.backups.settings.secretRemoved' | transloco
                    }}</span>
                    <button
                      z-button
                      zType="ghost"
                      zSize="sm"
                      type="button"
                      (click)="set({ secret: { kind: 'keep' } })"
                    >
                      {{
                        'editor.admin.backups.settings.secretKeep' | transloco
                      }}
                    </button>
                  </div>
                } @else {
                  <input
                    z-input
                    type="password"
                    class="max-w-96"
                    autocomplete="new-password"
                    aria-labelledby="backup-s3-secret-label"
                    [value]="secretValue()"
                    [attr.aria-invalid]="!!errors()['secret']"
                    (input)="
                      set({ secret: { kind: 'replace', value: text($event) } })
                    "
                  />
                  <span class="text-muted-foreground text-xs break-words">{{
                    'editor.admin.backups.settings.secretHint' | transloco
                  }}</span>
                }
                @if (errors()['secret']; as message) {
                  <span
                    class="text-destructive text-xs break-words"
                    role="alert"
                    >{{ message }}</span
                  >
                }
              </div>
            }
          </fieldset>

          <fieldset
            class="m-0 flex min-w-0 flex-col gap-3 border-0 p-0"
            data-slot="backup-verify"
          >
            <legend class="mb-2 p-0 text-sm font-medium">
              {{ 'editor.admin.backups.settings.check' | transloco }}
            </legend>
            <z-switch
              class="text-sm"
              data-slot="backup-verify-switch"
              [zChecked]="draft().verify"
              [zDisabled]="!!fixedOf('verify')"
              (zCheckedChange)="set({ verify: $event })"
              >{{
                'editor.admin.backups.settings.verify' | transloco
              }}</z-switch
            >
            <of-collapse [open]="draft().verify">
              <div class="flex min-w-0 flex-col gap-1.5 ps-1 pt-1">
                <z-switch
                  class="text-sm"
                  data-slot="backup-verify-decrypt"
                  [zChecked]="draft().verifyByDecrypting"
                  [zDisabled]="!!fixedOf('verifyByDecrypting')"
                  (zCheckedChange)="set({ verifyByDecrypting: $event })"
                  >{{
                    'editor.admin.backups.settings.verifyByDecrypting'
                      | transloco
                  }}</z-switch
                >
                <span
                  class="text-muted-foreground max-w-prose text-xs break-words"
                  >{{
                    (draft().verifyByDecrypting
                      ? 'editor.admin.backups.settings.decryptHint'
                      : 'editor.admin.backups.settings.noDecryptHint'
                    ) | transloco
                  }}</span
                >
                @if (errors()['verifyByDecrypting']; as message) {
                  <span
                    class="text-destructive text-xs break-words"
                    role="alert"
                    >{{ message }}</span
                  >
                }
              </div>
            </of-collapse>
            @for (field of checkFields; track field) {
              @if (fixedOf(field); as variable) {
                <p class="text-muted-foreground m-0 text-xs break-words">
                  {{ 'editor.admin.backups.fixedBy' | transloco: { variable } }}
                </p>
              }
            }
          </fieldset>

          @if (formError(); as message) {
            <p
              class="text-destructive m-0 text-sm break-words"
              role="alert"
              data-slot="backup-settings-error"
            >
              {{ message }}
            </p>
          }
          <div class="flex min-w-0 flex-wrap items-center gap-2 border-t pt-4">
            <button
              z-button
              type="submit"
              data-slot="backup-save"
              [zDisabled]="!dirty() || saving()"
            >
              {{ 'editor.admin.save' | transloco }}
            </button>
            <button
              z-button
              zType="ghost"
              type="button"
              data-slot="backup-discard"
              [zDisabled]="!dirty() || saving()"
              (click)="discard()"
            >
              {{ 'editor.admin.backups.settings.discard' | transloco }}
            </button>
            <span class="flex-1"></span>
            <button
              z-button
              zType="outline"
              type="button"
              data-slot="backup-test-location"
              [zDisabled]="!canRequest() || requesting() !== null"
              (click)="request('test-location')"
            >
              <ng-icon
                name="lucidePlugZap"
                data-icon="inline-start"
                aria-hidden="true"
              />
              {{ 'editor.admin.backups.actions.test' | transloco }}
            </button>
            <button
              z-button
              zType="outline"
              type="button"
              data-slot="backup-now"
              [zDisabled]="
                !canRequest() || !s.meta.key || requesting() !== null
              "
              (click)="request('run')"
            >
              <ng-icon
                name="lucideDatabaseBackup"
                data-icon="inline-start"
                aria-hidden="true"
              />
              {{ 'editor.admin.backups.actions.now' | transloco }}
            </button>
          </div>
          <div aria-live="polite" class="min-w-0">
            @if (requestHint(); as hint) {
              <p class="text-muted-foreground m-0 text-xs break-words">
                {{ hint | transloco }}
              </p>
            }
            @if (outcome(); as o) {
              <p
                class="m-0 flex min-w-0 items-start gap-2 text-sm break-words"
                data-slot="backup-request-outcome"
                [attr.data-kind]="o.kind"
                [attr.data-state]="o.state"
                [class.text-destructive]="o.state === 'failed'"
              >
                @if (o.state === 'done') {
                  <ng-icon
                    name="lucideCircleCheck"
                    class="text-success mt-0.5 shrink-0"
                    aria-hidden="true"
                  />
                } @else if (o.state === 'failed') {
                  <ng-icon
                    name="lucideCircleX"
                    class="mt-0.5 shrink-0"
                    aria-hidden="true"
                  />
                }
                <span class="min-w-0">
                  {{ outcomeKey(o) | transloco }}
                  @if (o.detail) {
                    <span
                      class="block font-mono text-xs [overflow-wrap:anywhere]"
                      >{{ o.detail }}</span
                    >
                  }
                </span>
              </p>
            }
          </div>
        </form>

        <section
          class="flex min-w-0 flex-col gap-2"
          aria-labelledby="backup-history-heading"
        >
          <h2 id="backup-history-heading" class="m-0 text-base font-semibold">
            {{ 'editor.admin.backups.history.heading' | transloco }}
          </h2>
          <of-list-frame
            #frame
            class="min-h-64 min-w-0"
            data-slot="backup-history"
            [label]="'editor.admin.backups.history.label' | transloco"
            [items]="runs()?.data ?? []"
            [page]="runs()?.meta?.page ?? null"
            [loading]="runsLoading()"
            [error]="runsError()"
            [offset]="offset()"
            [pageSizes]="pageSizes"
            [emptyTitle]="'editor.admin.backups.history.emptyTitle' | transloco"
            [emptyDescription]="
              'editor.admin.backups.history.emptyDescription' | transloco
            "
            (pageChange)="view.set({ page: $event })"
            (pageSizeChange)="view.set({ size: $event, page: 1 })"
            (retry)="reloadRuns()"
          >
            <ng-template ofListTable let-items>
              <!-- Fits the frame from a 1024 px window up; narrower, the frame scrolls it sideways. -->
              <table z-table class="min-w-[40rem] table-fixed">
                <thead z-table-header class="bg-background sticky top-0 z-10">
                  <tr z-table-row>
                    <th z-table-head class="w-36 xl:w-44">
                      {{ 'editor.admin.backups.history.time' | transloco }}
                    </th>
                    <th z-table-head class="w-32 xl:w-36">
                      {{ 'editor.admin.backups.history.result' | transloco }}
                    </th>
                    <th z-table-head class="w-24 text-end">
                      {{ 'editor.admin.backups.history.size' | transloco }}
                    </th>
                    <th z-table-head class="w-24 text-end">
                      {{ 'editor.admin.backups.history.duration' | transloco }}
                    </th>
                    <th z-table-head>
                      {{ 'editor.admin.backups.history.location' | transloco }}
                    </th>
                    <th z-table-head class="w-36 xl:w-44">
                      {{ 'editor.admin.backups.history.key' | transloco }}
                    </th>
                  </tr>
                </thead>
                <tbody z-table-body>
                  @for (run of asRuns(items); track run.id) {
                    <tr
                      z-table-row
                      [ofListItem]="run"
                      data-slot="backup-run"
                      [attr.data-run]="run.id"
                      [attr.data-status]="run.attributes.status"
                    >
                      <td z-table-cell class="align-top whitespace-normal">
                        <time
                          class="tabular-nums"
                          [attr.datetime]="run.attributes.startedAt"
                          >{{
                            run.attributes.startedAt | ofDate: dateFormat
                          }}</time
                        >
                        <span class="text-muted-foreground block text-xs">{{
                          triggerKey(run) | transloco
                        }}</span>
                      </td>
                      <td z-table-cell class="align-top whitespace-normal">
                        @switch (resultOf(run)) {
                          @case ('verified') {
                            <z-badge zType="success">{{
                              'editor.admin.backups.history.verified'
                                | transloco
                            }}</z-badge>
                          }
                          @case ('unverified') {
                            <z-badge zType="secondary">{{
                              'editor.admin.backups.history.unverified'
                                | transloco
                            }}</z-badge>
                          }
                          @case ('running') {
                            <z-badge zType="info">{{
                              'editor.admin.backups.history.running' | transloco
                            }}</z-badge>
                          }
                          @default {
                            <z-badge zType="destructive">{{
                              'editor.admin.backups.history.failed' | transloco
                            }}</z-badge>
                            <span
                              class="text-destructive mt-1 block text-xs break-words"
                              data-slot="backup-run-error"
                              >{{ errorKey(run) | transloco }}</span
                            >
                            @if (run.attributes.errorDetail; as detail) {
                              <span
                                class="text-muted-foreground mt-0.5 block font-mono text-xs [overflow-wrap:anywhere]"
                                >{{ detail }}</span
                              >
                            }
                          }
                        }
                      </td>
                      <td z-table-cell class="text-end align-top tabular-nums">
                        {{ sizeOf(run) }}
                      </td>
                      <td z-table-cell class="text-end align-top tabular-nums">
                        {{ durationText(run) }}
                      </td>
                      <td
                        z-table-cell
                        class="align-top font-mono text-xs [overflow-wrap:anywhere] whitespace-normal"
                      >
                        {{ run.attributes.location ?? '—' }}
                        @if (run.attributes.name; as name) {
                          <span class="text-muted-foreground block">{{
                            name
                          }}</span>
                        }
                      </td>
                      <td
                        z-table-cell
                        class="align-top font-mono text-xs [overflow-wrap:anywhere] whitespace-normal"
                        data-slot="backup-run-key"
                      >
                        {{ run.attributes.keyFingerprint ?? '—' }}
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </ng-template>
          </of-list-frame>
        </section>
      }

      <of-backup-key-dialog [(open)]="keyOpen" [shown]="shownKey()" />
    }
  `,
})
export class BackupsPage {
  protected readonly sandbox = inject(SandboxSession);
  private readonly api = inject(ApiClient);
  private readonly language = inject(LanguageService);
  private readonly dialogs = inject(ZardAlertDialogService);
  private readonly toast = inject(ToastService);
  private readonly injector = inject(Injector);
  private readonly t = injectTranslate();

  protected readonly view = injectQueryState({
    page: intParam(1),
    size: intParam(RUN_PAGE_SIZES[0], { only: RUN_PAGE_SIZES }),
  });
  protected readonly pageSizes = RUN_PAGE_SIZES;
  protected readonly weekdays = WEEKDAYS;
  protected readonly zones = timeZones();
  protected readonly dateFormat: Intl.DateTimeFormatOptions = {
    dateStyle: 'medium',
    timeStyle: 'short',
  };
  protected readonly scheduleFields = [
    'frequency',
    'expression',
    'every',
    'weekday',
    'time',
  ] as const;
  protected readonly checkFields = ['verify', 'verifyByDecrypting'] as const;
  protected readonly retentionFields = [
    { field: 'daily', label: 'editor.admin.backups.settings.keepDaily' },
    { field: 'weekly', label: 'editor.admin.backups.settings.keepWeekly' },
    { field: 'monthly', label: 'editor.admin.backups.settings.keepMonthly' },
  ] as const;
  protected readonly s3Fields = [
    {
      field: 'endpoint',
      label: 'editor.admin.backups.settings.endpoint',
      placeholder: 'https://s3.example.com',
    },
    {
      field: 'region',
      label: 'editor.admin.backups.settings.region',
      placeholder: 'us-east-1',
    },
    {
      field: 'bucket',
      label: 'editor.admin.backups.settings.bucket',
      placeholder: 'backups',
    },
    {
      field: 'prefix',
      label: 'editor.admin.backups.settings.prefix',
      placeholder: 'openfolia/',
    },
    {
      field: 'accessKeyId',
      label: 'editor.admin.backups.settings.accessKeyId',
      placeholder: '',
    },
  ] as const;

  protected readonly saved = signal<BackupSettingsResource | null>(null);
  protected readonly draft = signal<SettingsDraft>(EMPTY_DRAFT);
  private readonly loadFailure = signal<ApiError | null>(null);
  protected readonly status = signal<BackupStatusMeta | null>(null);
  protected readonly saving = signal(false);
  protected readonly errors = signal<
    Partial<Record<keyof SettingsDraft, string>>
  >({});
  protected readonly formError = signal<string | null>(null);
  protected readonly makingKey = signal(false);
  protected readonly keyOpen = signal(false);
  protected readonly shownKey = signal<ShownBackupKey | null>(null);
  protected readonly requesting = signal<RequestKind | null>(null);
  protected readonly outcome = signal<RequestOutcome | null>(null);

  protected readonly runs = signal<RunsDoc | null>(null);
  protected readonly runsLoading = signal(false);
  private readonly runsFailure = signal<ApiError | null>(null);
  private readonly runReloads = signal(0);
  protected readonly offset = signal('20rem');
  private readonly frame = viewChild('frame', { read: ElementRef });
  private loads = 0;
  private destroyed = false;
  private readonly now = signal(new Date());

  protected readonly loadError = computed(() =>
    this.errorOf(this.loadFailure()),
  );
  protected readonly runsError = computed(() =>
    this.errorOf(this.runsFailure()),
  );

  protected readonly summary = computed(() => {
    const status = this.status();
    return status
      ? statusSummary(status, this.now(), this.language.locale())
      : null;
  });

  protected readonly dirty = computed(() => {
    const saved = this.saved();
    const draft = this.draft();
    if (!saved) return false;
    return (
      Object.keys(changesOf(saved.attributes, draft, saved.meta.fixed)).length >
      0
    );
  });

  /** The service must be running for a request, and the form saved: a test tries what is saved. */
  protected readonly canRequest = computed(
    () => !!this.saved()?.meta.service.running && !this.dirty(),
  );

  protected readonly requestHint = computed(() => {
    const s = this.saved();
    if (!s) return null;
    if (!s.meta.service.running)
      return 'editor.admin.backups.actions.serviceDown';
    if (this.dirty()) return 'editor.admin.backups.actions.saveFirst';
    if (!s.meta.key) return 'editor.admin.backups.actions.keyFirst';
    return null;
  });

  /** The S3 secret as the form shows it: set (and kept), removed, or a field to type one in. */
  protected readonly secretShown = computed(() => {
    const s = this.saved();
    const d = this.draft();
    if (!s) return 'input';
    const set =
      s.attributes.location.kind === 's3' &&
      s.attributes.location.secretAccessKeySet;
    if (d.secret.kind === 'remove') return 'removed';
    if (set && d.secret.kind === 'keep') return 'set';
    return 'input';
  });

  protected readonly secretValue = computed(() => {
    const secret = this.draft().secret;
    return secret?.kind === 'replace' ? secret.value : '';
  });

  protected readonly frequencyOptions = computed<readonly SegmentedOption[]>(
    () => {
      this.language.locale();
      return [
        {
          value: 'daily',
          label: this.t('editor.admin.backups.frequency.daily'),
        },
        {
          value: 'weekly',
          label: this.t('editor.admin.backups.frequency.weekly'),
        },
        {
          value: 'hours',
          label: this.t('editor.admin.backups.frequency.hours'),
        },
        { value: 'cron', label: this.t('editor.admin.backups.frequency.cron') },
      ];
    },
  );

  protected readonly locationOptions = computed<readonly SegmentedOption[]>(
    () => {
      this.language.locale();
      return [
        {
          value: 'local',
          label: this.t('editor.admin.backups.location.local'),
        },
        { value: 's3', label: this.t('editor.admin.backups.location.s3') },
      ];
    },
  );

  constructor() {
    void this.load();
    effect(() => {
      const page = {
        number: this.view.get('page')(),
        size: this.view.get('size')(),
      };
      this.runReloads();
      untracked(() => void this.loadRuns(page));
    });

    const destroyRef = inject(DestroyRef);
    const measure = () => {
      const el = this.frame()?.nativeElement as HTMLElement | undefined;
      if (!el) return;
      const top = Math.round(el.getBoundingClientRect().top);
      this.offset.set(`${Math.max(0, top) + BELOW_FRAME_PX}px`);
    };
    afterRenderEffect(() => {
      this.frame();
      this.saved();
      this.runs();
      this.outcome();
      measure();
    });
    const onResize = () => measure();
    window.addEventListener('resize', onResize);
    // "6 hours ago" moves on while the page is open.
    const tick = setInterval(() => this.now.set(new Date()), 60_000);
    destroyRef.onDestroy(() => {
      this.destroyed = true;
      clearInterval(tick);
      window.removeEventListener('resize', onResize);
    });
  }

  /** Unsaved settings ask before the page is left (the route's `canDeactivate`). */
  leave(): Promise<boolean> {
    if (!this.dirty()) return Promise.resolve(true);
    return new Promise((resolve) => {
      let answered = false;
      const answer = (yes: boolean) => {
        if (answered) return;
        answered = true;
        resolve(yes);
      };
      const ref = this.dialogs.confirm({
        zTitle: this.t('editor.admin.backups.discardDialog.title'),
        zDescription: this.t('editor.admin.backups.discardDialog.description'),
        zOkText: this.t('editor.admin.backups.discardDialog.ok'),
        zCancelText: this.t('editor.admin.backups.discardDialog.cancel'),
        zOkDestructive: true,
        zOnOk: () => answer(true),
        zOnCancel: () => answer(false),
      });
      const closing = effect(
        () => {
          if (ref.isClosing()) {
            closing.destroy();
            queueMicrotask(() => answer(false));
          }
        },
        { injector: this.injector },
      );
    });
  }

  /** Reads the settings and the status; `keepDraft` keeps unsaved edits (a key was made). */
  async load(options: { keepDraft?: boolean } = {}): Promise<void> {
    this.loadFailure.set(null);
    try {
      const [settings, status] = await Promise.all([
        firstValueFrom(this.api.get('/backup-settings')),
        firstValueFrom(this.api.get('/backup-status')),
      ]);
      const before = this.saved();
      if (options.keepDraft && before && this.dirty()) {
        // The fields edited stay as edited; the others take what was read.
        this.draft.set(
          rebaseDraft(
            draftOf(before.attributes),
            this.draft(),
            draftOf(settings.data.attributes),
          ),
        );
        this.saved.set(settings.data);
      } else this.show(settings.data);
      this.status.set(status.data.meta);
    } catch (error) {
      this.loadFailure.set(toApiError(error));
    }
  }

  protected fixedOf(field: keyof SettingsDraft): string | null {
    return fixedVariable(this.saved()?.meta.fixed ?? {}, field);
  }

  protected set(changes: Partial<SettingsDraft>): void {
    this.draft.update((d) => ({ ...d, ...changes }));
    const cleared = { ...this.errors() };
    for (const key of Object.keys(changes)) {
      delete cleared[key as keyof SettingsDraft];
    }
    this.errors.set(cleared);
    this.formError.set(null);
  }

  protected setText(
    field: 'endpoint' | 'region' | 'bucket' | 'prefix' | 'accessKeyId',
    event: Event,
  ): void {
    this.set({ [field]: this.text(event) });
  }

  protected setRetention(
    field: 'daily' | 'weekly' | 'monthly',
    event: Event,
  ): void {
    this.set({ [field]: this.number(event) });
  }

  protected text(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }

  protected number(event: Event): number {
    const value = Number((event.target as HTMLInputElement).value);
    return Number.isFinite(value) ? Math.trunc(value) : 0;
  }

  protected asFrequency(value: string): FrequencyKind {
    return value as FrequencyKind;
  }

  protected asLocation(value: string): LocationKind {
    return value as LocationKind;
  }

  protected dayName(day: number): string {
    return weekdayName(day, this.language.locale());
  }

  protected discard(): void {
    const saved = this.saved();
    if (saved) this.draft.set(draftOf(saved.attributes));
    this.errors.set({});
    this.formError.set(null);
  }

  protected async save(event: Event): Promise<void> {
    event.preventDefault();
    const saved = this.saved();
    if (!saved || this.saving() || !this.dirty()) return;
    const attributes = changesOf(
      saved.attributes,
      this.draft(),
      saved.meta.fixed,
    );
    this.saving.set(true);
    this.errors.set({});
    this.formError.set(null);
    try {
      const doc = await firstValueFrom(
        this.api.patch(
          '/backup-settings',
          { path: {} as never },
          { data: { type: 'BackupSettings', id: 'instance', attributes } },
        ),
      );
      this.show(doc.data);
      this.toast.success(translated('editor.admin.backups.saved'));
      void this.loadStatus();
    } catch (error) {
      this.refused(toApiError(error));
    } finally {
      this.saving.set(false);
    }
  }

  protected confirmRotate(): void {
    this.dialogs.confirm({
      zTitle: this.t('editor.admin.backups.rotateDialog.title'),
      zDescription: this.t('editor.admin.backups.rotateDialog.description'),
      zOkText: this.t('editor.admin.backups.key.rotate'),
      zCancelText: this.t('editor.admin.cancel'),
      zOkDestructive: true,
      zOnOk: () => void this.makeKey(true),
    });
  }

  protected async makeKey(rotate: boolean): Promise<void> {
    if (this.makingKey()) return;
    this.makingKey.set(true);
    try {
      const doc = await firstValueFrom(
        this.api.post('/backup-keys', rotate ? { meta: { rotate: true } } : {}),
      );
      this.shownKey.set({
        identity: doc.meta.identity,
        fingerprint: doc.data.attributes.fingerprint,
        createdAt: doc.data.attributes.createdAt,
        rotated: doc.meta.rotated,
      });
      this.keyOpen.set(true);
      await this.load({ keepDraft: true });
    } catch (error) {
      this.toast.error(this.textOf(toApiError(error)));
    } finally {
      this.makingKey.set(false);
    }
  }

  /** Asks the backup service, then reads the request until it is finished. */
  protected async request(kind: RequestKind): Promise<void> {
    if (this.requesting()) return;
    this.requesting.set(kind);
    this.outcome.set({ kind, state: 'waiting', detail: null });
    try {
      const doc = await firstValueFrom(
        this.api.act(
          '/backup-requests',
          { path: {} as never },
          { data: { type: 'BackupRequest', attributes: { kind } } },
        ),
      );
      let request = doc?.data as BackupRequestItem | undefined;
      while (
        request &&
        !this.destroyed &&
        (request.attributes.status === 'pending' ||
          request.attributes.status === 'running')
      ) {
        await new Promise((r) => setTimeout(r, REQUEST_POLL_MS));
        const next = await firstValueFrom(
          this.api.get('/backup-requests/{requestId}', {
            path: { requestId: request.id },
          }),
        );
        request = next.data;
      }
      if (!request || this.destroyed) return;
      this.outcome.set({
        kind,
        state: request.attributes.status === 'done' ? 'done' : 'failed',
        detail: request.attributes.errorDetail,
      });
      if (kind === 'run') {
        this.reloadRuns();
        void this.loadStatus();
      }
    } catch (error) {
      const text = this.textOf(toApiError(error));
      this.outcome.set({
        kind,
        state: 'failed',
        detail: this.t(text.key, text.params),
      });
      // The service may have stopped meanwhile: the page says so again.
      void this.load();
    } finally {
      this.requesting.set(null);
    }
  }

  protected outcomeKey(o: RequestOutcome): string {
    return OUTCOME_KEYS[o.kind][o.state];
  }

  protected reloadRuns(): void {
    this.runReloads.update((n) => n + 1);
  }

  protected asRuns(items: readonly unknown[]): readonly BackupRunItem[] {
    return items as readonly BackupRunItem[];
  }

  protected resultOf(
    run: BackupRunItem,
  ): 'verified' | 'unverified' | 'running' | 'failed' {
    const a = run.attributes;
    if (a.status === 'running') return 'running';
    if (a.status === 'failed') return 'failed';
    return a.verified ? 'verified' : 'unverified';
  }

  protected triggerKey(run: BackupRunItem): string {
    return TRIGGER_KEYS[run.attributes.trigger];
  }

  protected errorKey(run: BackupRunItem): string {
    return (
      RUN_ERRORS[run.attributes.error ?? 'failed'] ??
      'editor.admin.backups.runErrors.failed'
    );
  }

  protected sizeOf(run: BackupRunItem): string {
    const size = run.attributes.sizeBytes;
    return size === null ? '—' : formatFileSize(size, this.language.locale());
  }

  protected durationText(run: BackupRunItem): string {
    const ms = durationOf(run);
    return ms === null ? '—' : formatDuration(ms, this.language.locale());
  }

  private show(settings: BackupSettingsResource): void {
    this.saved.set(settings);
    this.draft.set(draftOf(settings.attributes));
  }

  private async loadStatus(): Promise<void> {
    try {
      const doc = await firstValueFrom(this.api.get('/backup-status'));
      this.status.set(doc.data.meta);
      this.now.set(new Date());
    } catch {
      // The card keeps what it showed; the next load tries again.
    }
  }

  /** A refusal: each reason under its field, the rest above the buttons, and a toast. */
  private refused(error: ApiError): void {
    const fields: Partial<Record<keyof SettingsDraft, string>> = {};
    const rest: string[] = [];
    for (const object of error.errors) {
      const text = backupErrorText(object);
      const message = text
        ? this.t(text.key, text.params)
        : (object.detail ?? error.message);
      const field = fieldOfError(object);
      if (field && !fields[field]) fields[field] = message;
      else rest.push(message);
    }
    if (error.errors.length === 0) {
      const text = apiErrorText(error);
      rest.push(this.t(text.key, text.params));
    }
    this.errors.set(fields);
    this.formError.set(rest.length > 0 ? rest.join(' ') : null);
    this.toast.error(translated('editor.admin.backups.saveFailed'));
  }

  private textOf(error: ApiError): TranslatedText {
    const own = error.errors[0] ? backupErrorText(error.errors[0]) : null;
    return own ?? apiErrorText(error);
  }

  private errorOf(failure: ApiError | null) {
    if (!failure) return null;
    const text = apiErrorText(failure);
    return { kind: failure.kind, message: this.t(text.key, text.params) };
  }

  private async loadRuns(page: {
    number: number;
    size: number;
  }): Promise<void> {
    const run = ++this.loads;
    this.runsLoading.set(true);
    this.runsFailure.set(null);
    try {
      const doc = await firstValueFrom(
        this.api.get('/backup-runs', { query: pageQuery(page) }),
      );
      if (run !== this.loads) return;
      this.runs.set(doc);
    } catch (error) {
      if (run !== this.loads) return;
      this.runsFailure.set(toApiError(error));
    } finally {
      if (run === this.loads) this.runsLoading.set(false);
    }
  }
}
