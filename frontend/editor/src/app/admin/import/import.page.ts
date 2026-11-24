import { HttpEventType } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  inject,
  Injector,
  signal,
  untracked,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslocoPipe } from '@jsverse/transloco';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideBan,
  lucideCircleAlert,
  lucideCircleCheck,
  lucideCircleMinus,
  lucideCirclePlus,
  lucideClock,
  lucideExternalLink,
  lucideFileArchive,
  lucideLoaderCircle,
  lucideRefreshCw,
  lucideUpload,
} from '@ng-icons/lucide';
import { filter, firstValueFrom, tap } from 'rxjs';

import { ZardAlertDialogService } from '@openfolia/ui/alert-dialog';
import { ZardButtonComponent } from '@openfolia/ui/button';
import { CollapseComponent } from '@openfolia/ui/collapse';
import {
  injectTranslate,
  LanguageService,
  relativeTime,
  TextPipe,
  translated,
  type TranslatedText,
} from '@openfolia/ui/i18n';
import { ZardRadioGroupImports } from '@openfolia/ui/radio-group';
import { FadeInDirective } from '@openfolia/ui/smooth';
import {
  ErrorStateComponent,
  SkeletonRowsComponent,
} from '@openfolia/ui/states';
import { ToastService } from '@openfolia/ui/toast';

import { ApiClient, pageQuery, toApiError, type ApiError } from '../../api';
import { HelpService } from '../../help/help.service';
import { MeService } from '../../permissions/me';
import { GuardDirective } from '../../permissions/guard.directive';
import { PermissionService } from '../../permissions/permission.service';
import {
  injectQueryState,
  idParam,
  intParam,
  oneOfParam,
} from '../../view-state';
import {
  ACCEPTED_FILES,
  applyPercent,
  bundleErrors,
  changeSetOf,
  DOCUMENTED_IMPORTER,
  expired,
  failureText,
  FORMAT_ARTICLE,
  IMPORT_ID_PATTERN,
  IMPORTER_ID_PATTERN,
  importErrorText,
  ITEM_RESULTS,
  looseNotes,
  megabytes,
  orderImporters,
  PHASE_TEXT,
  REPORT_PAGE_SIZES,
  writtenCount,
  type ImportDoc,
  type Importer,
} from './import-model';
import { ImportItemsComponent } from './import-report.component';
import { ImportUpload, type ImportForm } from './import-upload';
import {
  ImportOptionsComponent,
  type OptionChange,
} from './options-form.component';
import {
  initialValues,
  optionFields,
  optionsOf,
  problemsOf,
  valuesFrom,
  type OptionValues,
} from './options-schema';
import { SandboxOffStateComponent } from '../../sandbox/sandbox-off-state.component';
import { SandboxSession } from '../../sandbox/sandbox-session';

/** The screen's view in the address: the importer, the stored import, and the report's filter and page. */
export const IMPORT_SCREEN_PARAMS = {
  importer: idParam(IMPORTER_ID_PATTERN),
  import: idParam(IMPORT_ID_PATTERN),
  result: oneOfParam(ITEM_RESULTS),
  page: intParam(1),
  size: intParam(REPORT_PAGE_SIZES[0] ?? 25, { only: REPORT_PAGE_SIZES }),
};

/** How often the expiry is looked at again. */
const TICK_MS = 15_000;
/** How often an import being applied is read again. */
const POLL_MS = 1_000;
/** The most importers read (a page of `GET /importers`). */
const IMPORTERS_PAGE = 100;

type Phase =
  | 'setup'
  | 'loading'
  | 'report'
  | 'expired'
  | 'applying'
  | 'done'
  | 'failed'
  | 'gone';

/**
 * Import content (#93, screen 26), the Admin page's "Import" tab (`admin.roles`): an admin brings
 * content in without a terminal, in steps on one page, each usable without a mouse.
 *
 * 1. **Importer:** the installed importers (`GET /importers`) as radios with their descriptions,
 *    the documented format first, with a link to its guide page.
 * 2. **File:** dropped or picked; the size limit (`meta.maxBytes`) is stated, and a larger file is
 *    refused before it is sent.
 * 3. **Options:** the importer's options schema as a form, and "Update existing".
 * 4. **Dry run:** the upload with its progress, then the report (`POST /imports`, stored for an
 *    hour so it survives a reload; nothing is written): the counts, the bundle's own findings, and
 *    the items, filterable by result and paged.
 * 5. **Import:** `…/apply`, with its progress read from `GET /imports/:id`, ending with "Open in
 *    review" for the new revision.
 *
 * An import with refused items can be imported without them, for every importer, once
 * confirmed: when the report says the rest stands without them (`applicableWithoutRefused`), it
 * is applied with `skipRefused` (#758), which leaves exactly those out.
 * The importer, the import, the filter and the page live in the address. Leaving with a file
 * chosen or a dry run not imported asks once; an expired dry run is run again in one click.
 */
@Component({
  selector: 'of-import-page',
  imports: [
    SandboxOffStateComponent,
    RouterLink,
    TranslocoPipe,
    NgIcon,
    TextPipe,
    ZardButtonComponent,
    ZardRadioGroupImports,
    CollapseComponent,
    FadeInDirective,
    ErrorStateComponent,
    SkeletonRowsComponent,
    GuardDirective,
    ImportItemsComponent,
    ImportOptionsComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [
    provideIcons({
      lucideBan,
      lucideCircleAlert,
      lucideCircleCheck,
      lucideCircleMinus,
      lucideCirclePlus,
      lucideClock,
      lucideExternalLink,
      lucideFileArchive,
      lucideLoaderCircle,
      lucideRefreshCw,
      lucideUpload,
    }),
  ],
  host: {
    class: 'flex min-w-0 flex-col gap-4',
    '(window:beforeunload)': 'beforeUnload($event)',
  },
  template: `
    @if (sandbox.on()) {
      <!-- A public sandbox imports nothing (issue 826): the screen says why. -->
      <of-sandbox-off-state
        [title]="'editor.sandbox.importsOff.title' | transloco"
        [description]="'editor.sandbox.importsOff.description' | transloco"
      />
    } @else {
      <input
        #fileInput
        id="import-file"
        type="file"
        class="sr-only"
        tabindex="-1"
        aria-hidden="true"
        [accept]="accepted"
        (change)="picked($event)"
      />

      <of-collapse [open]="setupOpen()">
        <div class="flex min-w-0 flex-col gap-4" data-slot="setup">
          <!-- 1. The importer -->
          <section
            class="border-border bg-card flex min-w-0 flex-col gap-3 rounded-lg border px-5 py-4"
            data-slot="step-importer"
            aria-labelledby="import-step-importer"
          >
            <h2 id="import-step-importer" class="m-0 text-base font-semibold">
              {{ 'editor.admin.import.steps.importer' | transloco }}
            </h2>
            @if (importers(); as list) {
              @if (list.length === 0) {
                <p class="text-muted-foreground m-0 text-sm break-words">
                  {{ 'editor.admin.import.importer.none' | transloco }}
                </p>
              } @else {
                <z-radio-group
                  ofFadeIn
                  class="flex flex-col gap-3"
                  [attr.aria-labelledby]="'import-step-importer'"
                  [value]="importerId()"
                  [zDisabled]="busy()"
                  (valueChange)="chooseImporter($any($event))"
                >
                  @for (i of list; track i.id) {
                    <label
                      class="flex min-w-0 cursor-pointer items-start gap-3"
                      [attr.data-importer]="i.id"
                    >
                      <z-radio
                        class="mt-0.5"
                        [value]="i.id"
                        [zId]="'import-importer-' + i.id"
                      />
                      <span class="flex min-w-0 flex-col gap-0.5">
                        <span class="text-sm font-medium break-words">{{
                          i.attributes.label
                        }}</span>
                        <span
                          class="text-muted-foreground text-xs break-words"
                          >{{ i.attributes.description }}</span
                        >
                        @if (i.id === documented) {
                          @if (formatLink(); as link) {
                            <a
                              class="text-primary focus-visible:ring-ring/50 inline-flex w-fit items-center gap-1 rounded-sm text-xs underline-offset-4 outline-none hover:underline focus-visible:ring-2"
                              data-slot="format-link"
                              target="_blank"
                              rel="noopener"
                              [href]="link.href"
                              >{{
                                'editor.admin.import.importer.formatLink'
                                  | transloco
                              }}<ng-icon
                                name="lucideExternalLink"
                                class="size-3"
                                aria-hidden="true"
                              /><span class="sr-only">{{
                                'editor.admin.import.importer.newTab'
                                  | transloco
                              }}</span></a
                            >
                          }
                        }
                      </span>
                    </label>
                  }
                </z-radio-group>
              }
            } @else if (importersError(); as err) {
              <of-error-state
                [kind]="err.kind"
                [message]="importersErrorText() | ofText"
                (retry)="loadImporters()"
              />
            } @else {
              <of-skeleton-rows
                [count]="2"
                [label]="'editor.admin.import.importer.loading' | transloco"
              />
            }
          </section>

          <!-- 2. The file -->
          <section
            class="border-border bg-card flex min-w-0 flex-col gap-3 rounded-lg border px-5 py-4"
            data-slot="step-file"
            aria-labelledby="import-step-file"
          >
            <h2 id="import-step-file" class="m-0 text-base font-semibold">
              {{ 'editor.admin.import.steps.file' | transloco }}
            </h2>
            @if (file(); as f) {
              <div
                class="border-border flex min-w-0 flex-wrap items-center gap-3 rounded-lg border border-dashed px-4 py-3 animate-in fade-in-0 motion-reduce:animate-none"
                data-slot="file"
                [class.border-primary]="dragging()"
                (dragenter)="dragOver($event)"
                (dragover)="dragOver($event)"
                (dragleave)="dragging.set(false)"
                (drop)="dropped($event)"
              >
                <ng-icon
                  name="lucideFileArchive"
                  class="text-muted-foreground size-5 shrink-0"
                  aria-hidden="true"
                />
                <div class="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span
                    class="font-medium break-words [overflow-wrap:anywhere]"
                    data-slot="file-name"
                    >{{ f.name }}</span
                  >
                  <span class="text-muted-foreground text-sm">{{
                    'editor.admin.import.file.size'
                      | transloco: { size: sizeOf(f.size) }
                  }}</span>
                </div>
                <button
                  z-button
                  zType="ghost"
                  type="button"
                  data-slot="replace"
                  [zDisabled]="busy()"
                  (click)="fileInput.click()"
                >
                  {{ 'editor.admin.import.file.replace' | transloco }}
                </button>
              </div>
            } @else {
              <label
                for="import-file-zone"
                class="border-border hover:bg-muted/40 has-[:focus-visible]:ring-ring/50 flex cursor-pointer flex-col items-center gap-2 rounded-lg border-2 border-dashed px-6 py-8 text-center transition-colors duration-150 has-[:focus-visible]:ring-[3px] motion-reduce:transition-none"
                [class.border-primary]="dragging()"
                [class.bg-muted]="dragging()"
                data-slot="drop-zone"
                (dragenter)="dragOver($event)"
                (dragover)="dragOver($event)"
                (dragleave)="dragging.set(false)"
                (drop)="dropped($event)"
              >
                <ng-icon
                  name="lucideUpload"
                  class="text-muted-foreground size-6"
                  aria-hidden="true"
                />
                <span class="font-medium">{{
                  'editor.admin.import.file.title' | transloco
                }}</span>
                <span class="text-muted-foreground text-sm">{{
                  'editor.admin.import.file.choose' | transloco
                }}</span>
                <input
                  id="import-file-zone"
                  type="file"
                  class="sr-only"
                  aria-describedby="import-file-limit"
                  [accept]="accepted"
                  [disabled]="busy()"
                  (change)="picked($event)"
                />
              </label>
            }
            <p
              id="import-file-limit"
              class="text-muted-foreground m-0 text-xs break-words"
              data-slot="size-limit"
            >
              @if (importer(); as i) {
                {{
                  'editor.admin.import.file.limit'
                    | transloco: { max: sizeOf(i.meta.maxBytes) }
                }}
              } @else {
                {{ 'editor.admin.import.file.limitUnknown' | transloco }}
              }
            </p>
            @if (fileError(); as err) {
              <p
                class="border-destructive/40 bg-destructive-muted text-foreground m-0 rounded-lg border px-4 py-3 text-sm break-words"
                role="alert"
                data-slot="file-error"
              >
                {{ err | ofText }}
              </p>
            }
          </section>

          <!-- 3. The options -->
          <section
            class="border-border bg-card flex min-w-0 flex-col gap-3 rounded-lg border px-5 py-4"
            data-slot="step-options"
            aria-labelledby="import-step-options"
          >
            <h2 id="import-step-options" class="m-0 text-base font-semibold">
              {{ 'editor.admin.import.steps.options' | transloco }}
            </h2>
            @if (fields().length === 0) {
              <p class="text-muted-foreground m-0 text-sm break-words">
                {{ 'editor.admin.import.options.none' | transloco }}
              </p>
            }
            <of-import-options
              [fields]="fields()"
              [values]="values()"
              [problems]="problems()"
              [shown]="shownProblems()"
              [updateExisting]="updateExisting()"
              [disabled]="busy()"
              (optionChange)="changeOption($event)"
              (updateExistingChange)="updateExisting.set($event)"
            />
          </section>

          <div
            class="flex min-w-0 flex-wrap items-center justify-end gap-3"
            data-slot="setup-actions"
          >
            @if (uploading()) {
              <div
                class="flex min-w-0 flex-1 flex-col gap-1"
                data-slot="upload-progress"
              >
                <span class="text-muted-foreground text-sm" role="status">{{
                  uploadPercent() === null
                    ? ('editor.admin.import.upload.checking' | transloco)
                    : ('editor.admin.import.upload.sending'
                      | transloco: { percent: uploadPercent() })
                }}</span>
                <span
                  class="bg-muted h-1.5 w-full overflow-hidden rounded-full"
                  role="progressbar"
                  aria-valuemin="0"
                  aria-valuemax="100"
                  [attr.aria-valuenow]="uploadPercent() ?? 100"
                  [attr.aria-label]="
                    'editor.admin.import.upload.label' | transloco
                  "
                >
                  <span
                    class="bg-primary block h-full rounded-full transition-[width] duration-200 motion-reduce:transition-none"
                    [class.animate-pulse]="uploadPercent() === null"
                    [style.width.%]="uploadPercent() ?? 100"
                  ></span>
                </span>
              </div>
            }
            @if (doc()) {
              <button
                z-button
                zType="ghost"
                type="button"
                data-slot="back-to-report"
                [zDisabled]="uploading()"
                (click)="setupShown.set(false)"
              >
                {{ 'editor.admin.import.setup.back' | transloco }}
              </button>
            }
            <button
              z-button
              type="button"
              data-slot="dry-run"
              [zLoading]="uploading()"
              [ofGuard]="{
                permission: 'admin.roles',
                blockedReason: dryRunBlocked(),
              }"
              (click)="dryRun()"
            >
              {{ 'editor.admin.import.setup.dryRun' | transloco }}
            </button>
          </div>
        </div>
      </of-collapse>

      @if (!setupOpen()) {
        @if (doc(); as d) {
          @let a = d.data.attributes;
          <section
            class="border-border flex min-w-0 flex-wrap items-center gap-3 rounded-lg border border-dashed px-4 py-3 animate-in fade-in-0 motion-reduce:animate-none"
            data-slot="summary"
            [attr.aria-label]="'editor.admin.import.summary.label' | transloco"
          >
            <ng-icon
              name="lucideFileArchive"
              class="text-muted-foreground size-5 shrink-0"
              aria-hidden="true"
            />
            <div class="flex min-w-0 flex-1 flex-col gap-0.5">
              <span class="font-medium break-words [overflow-wrap:anywhere]">{{
                a.fileName ??
                  ('editor.admin.import.summary.unnamed' | transloco)
              }}</span>
              <span
                class="text-muted-foreground text-sm break-words"
                data-slot="summary-meta"
                >{{ summaryMeta() }}</span
              >
            </div>
            @if (phase() === 'report' || phase() === 'expired') {
              <button
                z-button
                zType="ghost"
                type="button"
                data-slot="change"
                [zDisabled]="busy()"
                (click)="changeSetup()"
              >
                {{ 'editor.admin.import.summary.change' | transloco }}
              </button>
            }
          </section>
        }
      }

      @if (!setupOpen()) {
        @switch (phase()) {
          @case ('loading') {
            <div
              class="bg-muted h-24 animate-pulse rounded-lg motion-reduce:animate-none"
              ofFadeIn="delayed"
              role="status"
              [attr.aria-label]="'editor.admin.import.loading' | transloco"
            ></div>
          }
          @case ('gone') {
            <div
              class="border-warning/40 bg-warning-muted flex min-w-0 flex-wrap items-center gap-3 rounded-lg border px-4 py-3 text-sm animate-in fade-in-0 motion-reduce:animate-none"
              role="status"
              data-slot="gone"
            >
              <ng-icon
                name="lucideClock"
                class="text-warning shrink-0"
                aria-hidden="true"
              />
              <span class="min-w-0 flex-1 break-words">{{
                'editor.admin.import.gone' | transloco
              }}</span>
              <button
                z-button
                zType="outline"
                zSize="sm"
                type="button"
                (click)="startOver()"
              >
                {{ 'editor.admin.import.startOver' | transloco }}
              </button>
            </div>
          }
          @case ('expired') {
            <div
              class="border-warning/40 bg-warning-muted flex min-w-0 flex-wrap items-center gap-3 rounded-lg border px-4 py-3 text-sm animate-in fade-in-0 motion-reduce:animate-none"
              role="status"
              data-slot="expired"
            >
              <ng-icon
                name="lucideClock"
                class="text-warning shrink-0"
                aria-hidden="true"
              />
              <span class="min-w-0 flex-1 break-words">{{
                (file()
                  ? 'editor.admin.import.expired.withFile'
                  : 'editor.admin.import.expired.withoutFile'
                ) | transloco
              }}</span>
              <button
                z-button
                zType="outline"
                zSize="sm"
                type="button"
                data-slot="run-again"
                [zLoading]="uploading()"
                (click)="runAgain()"
              >
                {{
                  (file()
                    ? 'editor.admin.import.expired.again'
                    : 'editor.admin.import.expired.choose'
                  ) | transloco
                }}
              </button>
            </div>
          }
          @case ('applying') {
            @if (doc(); as d) {
              @let p = d.data.meta.progress;
              <section
                class="border-border bg-card flex min-w-0 flex-col gap-3 rounded-lg border px-5 py-4 animate-in fade-in-0 motion-reduce:animate-none"
                data-slot="applying"
                aria-labelledby="import-applying"
                aria-busy="true"
              >
                <div class="flex min-w-0 items-center gap-2">
                  <ng-icon
                    name="lucideLoaderCircle"
                    class="text-muted-foreground size-5 shrink-0 animate-spin motion-reduce:animate-none"
                    aria-hidden="true"
                  />
                  <h2 id="import-applying" class="m-0 text-base font-semibold">
                    {{ 'editor.admin.import.progress.title' | transloco }}
                  </h2>
                </div>
                <p class="m-0 text-sm" role="status" data-slot="phase">
                  {{ phaseText[p.phase] | transloco }}
                </p>
                <span
                  class="bg-muted h-1.5 w-full overflow-hidden rounded-full"
                  role="progressbar"
                  aria-valuemin="0"
                  aria-valuemax="100"
                  [attr.aria-valuenow]="applyPercentOf(p)"
                  [attr.aria-label]="
                    'editor.admin.import.progress.label' | transloco
                  "
                >
                  <span
                    class="bg-primary block h-full rounded-full transition-[width] duration-300 motion-reduce:transition-none"
                    [style.width.%]="applyPercentOf(p)"
                  ></span>
                </span>
                <ul
                  class="text-muted-foreground m-0 flex list-none flex-col gap-0.5 p-0 text-sm"
                >
                  <li data-slot="progress-assets">
                    {{
                      'editor.admin.import.progress.assets'
                        | transloco
                          : { done: p.assets.done, total: p.assets.total }
                    }}
                  </li>
                  <li data-slot="progress-files">
                    {{
                      'editor.admin.import.progress.files'
                        | transloco
                          : { done: p.files.done, total: p.files.total }
                    }}
                  </li>
                  <li data-slot="progress-commits">
                    {{
                      'editor.admin.import.progress.commits'
                        | transloco: { count: p.commits.length }
                    }}
                  </li>
                </ul>
              </section>
            }
          }
          @case ('done') {
            @if (doc(); as d) {
              <section
                class="border-success/40 bg-success-muted flex min-w-0 flex-col gap-3 rounded-lg border px-5 py-4 animate-in fade-in-0 motion-reduce:animate-none"
                data-slot="done"
                role="status"
              >
                <div class="flex min-w-0 items-start gap-3">
                  <ng-icon
                    name="lucideCircleCheck"
                    class="text-success mt-0.5 size-5 shrink-0"
                    aria-hidden="true"
                  />
                  <div class="flex min-w-0 flex-col gap-1">
                    <h2 class="m-0 text-base font-semibold">
                      {{ 'editor.admin.import.done.title' | transloco }}
                    </h2>
                    <p class="m-0 text-sm break-words">
                      {{
                        'editor.admin.import.done.text'
                          | transloco
                            : {
                                count: written(),
                                commits: d.data.meta.progress.commits.length,
                                title: changeSetTitle() ?? fallbackTitle(),
                              }
                      }}
                    </p>
                  </div>
                </div>
                <div class="flex flex-wrap gap-2">
                  @if (changeSetId(); as cs) {
                    <a
                      z-button
                      data-slot="open-review"
                      [routerLink]="['/review']"
                      [queryParams]="{ cs }"
                      >{{
                        'editor.admin.import.done.openReview' | transloco
                      }}</a
                    >
                  }
                  <button
                    z-button
                    zType="outline"
                    type="button"
                    data-slot="another"
                    (click)="another()"
                  >
                    {{ 'editor.admin.import.done.another' | transloco }}
                  </button>
                </div>
              </section>
            }
          }
          @case ('failed') {
            @if (doc(); as d) {
              <section
                class="border-destructive/40 bg-destructive-muted flex min-w-0 flex-col gap-3 rounded-lg border px-5 py-4 animate-in fade-in-0 motion-reduce:animate-none"
                data-slot="failed"
                role="alert"
              >
                <div class="flex min-w-0 items-start gap-3">
                  <ng-icon
                    name="lucideCircleAlert"
                    class="text-destructive mt-0.5 size-5 shrink-0"
                    aria-hidden="true"
                  />
                  <div class="flex min-w-0 flex-col gap-1">
                    <h2 class="m-0 text-base font-semibold">
                      {{ 'editor.admin.import.failure.title' | transloco }}
                    </h2>
                    <p class="m-0 text-sm break-words">
                      {{ failureKey() | transloco }}
                      @if (d.data.meta.failure; as f) {
                        <code class="font-mono text-xs">({{ f.code }})</code>
                      }
                    </p>
                  </div>
                </div>
                <div class="flex flex-wrap gap-2">
                  @if (changeSetId(); as cs) {
                    <a
                      z-button
                      zType="outline"
                      [routerLink]="['/review']"
                      [queryParams]="{ cs }"
                      >{{
                        'editor.admin.import.done.openReview' | transloco
                      }}</a
                    >
                  }
                  <button
                    z-button
                    type="button"
                    data-slot="run-again"
                    [zLoading]="uploading()"
                    (click)="runAgain()"
                  >
                    {{
                      (file()
                        ? 'editor.admin.import.expired.again'
                        : 'editor.admin.import.expired.choose'
                      ) | transloco
                    }}
                  </button>
                </div>
              </section>
            }
          }
        }

        @if (phase() === 'report' || phase() === 'expired') {
          @if (doc(); as d) {
            @let report = d.data.meta.report;
            @let counts = report.counts;
            <div
              class="grid min-w-0 grid-cols-2 gap-3 sm:grid-cols-5"
              data-slot="counts"
              role="group"
              [attr.aria-label]="'editor.admin.import.counts.label' | transloco"
            >
              <div
                class="bg-success-muted flex min-w-0 flex-col gap-0.5 rounded-lg px-4 py-3"
                data-slot="count-create"
              >
                <span
                  class="text-success flex items-center gap-1.5 text-2xl font-semibold tabular-nums"
                  ><ng-icon
                    name="lucideCirclePlus"
                    class="size-4"
                    aria-hidden="true"
                  />{{ counts.create }}</span
                >
                <span class="text-sm break-words">{{
                  'editor.admin.import.counts.create'
                    | transloco: { count: counts.create }
                }}</span>
              </div>
              <div
                class="bg-info-muted flex min-w-0 flex-col gap-0.5 rounded-lg px-4 py-3"
                data-slot="count-update"
              >
                <span
                  class="text-info flex items-center gap-1.5 text-2xl font-semibold tabular-nums"
                  ><ng-icon
                    name="lucideRefreshCw"
                    class="size-4"
                    aria-hidden="true"
                  />{{ counts.update }}</span
                >
                <span class="text-sm break-words">{{
                  'editor.admin.import.counts.update'
                    | transloco: { count: counts.update }
                }}</span>
              </div>
              <div
                class="bg-muted flex min-w-0 flex-col gap-0.5 rounded-lg px-4 py-3"
                data-slot="count-skip"
              >
                <span
                  class="text-foreground flex items-center gap-1.5 text-2xl font-semibold tabular-nums"
                  ><ng-icon
                    name="lucideCircleMinus"
                    class="size-4"
                    aria-hidden="true"
                  />{{ counts.skip }}</span
                >
                <span class="text-sm break-words">{{
                  'editor.admin.import.counts.skip'
                    | transloco: { count: counts.skip }
                }}</span>
              </div>
              <div
                class="bg-destructive-muted flex min-w-0 flex-col gap-0.5 rounded-lg px-4 py-3"
                data-slot="count-refuse"
              >
                <span
                  class="text-destructive flex items-center gap-1.5 text-2xl font-semibold tabular-nums"
                  ><ng-icon
                    name="lucideBan"
                    class="size-4"
                    aria-hidden="true"
                  />{{ counts.refuse }}</span
                >
                <span class="text-sm break-words">{{
                  'editor.admin.import.counts.refuse'
                    | transloco: { count: counts.refuse }
                }}</span>
              </div>
              <div
                class="bg-muted flex min-w-0 flex-col gap-0.5 rounded-lg px-4 py-3"
                data-slot="count-passthrough"
              >
                <span
                  class="text-foreground text-2xl font-semibold tabular-nums"
                  >{{ counts.passthrough }}</span
                >
                <span class="text-sm break-words">{{
                  'editor.admin.import.counts.passthrough'
                    | transloco: { count: counts.passthrough }
                }}</span>
              </div>
            </div>

            @if (bundleFindings().length > 0) {
              <section
                class="border-border flex min-w-0 flex-col rounded-lg border"
                data-slot="bundle-findings"
              >
                <button
                  type="button"
                  class="hover:bg-muted/50 focus-visible:ring-ring/50 flex min-w-0 items-center justify-between gap-2 rounded-lg px-4 py-2.5 text-start text-sm font-medium transition-colors duration-150 outline-none focus-visible:ring-2 motion-reduce:transition-none"
                  [attr.aria-expanded]="findingsOpen()"
                  aria-controls="import-bundle-findings"
                  (click)="findingsOpen.set(!findingsOpen())"
                >
                  <span class="min-w-0 break-words">{{
                    'editor.admin.import.bundle.title'
                      | transloco: { count: bundleFindings().length }
                  }}</span>
                  @if (hasBundleErrors()) {
                    <span
                      class="text-destructive flex shrink-0 items-center gap-1 text-xs"
                    >
                      <ng-icon name="lucideCircleAlert" aria-hidden="true" />{{
                        'editor.admin.import.bundle.hasErrors' | transloco
                      }}
                    </span>
                  }
                </button>
                <of-collapse [open]="findingsOpen()">
                  <ul
                    id="import-bundle-findings"
                    class="border-border m-0 flex list-none flex-col gap-1.5 border-t px-4 py-3 text-sm"
                  >
                    @for (line of bundleFindings(); track $index) {
                      <li class="min-w-0 break-words [overflow-wrap:anywhere]">
                        <span
                          class="font-medium"
                          [class.text-destructive]="line.severity === 'error'"
                          >{{ line.label | transloco }}:</span
                        >
                        {{ line.text }}
                        @if (line.code) {
                          <code class="text-muted-foreground font-mono text-xs"
                            >({{ line.code }})</code
                          >
                        }
                      </li>
                    }
                  </ul>
                </of-collapse>
              </section>
            }

            <of-import-items
              [report]="report"
              [result]="view.get('result')()"
              [page]="view.get('page')()"
              [size]="view.get('size')()"
              (resultChange)="view.set({ result: $event, page: 1 })"
              (pageChange)="view.set({ page: $event })"
              (pageSizeChange)="view.set({ size: $event, page: 1 })"
            />

            <div
              class="flex flex-wrap items-center justify-end gap-2"
              data-slot="actions"
            >
              <button
                z-button
                zType="ghost"
                type="button"
                data-slot="start-over"
                [zDisabled]="busy()"
                (click)="startOver()"
              >
                {{ 'editor.admin.import.startOver' | transloco }}
              </button>
              @if (leaveOutOffered()) {
                <button
                  z-button
                  type="button"
                  data-slot="import-rest"
                  [zLoading]="applying()"
                  [ofGuard]="{
                    permission: 'admin.roles',
                    blockedReason: leaveOutBlocked(),
                  }"
                  (click)="importRest()"
                >
                  {{
                    'editor.admin.import.leaveOut.action'
                      | transloco: { count: written() }
                  }}
                </button>
              } @else {
                <button
                  z-button
                  type="button"
                  data-slot="apply"
                  [zLoading]="applying()"
                  [ofGuard]="{
                    permission: 'admin.roles',
                    blockedReason: applyBlocked(),
                  }"
                  (click)="apply()"
                >
                  {{
                    'editor.admin.import.apply'
                      | transloco: { count: written() }
                  }}
                </button>
              }
            </div>
          }
        }
      }
    }
  `,
})
export class ImportPage {
  protected readonly sandbox = inject(SandboxSession);
  private readonly api = inject(ApiClient);
  private readonly upload = inject(ImportUpload);
  private readonly toast = inject(ToastService);
  private readonly dialogs = inject(ZardAlertDialogService);
  private readonly language = inject(LanguageService);
  private readonly help = inject(HelpService);
  private readonly permissions = inject(PermissionService);
  private readonly t = injectTranslate();
  /** The effect in `leave` runs outside the constructor. */
  private readonly injector = inject(Injector);
  private readonly me = inject(MeService).me;
  private readonly personId = computed(() => this.me().id);
  protected readonly view = injectQueryState(IMPORT_SCREEN_PARAMS);
  protected readonly accepted = ACCEPTED_FILES;
  protected readonly documented = DOCUMENTED_IMPORTER;
  protected readonly phaseText = PHASE_TEXT;

  protected readonly importers = signal<readonly Importer[] | null>(null);
  protected readonly importersError = signal<ApiError | null>(null);

  protected readonly file = signal<File | null>(null);
  protected readonly fileError = signal<TranslatedText | null>(null);
  protected readonly dragging = signal(false);
  protected readonly values = signal<OptionValues>({});
  /** The fields whose problem shows: changed ones, or all once the form was sent. */
  protected readonly shownProblems = signal<ReadonlySet<string> | 'all'>(
    new Set(),
  );
  protected readonly updateExisting = signal(false);

  protected readonly uploading = signal(false);
  /** The upload's share sent; null once sent, while the server checks it. */
  protected readonly uploadPercent = signal<number | null>(0);

  /** The stored import shown: its report, then its progress. */
  protected readonly doc = signal<ImportDoc | null>(null);
  private readonly gone = signal(false);
  protected readonly applying = signal(false);
  /** The setup is open again over a report ("Change"). */
  protected readonly setupShown = signal(false);
  protected readonly findingsOpen = signal(false);
  protected readonly changeSetTitle = signal<string | null>(null);
  private readonly now = signal(Date.now());
  /** Invalidates an upload, a load or a poll in flight when another starts or the page goes. */
  private runs = 0;
  /** Counts uploads: only the latest one ends `uploading`, whatever else the page did meanwhile. */
  private uploads = 0;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;

  protected readonly importerId = computed((): string | null => {
    const list = this.importers();
    const chosen = this.view.get('importer')();
    if (!list) return chosen ?? null;
    return list.some((i) => i.id === chosen)
      ? (chosen ?? null)
      : (list[0]?.id ?? null);
  });
  protected readonly importer = computed(
    () => this.importers()?.find((i) => i.id === this.importerId()) ?? null,
  );
  protected readonly fields = computed(() =>
    optionFields(this.importer()?.meta.optionsSchema),
  );
  protected readonly problems = computed(() =>
    problemsOf(this.fields(), this.values()),
  );
  protected readonly formatLink = computed(() =>
    this.help.link(FORMAT_ARTICLE),
  );

  protected readonly phase = computed((): Phase => {
    const id = this.view.get('import')();
    if (!id) return 'setup';
    if (this.gone()) return 'gone';
    const d = this.doc();
    if (!d || d.data.id !== id) return 'loading';
    switch (d.data.attributes.state) {
      case 'applying':
        return 'applying';
      case 'applied':
        return 'done';
      case 'failed':
        return 'failed';
      default:
        return expired(d.data, this.now()) ? 'expired' : 'report';
    }
  });

  /** The setup steps show: no import yet, or "Change" was chosen over its report. */
  protected readonly setupOpen = computed(
    () => this.phase() === 'setup' || this.setupShown(),
  );

  /** An upload or an apply is under way: the steps wait. */
  protected readonly busy = computed(() => this.uploading() || this.applying());

  protected readonly importersErrorText = computed(() => {
    const err = this.importersError();
    return err ? importErrorText(err) : null;
  });

  /** Importing needs `content.edit` too (in some role), beside `admin.roles`. */
  private readonly noEdit = computed(
    () =>
      this.permissions.state({ permission: 'content.edit' }).kind === 'hidden',
  );

  protected readonly dryRunBlocked = computed((): string | null => {
    if (this.noEdit()) return 'editor.admin.import.blocked.noEdit';
    if (!this.importer()) return 'editor.admin.import.blocked.noImporter';
    if (!this.file()) return 'editor.admin.import.blocked.noFile';
    return null;
  });

  protected readonly written = computed(() => {
    const d = this.doc();
    return d ? writtenCount(d.data.meta.report) : 0;
  });

  protected readonly hasBundleErrors = computed(() => {
    const d = this.doc();
    return d ? bundleErrors(d.data.meta.report).length > 0 : false;
  });

  /**
   * The report offers to import the rest without its refused items: the server says the rest
   * stands without them, for any importer.
   */
  protected readonly leaveOutOffered = computed(() => {
    const report = this.doc()?.data.meta.report;
    return !!report && !report.applicable && report.applicableWithoutRefused;
  });

  protected readonly leaveOutBlocked = computed((): string | null => {
    if (this.noEdit()) return 'editor.admin.import.blocked.noEdit';
    if (this.phase() !== 'report') return 'editor.admin.import.blocked.expired';
    if (this.uploading()) return 'editor.admin.import.blocked.checking';
    return null;
  });

  /** Why Import cannot run now (a translation key), or null. */
  protected readonly applyBlocked = computed((): string | null => {
    const d = this.doc();
    if (this.noEdit()) return 'editor.admin.import.blocked.noEdit';
    if (this.phase() !== 'report' || !d)
      return 'editor.admin.import.blocked.expired';
    const report = d.data.meta.report;
    if (bundleErrors(report).length > 0)
      return 'editor.admin.import.blocked.bundleErrors';
    if (writtenCount(report) === 0)
      return 'editor.admin.import.blocked.nothing';
    if (report.counts.refuse > 0) return 'editor.admin.import.blocked.refused';
    if (!report.applicable) return 'editor.admin.import.blocked.notApplicable';
    if (this.uploading()) return 'editor.admin.import.blocked.checking';
    return null;
  });

  /** The bundle's own findings and the converter's notes that belong to no item. */
  protected readonly bundleFindings = computed(() => {
    const d = this.doc();
    if (!d) return [];
    const report = d.data.meta.report;
    return [
      ...report.issues.map((i) => ({
        severity: i.severity,
        label:
          i.severity === 'error'
            ? 'editor.admin.import.bundle.error'
            : i.severity === 'warning'
              ? 'editor.admin.import.bundle.warning'
              : 'editor.admin.import.bundle.info',
        code: i.code as string | null,
        text: i.message,
      })),
      ...looseNotes(report).map((n) => ({
        severity: 'info' as const,
        label: 'editor.admin.import.bundle.note',
        code: null as string | null,
        text: n.sourceId + ': ' + n.message,
      })),
    ];
  });

  protected readonly changeSetId = computed(() => {
    const d = this.doc();
    return d ? changeSetOf(d.data) : null;
  });

  protected readonly failureKey = computed(() =>
    failureText(this.doc()?.data.meta.failure?.code ?? ''),
  );

  protected readonly fallbackTitle = computed(() =>
    this.t('editor.admin.import.done.changeSet'),
  );

  protected readonly summaryMeta = computed(() => {
    const d = this.doc();
    if (!d) return '';
    const a = d.data.attributes;
    const locale = this.language.locale();
    const now = new Date(this.now());
    const parts = [
      this.importers()?.find((i) => i.id === a.importer)?.attributes.label ??
        a.importer,
      this.t('editor.admin.import.file.size', { size: this.sizeOf(a.size) }),
      this.t(
        a.updateExisting
          ? 'editor.admin.import.summary.updateExisting'
          : 'editor.admin.import.summary.keepExisting',
      ),
      this.t('editor.admin.import.summary.checked', {
        when: relativeTime(new Date(a.createdAt), now, locale),
      }),
    ];
    if (a.state === 'validated' && !expired(d.data, this.now())) {
      parts.push(
        this.t('editor.admin.import.summary.expires', {
          when: relativeTime(new Date(a.expiresAt), now, locale),
        }),
      );
    }
    return parts.join(' · ');
  });

  constructor() {
    // The importers, read again for whoever acts (#706).
    effect(() => {
      this.personId();
      untracked(() => void this.loadImporters());
    });
    const timer = setInterval(() => this.now.set(Date.now()), TICK_MS);
    inject(DestroyRef).onDestroy(() => {
      clearInterval(timer);
      this.stopPolling();
      this.runs++;
    });

    // Another importer: its options start over.
    effect(() => {
      const fields = this.fields();
      untracked(() => {
        const d = this.doc();
        this.values.set(
          d && d.data.attributes.importer === this.importerId()
            ? valuesFrom(fields, d.data.attributes.options)
            : initialValues(fields),
        );
        this.shownProblems.set(new Set());
      });
    });

    // The import the address names.
    effect(() => {
      const id = this.view.get('import')();
      untracked(() => void this.load(id));
    });

    // While it is applied: its progress, read again.
    effect(() => {
      const d = this.doc();
      const applying = d?.data.attributes.state === 'applying';
      untracked(() => {
        if (applying && d) this.poll(d.data.id);
        else this.stopPolling();
      });
    });

    // Once applied: the change set's title.
    effect(() => {
      const id = this.changeSetId();
      untracked(() => void this.loadChangeSet(id));
    });
  }

  /** For the route's `canDeactivate`: leaving with a file chosen or a dry run not imported asks once. */
  leave(): Promise<boolean> {
    if (!this.unfinished()) return Promise.resolve(true);
    return new Promise((resolve) => {
      let answered = false;
      const answer = (yes: boolean) => {
        if (answered) return;
        answered = true;
        resolve(yes);
      };
      const ref = this.dialogs.confirm({
        zTitle: this.t('editor.admin.import.leave.title'),
        zDescription: this.t('editor.admin.import.leave.description'),
        zOkText: this.t('editor.admin.import.leave.ok'),
        zCancelText: this.t('editor.admin.import.leave.cancel'),
        zOkDestructive: true,
        zOnOk: () => answer(true),
        zOnCancel: () => answer(false),
      });
      // Closed another way (Escape): the person stays.
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

  /** Something would be lost by leaving: a file chosen, an upload under way, a dry run not imported. */
  private unfinished(): boolean {
    if (this.applying()) return false;
    const phase = this.phase();
    if (phase === 'report' || this.uploading()) return true;
    return phase === 'setup' && this.file() !== null;
  }

  protected beforeUnload(event: BeforeUnloadEvent): void {
    if (this.unfinished()) event.preventDefault();
  }

  /** A file's size: kilobytes below a megabyte (a small bundle is never "0 MB"), else megabytes. */
  protected sizeOf(bytes: number): string {
    const small = Math.ceil(bytes / 1024) < 1024;
    return new Intl.NumberFormat(this.language.locale(), {
      style: 'unit',
      unit: small ? 'kilobyte' : 'megabyte',
      maximumFractionDigits: small ? 0 : 1,
    }).format(small ? Math.max(1, Math.ceil(bytes / 1024)) : megabytes(bytes));
  }

  protected applyPercentOf(
    progress: ImportDoc['data']['meta']['progress'],
  ): number {
    return applyPercent(progress);
  }

  async loadImporters(): Promise<void> {
    this.importersError.set(null);
    try {
      const doc = await firstValueFrom(
        this.api.get('/importers', {
          query: pageQuery({ number: 1, size: IMPORTERS_PAGE }),
        }),
      );
      this.importers.set(orderImporters(doc.data));
    } catch (error) {
      this.importers.set(null);
      this.importersError.set(toApiError(error));
    }
  }

  protected chooseImporter(id: string): void {
    if (this.busy() || id === this.importerId()) return;
    this.fileError.set(null);
    this.view.set({ importer: id === DOCUMENTED_IMPORTER ? undefined : id });
  }

  protected changeOption(change: OptionChange): void {
    this.values.update((v) => ({ ...v, [change.name]: change.value }));
    this.shownProblems.update((s) =>
      s === 'all' ? s : new Set([...s, change.name]),
    );
  }

  protected dragOver(event: DragEvent): void {
    if (!event.dataTransfer?.types.includes('Files')) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    this.dragging.set(true);
  }

  protected dropped(event: DragEvent): void {
    event.preventDefault();
    this.dragging.set(false);
    const file = event.dataTransfer?.files[0];
    if (file) this.choose(file);
  }

  protected picked(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    // The same file may be chosen again (after an edit).
    input.value = '';
    if (file) this.choose(file);
  }

  /** A file chosen: refused at once when it is larger than the importer takes. */
  choose(file: File): void {
    if (this.busy()) return;
    this.fileError.set(null);
    const max = this.importer()?.meta.maxBytes;
    if (max !== undefined && file.size > max) {
      this.fileError.set(
        translated('editor.admin.import.file.tooLarge', {
          size: this.sizeOf(file.size),
          max: this.sizeOf(max),
        }),
      );
      return;
    }
    this.file.set(file);
    // A file chosen to run an expired or failed import again: the setup shows it.
    if (this.phase() !== 'setup') this.setupShown.set(true);
  }

  /** The dry run: the file with the importer and its options, checked and stored. */
  async dryRun(): Promise<void> {
    const importer = this.importer();
    const file = this.file();
    if (!importer || !file || this.busy()) return;
    if (Object.keys(this.problems()).length > 0) {
      this.shownProblems.set('all');
      return;
    }
    const doc = await this.check(file, {
      importer: importer.id,
      options: optionsOf(this.fields(), this.values()),
      updateExisting: this.updateExisting(),
    });
    if (!doc) return;
    this.show(doc);
  }

  /** An expired or failed import: the same file and settings checked again, or the file chosen again. */
  protected runAgain(): void {
    const file = this.file();
    if (!file) {
      this.changeSetup();
      document.getElementById('import-file')?.click();
      return;
    }
    void this.dryRun();
  }

  /** The setup again, over the report: another file or other options make a new dry run. */
  protected changeSetup(): void {
    this.setupShown.set(true);
  }

  /** Back to the first step; the file stays chosen. */
  protected startOver(): void {
    this.setupShown.set(false);
    this.view.set({ import: undefined, result: undefined, page: 1 });
  }

  /** After an import: everything starts over. */
  protected another(): void {
    this.file.set(null);
    this.fileError.set(null);
    this.startOver();
  }

  /** Applies the stored import shown. */
  async apply(): Promise<void> {
    const d = this.doc();
    if (!d || this.applying() || this.applyBlocked()) return;
    await this.applyImport(d.data.id);
  }

  /**
   * Imports the rest without the refused items, once confirmed: applied with `skipRefused`, so the
   * server leaves out exactly the items this report refuses, and checks again that the rest still
   * stands without them.
   */
  protected importRest(): void {
    const d = this.doc();
    if (!d || this.busy() || this.leaveOutBlocked() || !this.leaveOutOffered())
      return;
    const report = d.data.meta.report;
    this.dialogs.confirm({
      zTitle: this.t('editor.admin.import.leaveOut.title'),
      zDescription: this.t('editor.admin.import.leaveOut.description', {
        refused: report.counts.refuse,
        count: writtenCount(report),
      }),
      zOkText: this.t('editor.admin.import.leaveOut.ok'),
      zCancelText: this.t('editor.admin.import.leaveOut.cancel'),
      zOnOk: () => void this.applyImport(d.data.id, true),
    });
  }

  /** Uploads and checks `file`; the stored import, or null when it failed (said under the file). */
  private async check(file: File, form: ImportForm): Promise<ImportDoc | null> {
    this.uploading.set(true);
    this.uploadPercent.set(0);
    this.fileError.set(null);
    const run = ++this.runs;
    const upload = ++this.uploads;
    try {
      const answer = await firstValueFrom(
        this.upload.check(file, file.name, form).pipe(
          tap((event) => {
            if (upload !== this.uploads) return;
            if (event.type === HttpEventType.UploadProgress) {
              const total = event.total ?? file.size;
              const percent =
                total > 0 ? Math.round((event.loaded / total) * 100) : 100;
              this.uploadPercent.set(percent >= 100 ? null : percent);
            }
          }),
          filter((event) => event.type === HttpEventType.Response),
        ),
      );
      if (run !== this.runs) return null;
      return answer.type === HttpEventType.Response
        ? (answer.body ?? null)
        : null;
    } catch (error) {
      if (run !== this.runs) return null;
      const text = importErrorText(toApiError(error));
      this.fileError.set(text);
      // The setup shows the error where the file is.
      if (this.phase() !== 'setup') this.setupShown.set(true);
      return null;
    } finally {
      // Never left on: the page may have moved on (Back, say), but the upload has ended.
      if (upload === this.uploads) {
        this.uploading.set(false);
        this.uploadPercent.set(0);
      }
    }
  }

  /** Shows a stored import's report, in a new history entry. */
  private show(doc: ImportDoc): void {
    this.gone.set(false);
    this.changeSetTitle.set(null);
    this.setupShown.set(false);
    this.findingsOpen.set(bundleErrors(doc.data.meta.report).length > 0);
    this.now.set(Date.now());
    this.doc.set(doc);
    this.view.set({ import: doc.data.id, result: undefined, page: 1 });
  }

  /** Applies the stored import `id`; with `skipRefused`, without the items its report refuses. */
  private async applyImport(id: string, skipRefused = false): Promise<void> {
    if (this.applying()) return;
    this.applying.set(true);
    try {
      const done = await firstValueFrom(
        this.api.act(
          '/imports/{importId}/apply',
          { path: { importId: id } },
          skipRefused ? { meta: { skipRefused: true } } : undefined,
        ),
      );
      // Another import was opened meanwhile.
      if (this.doc()?.data.id !== id) return;
      this.doc.set(done);
    } catch (error) {
      const failure = toApiError(error);
      if (failure.kind === 'not-found') this.gone.set(true);
      else if (failure.code === 'invalid-state') void this.load(id, true);
      this.toast.error(importErrorText(failure));
    } finally {
      this.applying.set(false);
    }
  }

  private async load(id: string | undefined, again = false): Promise<void> {
    if (!id) {
      this.runs++;
      this.stopPolling();
      this.doc.set(null);
      this.gone.set(false);
      this.changeSetTitle.set(null);
      return;
    }
    if (!again && this.doc()?.data.id === id) return;
    const run = ++this.runs;
    this.gone.set(false);
    if (this.doc()?.data.id !== id) this.doc.set(null);
    try {
      const doc = await firstValueFrom(
        this.api.get('/imports/{importId}', { path: { importId: id } }),
      );
      if (run !== this.runs) return;
      this.doc.set(doc);
      this.now.set(Date.now());
      this.updateExisting.set(doc.data.attributes.updateExisting);
      if (doc.data.attributes.importer !== this.importerId()) {
        this.view.set(
          {
            importer:
              doc.data.attributes.importer === DOCUMENTED_IMPORTER
                ? undefined
                : doc.data.attributes.importer,
          },
          { replace: true },
        );
      } else {
        this.values.set(valuesFrom(this.fields(), doc.data.attributes.options));
      }
    } catch (error) {
      if (run !== this.runs) return;
      const failure = toApiError(error);
      if (failure.kind === 'not-found') {
        this.gone.set(true);
      } else {
        this.toast.error(importErrorText(failure));
        this.gone.set(true);
      }
    }
  }

  private poll(id: string): void {
    if (this.pollTimer !== null) return;
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      void this.readProgress(id);
    }, POLL_MS);
  }

  private stopPolling(): void {
    if (this.pollTimer !== null) clearTimeout(this.pollTimer);
    this.pollTimer = null;
  }

  private async readProgress(id: string): Promise<void> {
    try {
      const doc = await firstValueFrom(
        this.api.get('/imports/{importId}', { path: { importId: id } }),
      );
      if (this.doc()?.data.id !== id) return;
      this.doc.set(doc);
    } catch (error) {
      if (this.doc()?.data.id !== id) return;
      const failure = toApiError(error);
      if (failure.kind === 'not-found') {
        this.gone.set(true);
        return;
      }
      // A passing failure (the network): read again.
      this.poll(id);
    }
  }

  private async loadChangeSet(id: string | null): Promise<void> {
    if (!id) return;
    try {
      const doc = await firstValueFrom(
        this.api.get('/change-sets/{changeSetId}', {
          path: { changeSetId: id },
        }),
      );
      if (this.changeSetId() === id) {
        this.changeSetTitle.set(doc.data.attributes.title);
      }
    } catch {
      // "The new revision" stands in for its title.
    }
  }
}
