import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { NavigationStart, Router } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { filter } from 'rxjs';
import { TranslocoPipe } from '@jsverse/transloco';

import { StatusBadgeComponent } from '@openfolia/ui/badges';
import {
  ZardCommandComponent,
  ZardCommandImports,
  type ZardCommandOption,
} from '@openfolia/ui/command';
import { ZardDialogImports } from '@openfolia/ui/dialog';
import { HighlightedTextComponent } from '@openfolia/ui/highlighted-text';
import {
  injectTranslate,
  LanguageService,
  TextPipe,
  translated,
} from '@openfolia/ui/i18n';
import { KbdComponent } from '@openfolia/ui/kbd';
import { RefreshingDirective } from '@openfolia/ui/smooth';
import {
  EmptyStateComponent,
  ErrorStateComponent,
  NoAccessStateComponent,
  SkeletonRowsComponent,
} from '@openfolia/ui/states';
import { ToastService } from '@openfolia/ui/toast';

import { NewModuleRequest } from '../content/new-module-request';
import { HelpService } from '../help/help.service';
import { NewManualRequest } from '../manuals/new-manual-request';
import { apiErrorText } from '../i18n';
import { PermissionService } from '../permissions/permission.service';
import {
  ChangeSetSession,
  PUBLISHED,
  type ChangeSetOption,
} from '../session/change-set-session';
import { ChangeSetUrl } from '../session/change-set-url';
import type { PaletteAction } from './palette-actions';
import { matchesPage } from './palette-pages';
import { PaletteSearch } from './palette-search';
import { RecentItems } from './recent-items';
import { isPaletteShortcut, SearchPalette } from './search-palette.service';
import {
  recentRow,
  resultRow,
  rowLink,
  type OpenableRow,
} from './search-results';

const MORE = 'more';
const BACK = 'back';
const ACTION = 'action:';
const CHANGE_SET = 'change-set:';
const PAGE = 'page:';
const HELP = 'help:';

/** The rows of the change-set list. */
interface ChangeSetRow {
  readonly key: string;
  readonly id: string;
  readonly title: string;
  /** The state as a word, never only a colour. */
  readonly state: string;
  readonly current: boolean;
}

const STATE_KEYS: Record<ChangeSetOption['state'], string> = {
  draft: 'editor.changeSet.state.draft',
  'in-review': 'editor.changeSet.state.inReview',
  approved: 'editor.changeSet.state.approved',
  merged: 'editor.changeSet.state.merged',
  abandoned: 'editor.changeSet.state.abandoned',
};

const GROUP =
  'px-0 [&_[data-slot=command-group-heading]]:px-2.5 [&_[data-slot=command-group-heading]]:pt-3 [&_[data-slot=command-group-heading]]:pb-1.5 [&_[data-slot=command-group-heading]]:text-[11px] [&_[data-slot=command-group-heading]]:tracking-wider [&_[data-slot=command-group-heading]]:uppercase';
const ROW =
  'items-center gap-3 rounded-md px-2.5 py-2 data-[disabled=true]:opacity-100';

/**
 * Search palette (screen 18): Cmd/Ctrl+K from anywhere, or the sidebar's search button. One
 * field searches module titles and text and manual titles (`GET /search`, scoped to what the
 * person may read, in the chosen change set) and offers actions. With nothing typed it lists
 * what the person opened last (per viewer, in this browser) and the actions.
 *
 * Fully usable by keyboard: arrows move, Enter opens, Escape closes and focus returns to where
 * it was. States: a skeleton while the first search runs (delayed, so a quick answer never
 * flashes it), the last results dimmed while a refined one runs, nothing found, failed with a
 * retry, no access.
 * Matches are highlighted from the API's offsets, as text (never as HTML). Actions a role can
 * never use are hidden; one blocked right now is disabled with the reason on its second line.
 */
@Component({
  selector: 'of-search-palette',
  imports: [
    NgTemplateOutlet,
    ZardDialogImports,
    ZardCommandImports,
    HighlightedTextComponent,
    KbdComponent,
    SkeletonRowsComponent,
    StatusBadgeComponent,
    RefreshingDirective,
    EmptyStateComponent,
    ErrorStateComponent,
    NoAccessStateComponent,
    TranslocoPipe,
    TextPipe,
  ],
  providers: [PaletteSearch],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(document:keydown)': 'onShortcut($event)' },
  template: `
    <z-dialog
      [zVisible]="palette.isOpen()"
      (zVisibleChange)="$event ? palette.open() : palette.close()"
      (zAfterClose)="afterClose()"
      [zClosable]="false"
      zWidth="42.5rem"
      class="top-[12vh] block translate-y-0 gap-0 overflow-hidden p-0 sm:max-w-[min(42.5rem,calc(100%-2rem))]"
    >
      <z-dialog-header class="sr-only">
        <z-dialog-title>{{ 'editor.search.title' | transloco }}</z-dialog-title>
        <z-dialog-description>{{
          'editor.search.description' | transloco
        }}</z-dialog-description>
      </z-dialog-header>
      @if (palette.isOpen()) {
        <p class="sr-only" aria-live="polite" aria-atomic="true">
          {{ announcement() }}
        </p>
        @if (mode() === 'changeSet') {
          <z-command
            #command
            class="rounded-none border-0 p-0 shadow-none"
            (zCommandSelected)="select($event)"
          >
            <z-command-input
              zVariant="palette"
              [placeholder]="'editor.search.changeSet.placeholder' | transloco"
              [label]="'editor.search.changeSet.label' | transloco"
              (keydown.backspace)="backOnEmpty($event)"
            >
              <kbd
                of-kbd
                data-slot="command-input-trailing"
                aria-hidden="true"
                >{{ 'editor.search.keys.escape' | transloco }}</kbd
              >
            </z-command-input>
            @switch (changeSetView()) {
              @case ('loading') {
                <of-skeleton-rows class="px-2 pt-2" [count]="4" />
              }
              @case ('noAccess') {
                <of-no-access
                  class="py-6"
                  [message]="'editor.changeSet.noAccess' | transloco"
                />
              }
              @case ('failed') {
                <of-error-state
                  class="py-6"
                  [kind]="session.error()?.kind ?? 'unknown'"
                  [heading]="'editor.changeSet.failed' | transloco"
                  [retryable]="true"
                  (retry)="session.refresh()"
                />
              }
            }
            <z-command-list class="max-h-[min(28rem,60vh)] px-2 pb-2">
              <z-command-option-group
                [zLabel]="'editor.search.groups.changeSets' | transloco"
                [class]="group"
              >
                @if (changeSetView() === 'ready') {
                  @for (cs of changeSetRows(); track cs.key) {
                    <z-command-option
                      [zValue]="cs.key"
                      [zLabel]="cs.title"
                      [class]="row"
                    >
                      <span
                        data-slot="command-option-label"
                        class="flex flex-col gap-0.5"
                      >
                        <span class="font-medium break-words">{{
                          cs.title
                        }}</span>
                        @if (cs.state) {
                          <span class="text-muted-foreground text-xs">{{
                            cs.state
                          }}</span>
                        }
                      </span>
                      @if (cs.current) {
                        <span
                          data-slot="command-option-trailing"
                          class="text-muted-foreground shrink-0 text-xs"
                          >{{
                            'editor.search.changeSet.current' | transloco
                          }}</span
                        >
                      }
                    </z-command-option>
                  }
                }
                <z-command-option
                  [zValue]="back"
                  [zLabel]="'editor.search.changeSet.back' | transloco"
                  [class]="row"
                >
                  <span
                    data-slot="command-option-label"
                    class="text-muted-foreground"
                    >{{ 'editor.search.changeSet.back' | transloco }}</span
                  >
                </z-command-option>
              </z-command-option-group>
            </z-command-list>
            <ng-container *ngTemplateOutlet="footer" />
          </z-command>
        } @else {
          <z-command
            #command
            zShouldFilter="false"
            class="rounded-none border-0 p-0 shadow-none"
            (zCommandSelected)="select($event)"
          >
            <z-command-input
              zVariant="palette"
              [placeholder]="
                (palette.canSearch()
                  ? 'editor.search.placeholder'
                  : 'editor.search.placeholderActions'
                ) | transloco
              "
              [label]="'editor.search.label' | transloco"
              (valueChange)="search.query.set($event)"
            >
              <kbd
                of-kbd
                data-slot="command-input-trailing"
                aria-hidden="true"
                >{{ 'editor.search.keys.escape' | transloco }}</kbd
              >
            </z-command-input>
            <!-- The search's own states: above the list, or below it while pages are listed, so
                 they never move the pages (which never wait for the search). -->
            @if (!pageRows().length) {
              <ng-container *ngTemplateOutlet="searchStates" />
            }
            <z-command-list
              class="max-h-[min(28rem,60vh)] px-2 pb-2"
              [attr.aria-busy]="searchState().status === 'loading' || null"
            >
              <!-- The pages found by name (issue 591): first, as they never wait for the search, so
                   the results arriving below never move them. -->
              @if (pageRows().length) {
                <z-command-option-group
                  [zLabel]="'editor.search.groups.pages' | transloco"
                  [class]="group"
                >
                  @for (p of pageRows(); track p.id) {
                    <z-command-option
                      [zValue]="pageKey + p.id"
                      [zLabel]="p.label"
                      [class]="row"
                    >
                      <span
                        data-slot="command-option-label"
                        class="flex flex-col gap-0.5"
                      >
                        <span class="font-medium break-words">{{
                          p.name
                        }}</span>
                        <span
                          class="text-muted-foreground text-xs break-words"
                          >{{ p.label }}</span
                        >
                      </span>
                      <span
                        data-slot="command-option-trailing"
                        class="text-muted-foreground shrink-0 text-xs"
                        >{{ 'editor.search.kinds.page' | transloco }}</span
                      >
                    </z-command-option>
                  }
                </z-command-option-group>
              }
              @for (section of sections(); track section.id) {
                <!-- Refining: the last results stay, dimmed, until the new ones arrive. -->
                <z-command-option-group
                  [zLabel]="section.label | transloco"
                  [class]="group"
                  [ofRefreshing]="resultsView() === 'stale'"
                >
                  @for (r of section.rows; track r.key) {
                    <z-command-option
                      [zValue]="r.key"
                      [zLabel]="r.item.title"
                      [class]="row"
                    >
                      <span
                        data-slot="command-option-label"
                        class="flex flex-col gap-0.5"
                      >
                        <of-highlighted-text
                          class="font-medium"
                          [text]="r.item.title"
                          [matches]="r.titleMatches"
                        />
                        <of-highlighted-text
                          class="text-muted-foreground line-clamp-2 text-xs"
                          [text]="r.detail"
                          [matches]="r.detailMatches"
                        />
                      </span>
                      <span
                        data-slot="command-option-trailing"
                        class="text-muted-foreground flex shrink-0 flex-col items-end gap-1 text-end text-xs"
                      >
                        {{ kindLabel(r) }}
                        @if (r.deprecated) {
                          <of-status-badge status="deprecated" />
                        }
                      </span>
                    </z-command-option>
                  }
                </z-command-option-group>
              }
              @if (term() && palette.canSearch()) {
                @if (moreView(); as more) {
                  <z-command-option-group zLabel="" [class]="group">
                    <z-command-option
                      [zValue]="moreKey"
                      [zLabel]="more"
                      [class]="row"
                    >
                      <span
                        data-slot="command-option-label"
                        class="text-muted-foreground"
                        >{{ more }}</span
                      >
                    </z-command-option>
                  </z-command-option-group>
                }
              }
              <!-- The user guide's pages by title and summary (issue 221): after the search's
                   results, so a word typed to find content opens the content first. Each opens in
                   a new tab. -->
              @if (helpRows().length) {
                <z-command-option-group
                  [zLabel]="'editor.search.groups.help' | transloco"
                  [class]="group"
                >
                  @for (h of helpRows(); track h.id) {
                    <z-command-option
                      [zValue]="helpKey + h.id"
                      [zLabel]="h.title"
                      [class]="row"
                    >
                      <span
                        data-slot="command-option-label"
                        class="flex flex-col gap-0.5"
                      >
                        <span class="font-medium break-words">{{
                          h.title
                        }}</span>
                        <span
                          class="text-muted-foreground line-clamp-2 text-xs break-words"
                          >{{ h.summary }}</span
                        >
                      </span>
                      <span
                        data-slot="command-option-trailing"
                        class="text-muted-foreground shrink-0 text-xs"
                        >{{ 'editor.search.kinds.guide' | transloco }}</span
                      >
                    </z-command-option>
                  }
                </z-command-option-group>
              }
              @if (actionRows().length) {
                <z-command-option-group
                  [zLabel]="'editor.search.groups.actions' | transloco"
                  [class]="group"
                >
                  @for (a of actionRows(); track a.action.id) {
                    <z-command-option
                      [zValue]="actionKey + a.action.id"
                      [zLabel]="a.label"
                      [zDisabled]="!!a.blocked"
                      [class]="row"
                    >
                      <span
                        data-slot="command-option-label"
                        class="flex flex-col gap-0.5"
                      >
                        <span
                          class="font-medium break-words"
                          [class.text-muted-foreground]="!!a.blocked"
                          >{{ a.label }}</span
                        >
                        <span
                          class="text-muted-foreground text-xs break-words"
                          >{{
                            a.blocked || (a.action.description | transloco)
                          }}</span
                        >
                      </span>
                      <span
                        data-slot="command-option-trailing"
                        class="text-muted-foreground shrink-0 text-xs"
                        >{{ 'editor.search.kinds.action' | transloco }}</span
                      >
                    </z-command-option>
                  }
                </z-command-option-group>
              }
              @if (nothingToShow()) {
                <p
                  class="text-muted-foreground m-0 px-3 py-6 text-center text-sm"
                >
                  {{
                    (palette.canSearch()
                      ? 'editor.search.hint'
                      : 'editor.search.noActions'
                    ) | transloco
                  }}
                </p>
              }
            </z-command-list>
            @if (pageRows().length) {
              <ng-container *ngTemplateOutlet="searchStates" />
            }
            <ng-container *ngTemplateOutlet="footer" />
          </z-command>
        }
      }
    </z-dialog>

    <ng-template #searchStates>
      @if (term() && palette.canSearch()) {
        @switch (resultsView()) {
          @case ('loading') {
            <of-skeleton-rows
              class="px-2 pt-2"
              [count]="4"
              [label]="'editor.search.searching' | transloco"
            />
          }
          @case ('noAccess') {
            <of-no-access
              class="py-6"
              [message]="'editor.search.noAccess' | transloco"
            />
          }
          @case ('failed') {
            <of-error-state
              class="py-6"
              [kind]="failure()?.kind ?? 'unknown'"
              [heading]="'editor.search.failed' | transloco"
              [message]="failureText() | ofText"
              (retry)="search.retry()"
            />
          }
          @case ('empty') {
            <!-- A page found by name is a result too: no "nothing found" beside it. -->
            @if (!pageRows().length && !helpRows().length) {
              <of-empty-state
                class="py-6"
                [title]="
                  'editor.search.empty.title' | transloco: { term: term() }
                "
                [description]="'editor.search.empty.description' | transloco"
              />
            }
          }
        }
      }
    </ng-template>

    <ng-template #footer>
      <div
        class="text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1 border-t px-4 py-2.5 text-xs"
        aria-hidden="true"
      >
        <span class="flex items-center gap-1"
          ><kbd class="font-sans">{{
            'editor.search.keys.arrows' | transloco
          }}</kbd
          >{{ 'editor.search.footer.move' | transloco }}</span
        >
        <span class="flex items-center gap-1"
          ><kbd class="font-sans">{{
            'editor.search.keys.enter' | transloco
          }}</kbd
          >{{ 'editor.search.footer.open' | transloco }}</span
        >
        @if (palette.canSearch() && mode() === 'search') {
          <span>{{ 'editor.search.footer.scope' | transloco }}</span>
        }
      </div>
    </ng-template>
  `,
})
export class SearchPaletteComponent {
  protected readonly palette = inject(SearchPalette);
  protected readonly search = inject(PaletteSearch);
  protected readonly session = inject(ChangeSetSession);
  private readonly recents = inject(RecentItems);
  private readonly permissions = inject(PermissionService);
  private readonly router = inject(Router);
  private readonly csLink = inject(ChangeSetUrl);
  private readonly newModule = inject(NewModuleRequest);
  private readonly newManual = inject(NewManualRequest);
  private readonly toast = inject(ToastService);
  private readonly language = inject(LanguageService);
  private readonly help = inject(HelpService);
  private readonly t = injectTranslate();
  private readonly command = viewChild<ZardCommandComponent>('command');

  protected readonly group = GROUP;
  protected readonly row = ROW;
  protected readonly moreKey = MORE;
  protected readonly back = BACK;
  protected readonly actionKey = ACTION;
  protected readonly pageKey = PAGE;
  protected readonly helpKey = HELP;

  /** "New module" was chosen: asked for once the palette has closed, after this navigation. */
  private newModuleAfterClose: Promise<boolean> | null = null;
  /** The same for "New manual", which the manual builder hosts. */
  private newManualAfterClose: Promise<boolean> | null = null;

  /** `search`, or the list of change sets the "Switch change set" action opens. */
  protected readonly mode = signal<'search' | 'changeSet'>('search');
  protected readonly term = this.search.term;
  protected readonly searchState = this.search.state;

  /** The rows on screen: the current results, or the previous ones while new ones load. */
  private readonly resultRows = computed<readonly OpenableRow[]>(() => {
    const state = this.searchState();
    const results =
      state.status === 'ready'
        ? state.results
        : state.status === 'loading'
          ? state.previous
          : [];
    return results.flatMap((r) => resultRow(r) ?? []);
  });
  protected readonly moduleRows = computed(() =>
    this.resultRows().filter((r) => r.item.kind === 'module'),
  );
  protected readonly manualRows = computed(() =>
    this.resultRows().filter((r) => r.item.kind === 'manual'),
  );
  /** The groups of rows that open something: Recent with nothing typed, else the results. */
  protected readonly sections = computed(() => {
    if (!this.term()) {
      return this.recentRows().length
        ? [
            {
              id: 'recent',
              label: 'editor.search.groups.recent',
              rows: this.recentRows(),
            },
          ]
        : [];
    }
    return [
      {
        id: 'modules',
        label: 'editor.search.groups.modules',
        rows: this.moduleRows(),
      },
      {
        id: 'manuals',
        label: 'editor.search.groups.manuals',
        rows: this.manualRows(),
      },
    ].filter((section) => section.rows.length > 0);
  });
  protected readonly recentRows = computed(() =>
    this.palette.canSearch() ? this.recents.items().map(recentRow) : [],
  );

  protected readonly failure = computed(() => {
    const state = this.searchState();
    return state.status === 'error' ? state.error : null;
  });
  protected readonly failureText = computed(() => {
    const failure = this.failure();
    return failure ? apiErrorText(failure) : null;
  });

  protected readonly resultsView = computed(() => {
    const state = this.searchState();
    switch (state.status) {
      case 'loading':
        return state.previous.length ? 'stale' : 'loading';
      case 'error':
        return state.error.kind === 'unauthorized' ? 'noAccess' : 'failed';
      case 'ready':
        return this.resultRows().length ? 'results' : 'empty';
      default:
        return 'idle';
    }
  });

  /** "Show more results" (or its retry) while pages are left. */
  protected readonly moreView = computed(() => {
    const state = this.searchState();
    if (state.status !== 'ready' || state.page >= state.lastPage) return null;
    switch (this.search.moreStatus()) {
      case 'loading':
        return this.t('editor.search.more.loading');
      case 'error':
        return this.t('editor.search.more.retry');
      default:
        return this.t('editor.search.more.label', {
          shown: this.resultRows().length,
          total: state.total,
        });
    }
  });

  /** The actions on screen; without search, only those matching what is typed. */
  protected readonly actionRows = computed(() => {
    const term = this.term().toLocaleLowerCase();
    return this.palette
      .actions()
      .map((action) => ({
        action,
        label: this.t(action.label),
        blocked: this.blockedReason(action),
      }))
      .filter(
        (row) =>
          this.palette.canSearch() ||
          !term ||
          row.label.toLocaleLowerCase().includes(term),
      );
  });

  /**
   * The admin pages and settings topics whose place ("Admin › People and access › Users") holds
   * every word typed; none while nothing is typed.
   */
  protected readonly pageRows = computed(() => {
    const term = this.term();
    if (!term.trim()) return [];
    return this.palette
      .pages()
      .map((page) => {
        const trail = page.trail.map((key) => this.t(key));
        return {
          id: page.id,
          link: page.link,
          name: trail.at(-1) ?? '',
          label: trail.join(' › '),
        };
      })
      .filter((row) => matchesPage(row.label, term));
  });

  /**
   * The user guide's pages whose title and summary hold every word typed (#221), in the
   * interface language; none while nothing is typed or help links are off.
   */
  protected readonly helpRows = computed(() => {
    const term = this.term();
    if (!term.trim() || !this.palette.canFindHelp()) return [];
    return this.help.search(term);
  });

  protected readonly nothingToShow = computed(() => {
    if (
      this.actionRows().length ||
      this.pageRows().length ||
      this.helpRows().length
    )
      return false;
    if (!this.term()) return this.recentRows().length === 0;
    return !this.palette.canSearch();
  });

  protected readonly changeSetView = computed(() => {
    if (this.session.switching()) return 'loading';
    const status = this.session.status();
    if (status === 'error') {
      return this.session.error()?.status === 403 ? 'noAccess' : 'failed';
    }
    return (status === 'loading' || status === 'idle') &&
      this.session.options().length === 0
      ? 'loading'
      : 'ready';
  });

  protected readonly changeSetRows = computed<readonly ChangeSetRow[]>(() => {
    const value = this.session.value();
    return [
      {
        key: CHANGE_SET + PUBLISHED,
        id: PUBLISHED,
        title: this.t('editor.changeSet.published'),
        state: '',
        current: value === PUBLISHED,
      },
      ...this.session
        .options()
        .filter((option) => !option.pending)
        .map((option) => ({
          key: CHANGE_SET + option.id,
          id: option.id,
          title: option.title,
          state: this.session.isBranchMissing(option)
            ? this.t('editor.changeSet.stateBranchMissing', {
                state: this.t(STATE_KEYS[option.state]),
              })
            : this.t(STATE_KEYS[option.state]),
          current: value === option.id,
        })),
    ];
  });

  /** What a screen reader hears as results arrive. */
  protected readonly announcement = computed(() => {
    if (this.mode() !== 'search' || !this.term() || !this.palette.canSearch()) {
      return '';
    }
    switch (this.resultsView()) {
      case 'loading':
      case 'stale':
        return this.t('editor.search.searching');
      case 'empty':
        // Pages found by name are on screen: not "nothing found".
        return this.pageRows().length || this.helpRows().length
          ? ''
          : this.t('editor.search.empty.title', { term: this.term() });
      case 'results': {
        const state = this.searchState();
        return this.t('editor.search.found', {
          count: state.status === 'ready' ? state.total : 0,
        });
      }
      default:
        return '';
    }
  });

  constructor() {
    // A navigation the palette did not start (the browser's Back) closes it with its overlay.
    this.router.events
      .pipe(
        filter((e) => e instanceof NavigationStart),
        takeUntilDestroyed(),
      )
      .subscribe(() => this.palette.close());
    // Opened: the field has the focus. Closed, or nothing left to offer (another demo user):
    // back to a fresh search next time.
    effect(() => {
      const open = this.palette.isOpen();
      if (!this.palette.available() && open) {
        untracked(() => this.palette.close());
      }
      if (open) {
        // Opened again before it finished closing: a "New module" chosen then is dropped.
        this.newModuleAfterClose = null;
        this.newManualAfterClose = null;
        untracked(() => this.focusInput());
      } else {
        untracked(() => {
          this.mode.set('search');
          this.search.query.set('');
        });
      }
    });
  }

  protected onShortcut(event: KeyboardEvent): void {
    if (event.defaultPrevented || event.repeat || !isPaletteShortcut(event)) {
      return;
    }
    if (!this.palette.available()) return;
    event.preventDefault();
    this.palette.toggle();
  }

  protected kindLabel(row: OpenableRow): string {
    if (row.item.kind === 'manual') return this.t('editor.search.kinds.manual');
    const language = this.languageName(row.item.lang ?? '');
    if (row.keywordMatch) {
      return this.t('editor.search.kinds.keywordMatch', { language });
    }
    if (row.questionMatch) {
      return this.t('editor.search.kinds.questionMatch', { language });
    }
    return row.textMatch
      ? this.t('editor.search.kinds.textMatch', { language })
      : language;
  }

  protected backOnEmpty(event: Event): void {
    const input = event.target as HTMLInputElement | null;
    if (input && input.value === '') this.showSearch();
  }

  protected select(option: ZardCommandOption): void {
    const key = String(option.value);
    if (key === MORE) {
      this.search.loadMore();
      return;
    }
    if (key === BACK) {
      this.showSearch();
      return;
    }
    if (key.startsWith(ACTION)) {
      this.runAction(key.slice(ACTION.length));
      return;
    }
    if (key.startsWith(PAGE)) {
      this.openPage(key.slice(PAGE.length));
      return;
    }
    if (key.startsWith(HELP)) {
      this.openHelp(key.slice(HELP.length));
      return;
    }
    if (key.startsWith(CHANGE_SET)) {
      this.switchTo(key.slice(CHANGE_SET.length));
      return;
    }
    const row = [...this.resultRows(), ...this.recentRows()].find(
      (r) => r.key === key,
    );
    if (row) this.openRow(row);
  }

  private openRow(row: OpenableRow): void {
    this.recents.add(row.item);
    this.palette.close();
    void this.router.navigate(rowLink(row.item), {
      queryParams: this.csLink.params(),
      ...(row.blockId ? { fragment: row.blockId } : {}),
    });
  }

  private openPage(id: string): void {
    const page = this.pageRows().find((p) => p.id === id);
    if (!page) return;
    this.palette.close();
    void this.router.navigate([...page.link], {
      queryParams: this.csLink.params(),
    });
  }

  /** A guide page opens in a new tab; the palette closes. Only the help service's `http(s)` addresses. */
  private openHelp(id: string): void {
    const href = this.helpRows().find((h) => h.id === id)?.href;
    if (!href || !URL.canParse(href)) return;
    const { protocol } = new URL(href);
    if (protocol !== 'http:' && protocol !== 'https:') return;
    this.palette.close();
    window.open(href, '_blank', 'noopener,noreferrer');
  }

  private runAction(id: string): void {
    const action = this.palette.actions().find((a) => a.id === id);
    if (!action || this.blockedReason(action)) return;
    if (action.id === 'switchChangeSet') {
      if (this.session.status() === 'idle') void this.session.refresh();
      this.mode.set('changeSet');
      this.focusInput();
    }
    if (action.id === 'openReview') {
      this.palette.close();
      void this.router.navigate(['/review']);
    }
    if (action.id === 'newModule') {
      // The content browser hosts the dialog. It is asked for once the palette has closed and
      // given the focus back (so the dialog returns it there too), and only if the person got
      // to the browser: a cancelled navigation leaves nothing behind.
      this.palette.close();
      this.newModuleAfterClose = this.atContent()
        ? Promise.resolve(true)
        : this.router.navigate(['/content'], {
            queryParams: this.csLink.params(),
          });
    }
    if (action.id === 'newManual') {
      // The same, for the manual builder's dialog.
      this.palette.close();
      this.newManualAfterClose = this.atPath('manuals')
        ? Promise.resolve(true)
        : this.router.navigate(['/manuals'], {
            queryParams: this.csLink.params(),
          });
    }
  }

  private switchTo(id: string): void {
    const row = this.changeSetRows().find((r) => r.id === id);
    if (!row || this.session.switching()) return;
    this.palette.close();
    if (row.current) return;
    this.session.choose(id);
    this.toast.success(
      id === PUBLISHED
        ? translated('editor.search.changeSet.switchedPublished')
        : translated('editor.search.changeSet.switched', { title: row.title }),
    );
  }

  protected afterClose(): void {
    const navigation = this.newModuleAfterClose;
    this.newModuleAfterClose = null;
    void navigation?.then((arrived) => {
      if (arrived && this.atContent()) this.newModule.request();
    });
    const manual = this.newManualAfterClose;
    this.newManualAfterClose = null;
    void manual?.then((arrived) => {
      if (arrived && this.atPath('manuals')) this.newManual.request();
    });
  }

  /** Whether the content browser is on screen. */
  private atContent(): boolean {
    return this.atPath('content');
  }

  /** Whether the screen at `path` is on screen. */
  private atPath(path: string): boolean {
    return (
      this.router
        .parseUrl(this.router.url)
        .root.children['primary']?.segments.map((s) => s.path)
        .join('/') === path
    );
  }

  private showSearch(): void {
    this.search.query.set('');
    this.mode.set('search');
    this.focusInput();
  }

  /** The new list's field takes the focus once it is rendered. */
  private focusInput(): void {
    setTimeout(() => this.command()?.focus());
  }

  /** Why an action is blocked right now (translated), or empty. */
  private blockedReason(action: PaletteAction): string {
    const states = action.rules.map((rule) => this.permissions.state(rule));
    if (!states.some((s) => s.kind === 'enabled')) {
      const disabled = states.find((s) => s.kind === 'disabled');
      if (disabled?.kind === 'disabled') return this.t(disabled.reason);
    }
    if (action.id === 'switchChangeSet' && this.session.switching()) {
      return this.t('editor.changeSet.switchingReason');
    }
    if (action.id === 'newModule') {
      const blocked = this.newModule.blocked();
      if (blocked) return this.t(blocked);
    }
    if (action.id === 'newManual') {
      const blocked = this.newManual.blocked();
      if (blocked) return this.t(blocked);
    }
    return '';
  }

  private languageName(lang: string): string {
    try {
      const names = new Intl.DisplayNames([this.language.locale()], {
        type: 'language',
      });
      return names.of(lang) ?? lang.toUpperCase();
    } catch {
      return lang.toUpperCase();
    }
  }
}
