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
  lucideCircleCheck,
  lucideClock,
  lucideFileText,
  lucideLoaderCircle,
  lucideUpload,
} from '@ng-icons/lucide';
import { firstValueFrom } from 'rxjs';

import { ZardAlertDialogService } from '@openfolia/ui/alert-dialog';
import { ZardButtonComponent } from '@openfolia/ui/button';
import {
  injectTranslate,
  LanguageService,
  relativeTime,
  TextPipe,
  translated,
  type TranslatedText,
} from '@openfolia/ui/i18n';
import {
  SegmentedComponent,
  type SegmentedOption,
} from '@openfolia/ui/segmented';
import { PageHeaderComponent } from '@openfolia/ui/shell';
import { ToastService } from '@openfolia/ui/toast';

import { ApiClient, pageQuery, toApiError, type ApiError } from '../api';
import { languageName } from '../content/browser-model';
import { GuardDirective } from '../permissions/guard.directive';
import { MeService } from '../permissions/me';
import { PermissionService } from '../permissions/permission.service';
import { injectQueryState, idParam, intParam, oneOfParam } from '../view-state';
import {
  ImportReportComponent,
  type UnitDecision,
} from './import-report.component';
import {
  ACCEPTED_FILES,
  acceptedFile,
  changedUnits,
  countOf,
  decide,
  decisionsBody,
  expired,
  IMPORT_ID_PATTERN,
  importCount,
  importErrorText,
  KEEP_ALL,
  refusedCount,
  REPORT_PAGE_SIZES,
  UNIT_STATE_TEXT,
  UNIT_STATES,
  type ChangedUnit,
  type Decisions,
  type ImportDoc,
  type UnitState,
} from './import-model';
import { TranslationImportUpload } from './translation-import-upload';
import { TranslationsSource } from './translations-source';
import { jobSubjectText, type JobItem } from './translations-model';
import { TranslationsChanges } from './translations-view';
import { SandboxOffStateComponent } from '../sandbox/sandbox-off-state.component';
import { SandboxSession } from '../sandbox/sandbox-session';

/** The import screen's view in the address: the validated import, the state shown and the page. */
export const IMPORT_PARAMS = {
  import: idParam(IMPORT_ID_PATTERN),
  state: oneOfParam(UNIT_STATES),
  page: intParam(1),
  size: intParam(REPORT_PAGE_SIZES[0], { only: REPORT_PAGE_SIZES }),
};

/** How often the expiry is looked at again. */
const TICK_MS = 15_000;

/** The largest page the API reads (the decisions read every changed unit). */
const ALL_PAGE = 200;

type Phase = 'upload' | 'loading' | 'review' | 'expired' | 'done';

/**
 * Import translation (#244, screen 17): a translation manager uploads a translated XLIFF (or a
 * ZIP of them) of a delta export. The dry run (`POST /translations/imports`) checks it unit by
 * unit: the report counts what is ready, what needs a decision (its source changed since the
 * export) and what cannot be imported (broken markup, a block or module unknown, outside their
 * scope), lists it per module, paged and filtered by state. Each changed unit is kept (imported,
 * still outdated: the default) or skipped, one by one or all at once. Import
 * (`…/apply`) makes a change set, opened in review from here. The import, the state shown and
 * the page live in the address; the validation is kept an hour (its expiry shows, and an
 * expired one is checked again in one click). Leaving with an unapplied validation asks once.
 */
@Component({
  selector: 'of-translation-import-page',
  imports: [
    SandboxOffStateComponent,
    RouterLink,
    TranslocoPipe,
    NgIcon,
    PageHeaderComponent,
    SegmentedComponent,
    TextPipe,
    ZardButtonComponent,
    GuardDirective,
    ImportReportComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [TranslationsSource],
  viewProviders: [
    provideIcons({
      lucideCircleCheck,
      lucideClock,
      lucideFileText,
      lucideLoaderCircle,
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
        [description]="'editor.sandbox.importsOff.translations' | transloco"
      />
    } @else {
      <of-page-header
        [title]="'editor.translations.importScreen.title' | transloco"
      />

      <input
        #fileInput
        id="translation-import-file"
        type="file"
        class="sr-only"
        tabindex="-1"
        aria-hidden="true"
        [accept]="accepted"
        (change)="picked($event)"
      />

      @if (phase() === 'upload' && !validating()) {
        <label
          for="translation-import-file-zone"
          class="border-border hover:bg-muted/40 has-[:focus-visible]:ring-ring/50 flex cursor-pointer flex-col items-center gap-2 rounded-lg border-2 border-dashed px-6 py-10 text-center transition-colors duration-150 has-[:focus-visible]:ring-[3px] motion-reduce:transition-none animate-in fade-in-0 motion-reduce:animate-none"
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
            'editor.translations.importScreen.upload.title' | transloco
          }}</span>
          <span class="text-muted-foreground text-sm">{{
            'editor.translations.importScreen.upload.choose' | transloco
          }}</span>
          <span class="text-muted-foreground max-w-prose text-xs break-words">{{
            'editor.translations.importScreen.upload.hint' | transloco
          }}</span>
          <input
            id="translation-import-file-zone"
            type="file"
            class="sr-only"
            [accept]="accepted"
            (change)="picked($event)"
          />
        </label>
      } @else {
        <section
          class="border-border flex min-w-0 flex-wrap items-center gap-3 rounded-lg border border-dashed px-4 py-3 animate-in fade-in-0 motion-reduce:animate-none"
          data-slot="file"
          [attr.aria-busy]="validating() || null"
          (dragenter)="dragOver($event)"
          (dragover)="dragOver($event)"
          (dragleave)="dragging.set(false)"
          (drop)="dropped($event)"
          [class.border-primary]="dragging()"
        >
          <ng-icon
            [name]="validating() ? 'lucideLoaderCircle' : 'lucideFileText'"
            class="text-muted-foreground size-5 shrink-0 motion-reduce:animate-none"
            [class.animate-spin]="validating()"
            aria-hidden="true"
          />
          <div class="flex min-w-0 flex-1 flex-col gap-0.5">
            <span class="font-medium break-words [overflow-wrap:anywhere]">{{
              fileName() ??
                ('editor.translations.importScreen.file.unnamed' | transloco)
            }}</span>
            <span
              class="text-muted-foreground text-sm break-words"
              data-slot="file-meta"
              role="status"
            >
              @if (validating()) {
                {{
                  'editor.translations.importScreen.file.checking' | transloco
                }}
              } @else {
                {{ fileMeta() }}
              }
            </span>
          </div>
          @if (phase() !== 'done') {
            <button
              z-button
              zType="ghost"
              type="button"
              data-slot="replace"
              [zDisabled]="validating() || applying() || loading()"
              (click)="fileInput.click()"
            >
              {{ 'editor.translations.importScreen.file.replace' | transloco }}
            </button>
          }
        </section>
      }

      @if (uploadError(); as err) {
        <p
          class="border-destructive/40 bg-destructive-muted text-foreground m-0 rounded-lg border px-4 py-3 text-sm break-words"
          role="alert"
          data-slot="upload-error"
        >
          {{ err | ofText }}
        </p>
      }

      @if (phase() === 'expired') {
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
              ? 'editor.translations.importScreen.expired.withFile'
              : 'editor.translations.importScreen.expired.withoutFile'
            ) | transloco
          }}</span>
          <button
            z-button
            zType="outline"
            zSize="sm"
            type="button"
            data-slot="revalidate"
            [zDisabled]="validating()"
            (click)="revalidate()"
          >
            {{
              (file()
                ? 'editor.translations.importScreen.expired.again'
                : 'editor.translations.importScreen.expired.choose'
              ) | transloco
            }}
          </button>
        </div>
      }

      @if (doc(); as d) {
        @if (phase() === 'done') {
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
                  {{
                    'editor.translations.importScreen.done.title' | transloco
                  }}
                </h2>
                <p class="m-0 text-sm break-words">
                  @if (imported() !== null) {
                    {{
                      'editor.translations.importScreen.done.counted'
                        | transloco
                          : {
                              count: imported(),
                              title: changeSetTitle() ?? fallbackTitle(),
                            }
                    }}
                  } @else {
                    {{
                      'editor.translations.importScreen.done.text'
                        | transloco
                          : { title: changeSetTitle() ?? fallbackTitle() }
                    }}
                  }
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
                    'editor.translations.importScreen.done.openReview'
                      | transloco
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
                {{
                  'editor.translations.importScreen.done.another' | transloco
                }}
              </button>
            </div>
          </section>
        } @else {
          @let counts = d.data.meta.counts;
          <div
            class="grid min-w-0 gap-3 sm:grid-cols-3"
            data-slot="counts"
            [attr.aria-label]="
              'editor.translations.importScreen.counts.label' | transloco
            "
            role="group"
          >
            <div
              class="bg-success-muted flex min-w-0 flex-col gap-0.5 rounded-lg px-4 py-3"
              data-slot="count-ready"
            >
              <span class="text-success text-2xl font-semibold tabular-nums">{{
                counts.ok
              }}</span>
              <span class="text-sm break-words">{{
                'editor.translations.importScreen.counts.ready'
                  | transloco: { count: counts.ok }
              }}</span>
            </div>
            <div
              class="bg-muted flex min-w-0 flex-col gap-0.5 rounded-lg px-4 py-3"
              data-slot="count-decide"
            >
              <span class="text-warning text-2xl font-semibold tabular-nums">{{
                counts.sourceChanged
              }}</span>
              <span class="text-sm break-words">{{
                'editor.translations.importScreen.counts.decide'
                  | transloco: { count: counts.sourceChanged }
              }}</span>
            </div>
            <div
              class="bg-destructive-muted flex min-w-0 flex-col gap-0.5 rounded-lg px-4 py-3"
              data-slot="count-refused"
            >
              <span
                class="text-destructive text-2xl font-semibold tabular-nums"
                >{{ refused() }}</span
              >
              <span class="text-sm break-words">{{
                'editor.translations.importScreen.counts.refused'
                  | transloco: { count: refused() }
              }}</span>
            </div>
          </div>

          <div
            class="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center sm:justify-between"
          >
            <of-segmented
              data-slot="state-filter"
              [options]="filterOptions()"
              [value]="view.get('state')() ?? 'all'"
              (valueChange)="filter($event)"
              [label]="
                'editor.translations.importScreen.filter.label' | transloco
              "
            />
            @if (counts.sourceChanged > 0) {
              <div class="flex flex-wrap items-center gap-2">
                <span
                  class="text-muted-foreground text-sm"
                  data-slot="skipped"
                  >{{
                    'editor.translations.importScreen.decide.skipped'
                      | transloco
                        : { count: skipped(), total: counts.sourceChanged }
                  }}</span
                >
                <button
                  z-button
                  zType="outline"
                  zSize="sm"
                  type="button"
                  data-slot="keep-all"
                  [zDisabled]="applying() || allAre('keep')"
                  (click)="setAll('keep')"
                >
                  {{
                    'editor.translations.importScreen.decide.keepAll'
                      | transloco
                  }}
                </button>
                <button
                  z-button
                  zType="outline"
                  zSize="sm"
                  type="button"
                  data-slot="skip-all"
                  [zDisabled]="applying() || allAre('skip')"
                  (click)="setAll('skip')"
                >
                  {{
                    'editor.translations.importScreen.decide.skipAll'
                      | transloco
                  }}
                </button>
              </div>
            }
          </div>

          <of-import-report
            [modules]="d.data.meta.report"
            [page]="d.meta.page"
            [loading]="loading()"
            [error]="frameError()"
            [filtered]="view.get('state')() !== undefined"
            [decisions]="decisions()"
            [sourceLang]="source.sourceLang()"
            (pageChange)="turn({ page: $event })"
            (pageSizeChange)="turn({ size: $event, page: 1 })"
            (retry)="reload()"
            (decide)="decideUnit($event)"
          />

          <div
            class="flex flex-wrap items-center justify-end gap-2"
            data-slot="actions"
          >
            <a z-button zType="ghost" [routerLink]="['/translations']">{{
              'editor.translations.importScreen.cancel' | transloco
            }}</a>
            <button
              z-button
              type="button"
              data-slot="apply"
              [zLoading]="applying()"
              [ofGuard]="{
                permission: 'translation.manage',
                blockedReason: applyBlocked(),
              }"
              (click)="apply()"
            >
              {{
                'editor.translations.importScreen.apply'
                  | transloco: { count: toImport() }
              }}
            </button>
          </div>
        }
      } @else if (phase() === 'loading') {
        <div
          class="bg-muted h-24 animate-pulse rounded-lg motion-reduce:animate-none"
          role="status"
          [attr.aria-label]="
            'editor.translations.importScreen.loading' | transloco
          "
        ></div>
      } @else if (failure(); as f) {
        <p
          class="border-destructive/40 bg-destructive-muted m-0 flex flex-wrap items-center gap-3 rounded-lg border px-4 py-3 text-sm"
          role="alert"
        >
          <span class="min-w-0 flex-1 break-words">{{
            failureText() | ofText
          }}</span>
          <button
            z-button
            zType="outline"
            zSize="sm"
            type="button"
            (click)="reload()"
          >
            {{ 'editor.translations.importScreen.retry' | transloco }}
          </button>
        </p>
      }
    }
  `,
})
export class TranslationImportPage {
  protected readonly sandbox = inject(SandboxSession);
  private readonly api = inject(ApiClient);
  private readonly upload = inject(TranslationImportUpload);
  private readonly toast = inject(ToastService);
  private readonly dialogs = inject(ZardAlertDialogService);
  private readonly language = inject(LanguageService);
  private readonly permissions = inject(PermissionService);
  private readonly changes = inject(TranslationsChanges);
  private readonly t = injectTranslate();
  /** The effect in `leave` runs outside the constructor. */
  private readonly injector = inject(Injector);
  protected readonly source = inject(TranslationsSource);
  /** Who acts: a change reads the configuration and manuals again. */
  private readonly me = inject(MeService).me;
  private readonly personId = computed(() => this.me().id);
  protected readonly view = injectQueryState(IMPORT_PARAMS);
  protected readonly accepted = ACCEPTED_FILES;

  /** The file last chosen: an expired validation is checked again from it. */
  protected readonly file = signal<File | null>(null);
  protected readonly fileName = signal<string | null>(null);
  protected readonly validating = signal(false);
  protected readonly uploadError = signal<TranslatedText | null>(null);
  protected readonly dragging = signal(false);

  /** The import with the page of its report shown. */
  protected readonly doc = signal<ImportDoc | null>(null);
  protected readonly loading = signal(false);
  protected readonly failure = signal<ApiError | null>(null);
  /** The import is no longer kept (expired, or the server restarted). */
  private readonly gone = signal(false);
  private readonly reloads = signal(0);
  private readonly now = signal(Date.now());

  protected readonly decisions = signal<Decisions>(KEEP_ALL);
  protected readonly applying = signal(false);
  /** How many units the apply imported, when it ran here. */
  protected readonly imported = signal<number | null>(null);
  protected readonly changeSetTitle = signal<string | null>(null);
  private readonly job = signal<JobItem | null>(null);
  /** What the shown report page answers: `id|state|page|size`. */
  private loadedKey = '';
  /** Invalidates an upload in flight when another starts or the page goes. */
  private uploads = 0;
  /** Invalidates a report load in flight: a newer load, an upload or an apply wins. */
  private loads = 0;

  protected readonly phase = computed((): Phase => {
    const id = this.view.get('import')();
    if (!id) return 'upload';
    if (this.gone()) return 'expired';
    const d = this.doc();
    if (!d || d.data.id !== id) return 'loading';
    if (d.data.attributes.state === 'applied') return 'done';
    if (expired(d.data, this.now())) return 'expired';
    return 'review';
  });

  protected readonly refused = computed(() => {
    const d = this.doc();
    return d ? refusedCount(d.data.meta.counts) : 0;
  });
  protected readonly skipped = computed(() => {
    const d = this.doc();
    if (!d) return 0;
    const changed = d.data.meta.counts.sourceChanged;
    const { all, except } = this.decisions();
    return all === 'keep' ? except.size : changed - except.size;
  });
  protected readonly toImport = computed(() => {
    const d = this.doc();
    return d ? importCount(d.data.meta.counts, this.decisions()) : 0;
  });
  protected readonly changeSetId = computed(
    () => this.doc()?.data.relationships.changeSet.data?.id ?? null,
  );

  /** Why Import cannot run now (a translation key), or null. */
  protected readonly applyBlocked = computed((): string | null => {
    if (
      this.permissions.state({ permission: 'content.edit' }).kind === 'hidden'
    )
      return 'editor.translations.importScreen.blocked.noEdit';
    if (this.phase() !== 'review')
      return 'editor.translations.importScreen.blocked.expired';
    if (this.toImport() === 0)
      return 'editor.translations.importScreen.blocked.nothing';
    if (this.validating())
      return 'editor.translations.importScreen.blocked.checking';
    return null;
  });

  protected readonly filterOptions = computed((): SegmentedOption[] => {
    const d = this.doc();
    const counts = d?.data.meta.counts;
    const shown = this.view.get('state')();
    return [
      {
        value: 'all',
        label: this.t('editor.translations.importScreen.filter.all'),
        count: counts?.units ?? null,
      },
      ...UNIT_STATES.filter(
        (s) => s === shown || (counts && countOf(counts, s) > 0),
      ).map((s: UnitState) => ({
        value: s,
        label: this.t(UNIT_STATE_TEXT[s]),
        count: counts ? countOf(counts, s) : null,
      })),
    ];
  });

  protected readonly fileMeta = computed(() => {
    const d = this.doc();
    if (!d) return '';
    const locale = this.language.locale();
    const now = new Date(this.now());
    const parts = [
      d.data.attributes.languages
        .map((l) => languageName(locale, l))
        .join(', '),
    ];
    const job = this.job();
    if (job) {
      parts.push(
        jobSubjectText(job.attributes.subject, this.t, {
          manuals: this.source.manualTitles(),
          folders: this.source.folderLabels(),
        }),
      );
    }
    parts.push(
      this.t('editor.translations.importScreen.file.checked', {
        when: relativeTime(new Date(d.data.attributes.createdAt), now, locale),
      }),
    );
    if (d.data.attributes.state !== 'applied' && this.phase() !== 'expired') {
      parts.push(
        this.t('editor.translations.importScreen.file.expires', {
          when: relativeTime(
            new Date(d.data.attributes.expiresAt),
            now,
            locale,
          ),
        }),
      );
    }
    return parts.join(' · ');
  });

  protected readonly frameError = computed(() => {
    const f = this.failure();
    if (!f || !this.doc()) return null;
    const text = importErrorText(f);
    return { kind: f.kind, message: this.t(text.key, text.params) };
  });
  protected readonly failureText = computed(() => {
    const f = this.failure();
    return f ? importErrorText(f) : null;
  });

  protected readonly fallbackTitle = computed(() =>
    this.t('editor.translations.importScreen.done.changeSet'),
  );

  constructor() {
    // The configuration and the manuals, read again for whoever acts (#706).
    effect(() => {
      this.personId();
      untracked(() => void this.source.load());
    });
    const timer = setInterval(() => this.now.set(Date.now()), TICK_MS);
    inject(DestroyRef).onDestroy(() => {
      clearInterval(timer);
      this.uploads++;
      this.loads++;
    });

    // The report page for the address: the import, the state shown, the page and its size.
    effect(() => {
      const query = {
        id: this.view.get('import')(),
        state: this.view.get('state')(),
        page: this.view.get('page')(),
        size: this.view.get('size')(),
      };
      this.reloads();
      untracked(() => void this.load(query));
    });

    // What the file's line names: the job it came from.
    effect(() => {
      const jobId = this.doc()?.data.relationships.job.data.id;
      untracked(() => void this.loadJob(jobId));
    });

    // Once applied: the change set's title.
    effect(() => {
      const id = this.changeSetId();
      untracked(() => void this.loadChangeSet(id));
    });
  }

  /** For the route's `canDeactivate`: leaving with an unapplied validation asks once. */
  leave(): Promise<boolean> {
    if (this.phase() !== 'review' || this.applying()) {
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      let answered = false;
      const answer = (yes: boolean) => {
        if (answered) return;
        answered = true;
        resolve(yes);
      };
      const ref = this.dialogs.confirm({
        zTitle: this.t('editor.translations.importScreen.leave.title'),
        zDescription: this.t(
          'editor.translations.importScreen.leave.description',
        ),
        zOkText: this.t('editor.translations.importScreen.leave.ok'),
        zCancelText: this.t('editor.translations.importScreen.leave.cancel'),
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

  protected beforeUnload(event: BeforeUnloadEvent): void {
    if (this.phase() === 'review' && !this.applying()) event.preventDefault();
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
    if (file) void this.validate(file);
  }

  protected picked(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    // The same file may be chosen again (after an edit by the agency).
    input.value = '';
    if (file) void this.validate(file);
  }

  /** An expired validation: the file again, or a new one. */
  protected revalidate(): void {
    const file = this.file();
    if (file) {
      void this.validate(file);
    } else {
      document.getElementById('translation-import-file')?.click();
    }
  }

  /** Checks `file` (a dry run): its report becomes the page's, in a new history entry. */
  async validate(file: File): Promise<void> {
    if (this.validating() || this.applying()) return;
    this.uploadError.set(null);
    if (!acceptedFile(file.name)) {
      this.uploadError.set(
        translated('editor.translations.importScreen.fileError.type'),
      );
      return;
    }
    this.validating.set(true);
    const run = ++this.uploads;
    try {
      const size = this.view.get('size')();
      const doc = await firstValueFrom(
        this.upload.validate(file, file.name, size),
      );
      if (run !== this.uploads) return;
      // A report page still loading belongs to the import before.
      this.loads++;
      this.loading.set(false);
      this.file.set(file);
      this.fileName.set(file.name);
      this.reset();
      this.loadedKey = keyOf({
        id: doc.data.id,
        state: undefined,
        page: 1,
        size,
      });
      this.doc.set(doc);
      this.view.set({ import: doc.data.id, state: undefined, page: 1 });
    } catch (error) {
      if (run !== this.uploads) return;
      this.uploadError.set(importErrorText(toApiError(error)));
    } finally {
      if (run === this.uploads) this.validating.set(false);
    }
  }

  protected filter(value: string): void {
    const state = UNIT_STATES.find((s) => s === value);
    this.turn({ state, page: 1 });
  }

  /** Another page, size or state of the report. */
  protected turn(change: {
    state?: UnitState | undefined;
    page?: number;
    size?: number;
  }): void {
    // An upload or an apply that lands after it invalidates the load it starts.
    this.view.set(change);
  }

  protected allAre(decision: 'keep' | 'skip'): boolean {
    const { all, except } = this.decisions();
    return all === decision && except.size === 0;
  }

  /** "Keep all" or "Skip all", with Undo: the decisions before come back. */
  protected setAll(decision: 'keep' | 'skip'): void {
    const before = this.decisions();
    this.decisions.set({ all: decision, except: new Set() });
    this.toast.success(
      translated(
        decision === 'keep'
          ? 'editor.translations.importScreen.decide.keptAll'
          : 'editor.translations.importScreen.decide.skippedAll',
      ),
      {
        actionLabel: translated('ui.toast.undo'),
        onAction: () => this.decisions.set(before),
      },
    );
  }

  protected decideUnit(event: UnitDecision): void {
    this.decisions.update((d) => decide(d, event.key, event.decision));
  }

  protected reload(): void {
    this.loadedKey = '';
    this.reloads.update((n) => n + 1);
  }

  /** Starts over with another file. */
  protected another(): void {
    this.file.set(null);
    this.fileName.set(null);
    this.uploadError.set(null);
    this.view.set({ import: undefined, state: undefined, page: 1 });
  }

  /** Imports into a new change set: the units ready and the changed ones kept. */
  async apply(): Promise<void> {
    const d = this.doc();
    if (!d || this.applying() || this.applyBlocked()) return;
    this.applying.set(true);
    const count = this.toImport();
    try {
      const changed =
        d.data.meta.counts.sourceChanged > 0
          ? await this.allChanged(d.data.id)
          : [];
      const decisions = decisionsBody(this.decisions(), changed);
      const done = await firstValueFrom(
        this.api.act(
          '/translations/imports/{importId}/apply',
          { path: { importId: d.data.id } },
          decisions.length > 0 ? { meta: { decisions } } : undefined,
        ),
      );
      // A report page still loading shows the import before it was applied.
      this.loads++;
      this.loading.set(false);
      this.imported.set(count);
      this.loadedKey = keyOf({
        id: done.data.id,
        state: undefined,
        page: done.meta.page.currentPage,
        size: this.view.get('size')(),
      });
      this.doc.set(done);
      this.view.set({ state: undefined, page: 1 }, { replace: true });
      // The matrix and the jobs read again: the job's units came back.
      this.changes.notify();
      this.toast.success(
        translated('editor.translations.importScreen.done.toast', { count }),
      );
    } catch (error) {
      const failure = toApiError(error);
      if (failure.kind === 'not-found') {
        this.gone.set(true);
      } else if (failure.code === 'invalid-state') {
        this.reload();
      }
      this.toast.error(importErrorText(failure));
    } finally {
      this.applying.set(false);
    }
  }

  /** Every `source-changed` unit of the report, page by page. */
  private async allChanged(importId: string): Promise<ChangedUnit[]> {
    const units: ChangedUnit[] = [];
    for (let page = 1; ; page++) {
      const doc = await firstValueFrom(
        this.api.get('/translations/imports/{importId}', {
          path: { importId },
          query: {
            ...pageQuery({ number: page, size: ALL_PAGE }),
            'filter[state]': 'source-changed',
          },
        }),
      );
      units.push(...changedUnits(doc.data.meta.report));
      if (page >= doc.meta.page.lastPage) return units;
    }
  }

  private reset(): void {
    this.gone.set(false);
    this.failure.set(null);
    this.decisions.set(KEEP_ALL);
    this.imported.set(null);
    this.changeSetTitle.set(null);
    this.now.set(Date.now());
  }

  private async load(query: Query): Promise<void> {
    const key = keyOf(query);
    if (!query.id) {
      this.loads++;
      this.loading.set(false);
      this.loadedKey = '';
      this.doc.set(null);
      this.reset();
      return;
    }
    const run = ++this.loads;
    if (key === this.loadedKey) {
      // Back to the page shown: a load for another one no longer counts.
      this.loading.set(false);
      this.failure.set(null);
      return;
    }
    if (this.doc()?.data.id !== query.id) {
      // Another import (Back, a link): its decisions start over, and
      // nothing shown answers an address any more.
      this.loadedKey = '';
      this.doc.set(null);
      this.reset();
      this.fileName.set(null);
      this.file.set(null);
    }
    this.loading.set(true);
    this.failure.set(null);
    try {
      const doc = await firstValueFrom(
        this.api.get('/translations/imports/{importId}', {
          path: { importId: query.id },
          query: {
            ...pageQuery({ number: query.page, size: query.size }),
            ...(query.state && { 'filter[state]': query.state }),
          },
        }),
      );
      if (run !== this.loads) return;
      const last = Math.max(1, doc.meta.page.lastPage);
      if (doc.data.meta.report.length === 0 && query.page > last) {
        this.view.set({ page: last }, { replace: true });
        return;
      }
      this.loadedKey = key;
      this.doc.set(doc);
    } catch (error) {
      if (run !== this.loads) return;
      const failure = toApiError(error);
      if (failure.kind === 'not-found') this.gone.set(true);
      else this.failure.set(failure);
    } finally {
      if (run === this.loads) this.loading.set(false);
    }
  }

  private async loadJob(jobId: string | undefined): Promise<void> {
    if (!jobId) {
      this.job.set(null);
      return;
    }
    if (this.job()?.id === jobId) return;
    this.job.set(null);
    try {
      const doc = await firstValueFrom(
        this.api.get('/translations/exports/{jobId}', { path: { jobId } }),
      );
      if (this.doc()?.data.relationships.job.data.id === jobId) {
        this.job.set(doc.data);
      }
    } catch {
      // The line names the job's languages and times without it.
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
      // "The new change set" stands in for its title.
    }
  }
}

interface Query {
  readonly id: string | undefined;
  readonly state: UnitState | undefined;
  readonly page: number;
  readonly size: number;
}

const keyOf = (q: Query): string =>
  `${q.id ?? ''}|${q.state ?? ''}|${q.page}|${q.size}`;
