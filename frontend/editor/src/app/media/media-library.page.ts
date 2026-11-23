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
import { TranslocoPipe } from '@jsverse/transloco';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideFile,
  lucideImage,
  lucideLayoutGrid,
  lucideSearch,
  lucideTable,
  lucideUpload,
  lucideX,
} from '@ng-icons/lucide';
import { firstValueFrom } from 'rxjs';

import { formatFileSize } from '@openfolia/content-model/core';
import { ZardBadgeComponent } from '@openfolia/ui/badge';
import { ZardButtonComponent } from '@openfolia/ui/button';
import {
  injectTranslate,
  LanguageService,
  translated,
} from '@openfolia/ui/i18n';
import { ZardInputComponent } from '@openfolia/ui/input';
import { ZardInputGroupImports } from '@openfolia/ui/input-group';
import {
  ListFrameComponent,
  ListGridDirective,
  ListItemDirective,
  ListTableDirective,
} from '@openfolia/ui/list-frame';
import {
  SegmentedComponent,
  type SegmentedOption,
} from '@openfolia/ui/segmented';
import { ZardSheetImports } from '@openfolia/ui/sheet';
import { PageHeaderComponent } from '@openfolia/ui/shell';
import {
  FadeInDirective,
  ReservedSlotDirective,
  SidePanelComponent,
  SidePanelContentDirective,
} from '@openfolia/ui/smooth';
import { ZardTableImports } from '@openfolia/ui/table';
import { ToastService } from '@openfolia/ui/toast';

import {
  ApiClient,
  ReadRef,
  toApiError,
  type ApiError,
  type Response,
} from '../api';
import {
  languageName,
  languagesOf,
  type StoredConfig,
} from '../content/browser-model';
import {
  FilterChipComponent,
  type FilterOption,
} from '../content/filter-chip.component';
import { injectDraftBlocked } from '../content/module-actions';
import { apiErrorText, labelsInUi } from '../i18n';
import { ImageSources } from '../images/image-sources';
import { ImageThumbComponent } from '../images/image-thumb.component';
import { GuardDirective } from '../permissions/guard.directive';
import { MeService } from '../permissions/me';
import { ChangeSetSession } from '../session/change-set-session';
import { Generation } from '../shared/generation';
import { injectQueryState } from '../view-state';
import { MediaDeletion } from './media-deletion';
import { MediaDetailComponent } from './media-detail.component';
import {
  displayName,
  freshUpload,
  hasRenditions,
  inUse,
  isImage,
  listQuery,
  MEDIA_PARAMS,
  PAGE_SIZES,
  shortType,
  TYPE_FILTERS,
  type MediaItem,
  type MediaView,
  type TypeFilter,
} from './media-model';
import { MediaUploads } from './media-uploads';
import { UnusedLocator } from './media-unused';
import { MediaUsageReader } from './media-usage';

/** What a filter change sets. */
type FilterChange = Partial<Pick<MediaView, 'type' | 'usage' | 'lang' | 'q'>>;

/** Space kept below the frame: the page's bottom padding. */
const BELOW_FRAME_PX = 32;
const SEARCH_DEBOUNCE_MS = 300;
/** From this width the details sit beside the list; below it they open in a sheet. */
const WIDE = '(min-width: 64rem)';

/** The type filter's labels; keys written out in full. */
const TYPE_LABELS: Readonly<Record<TypeFilter, string>> = {
  image: 'editor.media.types.image',
  attachment: 'editor.media.types.attachment',
  'image/png': 'editor.media.types.png',
  'image/jpeg': 'editor.media.types.jpeg',
  'image/svg+xml': 'editor.media.types.svg',
  'image/gif': 'editor.media.types.gif',
  'image/webp': 'editor.media.types.webp',
  'application/pdf': 'editor.media.types.pdf',
  'application/zip': 'editor.media.types.zip',
};

/**
 * Screen 23, the media library: the images and attached files of the content (`GET /assets` at
 * the chosen change set's branch, its own uploads first), as a grid of thumbnails (the 320-pixel
 * renditions) or a table, filtered by type, language and "unused", searched, paged; the grid and
 * the table scroll inside their frame with the pagination outside it. A file's details open beside
 * the list (a sheet on phones). "Upload" sends files into the chosen draft change set with their
 * progress; "Delete" removes an unused file with Undo (`MediaDeletion`). The view, the filters,
 * the page and the open file are in the address.
 */
@Component({
  selector: 'of-media-library',
  imports: [
    TranslocoPipe,
    NgIcon,
    FadeInDirective,
    PageHeaderComponent,
    ListFrameComponent,
    ListGridDirective,
    ListItemDirective,
    ReservedSlotDirective,
    ListTableDirective,
    SegmentedComponent,
    SidePanelComponent,
    SidePanelContentDirective,
    ZardBadgeComponent,
    ZardButtonComponent,
    ZardInputComponent,
    ZardInputGroupImports,
    ZardSheetImports,
    ZardTableImports,
    GuardDirective,
    FilterChipComponent,
    ImageThumbComponent,
    MediaDetailComponent,
  ],
  providers: [ImageSources, MediaUsageReader, UnusedLocator],
  viewProviders: [
    provideIcons({
      lucideFile,
      lucideImage,
      lucideLayoutGrid,
      lucideSearch,
      lucideTable,
      lucideUpload,
      lucideX,
    }),
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'flex min-w-0 flex-col gap-4' },
  template: `
    <of-page-header [title]="'editor.media.title' | transloco">
      <button
        z-button
        type="button"
        [ofGuard]="{
          permission: 'content.edit',
          blockedReason: uploadBlocked(),
        }"
        (click)="fileInput.click()"
      >
        <ng-icon
          name="lucideUpload"
          data-icon="inline-start"
          strokeWidth="1.5"
          aria-hidden="true"
        />
        {{ 'editor.media.upload.open' | transloco }}
      </button>
      <input
        #fileInput
        type="file"
        multiple
        class="hidden"
        tabindex="-1"
        aria-hidden="true"
        (change)="picked($event)"
      />
    </of-page-header>

    <!-- The view switch and the search have a column of their own and Reset filters a place kept
         for it, so turning a filter on or off never wraps the bar or moves the list -->
    <div
      class="flex flex-col gap-2 xl:flex-row xl:items-start"
      role="group"
      [attr.aria-label]="'editor.media.filters.label' | transloco"
    >
      <div class="flex min-w-0 flex-1 flex-wrap items-center gap-2">
        <of-filter-chip
          [label]="'editor.media.filters.type' | transloco"
          [allLabel]="'editor.content.filters.all' | transloco"
          [options]="typeOptions()"
          [value]="view.get('type')() ?? ''"
          (changed)="patch({ type: asType($event) })"
        />
        @if (canSeeUnused()) {
          <of-filter-chip
            [label]="'editor.media.filters.usage' | transloco"
            [allLabel]="'editor.content.filters.all' | transloco"
            [options]="usageOptions()"
            [value]="unusedList() ? 'unused' : ''"
            (changed)="patch({ usage: $event === 'unused' ? 'unused' : 'all' })"
          />
        }
        @if (!unusedList()) {
          <of-filter-chip
            [label]="'editor.media.filters.language' | transloco"
            [allLabel]="'editor.content.filters.all' | transloco"
            [options]="languageOptions()"
            [value]="view.get('lang')() ?? ''"
            (changed)="patch({ lang: $event || undefined })"
          />
        }
        <button
          z-button
          zType="ghost"
          zSize="sm"
          type="button"
          class="text-muted-foreground"
          data-slot="filters-reset"
          [ofReservedSlot]="hasFilters()"
          (click)="resetFilters()"
        >
          <ng-icon name="lucideX" aria-hidden="true" />
          {{ 'editor.content.filters.reset' | transloco }}
        </button>
      </div>
      <span
        class="flex w-full flex-wrap items-center gap-2 xl:w-auto xl:shrink-0"
      >
        <of-segmented
          [options]="viewOptions()"
          [value]="view.get('view')()"
          [label]="'editor.media.view.label' | transloco"
          (valueChange)="setView($event)"
        />
        <z-input-group class="min-w-0 flex-1 sm:w-72 sm:flex-none">
          <z-input-group-addon>
            <ng-icon name="lucideSearch" aria-hidden="true" />
          </z-input-group-addon>
          <input
            z-input
            type="search"
            autocomplete="off"
            maxlength="200"
            [attr.aria-label]="'editor.media.filters.search' | transloco"
            [placeholder]="'editor.media.filters.search' | transloco"
            [value]="search()"
            (input)="typed($any($event.target).value)"
          />
        </z-input-group>
      </span>
    </div>

    @if (uploads.rows().length > 0) {
      <ul
        class="m-0 flex list-none flex-col gap-2 p-0"
        [attr.aria-label]="'editor.media.upload.list' | transloco"
      >
        @for (row of uploads.rows(); track row.key) {
          <li
            ofFadeIn
            class="border-border bg-card flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border px-3 py-2"
          >
            <span class="min-w-0 flex-1 [overflow-wrap:anywhere]">{{
              row.name
            }}</span>
            <span class="text-muted-foreground text-xs tabular-nums">{{
              'editor.media.upload.progress'
                | transloco: { percent: percent(row.progress) }
            }}</span>
            <span
              class="bg-muted h-1.5 w-full overflow-hidden rounded-full sm:w-40"
              role="progressbar"
              aria-valuemin="0"
              aria-valuemax="100"
              [attr.aria-valuenow]="percent(row.progress)"
              [attr.aria-label]="
                'editor.media.upload.uploading' | transloco: { name: row.name }
              "
            >
              <span
                class="bg-primary block h-full rounded-full transition-[width] duration-200 motion-reduce:transition-none"
                [style.width.%]="percent(row.progress)"
              ></span>
            </span>
          </li>
        }
      </ul>
    }

    <div class="flex min-h-0 min-w-0 items-start gap-4">
      <of-list-frame
        #frame
        class="min-w-0 flex-1"
        [label]="'editor.media.list' | transloco"
        [items]="items()"
        [page]="doc()?.meta?.page ?? null"
        [loading]="loading()"
        [error]="frameError()"
        [offset]="offset()"
        [pageSizes]="pageSizes"
        [skeletonRows]="12"
        [emptyTitle]="emptyTitle()"
        [emptyDescription]="emptyDescription()"
        (pageChange)="view.set({ page: $event })"
        (pageSizeChange)="view.set({ size: $event, page: 1 })"
        (retry)="reload()"
      >
        @if (hasFilters()) {
          <button
            ofListEmpty
            z-button
            zType="outline"
            zSize="sm"
            type="button"
            (click)="resetFilters()"
          >
            <ng-icon name="lucideX" aria-hidden="true" />
            {{ 'editor.content.filters.reset' | transloco }}
          </button>
        }
        @if (view.get('view')() === 'grid') {
          <ng-template ofListGrid let-items>
            <div
              class="grid grid-cols-2 gap-3 p-0.5 sm:grid-cols-3 xl:grid-cols-4"
              role="listbox"
              data-slot="media-grid"
              [attr.aria-label]="'editor.media.list' | transloco"
              (keydown)="moveIn($event)"
            >
              @for (f of asItems(items); track f.id) {
                @let chosen = f.id === view.get('file')();
                <button
                  type="button"
                  role="option"
                  [ofListItem]="f"
                  class="border-border bg-card hover:bg-muted/50 focus-visible:ring-ring/50 flex min-w-0 flex-col gap-1.5 rounded-lg border p-1.5 text-start transition-colors duration-150 outline-none focus-visible:ring-[3px] motion-reduce:transition-none"
                  [class.border-foreground]="chosen"
                  [class.ring-1]="chosen"
                  [class.ring-foreground]="chosen"
                  [attr.aria-selected]="chosen"
                  [attr.tabindex]="f.id === focusKey() ? 0 : -1"
                  [attr.data-key]="f.id"
                  (click)="select(f)"
                  (focus)="focused.set(f.id)"
                >
                  @if (isImage(f)) {
                    <of-image-thumb
                      [asset]="thumbAsset(f)"
                      [changeSetId]="ownChangeSet()"
                      [upload]="freshUpload(f)"
                      [width]="hasRenditions(f) ? 320 : undefined"
                    />
                  } @else {
                    <span
                      class="bg-muted text-muted-foreground flex aspect-[8/5] flex-col items-center justify-center gap-1 rounded-md"
                    >
                      <ng-icon name="lucideFile" size="24" aria-hidden="true" />
                      @if (shortType(f); as st) {
                        <span class="text-xs font-medium">{{ st }}</span>
                      }
                    </span>
                  }
                  <span
                    class="min-w-0 px-0.5 text-[0.8125rem] leading-5 [overflow-wrap:anywhere]"
                    >{{ name(f) }}</span
                  >
                  <span class="px-0.5 pb-0.5">
                    <z-badge
                      [zType]="inUse(f) ? 'success' : 'secondary'"
                      class="font-normal"
                      >{{ statusText(f) | transloco }}</z-badge
                    >
                  </span>
                </button>
              }
            </div>
          </ng-template>
        } @else {
          <ng-template ofListTable let-items>
            <table z-table class="min-w-[48rem] table-fixed">
              <thead z-table-header class="bg-background sticky top-0 z-10">
                <tr z-table-row>
                  <th z-table-head class="w-20">
                    <span class="sr-only">{{
                      'editor.media.table.preview' | transloco
                    }}</span>
                  </th>
                  <th z-table-head class="w-[30%]">
                    {{ 'editor.media.table.name' | transloco }}
                  </th>
                  <th z-table-head class="w-[12%]">
                    {{ 'editor.media.table.type' | transloco }}
                  </th>
                  <th z-table-head class="w-[10%]">
                    {{ 'editor.media.table.size' | transloco }}
                  </th>
                  <th z-table-head class="w-[13%]">
                    {{ 'editor.media.table.dimensions' | transloco }}
                  </th>
                  <th z-table-head class="w-[15%]">
                    {{ 'editor.media.table.languages' | transloco }}
                  </th>
                  <th z-table-head class="w-[14%]">
                    {{ 'editor.media.table.usage' | transloco }}
                  </th>
                </tr>
              </thead>
              <tbody z-table-body>
                @for (f of asItems(items); track f.id) {
                  @let chosen = f.id === view.get('file')();
                  <tr
                    z-table-row
                    [ofListItem]="f"
                    class="hover:bg-muted/50 cursor-pointer"
                    [attr.data-state]="chosen ? 'selected' : null"
                    [attr.aria-current]="chosen ? 'true' : null"
                    data-slot="media-row"
                    (click)="select(f)"
                  >
                    <td z-table-cell class="align-top">
                      @if (isImage(f)) {
                        <of-image-thumb
                          class="w-14"
                          [asset]="thumbAsset(f)"
                          [changeSetId]="ownChangeSet()"
                          [upload]="freshUpload(f)"
                          [width]="hasRenditions(f) ? 320 : undefined"
                        />
                      } @else {
                        <span
                          class="bg-muted text-muted-foreground flex aspect-[8/5] w-14 items-center justify-center rounded-md"
                        >
                          <ng-icon
                            name="lucideFile"
                            size="18"
                            aria-hidden="true"
                          />
                        </span>
                      }
                    </td>
                    <td
                      z-table-cell
                      class="align-top break-words whitespace-normal"
                    >
                      <button
                        type="button"
                        class="text-foreground focus-visible:ring-ring/50 rounded-sm text-start font-medium [overflow-wrap:anywhere] outline-none hover:underline focus-visible:ring-[3px]"
                        [attr.aria-current]="chosen ? 'true' : null"
                        (click)="$event.stopPropagation(); select(f)"
                      >
                        {{ name(f) }}
                      </button>
                    </td>
                    <td z-table-cell class="align-top whitespace-normal">
                      {{ shortType(f) ?? '' }}
                    </td>
                    <td z-table-cell class="align-top tabular-nums">
                      {{
                        f.attributes.size === null
                          ? ''
                          : bytes(f.attributes.size)
                      }}
                    </td>
                    <td z-table-cell class="align-top tabular-nums">
                      {{ dimensions(f) }}
                    </td>
                    <td z-table-cell class="align-top whitespace-normal">
                      <span class="flex flex-wrap gap-1 uppercase">
                        @for (l of f.meta.languages; track l) {
                          <z-badge
                            zType="outline"
                            class="font-normal"
                            [attr.title]="langName(l)"
                            >{{ l }}</z-badge
                          >
                        }
                      </span>
                    </td>
                    <td z-table-cell class="align-top whitespace-normal">
                      <z-badge
                        [zType]="inUse(f) ? 'success' : 'secondary'"
                        class="font-normal"
                        >{{ statusText(f) | transloco }}</z-badge
                      >
                      @if (inUse(f) && f.meta.usedInCount > 0) {
                        <span class="text-muted-foreground ms-1 text-xs">{{
                          'editor.images.usedIn'
                            | transloco: { count: f.meta.usedInCount }
                        }}</span>
                      }
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </ng-template>
        }
      </of-list-frame>

      <!-- Opens, switches and closes smoothly; on a narrow screen the sheet below has it. -->
      <of-side-panel
        class="[--of-side-panel-gap:1rem] xl:[--of-side-panel-width:21rem]"
      >
        <ng-template [ofSidePanelContent]="wide() ? selected() : null" let-f>
          <aside
            class="border-border bg-card overflow-y-auto rounded-xl border p-4"
            data-slot="media-detail"
            [style.max-height]="'calc(100dvh - ' + offset() + ')'"
            [attr.aria-label]="'editor.media.detail.title' | transloco"
          >
            <of-media-detail
              [item]="f"
              [label]="name(f)"
              [unusedList]="unusedList()"
              [languages]="languages()"
              [canDelete]="canSeeUnused()"
              [changeSetId]="ownChangeSet()"
              [changeSetTitle]="ownChangeSetTitle()"
              [replaceBlocked]="draftBlocked()"
              [revision]="revision()"
              [pageSize]="view.get('size')()"
              (closed)="close()"
              (deleted)="remove(f)"
            />
          </aside>
        </ng-template>
      </of-side-panel>
    </div>

    <!-- The address opens and closes it, Back and Forward included. -->
    <z-sheet
      zSide="bottom"
      zSize="custom"
      zHeight="85dvh"
      class="overflow-y-auto p-4"
      [zCloseOnNavigation]="false"
      [zVisible]="!!selected() && !wide()"
      (zVisibleChange)="$event || close()"
    >
      @if (selected(); as f) {
        @if (!wide()) {
          <z-sheet-header class="p-0 pb-2">
            <z-sheet-title>{{
              'editor.media.detail.title' | transloco
            }}</z-sheet-title>
          </z-sheet-header>
          <of-media-detail
            [item]="f"
            [label]="name(f)"
            [unusedList]="unusedList()"
            [languages]="languages()"
            [canDelete]="canSeeUnused()"
            [changeSetId]="ownChangeSet()"
            [changeSetTitle]="ownChangeSetTitle()"
            [replaceBlocked]="draftBlocked()"
            [closable]="false"
            [revision]="revision()"
            [pageSize]="view.get('size')()"
            (deleted)="remove(f)"
          />
        }
      }
    </z-sheet>
  `,
})
export class MediaLibraryPage {
  private readonly api = inject(ApiClient);
  private readonly readRef = inject(ReadRef);
  private readonly me = inject(MeService);
  private readonly toast = inject(ToastService);
  private readonly language = inject(LanguageService);
  private readonly changeSets = inject(ChangeSetSession);
  private readonly deletion = inject(MediaDeletion);
  protected readonly uploads = inject(MediaUploads);
  protected readonly draftBlocked = injectDraftBlocked();
  private readonly t = injectTranslate();

  protected readonly pageSizes = PAGE_SIZES;
  /** View, filters, search, page and the open file live in the address. */
  protected readonly view = injectQueryState(MEDIA_PARAMS);
  /** The search box's text; the address has it once typing pauses. */
  protected readonly search = signal(this.view.get('q')());
  /** The tile that holds the grid's tab stop. */
  protected readonly focused = signal<string | null>(null);

  /** The configuration as read (`GET /config`). */
  private readonly storedConfig = signal<StoredConfig | null>(null);
  /** The configuration with its labels in the interface language (#731). */
  protected readonly config = labelsInUi(this.storedConfig);
  protected readonly doc = signal<Response<'/assets'> | null>(null);
  protected readonly loading = signal(true);
  private readonly failure = signal<ApiError | null>(null);
  private readonly reloads = signal(0);
  /** Bumps with each list read: the open file's usage is read again with it. */
  protected readonly revision = signal(0);
  private runs = 0;
  private readonly configReads = new Generation();

  private readonly frame = viewChild('frame', { read: ElementRef });
  protected readonly offset = signal('16rem');
  protected readonly wide = signal(
    typeof matchMedia === 'function' ? matchMedia(WIDE).matches : true,
  );

  /**
   * What is read and by whom: the list is read again when either changes, or the branch gets a
   * new head (an update from main, #466).
   */
  private readonly readKey = computed(
    () =>
      `${this.readRef.ref() ?? ''}\n${this.me.me().id}\n${this.readRef.moves()}`,
  );

  /** The chosen change set when it is the person's own: its uploads come first (and preview). */
  protected readonly ownChangeSet = computed((): string | null => {
    const chosen = this.changeSets.selected();
    if (!chosen?.branch) return null;
    const option = this.changeSets.options().find((o) => o.id === chosen.id);
    return option && option.authorId === this.me.me().id ? chosen.id : null;
  });

  /** The own chosen change set's title, as the list has it; null while it isn't known. */
  protected readonly ownChangeSetTitle = computed((): string | null => {
    const id = this.ownChangeSet();
    if (!id) return null;
    return this.changeSets.options().find((o) => o.id === id)?.title || null;
  });

  /** Finding and deleting unused files: `content.read.draft` and `content.edit`, each unrestricted (`Me.editsEverything`). */
  protected readonly canSeeUnused = computed(
    () => this.me.me().editsEverything === true,
  );

  protected readonly unusedList = computed(
    () => this.view.get('usage')() === 'unused' && this.canSeeUnused(),
  );

  /** Why Upload is blocked now (a key), or null: uploads go into a draft change set of one's own. */
  protected readonly uploadBlocked = computed((): string | null => {
    const blocked = this.draftBlocked();
    if (blocked) return blocked;
    return this.ownChangeSet() ? null : 'editor.media.upload.notOwn';
  });

  protected readonly languages = computed((): readonly string[] => {
    const c = this.config();
    return c ? languagesOf(c) : [];
  });

  protected readonly typeOptions = computed((): FilterOption[] =>
    TYPE_FILTERS.map((value) => ({
      value,
      label: this.t(TYPE_LABELS[value]),
    })),
  );

  protected readonly usageOptions = computed((): FilterOption[] => [
    { value: 'unused', label: this.t('editor.media.filters.unused') },
  ]);

  protected readonly languageOptions = computed((): FilterOption[] => {
    const locale = this.language.locale();
    return this.languages().map((l) => ({
      value: l,
      label: languageName(locale, l),
    }));
  });

  protected readonly viewOptions = computed((): SegmentedOption[] => [
    { value: 'grid', label: this.t('editor.media.view.grid') },
    { value: 'table', label: this.t('editor.media.view.table') },
  ]);

  /** The page's files, less those waiting for their delete. */
  protected readonly items = computed((): readonly MediaItem[] => {
    const hidden = this.deletion.hidden();
    return (this.doc()?.data ?? []).filter((f) => !hidden.has(f.id));
  });

  /** The open file, when it is on the page shown. */
  protected readonly selected = computed((): MediaItem | null => {
    const id = this.view.get('file')();
    return id ? (this.items().find((f) => f.id === id) ?? null) : null;
  });

  protected readonly focusKey = computed(() => {
    const ids = this.items().map((f) => f.id);
    const focused = this.focused();
    if (focused && ids.includes(focused)) return focused;
    const chosen = this.view.get('file')();
    if (chosen && ids.includes(chosen)) return chosen;
    return ids[0] ?? null;
  });

  /**
   * The list's request, from the list's own fields only: opening a file or switching between
   * grid and table reads nothing again.
   */
  private readonly query = computed(
    () =>
      listQuery(
        { ...this.view.values(), usage: this.unusedList() ? 'unused' : 'all' },
        this.ownChangeSet(),
      ),
    { equal: (a, b) => JSON.stringify(a) === JSON.stringify(b) },
  );

  protected readonly hasFilters = computed(() => {
    const v = this.view.values();
    return (
      v.type !== undefined ||
      (v.lang !== undefined && !this.unusedList()) ||
      v.usage !== 'all' ||
      this.search().trim() !== ''
    );
  });

  protected readonly frameError = computed(() => {
    const f = this.failure();
    if (!f) return null;
    const text = apiErrorText(f);
    return { kind: f.kind, message: this.t(text.key, text.params) };
  });

  protected readonly emptyTitle = computed(() =>
    this.t(
      this.unusedList()
        ? 'editor.media.empty.unusedTitle'
        : this.hasFilters()
          ? 'editor.media.empty.filteredTitle'
          : 'editor.media.empty.title',
    ),
  );

  protected readonly emptyDescription = computed(() =>
    this.t(
      this.unusedList()
        ? 'editor.media.empty.unused'
        : this.hasFilters()
          ? 'editor.media.empty.filtered'
          : 'editor.media.empty.none',
    ),
  );

  constructor() {
    const destroyRef = inject(DestroyRef);
    // The configuration (its languages) follows the branch read, and whoever is acting.
    effect(() => {
      this.readKey();
      // A switch unanswered: what was asked for the person before lands for nobody (#716).
      if (this.changeSets.switching()) {
        this.configReads.end();
        return;
      }
      untracked(() => void this.loadConfig());
    });
    // Back, Forward or a link changed the search: the box shows it, unless the person is typing.
    effect(() => {
      const q = this.view.get('q')();
      untracked(() => {
        if (!this.typing && this.search().trim() !== q) this.search.set(q);
      });
    });
    // "Unused" in a link, for a role that may not list unused files: the usual list instead.
    effect(() => {
      if (this.me.status() !== 'ready') return;
      if (this.view.get('usage')() === 'unused' && !this.canSeeUnused()) {
        untracked(() =>
          this.view.set({ usage: 'all', page: 1 }, { replace: true }),
        );
      }
    });
    effect(() => {
      const query = this.query();
      this.readKey();
      this.reloads();
      this.deletion.changed();
      this.uploads.changed();
      if (this.changeSets.switching() || this.changeSets.resolving()) return;
      untracked(() => void this.load(query));
    });
    // An open file that is not on the page once it is read (gone, another page): closed.
    effect(() => {
      const id = this.view.get('file')();
      if (!id || this.loading() || this.failure()) return;
      if (!this.items().some((f) => f.id === id)) {
        untracked(() => this.view.set({ file: undefined }, { replace: true }));
      }
    });
    // The frame takes the height left under it, so the page itself never scrolls.
    const measure = () => {
      const el = this.frame()?.nativeElement as HTMLElement | undefined;
      if (!el) return;
      const top = Math.round(el.getBoundingClientRect().top);
      this.offset.set(`${Math.max(0, top) + BELOW_FRAME_PX}px`);
    };
    afterRenderEffect(() => {
      this.frame();
      this.uploads.rows();
      this.config();
      measure();
    });
    const media = typeof matchMedia === 'function' ? matchMedia(WIDE) : null;
    const onMedia = () => this.wide.set(media?.matches ?? true);
    media?.addEventListener('change', onMedia);
    window.addEventListener('resize', measure);
    let timer: ReturnType<typeof setTimeout> | undefined;
    this.debounce = (value: string) => {
      clearTimeout(timer);
      this.typing = true;
      timer = setTimeout(() => {
        this.typing = false;
        this.patch({ q: value.trim() });
      }, SEARCH_DEBOUNCE_MS);
    };
    this.cancelDebounce = () => {
      clearTimeout(timer);
      this.typing = false;
    };
    destroyRef.onDestroy(() => {
      media?.removeEventListener('change', onMedia);
      window.removeEventListener('resize', measure);
      clearTimeout(timer);
    });
  }

  private debounce: (value: string) => void = () => undefined;
  private cancelDebounce: () => void = () => undefined;
  /** Text typed is waiting for the debounce: the box is ahead of the address. */
  private typing = false;

  private async loadConfig(): Promise<void> {
    const live = this.configReads.start();
    try {
      const doc = await firstValueFrom(this.api.get('/config'));
      if (!live()) return;
      this.storedConfig.set(doc.data.attributes);
    } catch {
      // The list's own failure (the same server) says it; the language filter waits.
    }
  }

  private async load(query: ReturnType<typeof listQuery>): Promise<void> {
    const run = ++this.runs;
    this.loading.set(true);
    this.failure.set(null);
    try {
      const doc = await firstValueFrom(this.api.get('/assets', { query }));
      if (run !== this.runs) return;
      // A page past the end (the list shrank): the last one there is.
      const last = Math.max(1, doc.meta.page.lastPage);
      if (doc.data.length === 0 && this.view.get('page')() > last) {
        this.view.set({ page: last }, { replace: true });
        return;
      }
      // A link to one file by its hash (the storage view's largest files): a file nobody uses
      // is on the unused list, for whoever may see it.
      const v = this.view.values();
      if (
        doc.data.length === 0 &&
        query['filter[unused]'] === undefined &&
        v.q !== undefined &&
        v.q === v.file &&
        this.canSeeUnused()
      ) {
        this.view.set({ usage: 'unused', page: 1 }, { replace: true });
        return;
      }
      this.doc.set(doc);
      this.revision.update((n) => n + 1);
      this.loading.set(false);
    } catch (error) {
      if (run !== this.runs) return;
      this.doc.set(null);
      this.failure.set(toApiError(error));
      this.loading.set(false);
    }
  }

  protected reload(): void {
    this.reloads.update((n) => n + 1);
  }

  /** A filter changed: page 1 again; the open file stays open while it is listed. */
  protected patch(change: FilterChange): void {
    this.view.set({ ...change, page: 1 });
  }

  protected asType(value: string): TypeFilter | undefined {
    return TYPE_FILTERS.find((t) => t === value);
  }

  protected setView(value: string): void {
    this.view.set({ view: value === 'table' ? 'table' : 'grid' });
  }

  protected typed(value: string): void {
    this.search.set(value);
    this.debounce(value);
  }

  protected resetFilters(): void {
    this.cancelDebounce();
    this.search.set('');
    this.view.set({
      q: '',
      type: undefined,
      lang: undefined,
      usage: 'all',
      page: 1,
    });
  }

  protected select(item: MediaItem): void {
    this.focused.set(item.id);
    this.view.set({ file: item.id });
  }

  protected close(): void {
    this.view.set({ file: undefined });
  }

  /** Delete: the file leaves the list at once, with Undo; the details close. */
  protected remove(item: MediaItem): void {
    if (!this.unusedList() || !this.canSeeUnused()) return;
    this.deletion.delete(item.id, this.name(item));
    this.view.set({ file: undefined }, { replace: true });
  }

  protected picked(event: Event): void {
    const input = event.target as HTMLInputElement;
    const files = [...(input.files ?? [])];
    input.value = '';
    const changeSetId = this.ownChangeSet();
    if (files.length === 0) return;
    const blocked = this.uploadBlocked();
    if (blocked || !changeSetId) {
      this.toast.error(translated(blocked ?? 'editor.media.upload.notOwn'));
      return;
    }
    this.uploads.upload(files, changeSetId);
  }

  /** Arrows move the focus through the grid (a row is as wide as the grid shows), Home and End to its ends. */
  protected moveIn(event: KeyboardEvent): void {
    const keys = [
      'ArrowLeft',
      'ArrowRight',
      'ArrowUp',
      'ArrowDown',
      'Home',
      'End',
    ];
    if (!keys.includes(event.key)) return;
    const grid = event.currentTarget as HTMLElement;
    const tiles = [...grid.querySelectorAll<HTMLElement>('[role="option"]')];
    const index = tiles.indexOf(event.target as HTMLElement);
    if (index < 0) return;
    event.preventDefault();
    const style = getComputedStyle(grid);
    const columns = Math.max(
      1,
      style.gridTemplateColumns.split(' ').filter(Boolean).length,
    );
    const rtl = style.direction === 'rtl';
    const step: Record<string, number> = {
      ArrowLeft: rtl ? 1 : -1,
      ArrowRight: rtl ? -1 : 1,
      ArrowUp: -columns,
      ArrowDown: columns,
    };
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? tiles.length - 1
          : Math.min(
              tiles.length - 1,
              Math.max(0, index + (step[event.key] ?? 0)),
            );
    const key = tiles[next]?.dataset['key'];
    if (!key) return;
    this.focused.set(key);
    tiles[next]?.focus();
  }

  protected asItems(value: unknown): readonly MediaItem[] {
    return value as readonly MediaItem[];
  }

  protected readonly isImage = isImage;
  protected readonly hasRenditions = hasRenditions;
  protected readonly freshUpload = freshUpload;
  protected readonly shortType = shortType;

  protected inUse(item: MediaItem): boolean {
    return inUse(item, this.unusedList());
  }

  protected name(item: MediaItem): string {
    return displayName(item, this.view.get('lang')() ?? '');
  }

  /**
   * The image a tile reads: one a module at the branch shows, or the person's own fresh upload.
   * A file of the "unused" list is served to nobody (no module refers to it): no read, an icon.
   */
  protected thumbAsset(item: MediaItem): string {
    return this.unusedList() && !item.meta.uploaded
      ? ''
      : item.attributes.reference;
  }

  /** The tile's status word (a key): never told by colour alone. */
  protected statusText(item: MediaItem): string {
    if (this.inUse(item)) return 'editor.media.status.used';
    if (item.meta.missing) return 'editor.media.status.missing';
    if (item.meta.uploaded && !this.unusedList())
      return 'editor.media.status.uploaded';
    return 'editor.media.status.unused';
  }

  protected dimensions(item: MediaItem): string {
    const { width, height } = item.attributes;
    if (!width || !height) return '';
    const fmt = new Intl.NumberFormat(this.language.locale());
    return this.t('editor.images.pixels', {
      width: fmt.format(width),
      height: fmt.format(height),
    });
  }

  protected bytes(size: number): string {
    return formatFileSize(size, this.language.locale());
  }

  protected langName(lang: string): string {
    return languageName(this.language.locale(), lang);
  }

  protected percent(progress: number): number {
    return Math.round(progress * 100);
  }
}
