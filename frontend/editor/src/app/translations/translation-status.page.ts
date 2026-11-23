import {
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
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { TranslocoPipe } from '@jsverse/transloco';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideSearch, lucideX } from '@ng-icons/lucide';
import { firstValueFrom } from 'rxjs';

import {
  LanguageBadgeComponent,
  translationStates,
} from '@openfolia/ui/badges';
import { ZardButtonComponent } from '@openfolia/ui/button';
import { ZardCheckboxComponent } from '@openfolia/ui/checkbox';
import { injectTranslate, LanguageService } from '@openfolia/ui/i18n';
import { ZardInputComponent } from '@openfolia/ui/input';
import { ZardInputGroupImports } from '@openfolia/ui/input-group';
import {
  ListFrameComponent,
  ListItemDirective,
  ListTableDirective,
} from '@openfolia/ui/list-frame';
import {
  ReservedSlotDirective,
  SidePanelComponent,
  SidePanelContentDirective,
} from '@openfolia/ui/smooth';
import { ZardTableImports } from '@openfolia/ui/table';

import {
  ApiClient,
  pageQuery,
  ReadRef,
  toApiError,
  type ApiError,
  type Response,
} from '../api';
import { languageName } from '../content/browser-model';
import {
  FilterChipComponent,
  type FilterOption,
} from '../content/filter-chip.component';
import { apiErrorText } from '../i18n';
import { frameOffset } from '../releases/frame-offset';
import { ChangeSetUrl } from '../session/change-set-url';
import { injectQueryState } from '../view-state';
import { TranslationCellPanelComponent } from './cell-panel.component';
import { TranslationsSource } from './translations-source';
import {
  BADGE_STATE,
  cellKey,
  cellText,
  matrixLanguages,
  matrixRows,
  chosenText,
  pageRows,
  parseCell,
  rowOf,
  STATE_TEXT,
  STATES,
  STATUS_PAGE_SIZES,
  type ApiTranslationState,
  type MatrixRow,
  type StatusItem,
} from './translations-model';
import {
  MAX_CHOSEN,
  STATUS_PARAMS,
  TranslationsChanges,
} from './translations-view';

type StatusDoc = Response<'/translations/status'>;

/** Space kept below the frame: the page's bottom padding. */
const BELOW_FRAME_PX = 32;
/** Typing in the search waits this long before the address (and the list) follow. */
const SEARCH_DEBOUNCE_MS = 300;

/** Where focus sits in the matrix: a row and a language column. */
interface Position {
  readonly row: number;
  readonly col: number;
}

/**
 * The Status tab of Translations (#87, screen 5): a matrix of source modules (rows) × target
 * languages (columns), each cell a language badge (dot and word: up to date, outdated with its
 * block count, at the agency, not translated). Filters (manual, folder, language, state, search),
 * the page, the chosen cell and the rows chosen for an export live in the address. A cell opens
 * its side panel with the blocks that need work. The arrow keys move between cells (Home and End
 * to a row's ends); the language columns scroll sideways inside the frame, never the page.
 */
@Component({
  selector: 'of-translation-status-page',
  imports: [
    FormsModule,
    RouterLink,
    TranslocoPipe,
    NgIcon,
    LanguageBadgeComponent,
    ListFrameComponent,
    ListItemDirective,
    ListTableDirective,
    ReservedSlotDirective,
    SidePanelComponent,
    SidePanelContentDirective,
    ZardButtonComponent,
    ZardCheckboxComponent,
    ZardInputComponent,
    ZardInputGroupImports,
    ZardTableImports,
    FilterChipComponent,
    TranslationCellPanelComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [provideIcons({ lucideSearch, lucideX })],
  host: { class: 'flex min-w-0 flex-col gap-3' },
  template: `
    <div class="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start">
      <div
        class="flex min-w-0 flex-1 flex-wrap items-center gap-2"
        role="group"
        [attr.aria-label]="'editor.translations.filter.label' | transloco"
      >
        <of-filter-chip
          data-filter="manual"
          [label]="'editor.translations.filter.manual' | transloco"
          [allLabel]="'editor.translations.filter.all' | transloco"
          [options]="manualOptions()"
          [value]="view.get('manual')() ?? ''"
          (changed)="setFilter({ manual: $event || undefined })"
        />
        <of-filter-chip
          data-filter="folder"
          [label]="'editor.translations.filter.folder' | transloco"
          [allLabel]="'editor.translations.filter.all' | transloco"
          [options]="folders()"
          [value]="view.get('folder')() ?? ''"
          (changed)="setFilter({ folder: $event || undefined })"
        />
        <of-filter-chip
          data-filter="lang"
          [label]="'editor.translations.filter.language' | transloco"
          [allLabel]="'editor.translations.filter.all' | transloco"
          [options]="languageOptions()"
          [value]="view.get('lang')() ?? ''"
          (changed)="setFilter({ lang: $event || undefined })"
        />
        <of-filter-chip
          data-filter="state"
          [label]="'editor.translations.filter.state' | transloco"
          [allLabel]="'editor.translations.filter.all' | transloco"
          [options]="stateOptions()"
          [value]="view.get('state')() ?? ''"
          (changed)="setState($event)"
        />
        <button
          z-button
          zType="ghost"
          zSize="sm"
          type="button"
          data-slot="filters-clear"
          [ofReservedSlot]="filtered()"
          (click)="clearFilters()"
        >
          <ng-icon name="lucideX" data-icon="inline-start" aria-hidden="true" />
          {{ 'editor.translations.filter.clear' | transloco }}
        </button>
      </div>
      <z-input-group class="w-full shrink-0 sm:w-64">
        <z-input-group-addon>
          <ng-icon name="lucideSearch" aria-hidden="true" />
        </z-input-group-addon>
        <input
          z-input
          type="search"
          autocomplete="off"
          maxlength="200"
          data-slot="status-search"
          [attr.aria-label]="'editor.translations.filter.search' | transloco"
          [placeholder]="'editor.translations.filter.search' | transloco"
          [value]="search()"
          (input)="typed($any($event.target).value)"
        />
      </z-input-group>
    </div>

    <div
      class="text-muted-foreground flex min-h-7 flex-wrap items-center justify-between gap-x-4 gap-y-1 text-xs"
    >
      <p class="m-0 flex flex-wrap items-center gap-x-2 gap-y-1">
        <span
          class="text-sm"
          [class.text-foreground]="chosen().length > 0"
          data-slot="chosen-count"
          aria-live="polite"
          >{{ chosenLabel().key | transloco: chosenLabel().params }}</span
        >
        <button
          z-button
          zType="link"
          zSize="xs"
          type="button"
          class="h-auto px-0"
          data-slot="chosen-clear"
          [ofReservedSlot]="chosen().length > 0"
          (click)="view.set({ rows: [] })"
        >
          {{ 'editor.translations.selection.clear' | transloco }}
        </button>
      </p>
      <p class="m-0 flex flex-wrap items-center gap-x-3 gap-y-1">
        <span class="sr-only">{{
          'editor.translations.legend' | transloco
        }}</span>
        @for (s of legendStates; track s) {
          <of-language-badge [state]="s" display="legend" />
        }
      </p>
    </div>

    <div class="flex min-w-0 flex-col gap-4 lg:flex-row lg:items-start">
      <of-list-frame
        #frame
        class="min-h-64 min-w-0 flex-1"
        [label]="'editor.translations.matrix.label' | transloco"
        [items]="rows()"
        [page]="page()"
        [loading]="loading()"
        [error]="frameError()"
        [offset]="offset()"
        [skeletonRows]="8"
        [pageSizes]="pageSizes"
        [emptyTitle]="
          (filtered()
            ? 'editor.translations.empty.filteredTitle'
            : 'editor.translations.empty.title'
          ) | transloco
        "
        [emptyDescription]="
          (filtered()
            ? 'editor.translations.empty.filteredDescription'
            : 'editor.translations.empty.description'
          ) | transloco
        "
        (pageChange)="view.set({ page: $event, cell: undefined })"
        (pageSizeChange)="view.set({ size: $event, page: 1, cell: undefined })"
        (retry)="reload()"
      >
        <ng-template ofListTable let-items>
          @let matrix = asRows(items);
          <table
            z-table
            role="grid"
            class="table-fixed"
            data-slot="matrix"
            [style.min-width.rem]="22 + languages().length * 8.5"
            [attr.aria-label]="'editor.translations.matrix.label' | transloco"
            [attr.aria-rowcount]="matrix.length + 1"
            (keydown)="navigate($event)"
          >
            <thead z-table-header class="bg-background sticky top-0 z-10">
              <tr z-table-row>
                <th z-table-head class="w-10">
                  <z-checkbox
                    data-slot="choose-page"
                    [zAriaLabel]="
                      'editor.translations.selection.page' | transloco
                    "
                    [ngModel]="pageChosen(matrix)"
                    [ngModelOptions]="{ standalone: true }"
                    (checkChange)="choosePage(matrix, $event)"
                  />
                </th>
                <th z-table-head class="min-w-64">
                  {{ 'editor.translations.matrix.module' | transloco }}
                </th>
                @for (l of languages(); track l) {
                  <th
                    z-table-head
                    class="w-34 text-center"
                    scope="col"
                    [attr.data-lang]="l"
                  >
                    <abbr
                      class="font-medium uppercase no-underline"
                      [attr.title]="languageLabel(l)"
                      >{{ l }}</abbr
                    >
                    <span class="sr-only">{{ languageLabel(l) }}</span>
                  </th>
                }
              </tr>
            </thead>
            <tbody z-table-body>
              @for (row of matrix; track row.id; let r = $index) {
                <tr
                  z-table-row
                  [ofListItem]="row"
                  data-slot="matrix-row"
                  [attr.data-row]="row.id"
                  [attr.data-state]="isChosen(row.id) ? 'selected' : null"
                >
                  <td z-table-cell class="align-top">
                    <z-checkbox
                      class="pt-0.5"
                      data-slot="choose-row"
                      [zAriaLabel]="
                        'editor.translations.selection.row'
                          | transloco: { title: row.title }
                      "
                      [ngModel]="isChosen(row.id)"
                      [ngModelOptions]="{ standalone: true }"
                      (checkChange)="choose(row.id, $event)"
                    />
                  </td>
                  <th
                    z-table-cell
                    scope="row"
                    class="text-start align-top font-normal whitespace-normal"
                  >
                    @if (row.kind === 'design') {
                      <a
                        class="text-foreground focus-visible:ring-ring/50 block rounded-sm font-medium break-words outline-none hover:underline focus-visible:ring-[3px]"
                        data-slot="design-link"
                        [routerLink]="['/admin', 'page-designs', row.ref]"
                        [queryParams]="csLink.params()"
                        >{{ row.title }}</a
                      >
                      <span
                        class="text-muted-foreground block text-xs [overflow-wrap:anywhere]"
                        data-slot="design-kind"
                        >{{ 'editor.translations.matrix.design' | transloco }} ·
                        <span class="font-mono">{{ row.ref }}</span></span
                      >
                    } @else if (row.kind === 'config') {
                      <a
                        class="text-foreground focus-visible:ring-ring/50 block rounded-sm font-medium break-words outline-none hover:underline focus-visible:ring-[3px]"
                        data-slot="config-link"
                        [routerLink]="['/admin', 'settings']"
                        [queryParams]="csLink.params()"
                        >{{
                          'editor.translations.matrix.configTitle' | transloco
                        }}</a
                      >
                      <span
                        class="text-muted-foreground block text-xs break-words"
                        data-slot="config-kind"
                        >{{
                          'editor.translations.matrix.configHint' | transloco
                        }}</span
                      >
                    } @else if (row.kind === 'manual') {
                      <a
                        class="text-foreground focus-visible:ring-ring/50 block rounded-sm font-medium break-words outline-none hover:underline focus-visible:ring-[3px]"
                        data-slot="manual-link"
                        [routerLink]="['/manuals']"
                        [queryParams]="{ ...csLink.params(), manual: row.ref }"
                        >{{ row.title }}</a
                      >
                      <span
                        class="text-muted-foreground block text-xs [overflow-wrap:anywhere]"
                        data-slot="manual-kind"
                        >{{ 'editor.translations.matrix.manual' | transloco }} ·
                        <span class="font-mono">{{ row.ref }}</span></span
                      >
                    } @else {
                      <a
                        class="text-foreground focus-visible:ring-ring/50 block rounded-sm font-medium break-words outline-none hover:underline focus-visible:ring-[3px]"
                        data-slot="module-link"
                        [routerLink]="['/content', sourceLang(), row.id]"
                        [queryParams]="csLink.params()"
                        >{{ row.title }}</a
                      >
                      <span
                        class="text-muted-foreground block font-mono text-xs [overflow-wrap:anywhere]"
                        >{{ row.id }}</span
                      >
                    }
                  </th>
                  @for (l of languages(); track l; let c = $index) {
                    @let item = row.cells.get(l);
                    <td
                      z-table-cell
                      class="text-center align-top"
                      [attr.data-lang]="l"
                    >
                      @if (item) {
                        @let key = cellOf(item);
                        <button
                          type="button"
                          class="focus-visible:ring-ring/50 data-[current]:bg-accent hover:bg-accent/60 inline-flex max-w-full rounded-md p-0.5 outline-none focus-visible:ring-[3px]"
                          data-slot="matrix-cell"
                          [attr.data-cell]="key"
                          [attr.data-pos]="r + ':' + c"
                          [attr.data-current]="
                            key === view.get('cell')() ? '' : null
                          "
                          [attr.aria-pressed]="key === view.get('cell')()"
                          [attr.aria-label]="cellLabel(row, l, item)"
                          [tabindex]="isActive(r, c) ? 0 : -1"
                          (focus)="active.set({ row: r, col: c })"
                          (click)="openCell(item)"
                        >
                          <of-language-badge
                            [state]="badgeState[item.attributes.state]"
                            [label]="cellWord(item)"
                          />
                        </button>
                      } @else {
                        <span class="text-muted-foreground" aria-hidden="true"
                          >–</span
                        ><span class="sr-only">{{
                          'editor.translations.matrix.notShown' | transloco
                        }}</span>
                      }
                    </td>
                  }
                </tr>
              }
            </tbody>
          </table>
        </ng-template>
      </of-list-frame>

      <!-- Beside the matrix it grows and shrinks; stacked under it (narrow) it only fades. -->
      <of-side-panel
        class="[--of-side-panel-closed-width:100%] [--of-side-panel-width:100%] lg:[--of-side-panel-closed-width:0px] lg:[--of-side-panel-gap:1rem] lg:[--of-side-panel-width:22rem] xl:[--of-side-panel-width:26rem]"
      >
        <ng-template [ofSidePanelContent]="panelCell()" let-c>
          <aside
            class="border-border bg-card overflow-y-auto rounded-xl border p-4"
            data-slot="cell-panel"
            [style.max-height]="'calc(100dvh - ' + offset() + ')'"
            [attr.aria-label]="'editor.translations.panel.label' | transloco"
          >
            <of-translation-cell-panel
              [cell]="c.key"
              [title]="c.title"
              [sourceLang]="sourceLang()"
              (closed)="view.set({ cell: undefined })"
            />
          </aside>
        </ng-template>
      </of-side-panel>
    </div>
  `,
})
export class TranslationStatusPage {
  private readonly api = inject(ApiClient);
  private readonly readRef = inject(ReadRef);
  private readonly language = inject(LanguageService);
  private readonly changes = inject(TranslationsChanges);
  private readonly t = injectTranslate();
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  protected readonly csLink = inject(ChangeSetUrl);

  protected readonly view = injectQueryState(STATUS_PARAMS);
  protected readonly pageSizes = STATUS_PAGE_SIZES;
  protected readonly badgeState = BADGE_STATE;
  /** The states a cell can have: a cell always knows its state, never only `translated`. */
  protected readonly legendStates = translationStates.filter(
    (s) => s !== 'translated',
  );

  private readonly source = inject(TranslationsSource);
  protected readonly config = this.source.config;
  protected readonly doc = signal<StatusDoc | null>(null);
  protected readonly loading = signal(false);
  private readonly failure = signal<ApiError | null>(null);
  private readonly reloads = signal(0);
  /** The search box's text; the address has it once typing pauses. */
  protected readonly search = signal(this.view.get('q')());
  /** The cell that takes Tab into the matrix (roving focus). */
  protected readonly active = signal<Position>({ row: 0, col: 0 });
  private readonly frame = viewChild('frame', { read: ElementRef });
  protected readonly offset = frameOffset(this.frame, BELOW_FRAME_PX, () =>
    this.doc(),
  );
  private runs = 0;
  private searchTimer: ReturnType<typeof setTimeout> | undefined;

  protected readonly sourceLang = this.source.sourceLang;
  private readonly targets = this.source.targets;
  protected readonly chosen = this.view.get('rows');
  /** What the chosen rows are (#656): modules, page designs, cover image texts, or mixed. */
  protected readonly chosenLabel = computed(() => chosenText(this.chosen()));

  protected readonly filtered = computed(() => {
    const v = this.view.values();
    return (
      v.manual !== undefined ||
      v.folder !== undefined ||
      v.lang !== undefined ||
      v.state !== undefined ||
      v.q !== ''
    );
  });

  protected readonly languages = computed(() =>
    matrixLanguages(
      this.targets(),
      this.doc()?.data ?? [],
      this.view.get('lang')(),
    ),
  );
  /**
   * The rows, a manual's by its title in the interface language and the project labels' by their
   * name in it (#731; the API names both in the source language).
   */
  protected readonly rows = computed(() => {
    const manuals = new Map(
      this.source.manuals().map((m) => [m.value, m.label]),
    );
    return matrixRows(this.doc()?.data ?? []).map((row) =>
      row.kind === 'config'
        ? { ...row, title: this.t('editor.translations.matrix.configTitle') }
        : row.kind === 'manual'
          ? { ...row, title: manuals.get(row.ref) || row.title }
          : row,
    );
  });
  /** The API pages the matrix by row (#689): its paging is the matrix's. */
  protected readonly page = computed(() => this.doc()?.meta.page ?? null);

  /** The chosen cell, for the side panel: on the page, or only in the address (a link). */
  protected readonly panelCell = computed(() => {
    const key = this.view.get('cell')();
    const cell = key ? parseCell(key) : null;
    if (!key || !cell || !this.config()) return null;
    const item = this.doc()?.data.find((i) => i.id === key);
    const row =
      item && this.rows().find((r) => r.cells.get(cell.lang) === item);
    return { id: key, key, title: row?.title ?? item?.meta.title ?? '' };
  });

  protected readonly frameError = computed(() => {
    const failure = this.source.failure() ?? this.failure();
    if (!failure) return null;
    const text = apiErrorText(failure);
    return { kind: failure.kind, message: this.t(text.key, text.params) };
  });

  protected readonly manualOptions = computed(() =>
    withCurrent(this.source.manuals(), this.view.get('manual')()),
  );
  protected readonly folders = computed((): FilterOption[] =>
    withCurrent(this.source.folders(), this.view.get('folder')()),
  );
  protected readonly languageOptions = computed((): FilterOption[] =>
    withCurrent(
      this.targets().map((l) => ({ value: l, label: this.languageLabel(l) })),
      this.view.get('lang')(),
    ),
  );
  protected readonly stateOptions = computed((): FilterOption[] =>
    STATES.map((s) => ({ value: s, label: this.t(STATE_TEXT[s]) })),
  );

  constructor() {
    effect(() => {
      const config = this.config();
      // Only what the list is asked by: opening a cell or choosing rows reads nothing again.
      const view = this.view;
      const query = {
        manual: view.get('manual')(),
        folder: view.get('folder')(),
        lang: view.get('lang')(),
        state: view.get('state')(),
        q: view.get('q')(),
        page: view.get('page')(),
        size: view.get('size')(),
      };
      // The chosen revision's branch (or its new head, #466), and an export or a cancel: read
      // again.
      this.readRef.ref();
      this.readRef.moves();
      this.changes.changed();
      this.reloads();
      if (!config) return;
      untracked(() => void this.load(query));
    });
    // The address changed the search (Back, a link): the box follows.
    effect(() => {
      const q = this.view.get('q')();
      untracked(() => {
        // Not while typing, nor for what the box already holds (a trailing space stays).
        if (this.searchTimer === undefined && this.search().trim() !== q) {
          this.search.set(q);
        }
      });
    });
    inject(DestroyRef).onDestroy(() => {
      this.runs++;
      clearTimeout(this.searchTimer);
    });
  }

  protected asRows(items: readonly unknown[]): readonly MatrixRow[] {
    return items as readonly MatrixRow[];
  }

  protected cellOf(item: StatusItem): string {
    return cellKey(item.attributes.lang, rowOf(item));
  }

  protected cellWord(item: StatusItem): string {
    const text = cellText(item);
    return this.t(text.key, text.params);
  }

  protected cellLabel(row: MatrixRow, lang: string, item: StatusItem): string {
    return this.t('editor.translations.matrix.cellLabel', {
      title: row.title,
      language: this.languageLabel(lang),
      state: this.cellWord(item),
    });
  }

  protected languageLabel(lang: string): string {
    return languageName(this.language.locale(), lang);
  }

  /**
   * The cell Tab reaches: the one last focused, else (gone with a filter or a page) the first
   * cell there is.
   */
  private readonly roving = computed((): Position | null => {
    const langs = this.languages();
    const cells = this.rows().flatMap((row, r) =>
      langs.flatMap((l, c) => (row.cells.has(l) ? [{ row: r, col: c }] : [])),
    );
    const a = this.active();
    return (
      cells.find((p) => p.row === a.row && p.col === a.col) ?? cells[0] ?? null
    );
  });

  protected isActive(row: number, col: number): boolean {
    const a = this.roving();
    return a !== null && a.row === row && a.col === col;
  }

  protected isChosen(id: string): boolean {
    return this.chosen().includes(id);
  }

  protected pageChosen(rows: readonly MatrixRow[]): boolean {
    const page = pageRows(rows, this.chosen());
    return page.length > 0 && page.every((r) => this.isChosen(r.id));
  }

  protected choose(id: string, on: boolean): void {
    const rows = this.chosen().filter((r) => r !== id);
    this.view.set({
      rows: on ? [...rows, id].slice(0, MAX_CHOSEN) : rows,
    });
  }

  protected choosePage(rows: readonly MatrixRow[], on: boolean): void {
    const ids = pageRows(rows, this.chosen()).map((r) => r.id);
    const others = this.chosen().filter((r) => !ids.includes(r));
    this.view.set({
      rows: on ? [...others, ...ids].slice(0, MAX_CHOSEN) : others,
    });
  }

  protected openCell(item: StatusItem): void {
    const key = this.cellOf(item);
    this.view.set({ cell: this.view.get('cell')() === key ? undefined : key });
  }

  protected setFilter(change: {
    manual?: string | undefined;
    folder?: string | undefined;
    lang?: string | undefined;
  }): void {
    this.view.set({ ...change, page: 1, cell: undefined });
  }

  protected setState(value: string): void {
    const state = STATES.find((s): s is ApiTranslationState => s === value);
    this.view.set({ state, page: 1, cell: undefined });
  }

  protected clearFilters(): void {
    clearTimeout(this.searchTimer);
    this.searchTimer = undefined;
    this.search.set('');
    this.view.set({
      manual: undefined,
      folder: undefined,
      lang: undefined,
      state: undefined,
      q: '',
      page: 1,
      cell: undefined,
    });
  }

  protected typed(value: string): void {
    this.search.set(value);
    clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => {
      this.searchTimer = undefined;
      this.view.set({ q: value.trim(), page: 1, cell: undefined });
    }, SEARCH_DEBOUNCE_MS);
  }

  protected reload(): void {
    // Without the configuration nothing could be asked: read it again first.
    if (this.source.failure()) void this.source.load();
    this.reloads.update((n) => n + 1);
  }

  /** The arrow keys move between cells; Home and End go to a row's first and last. */
  protected navigate(event: KeyboardEvent): void {
    const target = event.target as HTMLElement | null;
    const pos = target?.closest<HTMLElement>('[data-pos]')?.dataset['pos'];
    if (!pos) return;
    const [row, col] = pos.split(':').map(Number) as [number, number];
    const cells = [
      ...this.host.nativeElement.querySelectorAll<HTMLElement>(
        '[data-slot="matrix-cell"]',
      ),
    ].map((el) => {
      const [r, c] = (el.dataset['pos'] ?? '0:0').split(':').map(Number) as [
        number,
        number,
      ];
      return { el, r, c };
    });
    const pick = (
      found: { el: HTMLElement; r: number; c: number } | undefined,
    ) => {
      if (!found) return;
      event.preventDefault();
      this.active.set({ row: found.r, col: found.c });
      found.el.focus();
    };
    const inRow = cells.filter((x) => x.r === row);
    const inCol = cells.filter((x) => x.c === col);
    switch (event.key) {
      case 'ArrowRight':
        return pick(inRow.find((x) => x.c > col));
      case 'ArrowLeft':
        return pick([...inRow].reverse().find((x) => x.c < col));
      case 'ArrowDown':
        return pick(
          inCol.find((x) => x.r > row) ?? nearest(cells, row + 1, col),
        );
      case 'ArrowUp':
        return pick(
          [...inCol].reverse().find((x) => x.r < row) ??
            nearest(cells, row - 1, col),
        );
      case 'Home':
        return pick(inRow[0]);
      case 'End':
        return pick(inRow.at(-1));
    }
  }

  private async load(query: {
    manual: string | undefined;
    folder: string | undefined;
    lang: string | undefined;
    state: ApiTranslationState | undefined;
    q: string;
    page: number;
    size: number;
  }): Promise<void> {
    const run = ++this.runs;
    this.loading.set(true);
    this.failure.set(null);
    try {
      const doc = await firstValueFrom(
        this.api.get('/translations/status', {
          query: {
            ...(query.manual ? { 'filter[manual]': query.manual } : {}),
            ...(query.folder ? { 'filter[folder]': query.folder } : {}),
            ...(query.lang ? { 'filter[lang]': query.lang } : {}),
            ...(query.state ? { 'filter[state]': query.state } : {}),
            ...(query.q ? { 'filter[q]': query.q } : {}),
            // A page of rows, each with its statuses in every language it has (#689).
            'page[by]': 'row',
            ...pageQuery({ number: query.page, size: query.size }),
          },
        }),
      );
      if (run !== this.runs) return;
      const last = Math.max(1, doc.meta.page.lastPage);
      if (doc.data.length === 0 && query.page > last) {
        this.view.set({ page: last }, { replace: true });
        return;
      }
      this.doc.set(doc);
    } catch (error) {
      if (run !== this.runs) return;
      this.failure.set(toApiError(error));
    } finally {
      if (run === this.runs) this.loading.set(false);
    }
  }
}

/** The cell in `row` (or the first row past it) nearest to column `col`. */
function nearest<T extends { r: number; c: number }>(
  cells: readonly T[],
  row: number,
  col: number,
): T | undefined {
  const rows = [...new Set(cells.map((x) => x.r))];
  const target = rows.includes(row) ? row : undefined;
  if (target === undefined) return undefined;
  return cells
    .filter((x) => x.r === target)
    .sort((a, b) => Math.abs(a.c - col) - Math.abs(b.c - col))[0];
}

/** The options, with the address's value added (as itself) when none of them is it. */
function withCurrent(
  options: readonly FilterOption[],
  current: string | undefined,
): FilterOption[] {
  if (current === undefined || options.some((o) => o.value === current)) {
    return [...options];
  }
  return [...options, { value: current, label: current }];
}
