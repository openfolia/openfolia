import type { LocalizedText } from '@openfolia/content-model/core';
import {
  afterRenderEffect,
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslocoPipe } from '@jsverse/transloco';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideDownload, lucideX } from '@ng-icons/lucide';
import { firstValueFrom } from 'rxjs';

import { ZardBadgeComponent } from '@openfolia/ui/badge';
import { ZardButtonComponent } from '@openfolia/ui/button';
import {
  injectTranslate,
  LanguageService,
  translated,
} from '@openfolia/ui/i18n';
import {
  ListFrameComponent,
  ListItemDirective,
  ListTableDirective,
} from '@openfolia/ui/list-frame';
import { MeterBarComponent } from '@openfolia/ui/meter-bar';
import { ZardSelectImports } from '@openfolia/ui/select';
import { ReservedSlotDirective } from '@openfolia/ui/smooth';
import { ZardTableImports } from '@openfolia/ui/table';
import { ToastService } from '@openfolia/ui/toast';

import {
  ApiClient,
  pageQuery,
  toApiError,
  type ApiError,
  type Response,
} from '../api';
import { languageName } from '../content/browser-model';
import { apiErrorText, UiTexts } from '../i18n';
import { PermissionService } from '../permissions/permission.service';
import { idParam, injectQueryState, intParam } from '../view-state';
import { ReportDownload } from './report-download';
import {
  type CoverageItem,
  ID_PATTERN,
  LANG_PATTERN,
  REPORT_PAGE_SIZES,
  upToDateShare,
} from './report-model';

type CoverageDoc = Response<'/reports/translations'>;

/** Space kept below the frame: the page's bottom padding. */
const BELOW_FRAME_PX = 48;

interface Option {
  readonly value: string;
  readonly label: string;
}

/**
 * The Translations tab of Reports (#56): one row per manual and target language the reader may
 * see, with the share of its modules up to date as a bar and a percentage, and the counts in
 * words (outdated, at the provider, missing; and the blocks). Each row links to the Translations
 * screen filtered to that manual and language, for someone who may open it. Filters (manual,
 * language), page and size are in the address; the CSV holds the whole report as filtered.
 */
@Component({
  selector: 'of-translation-report-page',
  imports: [
    RouterLink,
    TranslocoPipe,
    NgIcon,
    ListFrameComponent,
    ListItemDirective,
    ListTableDirective,
    ReservedSlotDirective,
    MeterBarComponent,
    ZardBadgeComponent,
    ZardButtonComponent,
    ZardSelectImports,
    ZardTableImports,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [provideIcons({ lucideDownload, lucideX })],
  host: { class: 'flex min-w-0 flex-col gap-4' },
  template: `
    <div
      class="flex flex-wrap items-center gap-3"
      role="group"
      [attr.aria-label]="'editor.reports.filter.label' | transloco"
    >
      <z-select
        class="w-full sm:w-64"
        zSearchable
        data-filter="manual"
        [zPrefix]="'editor.reports.filter.manual' | transloco"
        [zAriaLabel]="'editor.reports.filter.manual' | transloco"
        [zValue]="manual() ?? ''"
        (zSelectionChange)="setManual($event)"
      >
        @for (o of manualOptions(); track o.value) {
          <z-select-item [zValue]="o.value">{{ o.label }}</z-select-item>
        }
      </z-select>
      <z-select
        class="w-full sm:w-auto sm:max-w-72 sm:min-w-52"
        data-filter="lang"
        [zPrefix]="'editor.reports.filter.language' | transloco"
        [zAriaLabel]="'editor.reports.filter.language' | transloco"
        [zValue]="lang() ?? ''"
        (zSelectionChange)="setLang($event)"
      >
        @for (o of languageOptions(); track o.value) {
          <z-select-item [zValue]="o.value">{{ o.label }}</z-select-item>
        }
      </z-select>
      <button
        z-button
        zType="ghost"
        type="button"
        data-slot="report-clear"
        [ofReservedSlot]="filtered()"
        (click)="view.reset()"
      >
        <ng-icon name="lucideX" data-icon="inline-start" aria-hidden="true" />
        {{ 'editor.reports.filter.clear' | transloco }}
      </button>
      <button
        z-button
        zType="outline"
        type="button"
        class="sm:ms-auto"
        data-slot="report-download"
        [zLoading]="downloading()"
        [disabled]="downloading()"
        (click)="download()"
      >
        <ng-icon
          name="lucideDownload"
          data-icon="inline-start"
          aria-hidden="true"
        />
        {{ 'editor.reports.download' | transloco }}
      </button>
    </div>

    <of-list-frame
      #frame
      class="min-h-64 min-w-0"
      [label]="'editor.reports.translations.table.label' | transloco"
      [items]="doc()?.data ?? []"
      [page]="doc()?.meta?.page ?? null"
      [loading]="loading()"
      [error]="frameError()"
      [offset]="offset()"
      [pageSizes]="pageSizes"
      [emptyTitle]="
        (filtered()
          ? 'editor.reports.translations.empty.filteredTitle'
          : 'editor.reports.translations.empty.title'
        ) | transloco
      "
      [emptyDescription]="
        (filtered()
          ? 'editor.reports.translations.empty.filteredDescription'
          : 'editor.reports.translations.empty.description'
        ) | transloco
      "
      (pageChange)="view.set({ page: $event })"
      (pageSizeChange)="view.set({ size: $event, page: 1 })"
      (retry)="reload()"
    >
      <ng-template ofListTable let-items>
        <table z-table class="min-w-[48rem] table-fixed">
          <thead z-table-header class="bg-background sticky top-0 z-10">
            <tr z-table-row>
              <th z-table-head class="w-[22%]">
                {{ 'editor.reports.translations.table.manual' | transloco }}
              </th>
              <th z-table-head class="w-32">
                {{ 'editor.reports.translations.table.language' | transloco }}
              </th>
              <th z-table-head class="w-48">
                {{ 'editor.reports.translations.table.upToDate' | transloco }}
              </th>
              <th z-table-head>
                {{ 'editor.reports.translations.table.status' | transloco }}
              </th>
              @if (mayOpenTranslations()) {
                <th z-table-head class="w-36">
                  <span class="sr-only">{{
                    'editor.reports.translations.table.open' | transloco
                  }}</span>
                </th>
              }
            </tr>
          </thead>
          <tbody z-table-body>
            @for (row of asRows(items); track row.id) {
              @let m = row.meta.modules;
              @let b = row.meta.blocks;
              @let share = shareOf(row);
              <tr
                z-table-row
                [ofListItem]="row"
                data-slot="coverage-row"
                [attr.data-row]="row.id"
              >
                <td z-table-cell class="align-top whitespace-normal">
                  <span class="block font-medium break-words">{{
                    row.meta.title
                  }}</span>
                  <span
                    class="text-muted-foreground block font-mono text-xs [overflow-wrap:anywhere]"
                    >{{ row.attributes.manualId }}</span
                  >
                  @if (row.meta.deprecated) {
                    <z-badge zType="outline" class="mt-1 h-auto">{{
                      'editor.reports.deprecated' | transloco
                    }}</z-badge>
                  }
                </td>
                <td z-table-cell class="align-top whitespace-normal">
                  <span class="block break-words">{{
                    languageLabel(row.attributes.lang)
                  }}</span>
                  <span class="text-muted-foreground block font-mono text-xs">{{
                    row.attributes.lang
                  }}</span>
                </td>
                <td z-table-cell class="align-top whitespace-normal">
                  @if (m.total > 0) {
                    <div class="flex items-center gap-2 pt-1.5">
                      <of-meter-bar
                        class="flex-1"
                        [value]="share * 100"
                        [label]="
                          'editor.reports.translations.meter'
                            | transloco
                              : {
                                  manual: row.meta.title,
                                  language: languageLabel(row.attributes.lang),
                                }
                        "
                        [valueText]="
                          'editor.reports.translations.share'
                            | transloco: { share }
                        "
                      />
                      <span
                        class="w-12 shrink-0 text-end text-sm font-medium tabular-nums"
                        data-slot="coverage-share"
                        aria-hidden="true"
                        >{{
                          'editor.reports.translations.share'
                            | transloco: { share }
                        }}</span
                      >
                    </div>
                  } @else {
                    <span class="text-muted-foreground text-sm">{{
                      'editor.reports.translations.noModules' | transloco
                    }}</span>
                  }
                </td>
                <td
                  z-table-cell
                  class="align-top text-sm whitespace-normal"
                  data-slot="coverage-status"
                >
                  @if (m.total > 0) {
                    <span class="block break-words">{{
                      'editor.reports.translations.modules'
                        | transloco
                          : {
                              upToDate: m.upToDate,
                              total: m.total,
                              outdated: m.outdated,
                              atProvider: m.atProvider,
                              missing: m.missing,
                            }
                    }}</span>
                    <span class="text-muted-foreground block break-words">{{
                      'editor.reports.translations.blocks'
                        | transloco
                          : {
                              upToDate: b.upToDate,
                              total: b.total,
                              outdated: b.outdated,
                              atProvider: b.atProvider,
                              missing: b.missing,
                            }
                    }}</span>
                  }
                </td>
                @if (mayOpenTranslations()) {
                  <td z-table-cell class="align-top whitespace-normal">
                    <a
                      class="text-foreground text-sm break-words underline underline-offset-4 hover:no-underline focus-visible:no-underline"
                      data-slot="coverage-link"
                      routerLink="/translations"
                      [queryParams]="{
                        manual: row.attributes.manualId,
                        lang: row.attributes.lang,
                      }"
                      [attr.aria-label]="
                        'editor.reports.translations.openLabel'
                          | transloco
                            : {
                                manual: row.meta.title,
                                language: languageLabel(row.attributes.lang),
                              }
                      "
                      >{{ 'editor.reports.translations.open' | transloco }}</a
                    >
                  </td>
                }
              </tr>
            }
          </tbody>
        </table>
      </ng-template>
    </of-list-frame>
  `,
})
export class TranslationReportPage {
  private readonly api = inject(ApiClient);
  private readonly texts = inject(UiTexts);
  private readonly t = injectTranslate();
  private readonly language = inject(LanguageService);
  private readonly permissions = inject(PermissionService);
  private readonly downloads = inject(ReportDownload);
  private readonly toast = inject(ToastService);

  protected readonly view = injectQueryState({
    manual: idParam(ID_PATTERN),
    lang: idParam(LANG_PATTERN),
    page: intParam(1),
    size: intParam(REPORT_PAGE_SIZES[0], { only: REPORT_PAGE_SIZES }),
  });
  protected readonly manual = this.view.get('manual');
  protected readonly lang = this.view.get('lang');
  protected readonly pageSizes = REPORT_PAGE_SIZES;

  protected readonly doc = signal<CoverageDoc | null>(null);
  protected readonly loading = signal(false);
  protected readonly downloading = signal(false);
  private readonly failure = signal<ApiError | null>(null);
  private readonly reloads = signal(0);
  private readonly storedManuals = signal<
    readonly { readonly id: string; readonly title: LocalizedText }[]
  >([]);
  private readonly source = signal<string | null>(null);
  /** The manuals, each by its title in the interface language (#731). */
  private readonly manuals = computed((): readonly Option[] =>
    this.storedManuals().map((m) => ({
      value: m.id,
      label: this.texts.text(m.title, this.source()),
    })),
  );
  private readonly targets = signal<readonly string[]>([]);
  protected readonly offset = signal('20rem');
  private readonly frame = viewChild('frame', { read: ElementRef });
  private runs = 0;

  /** The Translations screen (#87) is there for this person: the rows link to it. */
  protected readonly mayOpenTranslations = computed(
    () =>
      this.permissions.state({ permission: 'translation.manage' }).kind !==
      'hidden',
  );

  protected readonly filtered = computed(
    () => this.manual() !== undefined || this.lang() !== undefined,
  );

  protected readonly frameError = computed(() => {
    const failure = this.failure();
    if (!failure) return null;
    const text = apiErrorText(failure);
    return { kind: failure.kind, message: this.t(text.key, text.params) };
  });

  protected readonly manualOptions = computed((): Option[] =>
    withCurrent(
      [
        { value: '', label: this.t('editor.reports.filter.anyManual') },
        ...this.manuals(),
      ],
      this.manual(),
    ),
  );

  protected readonly languageOptions = computed((): Option[] =>
    withCurrent(
      [
        { value: '', label: this.t('editor.reports.filter.anyLanguage') },
        ...this.targets().map((lang) => ({
          value: lang,
          label: this.languageLabel(lang),
        })),
      ],
      this.lang(),
    ),
  );

  constructor() {
    effect(() => {
      const query = {
        manual: this.manual(),
        lang: this.lang(),
        page: this.view.get('page')(),
        size: this.view.get('size')(),
      };
      this.reloads();
      untracked(() => void this.load(query));
    });
    void this.loadOptions();

    const destroyRef = inject(DestroyRef);
    const measure = () => {
      const el = this.frame()?.nativeElement as HTMLElement | undefined;
      if (!el) return;
      const top = Math.round(el.getBoundingClientRect().top);
      this.offset.set(`${Math.max(0, top) + BELOW_FRAME_PX}px`);
    };
    afterRenderEffect(() => {
      this.frame();
      this.doc();
      measure();
    });
    const onResize = () => measure();
    window.addEventListener('resize', onResize);
    destroyRef.onDestroy(() => window.removeEventListener('resize', onResize));
  }

  protected asRows(items: readonly unknown[]): readonly CoverageItem[] {
    return items as readonly CoverageItem[];
  }

  protected shareOf(row: CoverageItem): number {
    return upToDateShare(row.meta.modules);
  }

  protected languageLabel(lang: string): string {
    return languageName(this.language.locale(), lang);
  }

  protected setManual(value: string | string[]): void {
    const manual = typeof value === 'string' && value ? value : undefined;
    this.view.set({ manual, page: 1 });
  }

  protected setLang(value: string | string[]): void {
    const lang = typeof value === 'string' && value ? value : undefined;
    this.view.set({ lang, page: 1 });
  }

  protected reload(): void {
    this.reloads.update((n) => n + 1);
  }

  protected async download(): Promise<void> {
    this.downloading.set(true);
    try {
      await this.downloads.save(
        '/reports/translations/csv',
        { 'filter[manual]': this.manual(), 'filter[lang]': this.lang() },
        'translation-coverage.csv',
      );
    } catch {
      this.toast.error(translated('editor.reports.downloadFailed'));
    } finally {
      this.downloading.set(false);
    }
  }

  /** The filters' choices: the manuals and the target languages. Without them, the address's value stands. */
  private async loadOptions(): Promise<void> {
    try {
      const [manuals, config] = await Promise.all([
        firstValueFrom(
          this.api.get('/manuals', { query: pageQuery({ size: 200 }) }),
        ),
        firstValueFrom(this.api.get('/config')),
      ]);
      this.source.set(config.data.attributes.languages.source);
      this.storedManuals.set(
        manuals.data.flatMap((m) =>
          'attributes' in m ? [{ id: m.id, title: m.attributes.title }] : [],
        ),
      );
      this.targets.set(config.data.attributes.languages.targets);
    } catch {
      // The filters offer what the address holds.
    }
  }

  private async load(query: {
    manual: string | undefined;
    lang: string | undefined;
    page: number;
    size: number;
  }): Promise<void> {
    const run = ++this.runs;
    this.loading.set(true);
    this.failure.set(null);
    try {
      const doc = await firstValueFrom(
        this.api.get('/reports/translations', {
          query: {
            ...(query.manual ? { 'filter[manual]': query.manual } : {}),
            ...(query.lang ? { 'filter[lang]': query.lang } : {}),
            ...pageQuery({ number: query.page, size: query.size }),
          },
        }),
      );
      if (run !== this.runs) return;
      this.doc.set(doc);
    } catch (error) {
      if (run !== this.runs) return;
      this.failure.set(toApiError(error));
    } finally {
      if (run === this.runs) this.loading.set(false);
    }
  }
}

/** The options, with the address's value added (as itself) when none of them is it. */
function withCurrent(options: Option[], current: string | undefined): Option[] {
  if (current === undefined || options.some((o) => o.value === current)) {
    return options;
  }
  return [...options, { value: current, label: current }];
}
