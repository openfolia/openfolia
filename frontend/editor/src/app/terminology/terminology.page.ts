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
import { NgTemplateOutlet } from '@angular/common';
import { TranslocoPipe } from '@jsverse/transloco';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideDownload,
  lucidePlus,
  lucideSearch,
  lucideX,
} from '@ng-icons/lucide';
import { firstValueFrom } from 'rxjs';

import { ZardAlertDialogService } from '@openfolia/ui/alert-dialog';
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
  ListItemDirective,
  ListTableDirective,
} from '@openfolia/ui/list-frame';
import { ZardSheetImports } from '@openfolia/ui/sheet';
import { PageHeaderComponent } from '@openfolia/ui/shell';
import { ZardSkeletonComponent } from '@openfolia/ui/skeleton';
import {
  ReservedSlotDirective,
  SidePanelComponent,
  SidePanelContentDirective,
  FadeInDirective,
} from '@openfolia/ui/smooth';
import { ErrorStateComponent } from '@openfolia/ui/states';
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
  type ProjectConfig,
  type StoredConfig,
} from '../content/browser-model';
import {
  FilterChipComponent,
  type FilterOption,
} from '../content/filter-chip.component';
import { injectDraftBlocked } from '../content/module-actions';
import { apiErrorText, labelsInUi } from '../i18n';
import { GuardDirective } from '../permissions/guard.directive';
import { MeService } from '../permissions/me';
import { PermissionService } from '../permissions/permission.service';
import { ChangeSetSession } from '../session/change-set-session';
import { injectFailureText } from '../session/failure-text';
import { Generation } from '../shared/generation';
import { injectQueryState } from '../view-state';
import { NewTermDialogComponent } from './new-term-dialog.component';
import { TermDraft, type TermChangeSet } from './term-draft';
import { TermIndex } from './term-index';
import { TermPanelComponent } from './term-panel.component';
import { TermExport } from './term-export';
import { TermExists, TermLocked, TermWrites } from './term-writes';
import {
  definitionText,
  isReadable,
  listQuery,
  PAGE_SIZES,
  STATUS_BADGES,
  STATUS_LABELS,
  TERM_STATUSES,
  TERMS_PARAMS,
  withContent,
  type ListedTerm,
  type TermContent,
  type TermItem,
  type TermStatus,
  type TermsView,
  type TermUse,
} from './terms-model';

/** What a filter change sets. */
type FilterChange = Partial<
  Pick<TermsView, 'lang' | 'domain' | 'status' | 'q'>
>;

/** Space kept below the frame: the page's bottom padding. */
const BELOW_FRAME_PX = 32;
const SEARCH_DEBOUNCE_MS = 300;
/** From this width the panel sits beside the list; below it, it opens in a sheet. */
const WIDE = '(min-width: 64rem)';

/**
 * Terminology (#246): the terms at the chosen change set's branch (`GET /terms`) as a table, the
 * preferred variant per configured language as columns (source first; the table scrolls sideways
 * inside its frame), the domain and the status as a badge with its word; filtered by language,
 * domain and status, searched, paged, the rows scrolling inside the frame with the pagination
 * outside it. A term's panel opens beside the list (a sheet on phones): read for everyone with
 * `content.read`, edited for `content.edit` in a draft change set of one's own, through the term's
 * working copy (`TermDraft`: lock, autosave, save points), so a change is reviewed like any other.
 * "New term" adds one (`TermWrites`), "Delete term" removes one with Undo. TBX and CSV export the
 * terms read. The filters, the page and the open term are in the address.
 */
@Component({
  selector: 'of-terminology',
  imports: [
    NgTemplateOutlet,
    TranslocoPipe,
    NgIcon,
    ErrorStateComponent,
    FadeInDirective,
    PageHeaderComponent,
    ListFrameComponent,
    ListItemDirective,
    ListTableDirective,
    ReservedSlotDirective,
    SidePanelComponent,
    SidePanelContentDirective,
    ZardBadgeComponent,
    ZardButtonComponent,
    ZardInputComponent,
    ZardInputGroupImports,
    ZardSheetImports,
    ZardSkeletonComponent,
    ZardTableImports,
    GuardDirective,
    FilterChipComponent,
    NewTermDialogComponent,
    TermPanelComponent,
  ],
  providers: [TermDraft, TermIndex],
  viewProviders: [
    provideIcons({ lucideDownload, lucidePlus, lucideSearch, lucideX }),
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'flex min-w-0 flex-col gap-4' },
  template: `
    <of-page-header [title]="'editor.terminology.title' | transloco">
      <span class="flex flex-wrap items-center gap-2">
        <button
          z-button
          zType="outline"
          type="button"
          data-slot="export-tbx"
          [zLoading]="exporting() === 'tbx'"
          (click)="export('tbx')"
        >
          <ng-icon
            name="lucideDownload"
            data-icon="inline-start"
            aria-hidden="true"
          />
          {{ 'editor.terminology.export.tbx' | transloco }}
        </button>
        <button
          z-button
          zType="outline"
          type="button"
          data-slot="export-csv"
          [zLoading]="exporting() === 'csv'"
          (click)="export('csv')"
        >
          <ng-icon
            name="lucideDownload"
            data-icon="inline-start"
            aria-hidden="true"
          />
          {{ 'editor.terminology.export.csv' | transloco }}
        </button>
        <button
          z-button
          type="button"
          data-slot="new-term"
          [ofGuard]="{
            permission: 'content.edit',
            blockedReason: newBlocked(),
          }"
          (click)="openNew()"
        >
          <ng-icon
            name="lucidePlus"
            data-icon="inline-start"
            aria-hidden="true"
          />
          {{ 'editor.terminology.new.open' | transloco }}
        </button>
      </span>
    </of-page-header>

    <!-- The search has a column of its own and Reset filters a place kept for it, so turning a
         filter on or off never wraps the bar or moves the list -->
    <div
      class="flex flex-col gap-2 xl:flex-row xl:items-start"
      role="group"
      [attr.aria-label]="'editor.terminology.filters.label' | transloco"
    >
      <div class="flex min-w-0 flex-1 flex-wrap items-center gap-2">
        <of-filter-chip
          [label]="'editor.terminology.filters.language' | transloco"
          [allLabel]="'editor.content.filters.all' | transloco"
          [options]="languageOptions()"
          [value]="view.get('lang')() ?? ''"
          (changed)="patch({ lang: $event || undefined })"
        />
        <of-filter-chip
          [label]="'editor.terminology.filters.domain' | transloco"
          [allLabel]="'editor.content.filters.all' | transloco"
          [options]="domainOptions()"
          [value]="view.get('domain')()"
          (changed)="patch({ domain: $event })"
        />
        <of-filter-chip
          [label]="'editor.terminology.filters.status' | transloco"
          [allLabel]="'editor.content.filters.all' | transloco"
          [options]="statusOptions()"
          [value]="view.get('status')() ?? ''"
          (changed)="patch({ status: asStatus($event) })"
        />
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
      <z-input-group class="min-w-0 sm:w-72 xl:shrink-0">
        <z-input-group-addon>
          <ng-icon name="lucideSearch" aria-hidden="true" />
        </z-input-group-addon>
        <input
          z-input
          type="search"
          autocomplete="off"
          maxlength="200"
          data-slot="terms-search"
          [attr.aria-label]="'editor.terminology.filters.search' | transloco"
          [placeholder]="'editor.terminology.filters.search' | transloco"
          [value]="search()"
          (input)="typed($any($event.target).value)"
        />
      </z-input-group>
    </div>

    <div class="flex min-h-0 min-w-0 items-start gap-4">
      <of-list-frame
        #frame
        class="min-w-0 flex-1"
        [label]="'editor.terminology.list' | transloco"
        [items]="rows()"
        [page]="doc()?.meta?.page ?? null"
        [loading]="loading()"
        [error]="frameError()"
        [offset]="offset()"
        [pageSizes]="pageSizes"
        [skeletonRows]="10"
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
        <ng-template ofListTable let-items>
          <table
            z-table
            class="table-fixed"
            data-slot="terms-table"
            [style.min-width.rem]="tableWidth()"
          >
            <thead z-table-header class="bg-background sticky top-0 z-10">
              <tr z-table-row>
                @for (l of languages(); track l; let first = $first) {
                  <th
                    z-table-head
                    class="w-48"
                    [class.w-60]="first"
                    [attr.data-lang]="l"
                  >
                    {{ langName(l) }}
                  </th>
                }
                <th z-table-head class="w-72">
                  {{ 'editor.terminology.table.definition' | transloco }}
                </th>
                <th z-table-head class="w-36">
                  {{ 'editor.terminology.table.domain' | transloco }}
                </th>
                <th z-table-head class="w-32">
                  {{ 'editor.terminology.table.status' | transloco }}
                </th>
              </tr>
            </thead>
            <tbody z-table-body>
              @for (row of asRows(items); track row.id) {
                @let chosen = row.id === view.get('term')();
                <tr
                  z-table-row
                  [ofListItem]="row"
                  class="hover:bg-muted/50 cursor-pointer"
                  data-slot="term-row"
                  [attr.data-term]="row.id"
                  [attr.data-state]="chosen ? 'selected' : null"
                  [attr.aria-current]="chosen ? 'true' : null"
                  (click)="select(row.id)"
                >
                  @if (readable(row)) {
                    @for (l of languages(); track l; let first = $first) {
                      <td
                        z-table-cell
                        class="align-top break-words whitespace-normal [overflow-wrap:anywhere]"
                        [attr.lang]="l"
                      >
                        @if (first) {
                          <button
                            type="button"
                            class="text-foreground focus-visible:ring-ring/50 flex min-w-0 flex-col items-start rounded-sm text-start outline-none focus-visible:ring-[3px]"
                            [attr.aria-current]="chosen ? 'true' : null"
                            (click)="$event.stopPropagation(); select(row.id)"
                          >
                            <span
                              class="font-medium [overflow-wrap:anywhere] hover:underline"
                              >{{
                                row.attributes.languages[l]?.preferred ?? row.id
                              }}</span
                            >
                            @if (
                              row.attributes.languages[l]?.preferred !== row.id
                            ) {
                              <span
                                class="text-muted-foreground font-mono text-xs [overflow-wrap:anywhere]"
                                data-slot="term-id"
                                >{{ row.id }}</span
                              >
                            }
                          </button>
                        } @else {
                          @if (row.attributes.languages[l]; as e) {
                            {{ e.preferred }}
                          } @else {
                            <span
                              class="text-muted-foreground"
                              aria-hidden="true"
                              >–</span
                            >
                            <span class="sr-only">{{
                              'editor.terminology.table.missing' | transloco
                            }}</span>
                          }
                        }
                      </td>
                    }
                    <td
                      z-table-cell
                      class="text-muted-foreground align-top break-words whitespace-normal [overflow-wrap:anywhere]"
                      data-slot="term-definition"
                    >
                      <span class="line-clamp-3">{{ definition(row) }}</span>
                    </td>
                    <td
                      z-table-cell
                      class="align-top break-words whitespace-normal [overflow-wrap:anywhere]"
                    >
                      {{ row.attributes.domain ?? '' }}
                    </td>
                    <td z-table-cell class="align-top whitespace-normal">
                      <z-badge
                        [zType]="badge(row.attributes.status)"
                        class="font-normal"
                        data-slot="term-status"
                        >{{
                          statusLabel(row.attributes.status) | transloco
                        }}</z-badge
                      >
                    </td>
                  } @else {
                    <td
                      z-table-cell
                      class="align-top break-words whitespace-normal [overflow-wrap:anywhere]"
                      [attr.colspan]="languages().length + 3"
                    >
                      <span class="font-mono text-xs">{{ row.id }}</span>
                      <span class="text-muted-foreground ms-2">{{
                        'editor.terminology.table.unreadable' | transloco
                      }}</span>
                    </td>
                  }
                </tr>
              }
            </tbody>
          </table>
        </ng-template>
      </of-list-frame>

      <!-- Opens, switches and closes smoothly; on a narrow screen the sheet below has it. -->
      <of-side-panel
        class="[--of-side-panel-gap:1rem] [--of-side-panel-width:24rem] xl:[--of-side-panel-width:28rem]"
      >
        <ng-template [ofSidePanelContent]="wide() ? openId() : null">
          <aside
            class="border-border bg-card overflow-y-auto rounded-xl border p-4"
            data-slot="term-panel"
            [style.max-height]="'calc(100dvh - ' + offset() + ')'"
            [attr.aria-label]="'editor.terminology.panel.title' | transloco"
          >
            <ng-container
              [ngTemplateOutlet]="panelBody"
              [ngTemplateOutletContext]="{ closable: true }"
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
      [zVisible]="!!openId() && !wide()"
      (zVisibleChange)="$event || close()"
    >
      @if (openId() && !wide()) {
        <z-sheet-header class="p-0 pb-2">
          <z-sheet-title>{{
            'editor.terminology.panel.title' | transloco
          }}</z-sheet-title>
        </z-sheet-header>
        <ng-container
          [ngTemplateOutlet]="panelBody"
          [ngTemplateOutletContext]="{ closable: false }"
        />
      }
    </z-sheet>

    <ng-template #panelBody let-closable="closable">
      @if (draft.term(); as t) {
        <of-term-panel
          ofFadeIn
          [term]="t"
          [mode]="draft.mode()"
          [languages]="languages()"
          [saveState]="draft.saveState()"
          [changeSetTitle]="changeSetTitle()"
          [changeSetId]="changeSet()?.id ?? null"
          [terms]="index.terms()"
          [linkedBy]="index.linksTo(t.id)"
          [usedIn]="usedIn().id === t.id ? usedIn().modules : []"
          [usedInCount]="usedIn().id === t.id ? usedIn().count : 0"
          [closable]="closable"
          (changed)="draft.change($event)"
          (closed)="close()"
          (deleteRequested)="askDelete(t)"
        />
      } @else if (draft.status() === 'error') {
        <of-error-state
          [kind]="draft.error()?.kind ?? 'unknown'"
          [message]="panelError()"
          (retry)="loadOpen()"
        />
      } @else {
        <div
          ofFadeIn="delayed"
          class="flex flex-col gap-3"
          aria-hidden="true"
          data-slot="term-panel-loading"
        >
          <z-skeleton class="h-6 w-2/3" />
          <z-skeleton class="h-4 w-1/3" />
          <z-skeleton class="h-9 w-full" />
          <z-skeleton class="h-24 w-full" />
        </div>
      }
    </ng-template>

    <of-new-term-dialog
      [(open)]="newOpen"
      [languages]="languages()"
      [changeSetTitle]="changeSetTitle()"
      [takenIds]="takenIds()"
      [busy]="creating()"
      [failure]="createFailure()"
      (created)="create($event)"
    />
  `,
})
export class TerminologyPage {
  private readonly api = inject(ApiClient);
  private readonly readRef = inject(ReadRef);
  private readonly me = inject(MeService);
  private readonly permissions = inject(PermissionService);
  private readonly toast = inject(ToastService);
  private readonly language = inject(LanguageService);
  private readonly changeSets = inject(ChangeSetSession);
  private readonly dialogs = inject(ZardAlertDialogService);
  private readonly exporter = inject(TermExport);
  private readonly writes = inject(TermWrites);
  private readonly failureText = injectFailureText();
  private readonly draftBlocked = injectDraftBlocked();
  private readonly t = injectTranslate();
  protected readonly draft = inject(TermDraft);
  protected readonly index = inject(TermIndex);

  protected readonly pageSizes = PAGE_SIZES;
  /** Filters, search, page and the open term live in the address. */
  protected readonly view = injectQueryState(TERMS_PARAMS);
  /** The search box's text; the address has it once typing pauses. */
  protected readonly search = signal(this.view.get('q')());

  /** The configuration as read (`GET /config`). */
  private readonly storedConfig = signal<StoredConfig | null>(null);
  /** The configuration with its labels in the interface language (#731). */
  protected readonly config = labelsInUi(this.storedConfig);
  protected readonly doc = signal<Response<'/terms'> | null>(null);
  protected readonly loading = signal(true);
  private readonly failure = signal<ApiError | null>(null);
  private readonly reloads = signal(0);
  private runs = 0;
  private readonly configReads = new Generation();

  protected readonly exporting = signal<'tbx' | 'csv' | null>(null);
  protected readonly newOpen = signal(false);
  protected readonly creating = signal(false);
  protected readonly createFailure = signal<string | null>(null);

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

  /** The chosen change set, as the panel reads and writes terms in it; null: the released content. */
  protected readonly changeSet = computed((): TermChangeSet | null => {
    const chosen = this.changeSets.selected();
    if (!chosen?.branch) return null;
    const option = this.changeSets.options().find((o) => o.id === chosen.id);
    return {
      id: chosen.id,
      branch: chosen.branch,
      state: option?.state ?? 'draft',
      authorId: option?.authorId ?? '',
    };
  });

  protected readonly changeSetTitle = computed(
    () => this.changeSets.selected()?.title ?? '',
  );

  /** Why "New term" is blocked now (a key), or null: terms are added to a draft change set of one's own. */
  protected readonly newBlocked = computed((): string | null => {
    const blocked = this.draftBlocked();
    if (blocked) return blocked;
    const cs = this.changeSet();
    if (cs && cs.authorId !== '' && cs.authorId !== this.me.me().id)
      return 'editor.terminology.blocked.notAuthor';
    return null;
  });

  protected readonly languages = computed((): readonly string[] => {
    const c = this.config();
    return c ? languagesOf(c) : [];
  });

  /** The table's least width: the language columns, the definition, domain and status. */
  protected readonly tableWidth = computed(
    () => 15 + Math.max(0, this.languages().length - 1) * 12 + 18 + 9 + 8,
  );

  protected readonly domains = computed(() => {
    this.index.terms();
    return this.index.domains(this.language.locale());
  });

  protected readonly takenIds = computed(
    () => new Set(this.index.terms().map((t) => t.id)),
  );

  protected readonly languageOptions = computed((): FilterOption[] => {
    const locale = this.language.locale();
    return this.languages().map((l) => ({
      value: l,
      label: languageName(locale, l),
    }));
  });

  protected readonly domainOptions = computed((): FilterOption[] => {
    const options = this.domains().map((d) => ({ value: d, label: d }));
    const chosen = this.view.get('domain')();
    // A domain from a link the index does not hold (yet) still shows as chosen.
    if (chosen && !options.some((o) => o.value === chosen))
      options.unshift({ value: chosen, label: chosen });
    return options;
  });

  protected readonly statusOptions = computed((): FilterOption[] =>
    TERM_STATUSES.map((s) => ({ value: s, label: this.t(STATUS_LABELS[s]) })),
  );

  /** The open term's ID. */
  protected readonly openId = computed(() => this.view.get('term')() ?? null);

  /** The module files linking the open term (#245), as the API reads them at the ref read. */
  protected readonly usedIn = signal<{
    id: string | null;
    modules: readonly TermUse[];
    count: number;
  }>({ id: null, modules: [], count: 0 });
  private usageRuns = 0;

  /** The page's terms, less those deleted here; the open one as the panel last changed it. */
  protected readonly rows = computed((): readonly ListedTerm[] => {
    const cs = this.changeSet()?.id ?? null;
    const term = this.draft.term();
    const editing = this.draft.mode().kind === 'edit' && term;
    return (this.doc()?.data ?? [])
      .filter((r) => !this.writes.isHidden(cs, r.id))
      .map((r) =>
        editing && r.id === term.id && isReadable(r) ? withContent(r, term) : r,
      );
  });

  /** The list's request, from the list's own fields only: opening a term reads nothing again. */
  private readonly query = computed(() => listQuery(this.view.values()), {
    equal: (a, b) => JSON.stringify(a) === JSON.stringify(b),
  });

  protected readonly hasFilters = computed(() => {
    const v = this.view.values();
    return (
      v.lang !== undefined ||
      v.domain !== '' ||
      v.status !== undefined ||
      this.search().trim() !== ''
    );
  });

  protected readonly frameError = computed(() => {
    const f = this.failure();
    if (!f) return null;
    const text = apiErrorText(f);
    return { kind: f.kind, message: this.t(text.key, text.params) };
  });

  protected readonly panelError = computed(() => {
    const f = this.draft.error();
    if (!f) return '';
    if (f.status === 404) return this.t('editor.terminology.panel.notFound');
    const text = apiErrorText(f);
    return this.t(text.key, text.params);
  });

  protected readonly emptyTitle = computed(() =>
    this.t(
      this.hasFilters()
        ? 'editor.terminology.empty.filteredTitle'
        : 'editor.terminology.empty.title',
    ),
  );

  protected readonly emptyDescription = computed(() =>
    this.t(
      this.hasFilters()
        ? 'editor.terminology.empty.filtered'
        : this.permissions.state({ permission: 'content.edit' }).kind ===
            'hidden'
          ? 'editor.terminology.empty.noneRead'
          : 'editor.terminology.empty.none',
    ),
  );

  constructor() {
    const destroyRef = inject(DestroyRef);
    // The configuration (its languages) and the index follow the branch read, and whoever acts.
    effect(() => {
      this.readKey();
      this.writes.changed();
      this.draft.commits();
      // A switch unanswered: what was asked for the person before lands for nobody (#716).
      if (this.changeSets.switching()) {
        this.configReads.end();
        return;
      }
      untracked(() => {
        void this.loadConfig();
        void this.index.load();
      });
    });
    // Back, Forward or a link changed the search: the box shows it, unless the person is typing.
    effect(() => {
      const q = this.view.get('q')();
      untracked(() => {
        if (!this.typing && this.search().trim() !== q) this.search.set(q);
      });
    });
    effect(() => {
      const query = this.query();
      this.readKey();
      this.reloads();
      this.writes.changed();
      this.draft.commits();
      if (this.changeSets.switching() || this.changeSets.resolving()) return;
      untracked(() => void this.load(query));
    });
    // The open term (from the address) is read in the chosen change set, and again on its branch's
    // new head (an update from main, #466); the one before gets its save point first.
    effect(() => {
      const id = this.openId();
      this.changeSet();
      this.me.me();
      this.readRef.moves();
      if (this.changeSets.switching() || this.changeSets.resolving()) return;
      untracked(() => void this.loadOpen(id));
    });
    // Where the open term is linked: read again after every commit, which may add or remove links.
    effect(() => {
      const id = this.openId();
      this.readKey();
      this.writes.changed();
      this.draft.commits();
      if (this.changeSets.switching() || this.changeSets.resolving()) return;
      untracked(() => void this.loadUsage(id));
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
  /** What the panel has open: the term in its change set. */
  private opened = '';

  /** Leaving the screen (the route guard): the open term's saved changes become a save point first. */
  async leave(): Promise<boolean> {
    if (this.draft.mode().kind === 'edit') await this.draft.savePoint();
    return true;
  }

  /** Reads the open term into the panel (again, with `id` undefined). */
  protected async loadOpen(id = this.openId()): Promise<void> {
    const cs = this.changeSet();
    const key = id
      ? `${cs?.id ?? ''}\n${id}\n${this.me.me().id}\n${this.readRef.moves()}`
      : '';
    if (key === this.opened && this.draft.status() !== 'error') return;
    this.opened = key;
    if (this.draft.termId() && this.draft.mode().kind === 'edit') {
      await this.draft.savePoint();
    }
    if (key !== this.opened) return;
    if (!id) {
      await this.draft.close();
      return;
    }
    await this.draft.load(cs, id);
  }

  /** Reads where `id` is linked; none for a term not committed at the ref (a new one). */
  private async loadUsage(id: string | null): Promise<void> {
    const run = ++this.usageRuns;
    if (!id) {
      this.usedIn.set({ id: null, modules: [], count: 0 });
      return;
    }
    try {
      const doc = await firstValueFrom(
        this.api.get('/terms/{termId}', { path: { termId: id } }),
      );
      if (run !== this.usageRuns) return;
      this.usedIn.set({
        id,
        modules: doc.data.meta.linkedIn,
        count: doc.data.meta.usage.modules,
      });
    } catch {
      // Not committed here, or unreadable: nothing links it that the API could name. A delete is
      // still checked by the API (`term-in-use`).
      if (run === this.usageRuns) {
        this.usedIn.set({ id, modules: [], count: 0 });
      }
    }
  }

  private async loadConfig(): Promise<void> {
    const live = this.configReads.start();
    try {
      const doc = await firstValueFrom(this.api.get('/config'));
      if (!live()) return;
      this.storedConfig.set(doc.data.attributes);
    } catch {
      // The list's own failure (the same server) says it; the columns wait.
    }
  }

  private async load(query: ReturnType<typeof listQuery>): Promise<void> {
    const run = ++this.runs;
    this.loading.set(true);
    this.failure.set(null);
    try {
      const doc = await firstValueFrom(this.api.get('/terms', { query }));
      if (run !== this.runs) return;
      // A page past the end (the list shrank): the last one there is.
      const last = Math.max(1, doc.meta.page.lastPage);
      if (doc.data.length === 0 && this.view.get('page')() > last) {
        this.view.set({ page: last }, { replace: true });
        return;
      }
      this.doc.set(doc);
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

  /** A filter changed: page 1 again; the open term stays open. */
  protected patch(change: FilterChange): void {
    this.view.set({ ...change, page: 1 });
  }

  protected asStatus(value: string): TermStatus | undefined {
    return TERM_STATUSES.find((s) => s === value);
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
      lang: undefined,
      domain: '',
      status: undefined,
      page: 1,
    });
  }

  protected select(id: string): void {
    this.view.set({ term: id });
  }

  protected close(): void {
    this.view.set({ term: undefined });
  }

  protected openNew(): void {
    if (this.newBlocked()) return;
    this.createFailure.set(null);
    this.newOpen.set(true);
  }

  /** The new-term dialog's term: added to the chosen change set, then its panel opens. */
  protected async create(term: TermContent): Promise<void> {
    const cs = this.changeSet();
    if (!cs || this.newBlocked() || this.creating()) return;
    this.creating.set(true);
    this.createFailure.set(null);
    try {
      await this.writes.create(term, cs.id);
      this.newOpen.set(false);
      const word = Object.values(term.languages)[0]?.preferred ?? term.id;
      this.toast.success(
        translated('editor.terminology.new.done', { term: word }),
      );
      this.view.set({ term: term.id });
    } catch (error) {
      if (error instanceof TermExists) {
        this.createFailure.set('editor.terminology.new.idTaken');
      } else if (error instanceof TermLocked) {
        this.createFailure.set('editor.terminology.new.locked');
      } else {
        const text = apiErrorText(toApiError(error));
        this.createFailure.set(text.key);
      }
    } finally {
      this.creating.set(false);
    }
  }

  /** "Delete term": a confirm naming it, then the delete with Undo in its toast. */
  protected askDelete(term: TermContent): void {
    const cs = this.changeSet();
    if (!cs || this.draft.mode().kind !== 'edit') return;
    if (this.index.linksTo(term.id).length > 0) return;
    if (this.usedIn().id === term.id && this.usedIn().count > 0) return;
    const label = this.labelOf(term);
    this.dialogs.confirm({
      zTitle: this.t('editor.terminology.delete.title', { term: label }),
      zDescription: this.t('editor.terminology.delete.description', {
        term: label,
        changeSet: this.changeSetTitle(),
      }),
      zOkText: this.t('editor.terminology.delete.confirm'),
      zCancelText: this.t('editor.terminology.new.cancel'),
      zOkDestructive: true,
      zOnOk: () => void this.runDelete(term, label, cs.id),
    });
  }

  private async runDelete(
    term: TermContent,
    label: string,
    changeSetId: string,
  ): Promise<void> {
    // What the panel saved goes into the save point first, so Undo brings that back; edits made
    // while the delete runs are not taken (one would bring the term back).
    this.draft.hold(true);
    try {
      await this.draft.savePoint();
      const deleted = await this.writes.delete(
        term.id,
        label,
        changeSetId,
        () => this.view.set({ term: term.id }),
      );
      if (deleted && this.openId() === term.id) {
        this.view.set({ term: undefined }, { replace: true });
      }
    } finally {
      this.draft.hold(false);
    }
  }

  /** Downloads the terms read (the filter's language only, when one is chosen) as TBX or CSV. */
  protected async export(format: 'tbx' | 'csv'): Promise<void> {
    if (this.exporting()) return;
    this.exporting.set(format);
    try {
      await this.exporter.save(format, this.view.get('lang')());
    } catch (error) {
      this.toast.error(
        this.failureText(
          translated('editor.terminology.export.failed'),
          toApiError(error),
        ),
      );
    } finally {
      this.exporting.set(null);
    }
  }

  protected asRows(value: unknown): readonly ListedTerm[] {
    return value as readonly ListedTerm[];
  }

  protected readable(row: ListedTerm): row is TermItem {
    return isReadable(row);
  }

  protected definition(row: TermItem): string {
    const langs = this.languages();
    const lang =
      this.view.get('lang')() ??
      langs.find((l) => row.attributes.languages[l]?.definition) ??
      '';
    return definitionText(row.attributes.languages[lang]?.definition);
  }

  protected statusLabel(status: TermStatus): string {
    return STATUS_LABELS[status];
  }

  protected badge(status: TermStatus) {
    return STATUS_BADGES[status];
  }

  protected langName(lang: string): string {
    return languageName(this.language.locale(), lang);
  }

  private labelOf(term: TermContent): string {
    const lang =
      this.languages().find((l) => term.languages[l]) ??
      Object.keys(term.languages)[0] ??
      '';
    return term.languages[lang]?.preferred ?? term.id;
  }
}
