import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  inject,
  input,
  model,
  output,
  signal,
  untracked,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslocoPipe } from '@jsverse/transloco';
import { firstValueFrom } from 'rxjs';

import { ZardButtonComponent } from '@openfolia/ui/button';
import { ZardCheckboxComponent } from '@openfolia/ui/checkbox';
import { ZardDialogImports } from '@openfolia/ui/dialog';
import {
  injectTranslate,
  LanguageService,
  translated,
} from '@openfolia/ui/i18n';
import { ZardInputComponent } from '@openfolia/ui/input';
import { ZardRadioGroupImports } from '@openfolia/ui/radio-group';
import { ZardSelectImports } from '@openfolia/ui/select';
import { ToastService } from '@openfolia/ui/toast';

import { ApiClient, ReadRef, toApiError, type ApiError } from '../api';
import { languageName } from '../content/browser-model';
import type { FilterOption } from '../content/filter-chip.component';
import { apiErrorText } from '../i18n';
import { TranslationJobDownload } from './job-download';
import {
  exportBody,
  initialChoice,
  subjectOf,
  validDueDate,
  type JobItem,
  type JobMeta,
  type SubjectChoice,
  chosenExportText,
  mixedRows,
} from './translations-model';

/** Changes to the choices wait this long before the dry run asks again. */
const DRY_RUN_DEBOUNCE_MS = 250;

/** What the dry run says about the current choices. */
type Estimate =
  | { readonly kind: 'idle' }
  | { readonly kind: 'counting' }
  | { readonly kind: 'ready'; readonly meta: JobMeta }
  | { readonly kind: 'nothing' }
  | { readonly kind: 'error'; readonly error: ApiError };

/**
 * "Create delta export" (#87): what to send (the chosen rows, a manual or a folder), into which
 * target languages, and an optional due date. Each change asks the API for a dry run, so the
 * counts (modules, blocks, words, per language) are shown before anything is sent; "Export and
 * download" then records the job (its blocks are at the agency from then on) and downloads its
 * file: one XLIFF for one language, else a ZIP of one per language. It starts from the Status
 * tab's filters and chosen rows.
 */
@Component({
  selector: 'of-translation-export-dialog',
  imports: [
    FormsModule,
    TranslocoPipe,
    ZardDialogImports,
    ZardButtonComponent,
    ZardCheckboxComponent,
    ZardInputComponent,
    ZardRadioGroupImports,
    ZardSelectImports,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <z-dialog [(zVisible)]="open" class="sm:max-w-[36rem]">
      <z-dialog-header>
        <z-dialog-title>{{
          'editor.translations.export.title' | transloco
        }}</z-dialog-title>
        <z-dialog-description>{{
          'editor.translations.export.description' | transloco
        }}</z-dialog-description>
      </z-dialog-header>
      @if (open()) {
        <form
          id="translation-export-form"
          class="flex min-w-0 flex-col gap-5"
          novalidate
          (submit)="submit($event)"
        >
          <fieldset class="m-0 flex min-w-0 flex-col gap-3 border-0 p-0">
            <legend class="mb-2 p-0 text-sm font-medium">
              {{ 'editor.translations.export.subject' | transloco }}
            </legend>
            <z-radio-group
              class="flex flex-col gap-3"
              [attr.aria-label]="
                'editor.translations.export.subject' | transloco
              "
              [value]="choice()"
              (valueChange)="choose($event)"
            >
              <label
                class="flex items-start gap-3"
                [class.cursor-pointer]="selection().length > 0"
                [class.cursor-not-allowed]="selection().length === 0"
              >
                <z-radio
                  value="selection"
                  zId="export-subject-selection"
                  [zDisabled]="selection().length === 0"
                />
                <span class="flex min-w-0 flex-col gap-0.5">
                  <span
                    class="text-sm font-medium"
                    [class.text-muted-foreground]="selection().length === 0"
                    >{{
                      selectionLabel().key | transloco: selectionLabel().params
                    }}</span
                  >
                  @if (selection().length === 0) {
                    <span class="text-muted-foreground text-xs break-words">{{
                      'editor.translations.export.selectionHint' | transloco
                    }}</span>
                  } @else if (mixedSelection()) {
                    <span
                      class="text-destructive text-xs break-words"
                      data-slot="mixed-selection"
                      >{{
                        'editor.translations.export.mixedHint' | transloco
                      }}</span
                    >
                  }
                </span>
              </label>
              <div class="flex min-w-0 flex-col gap-2">
                <label class="flex cursor-pointer items-start gap-3">
                  <z-radio value="manual" zId="export-subject-manual" />
                  <span class="text-sm font-medium">{{
                    'editor.translations.export.manual' | transloco
                  }}</span>
                </label>
                @if (choice() === 'manual') {
                  <z-select
                    class="ms-7 w-auto min-w-0"
                    zSearchable
                    zPosition="popper"
                    data-field="manual"
                    [zAriaLabel]="
                      'editor.translations.export.manual' | transloco
                    "
                    [zPlaceholder]="
                      'editor.translations.export.chooseManual' | transloco
                    "
                    [zValue]="manualId()"
                    (zSelectionChange)="manualId.set(one($event))"
                  >
                    @for (m of manuals(); track m.value) {
                      <z-select-item [zValue]="m.value">{{
                        m.label
                      }}</z-select-item>
                    }
                  </z-select>
                }
              </div>
              <div class="flex min-w-0 flex-col gap-2">
                <label class="flex cursor-pointer items-start gap-3">
                  <z-radio value="folder" zId="export-subject-folder" />
                  <span class="text-sm font-medium">{{
                    'editor.translations.export.folder' | transloco
                  }}</span>
                </label>
                @if (choice() === 'folder') {
                  <z-select
                    class="ms-7 w-auto min-w-0"
                    zPosition="popper"
                    data-field="folder"
                    [zAriaLabel]="
                      'editor.translations.export.folder' | transloco
                    "
                    [zPlaceholder]="
                      'editor.translations.export.chooseFolder' | transloco
                    "
                    [zValue]="folder()"
                    (zSelectionChange)="folder.set(one($event))"
                  >
                    @for (f of folders(); track f.value) {
                      <z-select-item [zValue]="f.value">{{
                        f.label
                      }}</z-select-item>
                    }
                  </z-select>
                }
              </div>
            </z-radio-group>
          </fieldset>

          <fieldset class="m-0 flex min-w-0 flex-col gap-2 border-0 p-0">
            <legend class="mb-2 p-0 text-sm font-medium">
              {{ 'editor.translations.export.languages' | transloco }}
            </legend>
            <div class="flex flex-wrap gap-x-5 gap-y-2">
              @for (l of targets(); track l) {
                <z-checkbox
                  [attr.data-lang]="l"
                  [ngModel]="languages().includes(l)"
                  [ngModelOptions]="{ standalone: true }"
                  (checkChange)="toggleLanguage(l, $event)"
                  >{{ languageLabel(l) }}</z-checkbox
                >
              }
            </div>
            @if (languages().length === 0) {
              <p class="text-destructive m-0 text-xs" data-slot="no-language">
                {{ 'editor.translations.export.noLanguage' | transloco }}
              </p>
            }
          </fieldset>

          <div class="flex min-w-0 flex-col gap-1.5">
            <label class="text-sm font-medium" for="translation-export-due">{{
              'editor.translations.export.due' | transloco
            }}</label>
            <input
              id="translation-export-due"
              z-input
              type="date"
              class="w-48"
              data-field="due"
              aria-describedby="translation-export-due-hint"
              [attr.aria-invalid]="dueInvalid() ? 'true' : null"
              [value]="dueDate()"
              (input)="dueDate.set($any($event.target).value)"
            />
            <p
              id="translation-export-due-hint"
              class="text-muted-foreground m-0 text-xs break-words"
              [class.text-destructive]="dueInvalid()"
            >
              {{
                (dueInvalid()
                  ? 'editor.translations.export.dueInvalid'
                  : 'editor.translations.export.dueHint'
                ) | transloco
              }}
            </p>
          </div>

          <section
            class="bg-muted/50 flex min-h-24 min-w-0 flex-col justify-center gap-1 rounded-lg px-4 py-3"
            data-slot="estimate"
            aria-live="polite"
            [attr.aria-busy]="estimate().kind === 'counting' || null"
            [attr.data-state]="estimate().kind"
          >
            @switch (estimate().kind) {
              @case ('ready') {
                @let m = meta()!;
                <p
                  class="m-0 text-sm font-medium break-words"
                  data-slot="estimate-total"
                  [class.opacity-60]="stale()"
                >
                  {{
                    'editor.translations.export.counts'
                      | transloco
                        : {
                            modules: m.modules,
                            units: m.units,
                            words: m.words,
                          }
                  }}
                </p>
                <ul
                  class="text-muted-foreground m-0 flex list-none flex-col gap-0.5 p-0 text-xs"
                  [class.opacity-60]="stale()"
                >
                  @for (l of m.languages; track l.lang) {
                    <li class="break-words" [attr.data-lang]="l.lang">
                      {{
                        'editor.translations.export.perLanguage'
                          | transloco
                            : {
                                language: languageLabel(l.lang),
                                units: l.units,
                                words: l.words,
                              }
                      }}
                    </li>
                  }
                </ul>
              }
              @case ('nothing') {
                <p class="m-0 text-sm break-words" data-slot="estimate-nothing">
                  {{ 'editor.translations.export.nothing' | transloco }}
                </p>
              }
              @case ('error') {
                <p
                  class="text-destructive m-0 text-sm break-words"
                  role="alert"
                  data-slot="estimate-error"
                >
                  {{ errorText() }}
                </p>
              }
              @case ('counting') {
                <p class="text-muted-foreground m-0 text-sm">
                  {{ 'editor.translations.export.counting' | transloco }}
                </p>
              }
              @default {
                <p class="text-muted-foreground m-0 text-sm break-words">
                  {{ 'editor.translations.export.choose' | transloco }}
                </p>
              }
            }
          </section>
        </form>
      }
      <z-dialog-footer>
        <button z-button zType="ghost" type="button" z-dialog-close>
          {{ 'editor.translations.export.cancel' | transloco }}
        </button>
        <button
          z-button
          type="submit"
          form="translation-export-form"
          data-slot="export-confirm"
          [zDisabled]="!canExport()"
          [zLoading]="exporting()"
        >
          {{ 'editor.translations.export.confirm' | transloco }}
        </button>
      </z-dialog-footer>
    </z-dialog>
  `,
})
export class TranslationExportDialogComponent {
  readonly open = model(false);
  /** The Status tab's filters and chosen rows: where the choices start. */
  readonly filterManual = input<string | undefined>(undefined);
  readonly filterFolder = input<string | undefined>(undefined);
  readonly filterLang = input<string | undefined>(undefined);
  readonly selection = input<readonly string[]>([]);
  /** What the chosen rows are, in words (#656). */
  protected readonly selectionLabel = computed(() =>
    chosenExportText(this.selection()),
  );
  /** Rows of page designs (#568) and of modules chosen together: no one export takes both. */
  protected readonly mixedSelection = computed(() => {
    return mixedRows(this.selection());
  });
  /** The target languages one may choose. */
  readonly targets = input<readonly string[]>([]);
  readonly manuals = input<readonly FilterOption[]>([]);
  readonly folders = input<readonly FilterOption[]>([]);
  /** The job made, its file downloading. */
  readonly exported = output<JobItem>();

  private readonly api = inject(ApiClient);
  private readonly readRef = inject(ReadRef);
  private readonly toast = inject(ToastService);
  private readonly downloads = inject(TranslationJobDownload);
  private readonly language = inject(LanguageService);
  private readonly t = injectTranslate();

  protected readonly choice = signal<SubjectChoice>('manual');
  protected readonly manualId = signal('');
  protected readonly folder = signal('');
  protected readonly languages = signal<readonly string[]>([]);
  protected readonly dueDate = signal('');
  protected readonly estimate = signal<Estimate>({ kind: 'idle' });
  /** The counts shown are for earlier choices: a new dry run is under way. */
  protected readonly stale = signal(false);
  protected readonly exporting = signal(false);
  private runs = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;

  protected readonly dueInvalid = computed(() => !validDueDate(this.dueDate()));
  private readonly subject = computed(() =>
    subjectOf(this.choice(), {
      selection: this.selection(),
      manual: this.manualId(),
      folder: this.folder(),
    }),
  );
  /** The request as chosen, or null while it is incomplete. */
  private readonly request = computed(() => {
    const subject = this.subject();
    const languages = this.languages();
    if (!subject || languages.length === 0 || this.dueInvalid()) return null;
    return {
      subject,
      languages,
      dueDate: this.dueDate(),
      ref: this.readRef.ref(),
    };
  });
  protected readonly meta = computed(() => {
    const e = this.estimate();
    return e.kind === 'ready' ? e.meta : null;
  });
  protected readonly canExport = computed(
    () =>
      this.request() !== null &&
      this.estimate().kind === 'ready' &&
      !this.stale() &&
      !this.exporting(),
  );
  protected readonly errorText = computed(() => {
    const e = this.estimate();
    if (e.kind !== 'error') return '';
    const text = apiErrorText(e.error);
    return this.t(text.key, text.params);
  });

  constructor() {
    // Every opening starts from the Status tab's filters and chosen rows.
    effect(() => {
      if (!this.open()) return;
      untracked(() => {
        const manual = this.filterManual();
        const folder = this.filterFolder();
        this.choice.set(
          initialChoice({ selection: this.selection(), manual, folder }),
        );
        this.manualId.set(manual ?? '');
        this.folder.set(folder ?? '');
        const lang = this.filterLang();
        this.languages.set(
          lang && this.targets().includes(lang) ? [lang] : [...this.targets()],
        );
        this.dueDate.set('');
        this.estimate.set({ kind: 'idle' });
        this.stale.set(false);
      });
    });
    // No manual named: the first one, so the counts show at once.
    effect(() => {
      const first = this.manuals()[0]?.value;
      const open = this.open();
      untracked(() => {
        if (open && first && this.choice() === 'manual' && !this.manualId()) {
          this.manualId.set(first);
        }
      });
    });
    // The targets arrive after an opening from the address: all of them, as above.
    effect(() => {
      const targets = this.targets();
      untracked(() => {
        if (this.open() && this.languages().length === 0) {
          const lang = this.filterLang();
          this.languages.set(
            lang && targets.includes(lang) ? [lang] : [...targets],
          );
        }
      });
    });
    // A dry run for every complete choice.
    effect(() => {
      const request = this.request();
      const open = this.open();
      untracked(() => this.schedule(open ? request : null));
    });
    inject(DestroyRef).onDestroy(() => {
      this.runs++;
      clearTimeout(this.timer);
    });
  }

  protected one(value: string | string[]): string {
    return (Array.isArray(value) ? value[0] : value) ?? '';
  }

  protected choose(value: unknown): void {
    if (value === 'selection' || value === 'manual' || value === 'folder') {
      this.choice.set(value);
    }
  }

  protected toggleLanguage(lang: string, on: boolean): void {
    const rest = this.languages().filter((l) => l !== lang);
    const chosen = on ? [...rest, lang] : rest;
    // In the configured order.
    this.languages.set(this.targets().filter((l) => chosen.includes(l)));
  }

  protected languageLabel(lang: string): string {
    return languageName(this.language.locale(), lang);
  }

  protected async submit(event: Event): Promise<void> {
    event.preventDefault();
    const request = this.request();
    if (!request || !this.canExport()) return;
    this.exporting.set(true);
    try {
      const doc = await firstValueFrom(
        this.api.post('/translations/exports', exportBody(request, false)),
      );
      const job = doc.data;
      const languages = job.attributes.languages
        .map((l) => this.languageLabel(l))
        .join(', ');
      this.open.set(false);
      this.exported.emit(job);
      try {
        await this.downloads.save({
          id: job.id,
          languages: job.attributes.languages,
        });
        this.toast.success(
          translated('editor.translations.export.done', {
            units: job.meta.units,
            languages,
          }),
        );
      } catch {
        this.toast.error(
          translated('editor.translations.export.downloadFailed', {
            languages,
          }),
        );
      }
    } catch (error) {
      const failure = toApiError(error);
      if (failure.code === 'nothing-to-translate') {
        this.estimate.set({ kind: 'nothing' });
      } else {
        // Say why, and count again: the export can be tried once more (a conflict, a blip).
        const text = apiErrorText(failure);
        this.toast.error(translated(text.key, text.params));
        this.schedule(request);
      }
    } finally {
      this.exporting.set(false);
    }
  }

  private schedule(request: ReturnType<typeof this.request> | null): void {
    clearTimeout(this.timer);
    const run = ++this.runs;
    if (!request) {
      this.estimate.set({ kind: 'idle' });
      this.stale.set(false);
      return;
    }
    // The last counts stay, dimmed, until the new ones arrive.
    if (this.estimate().kind === 'ready') this.stale.set(true);
    else this.estimate.set({ kind: 'counting' });
    this.timer = setTimeout(
      () => void this.dryRun(request, run),
      DRY_RUN_DEBOUNCE_MS,
    );
  }

  private async dryRun(
    request: NonNullable<ReturnType<typeof this.request>>,
    run: number,
  ): Promise<void> {
    try {
      const doc = await firstValueFrom(
        this.api.post('/translations/exports', exportBody(request, true)),
      );
      if (run !== this.runs) return;
      this.estimate.set({ kind: 'ready', meta: doc.data.meta });
    } catch (error) {
      if (run !== this.runs) return;
      const failure = toApiError(error);
      this.estimate.set(
        failure.code === 'nothing-to-translate'
          ? { kind: 'nothing' }
          : { kind: 'error', error: failure },
      );
    } finally {
      if (run === this.runs) this.stale.set(false);
    }
  }
}
