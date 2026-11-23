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
import { injectTranslate, translated } from '@openfolia/ui/i18n';
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
import type { StoredConfig } from '../content/browser-model';
import { apiErrorText, labelsInUi } from '../i18n';
import { idParam, injectQueryState, intParam, oneOfParam } from '../view-state';
import { ReportDownload } from './report-download';
import {
  KEY_PATTERN,
  REPORT_PAGE_SIZES,
  unusedFilter,
  USAGE_SHOWS,
  USAGE_SORT_PARAM,
  USAGE_SORT_TEXTS,
  USAGE_SORTS,
  usesOf,
  type UsageItem,
  type UsageShow,
  type UsageSortChoice,
} from './report-model';

type UsageDoc = Response<'/reports/module-usage'>;

/** Space kept below the frame: the page's bottom padding. */
const BELOW_FRAME_PX = 48;

interface Option {
  readonly value: string;
  readonly label: string;
}

const SHOW_TEXTS: Readonly<Record<UsageShow, string>> = {
  all: 'editor.reports.usage.show.all',
  used: 'editor.reports.usage.show.used',
  unused: 'editor.reports.usage.show.unused',
};

/**
 * The Usage tab of Reports (#56): every module the reader may see with how many manuals include
 * it (directly or through module references) and how many modules refer to it, and the manuals
 * each one is in. "Unused" shows the modules no manual includes; a module included only through a
 * module reference is used. The view, type, order, page and size are in the address; the CSV
 * holds the whole report as filtered.
 */
@Component({
  selector: 'of-usage-report-page',
  imports: [
    RouterLink,
    TranslocoPipe,
    NgIcon,
    ListFrameComponent,
    ListItemDirective,
    ListTableDirective,
    ReservedSlotDirective,
    SegmentedComponent,
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
      <of-segmented
        data-filter="show"
        [label]="'editor.reports.usage.show.label' | transloco"
        [options]="showOptions()"
        [value]="show()"
        (valueChange)="setShow($event)"
      />
      <z-select
        class="w-full sm:w-52"
        data-filter="type"
        [zPrefix]="'editor.reports.filter.type' | transloco"
        [zAriaLabel]="'editor.reports.filter.type' | transloco"
        [zValue]="type() ?? ''"
        (zSelectionChange)="setType($event)"
      >
        @for (o of typeOptions(); track o.value) {
          <z-select-item [zValue]="o.value">{{ o.label }}</z-select-item>
        }
      </z-select>
      <z-select
        class="w-full sm:w-52"
        data-filter="sort"
        [zPrefix]="'editor.reports.usage.sort.label' | transloco"
        [zAriaLabel]="'editor.reports.usage.sort.label' | transloco"
        [zValue]="sort()"
        (zSelectionChange)="setSort($event)"
      >
        @for (o of sortOptions(); track o.value) {
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
      [label]="'editor.reports.usage.table.label' | transloco"
      [items]="doc()?.data ?? []"
      [page]="doc()?.meta?.page ?? null"
      [loading]="loading()"
      [error]="frameError()"
      [offset]="offset()"
      [pageSizes]="pageSizes"
      [emptyTitle]="
        (show() === 'unused' && type() === undefined
          ? 'editor.reports.usage.empty.unusedTitle'
          : filtered()
            ? 'editor.reports.usage.empty.filteredTitle'
            : 'editor.reports.usage.empty.title'
        ) | transloco
      "
      [emptyDescription]="
        (show() === 'unused' && type() === undefined
          ? 'editor.reports.usage.empty.unusedDescription'
          : filtered()
            ? 'editor.reports.usage.empty.filteredDescription'
            : 'editor.reports.usage.empty.description'
        ) | transloco
      "
      (pageChange)="view.set({ page: $event })"
      (pageSizeChange)="view.set({ size: $event, page: 1 })"
      (retry)="reload()"
    >
      <ng-template ofListTable let-items>
        <table z-table class="min-w-[52rem] table-fixed">
          <thead z-table-header class="bg-background sticky top-0 z-10">
            <tr z-table-row>
              <th z-table-head class="w-[26%]">
                {{ 'editor.reports.usage.table.module' | transloco }}
              </th>
              <th z-table-head class="w-32">
                {{ 'editor.reports.usage.table.type' | transloco }}
              </th>
              <th z-table-head class="w-24 text-end">
                {{ 'editor.reports.usage.table.manuals' | transloco }}
              </th>
              <th z-table-head class="w-24 text-end">
                {{ 'editor.reports.usage.table.modules' | transloco }}
              </th>
              <th z-table-head>
                {{ 'editor.reports.usage.table.usedIn' | transloco }}
              </th>
            </tr>
          </thead>
          <tbody z-table-body>
            @for (row of asRows(items); track row.id) {
              @let a = row.attributes;
              @let uses = usesOfRow(row);
              <tr
                z-table-row
                [ofListItem]="row"
                data-slot="usage-row"
                [attr.data-module]="row.id"
              >
                <td z-table-cell class="align-top whitespace-normal">
                  @let lang = row.meta.languages[0];
                  @if (lang) {
                    <a
                      class="text-foreground block font-medium break-words underline-offset-4 hover:underline focus-visible:underline"
                      data-slot="usage-module-link"
                      [routerLink]="['/content', lang, a.moduleId]"
                      >{{ a.title }}</a
                    >
                  } @else {
                    <span class="block font-medium break-words">{{
                      a.title
                    }}</span>
                  }
                  <span
                    class="text-muted-foreground block font-mono text-xs [overflow-wrap:anywhere]"
                    >{{ a.moduleId }}</span
                  >
                  <span class="mt-1 flex flex-wrap gap-1">
                    @if (row.meta.usage.manuals === 0) {
                      <z-badge
                        zType="warning"
                        class="h-auto"
                        data-slot="usage-unused"
                        >{{
                          'editor.reports.usage.unused' | transloco
                        }}</z-badge
                      >
                    }
                    @if (a.deprecated) {
                      <z-badge zType="outline" class="h-auto">{{
                        'editor.reports.deprecated' | transloco
                      }}</z-badge>
                    }
                  </span>
                </td>
                <td
                  z-table-cell
                  class="align-top break-words whitespace-normal"
                >
                  {{ typeLabel(a.type) }}
                </td>
                <td
                  z-table-cell
                  class="text-end align-top tabular-nums"
                  data-slot="usage-manuals"
                >
                  {{ row.meta.usage.manuals }}
                </td>
                <td
                  z-table-cell
                  class="text-end align-top tabular-nums"
                  data-slot="usage-modules"
                >
                  {{ row.meta.usage.modules }}
                </td>
                <td
                  z-table-cell
                  class="align-top text-sm whitespace-normal"
                  data-slot="usage-used-in"
                >
                  @if (uses.manuals.length > 0) {
                    <ul class="m-0 flex list-none flex-col gap-0.5 p-0">
                      @for (use of uses.manuals; track use.id) {
                        <li class="break-words">
                          <a
                            class="text-foreground underline-offset-4 hover:underline focus-visible:underline"
                            data-slot="usage-manual-link"
                            routerLink="/manuals"
                            [queryParams]="{ manual: use.id }"
                            >{{ use.title }}</a
                          >
                          @if (!use.direct) {
                            <span class="text-muted-foreground">
                              {{
                                'editor.reports.usage.throughReference'
                                  | transloco
                              }}</span
                            >
                          }
                        </li>
                      }
                      @if (uses.moreManuals > 0) {
                        <li class="text-muted-foreground">
                          {{
                            'editor.reports.usage.moreManuals'
                              | transloco: { count: uses.moreManuals }
                          }}
                        </li>
                      }
                    </ul>
                  } @else {
                    <span class="text-muted-foreground">{{
                      'editor.reports.usage.inNoManual' | transloco
                    }}</span>
                  }
                  @if (uses.modules.length > 0) {
                    <span
                      class="text-muted-foreground mt-1 block break-words"
                      data-slot="usage-referred-by"
                      >{{
                        'editor.reports.usage.referredBy'
                          | transloco
                            : {
                                modules: titlesOf(uses.modules),
                                more: uses.moreModules,
                              }
                      }}</span
                    >
                  }
                </td>
              </tr>
            }
          </tbody>
        </table>
      </ng-template>
    </of-list-frame>
  `,
})
export class UsageReportPage {
  private readonly api = inject(ApiClient);
  private readonly t = injectTranslate();
  private readonly downloads = inject(ReportDownload);
  private readonly toast = inject(ToastService);

  protected readonly view = injectQueryState({
    show: oneOfParam(USAGE_SHOWS, 'all'),
    type: idParam(KEY_PATTERN),
    sort: oneOfParam(USAGE_SORTS, 'title'),
    page: intParam(1),
    size: intParam(REPORT_PAGE_SIZES[0], { only: REPORT_PAGE_SIZES }),
  });
  protected readonly show = this.view.get('show');
  protected readonly type = this.view.get('type');
  protected readonly sort = this.view.get('sort');
  protected readonly pageSizes = REPORT_PAGE_SIZES;

  protected readonly doc = signal<UsageDoc | null>(null);
  protected readonly loading = signal(false);
  protected readonly downloading = signal(false);
  private readonly failure = signal<ApiError | null>(null);
  private readonly reloads = signal(0);
  private readonly storedConfig = signal<StoredConfig | null>(null);
  private readonly shownConfig = labelsInUi(this.storedConfig);
  /** The module types, each by its label in the interface language (#731). */
  private readonly types = computed((): readonly Option[] =>
    (this.shownConfig()?.moduleTypes ?? []).map((t) => ({
      value: t.id,
      label: t.label,
    })),
  );
  protected readonly offset = signal('20rem');
  private readonly frame = viewChild('frame', { read: ElementRef });
  private runs = 0;

  protected readonly filtered = computed(
    () =>
      this.show() !== 'all' ||
      this.type() !== undefined ||
      this.sort() !== 'title',
  );

  protected readonly frameError = computed(() => {
    const failure = this.failure();
    if (!failure) return null;
    const text = apiErrorText(failure);
    return { kind: failure.kind, message: this.t(text.key, text.params) };
  });

  protected readonly showOptions = computed((): SegmentedOption[] =>
    USAGE_SHOWS.map((value) => ({
      value,
      label: this.t(SHOW_TEXTS[value]),
    })),
  );

  protected readonly typeOptions = computed((): Option[] => {
    const options: Option[] = [
      { value: '', label: this.t('editor.reports.filter.anyType') },
      ...this.types(),
    ];
    const current = this.type();
    return current === undefined || options.some((o) => o.value === current)
      ? options
      : [...options, { value: current, label: current }];
  });

  protected readonly sortOptions = computed((): Option[] =>
    USAGE_SORTS.map((value) => ({
      value,
      label: this.t(USAGE_SORT_TEXTS[value]),
    })),
  );

  constructor() {
    effect(() => {
      const query = {
        show: this.show(),
        type: this.type(),
        sort: this.sort(),
        page: this.view.get('page')(),
        size: this.view.get('size')(),
      };
      this.reloads();
      untracked(() => void this.load(query));
    });
    void this.loadTypes();

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

  protected asRows(items: readonly unknown[]): readonly UsageItem[] {
    return items as readonly UsageItem[];
  }

  protected usesOfRow(row: UsageItem): ReturnType<typeof usesOf> {
    return usesOf(row);
  }

  protected titlesOf(uses: readonly { readonly title: string }[]): string {
    return uses.map((u) => u.title).join(', ');
  }

  protected typeLabel(type: string): string {
    return this.types().find((o) => o.value === type)?.label ?? type;
  }

  protected setShow(value: string): void {
    const show = USAGE_SHOWS.find((s) => s === value) ?? 'all';
    this.view.set({ show, page: 1 });
  }

  protected setType(value: string | string[]): void {
    const type = typeof value === 'string' && value ? value : undefined;
    this.view.set({ type, page: 1 });
  }

  protected setSort(value: string | string[]): void {
    const sort: UsageSortChoice =
      USAGE_SORTS.find((s) => s === value) ?? 'title';
    this.view.set({ sort, page: 1 });
  }

  protected reload(): void {
    this.reloads.update((n) => n + 1);
  }

  protected async download(): Promise<void> {
    this.downloading.set(true);
    try {
      await this.downloads.save(
        '/reports/module-usage/csv',
        {
          'filter[unused]': unusedFilter(this.show()),
          'filter[type]': this.type(),
          sort: USAGE_SORT_PARAM[this.sort()],
        },
        'module-usage.csv',
      );
    } catch {
      this.toast.error(translated('editor.reports.downloadFailed'));
    } finally {
      this.downloading.set(false);
    }
  }

  /** The module types, for the filter and the type column; without them, the IDs stand. */
  private async loadTypes(): Promise<void> {
    try {
      const config = await firstValueFrom(this.api.get('/config'));
      this.storedConfig.set(config.data.attributes);
    } catch {
      // The filter offers what the address holds.
    }
  }

  private async load(query: {
    show: UsageShow;
    type: string | undefined;
    sort: UsageSortChoice;
    page: number;
    size: number;
  }): Promise<void> {
    const run = ++this.runs;
    this.loading.set(true);
    this.failure.set(null);
    const unused = unusedFilter(query.show);
    try {
      const doc = await firstValueFrom(
        this.api.get('/reports/module-usage', {
          query: {
            ...(unused ? { 'filter[unused]': unused } : {}),
            ...(query.type ? { 'filter[type]': query.type } : {}),
            sort: USAGE_SORT_PARAM[query.sort],
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
