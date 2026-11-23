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
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideArrowDown,
  lucideArrowUp,
  lucideBookOpen,
  lucideFileText,
  lucideSettings,
  lucideUndo2,
} from '@ng-icons/lucide';
import { TranslocoPipe } from '@jsverse/transloco';
import { firstValueFrom } from 'rxjs';

import { ZardAlertDialogService } from '@openfolia/ui/alert-dialog';
import { ZardBadgeComponent } from '@openfolia/ui/badge';
import { StatusBadgeComponent, type ContentStatus } from '@openfolia/ui/badges';
import { ZardButtonComponent } from '@openfolia/ui/button';
import {
  DiffDeletedComponent,
  DiffInsertedComponent,
} from '@openfolia/ui/diff-marks';
import {
  injectTranslate,
  LanguageService,
  RelativeTimePipe,
  translated,
} from '@openfolia/ui/i18n';
import { KbdComponent } from '@openfolia/ui/kbd';
import { ListFrameComponent, ListRowDirective } from '@openfolia/ui/list-frame';
import {
  SegmentedComponent,
  type SegmentedOption,
} from '@openfolia/ui/segmented';
import { PageHeaderComponent } from '@openfolia/ui/shell';
import { ZardSkeletonComponent } from '@openfolia/ui/skeleton';
import { FadeInDirective, RefreshingDirective } from '@openfolia/ui/smooth';
import {
  EmptyStateComponent,
  ErrorStateComponent,
  NoAccessStateComponent,
} from '@openfolia/ui/states';
import { ToastService } from '@openfolia/ui/toast';

import {
  ApiClient,
  pageQuery,
  toApiError,
  type ApiError,
  type Response,
} from '../api';
import { languageName } from '../content/browser-model';
import { apiErrorText } from '../i18n';
import { contributesOnly } from '../permissions/permissions';
import { GuardDirective } from '../permissions/guard.directive';
import { MeService } from '../permissions/me';
import { ChangeSetSession } from '../session/change-set-session';
import { DemoSession } from '../session/demo-session';
import { isChangeSetId } from '../session/change-set-id';
import { type ChangeSetRename } from '../session/change-set-rename.component';
import {
  idParam,
  injectQueryState,
  intParam,
  listParam,
  oneOfParam,
} from '../view-state';
import { ChangeSetBaseRewrittenComponent } from '../session/change-set-base-rewritten.component';
import { CarryForward } from '../session/carry-forward';
import { LineBadgeComponent } from '../session/line-badge.component';
import { MaintenanceLines } from '../session/maintenance-lines';
import { ChangeSetMove } from '../session/change-set-move';
import { ChangeSetUpdate } from '../session/change-set-update';
import { injectFailureText } from '../session/failure-text';
import { ChecksSummaryComponent } from '../checks/checks-summary.component';
import { ImageSources } from '../images/image-sources';
import { ManualDiffComponent } from './manual-diff.component';
import { ProjectFileDiffComponent } from './project-file-diff.component';
import {
  ModuleDiffComponent,
  subjectKey,
  type DiffView,
} from './module-diff.component';
import { ReviewComments } from './review-comments';
import { ReviewContext, type ItemSummary } from './review-context';
import {
  expectedAfter,
  FILTER_LABELS,
  FILTER_TITLES,
  isAuthor,
  retryableFailure,
  REVIEW_FILTERS,
  summaryOf,
  type ChangeSet,
  type ChangeSetChange,
  type ReviewFilter,
  type ReviewMeta,
  type TransitionName,
} from './review-model';
import { ReviewPanelComponent } from './review-panel.component';

/** Change sets per page of the list on the left; modules per page of the diff. */
const LIST_PAGE_SIZE = 20;
/** The list's page sizes to choose from (`?size=`). */
const LIST_PAGE_SIZES: readonly number[] = [20, 50, 100];

/** The diff views as the address names them (`?diff=`); inline is the default, left out. */
const DIFF_PARAMS = {
  inline: undefined,
  side: 'side-by-side',
  rendered: 'rendered',
} as const satisfies Readonly<Record<DiffView, string | undefined>>;
type DiffParam = 'side-by-side' | 'rendered';
const DIFF_VIEWS: Readonly<Record<DiffParam, DiffView>> = {
  'side-by-side': 'side',
  rendered: 'rendered',
};
/** A module's ID and a language tag as the content model allows them (`?module=`, `?lang=`). */
const MODULE_ID = /^[a-z0-9][a-z0-9-]{0,127}$/;
/** A run of unchanged blocks opened (`?open=`): the item's key, `~`, the run's first ID. */
const OPEN_RUN =
  /^(module\/[a-z]{2,3}(-[A-Za-z0-9]{2,8})*\/|manual\/)[a-z0-9-]{1,128}~[A-Za-z0-9_:.-]{1,200}$/;
/** At most this many opened runs are kept in the address (the oldest go first). */
const MAX_OPEN = 32;
const LANG = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

const CHANGES_PAGE_SIZE = 5;
/** Below this width side by side falls back to inline. */
const NARROW = '(max-width: 767px)';
/**
 * The keys that move to the next and the previous change, and open a thread on it (the shortcut
 * reference, `shortcuts/shortcuts.ts`, lists them).
 */
export const REVIEW_KEYS = {
  next: ['j', 'n'],
  previous: ['k', 'p'],
  comment: ['c'],
} as const satisfies Record<string, readonly string[]>;
/** Space kept below a frame: the page's bottom padding. */
const BELOW_FRAME_PX = 24;

/**
 * Whether trying the same transition again may go through: the API or the network was away, or
 * another write was in the way. A refusal (four eyes, a state that does not take it) would not.
 */
const retryable = retryableFailure;

/** What belongs to the chosen change set in the address: cleared when another is chosen. */
const CHANGE_SET_PARAMS_BUT_CS = {
  changes: 1,
  module: undefined,
  lang: undefined,
  manual: undefined,
  open: [],
} as const;
const CHANGE_SET_PARAMS = { cs: undefined, ...CHANGE_SET_PARAMS_BUT_CS };

/**
 * The view state in the address (`injectQueryState`): the list's state, page and size; the change
 * set under review (`cs`, this page's own, see `ChangeSetUrl`), the page of its changes, the
 * module marked (`module` and `lang`, both or neither) and the diff view.
 */
const REVIEW_PARAMS = {
  state: oneOfParam(REVIEW_FILTERS, 'in-review'),
  page: intParam(1),
  size: intParam(LIST_PAGE_SIZE, { only: LIST_PAGE_SIZES }),
  cs: idParam(isChangeSetId),
  changes: intParam(1),
  module: idParam(MODULE_ID),
  lang: idParam(LANG),
  manual: idParam(MODULE_ID),
  open: listParam(OPEN_RUN, { max: MAX_OPEN }),
  diff: oneOfParam<DiffParam>(['side-by-side', 'rendered']),
};

/** The panes shown one at a time below `xl`. */
const PANES = ['list', 'changes', 'approvals'] as const;
type Pane = (typeof PANES)[number];
const PANE_LABELS: Readonly<Record<Pane, string>> = {
  list: 'editor.review.pane.list',
  changes: 'editor.review.pane.changes',
  approvals: 'editor.review.pane.approvals',
};

/** The route each transition posts to. */
const ROUTES = {
  submit: '/change-sets/{changeSetId}/submit',
  return: '/change-sets/{changeSetId}/return',
  approve: '/change-sets/{changeSetId}/approve',
  'sign-off': '/change-sets/{changeSetId}/sign-off',
  merge: '/change-sets/{changeSetId}/merge',
} as const;

/** What taking an item out loses, by what the change set did to it. */
const TAKE_OUT_TEXT: Readonly<Record<'added' | 'changed' | 'removed', string>> =
  {
    added: 'editor.review.takeOut.added',
    changed: 'editor.review.takeOut.changed',
    removed: 'editor.review.takeOut.removed',
  };

const DONE: Readonly<Record<TransitionName, string>> = {
  submit: 'editor.review.done.submit',
  return: 'editor.review.done.return',
  approve: 'editor.review.done.approve',
  'sign-off': 'editor.review.done.signOff',
  merge: 'editor.review.done.merge',
};

const FAILED: Readonly<Record<TransitionName, string>> = {
  submit: 'editor.review.failed.submit',
  return: 'editor.review.failed.return',
  approve: 'editor.review.failed.approve',
  'sign-off': 'editor.review.failed.signOff',
  merge: 'editor.review.failed.merge',
};

const isFilter = (value: unknown): value is ReviewFilter =>
  (REVIEW_FILTERS as readonly unknown[]).includes(value);

/**
 * Screen 4, the review: the change sets in a state (waiting for review, approved, drafts) on the
 * left, paged; the chosen one's modules compared with its base in the middle (inline, side by
 * side or rendered, paged); its approvals, the review comment and the transitions on the right.
 * Transitions are eager: the screen shows the outcome at once and takes it back, with a Retry
 * toast, if the API refuses. The chosen change set and the list's state are in the address.
 *
 * Comments anchored to blocks come with the comments API: the diff leaves room for them under
 * each block, without a panel of its own.
 */
@Component({
  selector: 'of-review-page',
  imports: [
    FadeInDirective,
    RefreshingDirective,
    RouterLink,
    TranslocoPipe,
    RelativeTimePipe,
    PageHeaderComponent,
    SegmentedComponent,
    ListFrameComponent,
    ListRowDirective,
    StatusBadgeComponent,
    ZardBadgeComponent,
    EmptyStateComponent,
    ErrorStateComponent,
    NoAccessStateComponent,
    ModuleDiffComponent,
    ProjectFileDiffComponent,
    ManualDiffComponent,
    ReviewPanelComponent,
    ChecksSummaryComponent,
    ZardSkeletonComponent,
    NgIcon,
    KbdComponent,
    DiffInsertedComponent,
    DiffDeletedComponent,
    ZardButtonComponent,
    GuardDirective,
    ChangeSetBaseRewrittenComponent,
    LineBadgeComponent,
  ],
  providers: [ReviewContext, ReviewComments, ImageSources],
  viewProviders: [
    provideIcons({
      lucideArrowDown,
      lucideArrowUp,
      lucideBookOpen,
      lucideFileText,
      lucideSettings,
      lucideUndo2,
    }),
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'flex min-w-0 flex-col gap-4',
    '(document:keydown)': 'onKey($event)',
  },
  template: `
    <of-page-header [title]="filterTitle() | transloco">
      <of-segmented
        data-tip="review.filters"
        [label]="'editor.review.filters.label' | transloco"
        [options]="filterOptions()"
        [value]="filter()"
        (valueChange)="chooseFilter($event)"
      />
    </of-page-header>

    <!-- Narrower than three columns: one pane at a time, each in its own frame. With nothing to
         choose there is only the list, so no switcher. -->
    @if (!nothingToChoose()) {
      <of-segmented
        class="self-start xl:hidden"
        [label]="'editor.review.pane.label' | transloco"
        [options]="paneOptions()"
        [value]="pane()"
        (valueChange)="choosePane($event)"
      />
    }

    <div class="flex min-h-0 min-w-0 flex-col gap-4 xl:flex-row xl:items-start">
      <of-list-frame
        #listFrame
        class="w-full shrink-0"
        [class]="{
          'max-xl:hidden': shownPane() !== 'list',
          'xl:w-[16.25rem]': !nothingToChoose(),
        }"
        cards
        [label]="'editor.review.list.label' | transloco"
        [items]="listDoc()?.data ?? []"
        [page]="listDoc()?.meta?.page ?? null"
        [loading]="listLoading()"
        [error]="listError()"
        [offset]="listOffset()"
        [skeletonRows]="3"
        [emptyTitle]="emptyTitle() | transloco"
        [emptyDescription]="'editor.review.list.emptyHint' | transloco"
        [pageSizes]="listPageSizes"
        (pageChange)="chooseListPage($event)"
        (pageSizeChange)="chooseListSize($event)"
        (retry)="reloadList()"
      >
        <ng-template ofListRow let-item>
          @let cs = asChangeSet(item);
          <a
            class="focus-visible:ring-ring flex flex-col gap-1.5 rounded-xl p-3 text-sm outline-none focus-visible:ring-2"
            [class]="
              cs.id === selectedId()
                ? 'bg-muted text-foreground font-medium'
                : 'border-border hover:bg-muted/50 border'
            "
            [routerLink]="[]"
            [queryParams]="{
              cs: cs.id,
              changes: null,
              module: null,
              lang: null,
            }"
            queryParamsHandling="merge"
            (click)="pane.set('changes')"
            [attr.aria-current]="cs.id === selectedId() ? 'true' : null"
          >
            <span class="leading-5 font-medium break-words">{{
              cs.attributes.title
            }}</span>
            <span
              class="text-muted-foreground text-xs leading-5 font-normal break-words"
            >
              {{ authorOf(cs) }} ·
              {{ cs.attributes.updatedAt | ofRelativeTime }}
            </span>
            @if (byContributor(cs)) {
              <span
                z-badge
                zType="outline"
                data-contributor
                class="font-normal"
                >{{ 'editor.review.contributor' | transloco }}</span
              >
            }
            <span class="flex min-w-0 flex-wrap gap-1.5">
              <of-status-badge [status]="statusOf(cs)" />
              <!-- The product version it fixes, when on a maintenance line. -->
              <of-line-badge [baseRef]="cs.attributes.baseRef" />
            </span>
          </a>
        </ng-template>
      </of-list-frame>

      @if (selected(); as cs) {
        <section
          class="border-border flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl border"
          [class]="{ 'max-xl:hidden': shownPane() !== 'changes' }"
          ofFadeIn
          [ofRefreshing]="switching()"
          [attr.aria-label]="cs.attributes.title"
        >
          <header class="border-border flex flex-col gap-3 border-b px-4 py-3">
            <div class="flex flex-wrap items-start justify-between gap-3">
              <div class="flex min-w-0 flex-col gap-1.5">
                <h2 class="m-0 text-base leading-6 font-semibold break-words">
                  {{ cs.attributes.title }}
                </h2>
                <div
                  class="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1 text-xs leading-5"
                >
                  <of-status-badge [status]="statusOf(cs)" />
                  <of-line-badge [baseRef]="cs.attributes.baseRef" />
                  <span class="break-words"
                    >{{ authorOf(cs) }} ·
                    {{ cs.attributes.updatedAt | ofRelativeTime }}</span
                  >
                  @if (byContributor(cs)) {
                    <span z-badge zType="outline" data-contributor>{{
                      'editor.review.contributor' | transloco
                    }}</span>
                  }
                  <span class="break-words">{{ changeSummary() }}</span>
                  <of-checks-summary [changeSetId]="cs.id" [compact]="true" />
                </div>
              </div>
              <of-segmented
                [label]="'editor.review.view.label' | transloco"
                [options]="viewOptions()"
                [value]="shownView()"
                (valueChange)="chooseView($event)"
              />
            </div>
            <of-change-set-base-rewritten
              [changeSetId]="cs.id"
              [title]="cs.attributes.title"
              [state]="cs.attributes.state"
              [baseRef]="cs.attributes.baseRef"
              [rewritten]="cs.meta?.base?.state === 'rewritten'"
              [authorId]="cs.attributes.author.id"
            />
            @if (cs.meta?.supersededBy; as next) {
              <!-- Moved onto the current main: where its changes are now. -->
              <p
                ofFadeIn
                class="text-muted-foreground m-0 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm break-words"
                data-testid="change-set-superseded"
              >
                {{ 'editor.review.superseded' | transloco }}
                <button
                  z-button
                  zType="outline"
                  zSize="sm"
                  type="button"
                  (click)="openChangeSet(next)"
                >
                  {{ 'editor.review.openSuperseding' | transloco }}
                </button>
              </p>
            }
            @if (changesDoc()?.data; as items) {
              @if (items.length > 0) {
                <nav
                  [attr.aria-label]="'editor.review.overview.label' | transloco"
                >
                  <ul class="m-0 flex list-none flex-wrap gap-1.5 p-0">
                    @for (item of items; track item.id) {
                      @let c = asChange(item);
                      @let s = summaryOf(c);
                      <li class="min-w-0">
                        <a
                          class="border-border hover:bg-muted focus-visible:ring-ring flex max-w-full min-w-0 items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs outline-none focus-visible:ring-2"
                          [class.bg-muted]="isFocused(c)"
                          [routerLink]="[]"
                          [queryParams]="focusParams(c)"
                          queryParamsHandling="merge"
                          [attr.aria-current]="isFocused(c) ? 'true' : null"
                        >
                          <ng-icon
                            [name]="
                              c.attributes.subject.type === 'manual'
                                ? 'lucideBookOpen'
                                : c.attributes.subject.type === 'module'
                                  ? 'lucideFileText'
                                  : 'lucideSettings'
                            "
                            class="text-muted-foreground shrink-0"
                            aria-hidden="true"
                          />
                          <span class="min-w-0 font-medium break-words">{{
                            s?.title || subjectId(c)
                          }}</span>
                          <span class="text-muted-foreground shrink-0">{{
                            subjectKind(c)
                          }}</span>
                          @if (s) {
                            @for (n of shortCounts(s); track n.key) {
                              <span class="shrink-0 font-mono" [class]="n.tone"
                                ><span aria-hidden="true"
                                  >{{ n.symbol }}{{ n.count }}</span
                                ><span class="sr-only">{{
                                  n.key | transloco: { count: n.count }
                                }}</span></span
                              >
                            }
                          } @else {
                            <z-skeleton class="h-3 w-8" aria-hidden="true" />
                          }
                        </a>
                      </li>
                    }
                  </ul>
                </nav>
              }
            }
            <div
              class="flex flex-wrap items-center justify-between gap-x-4 gap-y-2"
            >
              <p
                class="text-muted-foreground m-0 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs"
                [attr.aria-label]="'editor.review.legend.label' | transloco"
              >
                <span
                  ><span class="text-success font-mono" aria-hidden="true"
                    >+ </span
                  >{{ 'editor.review.legend.added' | transloco }}</span
                >
                <span
                  ><span class="text-destructive font-mono" aria-hidden="true"
                    >− </span
                  >{{ 'editor.review.legend.removed' | transloco }}</span
                >
                <span
                  ><span class="text-info font-mono" aria-hidden="true">~ </span
                  >{{ 'editor.review.legend.changed' | transloco }}</span
                >
                <span
                  ><span class="text-info font-mono" aria-hidden="true">↕ </span
                  >{{ 'editor.review.legend.moved' | transloco }}</span
                >
                <span
                  ><ins of-diff-inserted>{{
                    'editor.review.legend.inserted' | transloco
                  }}</ins></span
                >
                <span
                  ><del of-diff-deleted>{{
                    'editor.review.legend.deleted' | transloco
                  }}</del></span
                >
              </p>
              <div class="flex items-center gap-1.5 text-xs">
                <button
                  type="button"
                  class="border-border hover:bg-muted focus-visible:ring-ring inline-flex size-7 items-center justify-center rounded-md border outline-none focus-visible:ring-2 disabled:opacity-50"
                  [disabled]="hunkCount() === 0"
                  [attr.aria-label]="'editor.review.nav.previous' | transloco"
                  (click)="step(-1)"
                >
                  <ng-icon name="lucideArrowUp" aria-hidden="true" />
                </button>
                <span
                  class="min-w-24 text-center tabular-nums"
                  aria-live="polite"
                  >{{ position() }}</span
                >
                <button
                  type="button"
                  class="border-border hover:bg-muted focus-visible:ring-ring inline-flex size-7 items-center justify-center rounded-md border outline-none focus-visible:ring-2 disabled:opacity-50"
                  [disabled]="hunkCount() === 0"
                  [attr.aria-label]="'editor.review.nav.next' | transloco"
                  (click)="step(1)"
                >
                  <ng-icon name="lucideArrowDown" aria-hidden="true" />
                </button>
                <span
                  class="text-muted-foreground hidden items-center gap-1 sm:flex"
                >
                  <kbd of-kbd>{{ keys.next }}</kbd><kbd of-kbd>{{
                    keys.previous
                  }}</kbd>
                  @if (canComment()) {
                    <kbd
                      of-kbd
                      [attr.title]="'editor.review.nav.comment' | transloco"
                      >{{ keys.comment }}</kbd><span class="sr-only">{{
                      'editor.review.nav.comment' | transloco
                    }}</span>
                  }
                </span>
              </div>
            </div>
          </header>
          <of-list-frame
            #changesFrame
            class="min-w-0 [&_[data-slot=list-pagination]]:border-border [&_[data-slot=list-pagination]]:border-t [&_[data-slot=list-pagination]]:px-4 [&_ul]:divide-border [&_ul]:divide-y [&_ul]:gap-0!"
            cards
            [label]="'editor.review.diff.label' | transloco"
            [items]="changesDoc()?.data ?? []"
            [page]="changesDoc()?.meta?.page ?? null"
            [loading]="changesLoading()"
            [error]="changesError()"
            [offset]="changesOffset()"
            [skeletonRows]="4"
            [emptyTitle]="'editor.review.diff.emptyTitle' | transloco"
            [emptyDescription]="'editor.review.diff.emptyHint' | transloco"
            (pageChange)="chooseChangesPage($event)"
            (retry)="reloadChanges()"
          >
            <ng-template ofListRow let-item>
              @let change = asChange(item);
              <!-- Dimmed while taken out: a wrapper, so the diff's own reload dimming stays. -->
              <div [ofRefreshing]="takingOut() === change.id">
                @if (change.attributes.subject.type === 'manual') {
                  <of-manual-diff
                    [change]="change"
                    [view]="shownView()"
                    [base]="changesDoc()?.meta?.base ?? ''"
                    [head]="changesDoc()?.meta?.head ?? ''"
                    [focusParams]="focusParams(change)"
                    [focused]="isFocused(change)"
                    [open]="openFor(change)"
                    [link]="moduleLink"
                    (toggled)="toggleRun(change, $event)"
                  >
                    @if (canTakeOut()) {
                      <button
                        ofItemActions
                        z-button
                        zType="ghost"
                        zSize="sm"
                        type="button"
                        [ofGuard]="{
                          permission: 'content.edit',
                          blockedReason: takeOutBlocked(),
                        }"
                        (click)="takeOut(change)"
                      >
                        <ng-icon
                          name="lucideUndo2"
                          data-icon="inline-start"
                          strokeWidth="1.5"
                          aria-hidden="true"
                        />
                        {{ 'editor.review.takeOut.action' | transloco }}
                      </button>
                    }
                  </of-manual-diff>
                } @else if (
                  change.attributes.subject.type === 'config' ||
                  change.attributes.subject.type === 'term' ||
                  change.attributes.subject.type === 'design' ||
                  change.attributes.subject.type === 'template'
                ) {
                  <of-project-file-diff [change]="change" [view]="shownView()">
                    @if (canTakeOut()) {
                      <button
                        ofItemActions
                        z-button
                        zType="ghost"
                        zSize="sm"
                        type="button"
                        [ofGuard]="{
                          permission: 'content.edit',
                          blockedReason: takeOutBlocked(),
                        }"
                        (click)="takeOut(change)"
                      >
                        <ng-icon
                          name="lucideUndo2"
                          data-icon="inline-start"
                          strokeWidth="1.5"
                          aria-hidden="true"
                        />
                        {{ 'editor.review.takeOut.action' | transloco }}
                      </button>
                    }
                  </of-project-file-diff>
                } @else {
                  <of-module-diff
                    [change]="change"
                    [base]="changesDoc()?.meta?.base ?? ''"
                    [head]="changesDoc()?.meta?.head ?? ''"
                    [view]="shownView()"
                    [focusParams]="focusParams(change)"
                    [focused]="isFocused(change)"
                    [open]="openFor(change)"
                    (toggled)="toggleRun(change, $event)"
                  >
                    @if (canTakeOut()) {
                      <button
                        ofItemActions
                        z-button
                        zType="ghost"
                        zSize="sm"
                        type="button"
                        [ofGuard]="{
                          permission: 'content.edit',
                          blockedReason: takeOutBlocked(),
                        }"
                        (click)="takeOut(change)"
                      >
                        <ng-icon
                          name="lucideUndo2"
                          data-icon="inline-start"
                          strokeWidth="1.5"
                          aria-hidden="true"
                        />
                        {{ 'editor.review.takeOut.action' | transloco }}
                      </button>
                    }
                  </of-module-diff>
                }
              </div>
            </ng-template>
          </of-list-frame>
        </section>

        <of-review-panel
          class="w-full shrink-0 xl:w-[16.25rem]"
          [class]="{ 'max-xl:hidden': shownPane() !== 'approvals' }"
          [ofRefreshing]="switching()"
          [changeSet]="cs"
          [review]="review()"
          [reviewLoading]="reviewLoading()"
          [busy]="busy()"
          [nameOf]="nameOf"
          [typeLabel]="typeLabel"
          [(comment)]="comment"
          [canRename]="canRename()"
          [carrying]="carry.busy(cs.id)"
          (transition)="run($event)"
          (renamed)="rename($event)"
          (carryForward)="carryForward(cs)"
        />
      } @else if (selectedFailure(); as f) {
        <div class="border-border flex min-w-0 flex-1 rounded-xl border p-6">
          @if (f.kind === 'unauthorized') {
            <of-no-access class="w-full" [message]="selectedFailureText()" />
          } @else {
            <of-error-state
              class="w-full"
              [kind]="f.kind"
              [message]="selectedFailureText()"
              (retry)="loadSelected()"
            />
          }
        </div>
      } @else if (selectedId()) {
        <!-- The first read of the chosen change set: its card and panel in their real shape. -->
        <div
          ofFadeIn="delayed"
          class="flex min-w-0 flex-1 flex-col gap-4 xl:flex-row xl:items-start"
          aria-hidden="true"
        >
          <div
            class="border-border flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl border"
          >
            <div
              class="border-border flex items-center justify-between gap-2 border-b px-4 py-3"
            >
              <div class="flex flex-col gap-1.5">
                <z-skeleton class="h-4 w-48" />
                <z-skeleton class="h-3 w-64" />
              </div>
              <z-skeleton class="h-8 w-60 rounded-lg" />
            </div>
            <div class="flex flex-col gap-3.5 px-4 py-6 sm:px-8">
              <z-skeleton class="h-6 w-40" />
              <z-skeleton class="h-3 w-56" />
              <z-skeleton class="h-4 w-full" />
              <z-skeleton class="h-4 w-5/6" />
              <z-skeleton class="h-4 w-2/3" />
            </div>
          </div>
          <div
            class="flex w-full shrink-0 flex-col gap-3 max-xl:hidden xl:w-[16.25rem]"
          >
            <div
              class="border-border flex flex-col gap-3 rounded-xl border p-3.5"
            >
              <z-skeleton class="h-4 w-24" />
              <z-skeleton class="h-4 w-full" />
              <z-skeleton class="h-4 w-full" />
            </div>
            <z-skeleton class="h-24 w-full rounded-xl" />
          </div>
        </div>
      } @else if (nothingToChoose()) {
        <!-- Nothing to choose: the list says why. -->
      } @else if (!selectedId()) {
        <div class="border-border flex min-w-0 flex-1 rounded-xl border p-6">
          <of-empty-state
            class="w-full"
            [title]="'editor.review.choose.title' | transloco"
            [description]="'editor.review.choose.hint' | transloco"
          />
        </div>
      }
    </div>
  `,
})
export class ReviewPage {
  private readonly api = inject(ApiClient);
  private readonly toast = inject(ToastService);
  private readonly me = inject(MeService);
  private readonly demo = inject(DemoSession);
  private readonly session = inject(ChangeSetSession);
  private readonly updates = inject(ChangeSetUpdate);
  private readonly moves = inject(ChangeSetMove);
  protected readonly carry = inject(CarryForward);
  private readonly lines = inject(MaintenanceLines);
  private readonly language = inject(LanguageService);
  private readonly t = injectTranslate();
  private readonly failureText = injectFailureText();
  private readonly reviewContext = inject(ReviewContext);
  private readonly comments = inject(ReviewComments);

  private readonly view$ = injectQueryState(REVIEW_PARAMS);

  protected readonly filter = computed((): ReviewFilter => {
    return this.view$.get('state')();
  });
  /** The chosen change set's ID; anything but an ID (a crafted `..`, say) chooses none. */
  protected readonly selectedId = computed(() => {
    return this.view$.get('cs')() ?? '';
  });

  /** Another change set is chosen and on its way: the one shown stays, dimmed and inert. */
  protected readonly switching = computed(() => {
    const shown = this.selected();
    return (
      shown !== null &&
      (shown.id !== this.selectedId() ||
        (this.changesLoading() && this.changesFor() !== shown.id))
    );
  });
  /** The change set the changes shown are of. */
  private readonly changesFor = signal('');

  /** The diff view (`?diff=side-by-side|rendered`, inline when left out). */
  protected readonly view = computed((): DiffView => {
    const diff = this.view$.get('diff')();
    return diff ? DIFF_VIEWS[diff] : 'inline';
  });
  /** The module the address points at (`?module=&lang=`, both or neither), shown and marked. */
  protected readonly focus = computed(() => {
    const module = this.view$.get('module')();
    const lang = this.view$.get('lang')();
    return module && lang ? { module, lang } : null;
  });
  protected readonly comment = signal('');

  // The list.
  /** The list's page and page size (`?page=`, `?size=`; 1 and 20 left out). */
  protected readonly listPage = this.view$.get('page');
  protected readonly listSize = this.view$.get('size');
  protected readonly listPageSizes = LIST_PAGE_SIZES;
  protected readonly listDoc = signal<Response<'/change-sets'> | null>(null);
  protected readonly listLoading = signal(true);
  /**
   * No change set chosen and none to choose: the list's empty state takes the whole width (and,
   * below `xl`, is the one pane). While the list reloads, its last answer stands, so switching
   * between empty filters doesn't flicker.
   */
  protected readonly nothingToChoose = computed(() => {
    if (this.selectedId()) return false;
    const doc = this.listDoc();
    if (this.listLoading()) return doc !== null && doc.data.length === 0;
    return (doc?.data?.length ?? 0) === 0;
  });
  private readonly listFailure = signal<ApiError | null>(null);
  private readonly listReloads = signal(0);
  private listRuns = 0;

  // The chosen change set.
  protected readonly selected = signal<ChangeSet | null>(null);
  protected readonly selectedFailure = signal<ApiError | null>(null);
  protected readonly review = signal<ReviewMeta | null>(null);
  protected readonly reviewLoading = signal(false);
  private selectedRuns = 0;

  // Its changes.
  /** The page of its changes (`?changes=`, 1 left out). */
  protected readonly changesPage = this.view$.get('changes');
  protected readonly changesDoc =
    signal<Response<'/change-sets/{changeSetId}/changes'> | null>(null);
  protected readonly changesLoading = signal(false);
  private readonly changesFailure = signal<ApiError | null>(null);
  private readonly changesReloads = signal(0);
  private changesRuns = 0;

  protected readonly busy = signal(false);
  /** The change (`module/<lang>/<id>`, `manual/<id>`) being taken out, while the API answers. */
  protected readonly takingOut = signal<string | null>(null);
  private readonly dialogs = inject(ZardAlertDialogService);
  /** The module types' labels in the interface language (#731), for the sign-offs. */
  private readonly typeLabels = computed(
    (): ReadonlyMap<string, string> =>
      new Map(
        (this.reviewContext.config()?.moduleTypes ?? []).map((m) => [
          m.id,
          m.label,
        ]),
      ),
  );

  private readonly listFrame = viewChild('listFrame', { read: ElementRef });
  private readonly changesFrame = viewChild('changesFrame', {
    read: ElementRef,
  });
  protected readonly listOffset = signal('14rem');
  protected readonly changesOffset = signal('18rem');

  protected readonly filterTitle = computed(() => FILTER_TITLES[this.filter()]);
  protected readonly emptyTitle = computed(
    () =>
      ({
        'in-review': 'editor.review.list.emptyInReview',
        approved: 'editor.review.list.emptyApproved',
        draft: 'editor.review.list.emptyDraft',
      })[this.filter()],
  );

  protected readonly filterOptions = computed((): SegmentedOption[] =>
    REVIEW_FILTERS.map((f) => ({
      value: f,
      label: this.t(FILTER_LABELS[f]),
      count: this.counts()[f] ?? null,
    })),
  );

  /**
   * How many change sets each filter holds, so an empty "Waiting" doesn't hide drafts: the list's
   * own answer counts every state (`meta.counts`, #481), so no read per state; until a list is
   * read, no count.
   */
  protected readonly counts = signal<Partial<Record<ReviewFilter, number>>>({});

  /** Below `xl`, the one pane shown. */
  protected readonly pane = signal<Pane>('changes');
  /** The pane shown: the list when there is nothing to choose, so its empty state says why. */
  protected readonly shownPane = computed((): Pane =>
    this.nothingToChoose() ? 'list' : this.pane(),
  );
  protected readonly paneOptions = computed((): SegmentedOption[] =>
    PANES.map((p) => ({ value: p, label: this.t(PANE_LABELS[p]) })),
  );

  protected choosePane(value: string): void {
    if ((PANES as readonly string[]).includes(value))
      this.pane.set(value as Pane);
  }

  protected readonly viewOptions = computed((): SegmentedOption[] => [
    { value: 'inline', label: this.t('editor.review.view.inline') },
    // Two columns do not fit a phone: side by side is offered from a wider screen on.
    ...(this.narrow()
      ? []
      : [{ value: 'side', label: this.t('editor.review.view.side') }]),
    { value: 'rendered', label: this.t('editor.review.view.rendered') },
  ]);

  /** Narrower than two columns of text take (a phone). */
  protected readonly narrow = signal(false);
  /** The view drawn: side by side falls back to inline on a narrow screen. */
  protected readonly shownView = computed((): DiffView =>
    this.narrow() && this.view() === 'side' ? 'inline' : this.view(),
  );

  protected readonly listError = computed(() =>
    this.frameError(this.listFailure()),
  );
  protected readonly changesError = computed(() =>
    this.frameError(this.changesFailure()),
  );
  protected readonly selectedFailureText = computed(() => {
    const f = this.selectedFailure();
    if (!f) return '';
    const text = apiErrorText(f);
    return this.t(text.key, text.params);
  });

  /** "2 modules · Deutsch, English · compared with main". */
  protected readonly changeSummary = computed(() => {
    const doc = this.changesDoc();
    const cs = this.selected();
    if (!cs) return '';
    const compared = this.t('editor.review.diff.comparedWith', {
      ref: this.lines.label(cs.attributes.baseRef),
    });
    if (!doc) return compared;
    const summary = summaryOf(doc.data);
    const locale = this.language.locale();
    const parts = [
      this.t('editor.review.summary.items', {
        count: doc.meta.page.total,
      }),
      ...(summary.languages.length > 0
        ? [summary.languages.map((l) => languageName(locale, l)).join(', ')]
        : []),
      compared,
    ];
    return parts.join(' · ');
  });

  /** The person is the author of the change set shown. */
  private readonly authorShown = computed(() => {
    const cs = this.selected();
    const me = this.me.me();
    return (
      !!cs &&
      cs.attributes.author.kind === me.kind &&
      cs.attributes.author.id === me.id
    );
  });
  /** Its author may rename it while it is open. */
  protected readonly canRename = computed(
    () =>
      this.authorShown() &&
      ['draft', 'in-review', 'approved'].includes(
        this.selected()?.attributes.state ?? '',
      ),
  );
  /** Its author may take changes out of it while it is a draft. */
  protected readonly canTakeOut = computed(
    () => this.authorShown() && this.selected()?.attributes.state === 'draft',
  );
  /** Why taking out waits (a key), or null. */
  protected readonly takeOutBlocked = computed(() =>
    this.takingOut() !== null || this.busy() || this.switching()
      ? 'editor.review.takeOut.busy'
      : null,
  );

  /** Whoever is acting: lists and reviews are read again for another person. */
  private readonly who = computed(() => this.me.me().id);

  protected readonly nameOf = (kind: string, id: string): string => {
    const me = this.me.me();
    if (kind === me.kind && id === me.id && me.name) return me.name;
    return this.demo.users().find((u) => u.id === id)?.name ?? id;
  };

  protected readonly typeLabel = (id: string): string =>
    this.typeLabels().get(id) ?? id;

  constructor() {
    // The review threads: of the change set shown, written by its author or a reviewer while open.
    this.comments.nameOf.set(this.nameOf);
    effect(() => {
      const id = this.selected()?.id ?? '';
      untracked(() => {
        if (id !== this.comments.changeSetId()) this.comments.reset(id);
      });
    });
    effect(() => {
      const cs = this.selected();
      const me = this.me.me();
      const open =
        !!cs &&
        ['draft', 'in-review', 'approved'].includes(cs.attributes.state);
      const author =
        !!cs &&
        cs.attributes.author.kind === me.kind &&
        cs.attributes.author.id === me.id;
      this.comments.canWrite.set(
        open && (author || me.permissions.has('content.review')),
      );
      this.comments.me.set(
        me.kind === 'nobody' ? null : { kind: me.kind, id: me.id },
      );
    });
    // Another view draws other changes: moving through them starts again.
    effect(() => {
      this.shownView();
      untracked(() => {
        this.current.set(-1);
        for (const el of this.hunks()) el.removeAttribute('data-current');
      });
    });
    const destroyRef = inject(DestroyRef);
    // The list: by state and page, for whoever is acting.
    effect(() => {
      const state = this.filter();
      const page = this.listPage();
      const size = this.listSize();
      this.who();
      this.listReloads();
      untracked(() => void this.loadList(state, page, size));
    });
    // Nothing chosen: the first of the list, once it is there.
    effect(() => {
      const doc = this.listDoc();
      if (this.selectedId() || this.listLoading()) return;
      const first = doc?.data[0];
      if (first) {
        untracked(() => this.view$.set({ cs: first.id }, { replace: true }));
      }
    });
    // The chosen change set, its review and its changes.
    effect(() => {
      const id = this.selectedId();
      this.who();
      untracked(() => {
        this.comment.set('');
        void this.loadSelected(id);
      });
    });
    // Moved onto the current main (#471): the new change set holds its changes now.
    // Only a move made while this screen is open: an older one is not followed again.
    const seen = this.moves.moved();
    effect(() => {
      const moved = this.moves.moved();
      untracked(() => {
        if (!moved || moved === seen) return;
        this.reloadList();
        if (moved.from === this.selectedId()) this.openChangeSet(moved.to);
      });
    });
    // Updated from its base (#22): its head, base commit and changes are new.
    effect(() => {
      const done = this.updates.done();
      untracked(() => {
        if (!done || done.id !== this.selected()?.id) return;
        void this.loadSelected(done.id);
        this.changesReloads.update((n) => n + 1);
      });
    });
    effect(() => {
      const id = this.selectedId();
      const page = this.changesPage();
      this.who();
      this.changesReloads();
      untracked(() => void this.loadChanges(id, page));
    });
    void this.loadTypes();

    // Each frame is capped to the screen below its top (one pane at a time when narrow, so the
    // frame shown is measured where it stands).
    const measure = () => {
      const top = (el: ElementRef | undefined) =>
        Math.max(
          0,
          Math.round(
            (
              el?.nativeElement as HTMLElement | undefined
            )?.getBoundingClientRect().top ?? 0,
          ),
        );
      this.listOffset.set(`${top(this.listFrame()) + BELOW_FRAME_PX}px`);
      // The card's own border and padding below the frame count too.
      const below = `${top(this.changesFrame()) + BELOW_FRAME_PX + 2}px`;
      // On a phone the header above takes most of the screen: the diff keeps at least 70% of
      // its height, and the page scrolls the header away to reach it.
      this.changesOffset.set(this.narrow() ? `min(${below}, 30dvh)` : below);
    };
    afterRenderEffect(() => {
      // The pane shown, and the switcher above it coming or going.
      this.shownPane();
      this.nothingToChoose();
      this.listFrame();
      this.changesFrame();
      this.selected();
      this.narrow();
      measure();
    });
    const narrowQuery = window.matchMedia?.(NARROW);
    const onNarrow = () => this.narrow.set(!!narrowQuery?.matches);
    onNarrow();
    narrowQuery?.addEventListener('change', onNarrow);
    destroyRef.onDestroy(() =>
      narrowQuery?.removeEventListener('change', onNarrow),
    );
    const onResize = () => measure();
    window.addEventListener('resize', onResize);
    // The changes drawn, counted again whenever the diff below changes.
    let counting = 0;
    const observer = new MutationObserver(() => {
      cancelAnimationFrame(counting);
      counting = requestAnimationFrame(() =>
        this.hunkCount.set(this.hunks().length),
      );
    });
    effect(() => {
      const root = this.changesFrame()?.nativeElement as
        HTMLElement | undefined;
      observer.disconnect();
      if (root) {
        observer.observe(root, {
          subtree: true,
          childList: true,
          attributes: true,
          attributeFilter: ['data-hunk', 'inert'],
        });
        this.hunkCount.set(this.hunks().length);
      }
    });
    destroyRef.onDestroy(() => {
      observer.disconnect();
      cancelAnimationFrame(counting);
    });
    destroyRef.onDestroy(() => window.removeEventListener('resize', onResize));
  }

  private frameError(f: ApiError | null) {
    if (!f) return null;
    const text = apiErrorText(f);
    return { kind: f.kind, message: this.t(text.key, text.params) };
  }

  private async loadList(
    state: ReviewFilter,
    page: number,
    size: number,
  ): Promise<void> {
    const run = ++this.listRuns;
    this.listLoading.set(true);
    this.listFailure.set(null);
    try {
      const doc = await firstValueFrom(
        this.api.get('/change-sets', {
          query: {
            'filter[state]': state,
            ...pageQuery({ number: page, size }),
          },
        }),
      );
      if (run !== this.listRuns) return;
      const last = Math.max(1, doc.meta.page.lastPage);
      if (doc.data.length === 0 && page > last) {
        // Past the end (a stale link): the last page, in place of this one.
        this.view$.set({ page: last }, { replace: true });
        return;
      }
      this.listDoc.set(doc);
      // The counts on the filters come with it, for whoever is acting, after every change.
      this.counts.set(
        Object.fromEntries(
          REVIEW_FILTERS.map((state) => [state, doc.meta.counts[state]]),
        ),
      );
    } catch (error) {
      if (run !== this.listRuns) return;
      this.listDoc.set(null);
      // Not known now (perhaps of someone else, who acted before): no counts.
      this.counts.set({});
      this.listFailure.set(toApiError(error));
    }
    this.listLoading.set(false);
  }

  protected reloadList(): void {
    this.listReloads.update((n) => n + 1);
  }

  protected async loadSelected(id = this.selectedId()): Promise<void> {
    const run = ++this.selectedRuns;
    this.selectedFailure.set(null);
    if (!id) {
      this.selected.set(null);
      this.review.set(null);
      return;
    }
    // What is shown stays, dimmed (`switching`), until the change set and its review are both
    // there: they then replace it together, never one without the other.
    this.reviewLoading.set(true);
    const review = firstValueFrom(
      this.api.get('/change-sets/{changeSetId}/review', {
        path: { changeSetId: id },
      }),
    ).then(
      (doc) => doc.meta.review,
      // The approvals stay unknown (the panel shows the review alone); the transitions still
      // work, and their answers say where it stands.
      () => null,
    );
    try {
      const doc = await firstValueFrom(
        this.api.get('/change-sets/{changeSetId}', {
          path: { changeSetId: id },
        }),
      );
      const standing = await review;
      if (run !== this.selectedRuns) return;
      this.selected.set(doc.data);
      this.review.set(standing);
    } catch (error) {
      if (run !== this.selectedRuns) return;
      this.selected.set(null);
      this.review.set(null);
      this.selectedFailure.set(toApiError(error));
    } finally {
      if (run === this.selectedRuns) this.reviewLoading.set(false);
    }
  }

  private async loadReview(id: string, run = this.selectedRuns): Promise<void> {
    this.reviewLoading.set(true);
    try {
      const doc = await firstValueFrom(
        this.api.get('/change-sets/{changeSetId}/review', {
          path: { changeSetId: id },
        }),
      );
      if (run !== this.selectedRuns) return;
      this.review.set(doc.meta.review);
    } catch {
      // The approvals stay unknown (the panel shows the review alone); the transitions still
      // work, and their answers say where it stands.
      if (run !== this.selectedRuns) return;
      this.review.set(null);
    } finally {
      if (run === this.selectedRuns) this.reviewLoading.set(false);
    }
  }

  private async loadChanges(id: string, page: number): Promise<void> {
    const run = ++this.changesRuns;
    if (!id) {
      this.changesDoc.set(null);
      this.changesLoading.set(false);
      return;
    }
    this.changesLoading.set(true);
    this.changesFailure.set(null);
    try {
      const doc = await firstValueFrom(
        this.api.get('/change-sets/{changeSetId}/changes', {
          path: { changeSetId: id },
          query: pageQuery({ number: page, size: CHANGES_PAGE_SIZE }),
        }),
      );
      if (run !== this.changesRuns) return;
      this.reviewContext.reset();
      this.current.set(-1);
      this.changesDoc.set(doc);
      this.changesFor.set(id);
    } catch (error) {
      if (run !== this.changesRuns) return;
      this.changesDoc.set(null);
      this.changesFailure.set(toApiError(error));
    }
    this.changesLoading.set(false);
  }

  protected reloadChanges(): void {
    this.changesReloads.update((n) => n + 1);
  }

  /** The configuration's module type labels, for the sign-offs. */
  private async loadTypes(): Promise<void> {
    try {
      const doc = await firstValueFrom(this.api.get('/config'));
      this.reviewContext.storedConfig.set(doc.data.attributes);
    } catch {
      // The type's ID names it instead.
    }
  }

  protected chooseFilter(value: string): void {
    if (!isFilter(value) || value === this.filter()) return;
    this.view$.set({ state: value, page: 1, ...CHANGE_SET_PARAMS });
  }

  protected chooseView(value: string): void {
    if (value === 'inline' || value === 'side' || value === 'rendered') {
      this.view$.set({ diff: DIFF_PARAMS[value] });
    }
  }

  protected chooseListPage(page: number): void {
    this.view$.set({ page });
  }

  protected chooseListSize(size: number): void {
    if (!LIST_PAGE_SIZES.includes(size)) return;
    this.view$.set({ size, page: 1 });
  }

  protected chooseChangesPage(page: number): void {
    this.view$.set({
      changes: page,
      module: undefined,
      lang: undefined,
      manual: undefined,
      open: [],
    });
  }

  /** The query parameters that open an item of the chosen change set, marked. */
  protected focusParams(
    change: ChangeSetChange,
  ): Record<string, string | null> {
    const s = change.attributes.subject;
    if (s.type === 'module') {
      return { module: s.moduleId, lang: s.lang, manual: null };
    }
    // A project file opens no item of its own: the parameters clear the focus.
    return {
      module: null,
      lang: null,
      manual: s.type === 'manual' ? s.manualId : null,
    };
  }

  protected isFocused(change: ChangeSetChange): boolean {
    const s = change.attributes.subject;
    if (s.type === 'manual') return this.view$.get('manual')() === s.manualId;
    if (s.type !== 'module') return false;
    const f = this.focus();
    return f !== null && s.moduleId === f.module && s.lang === f.lang;
  }

  /** A module's own diff on this page, from a manual's outline: the parameters that open it. */
  protected readonly moduleLink = (
    moduleId: string,
  ): Record<string, string | null> | null => {
    const found = this.changesDoc()?.data.find((c) => {
      const s = c.attributes.subject;
      return s.type === 'module' && s.moduleId === moduleId;
    });
    return found ? this.focusParams(found) : null;
  };

  /** The runs of unchanged blocks opened in an item (`?open=`). */
  protected openFor(change: ChangeSetChange): ReadonlySet<string> {
    const prefix = `${subjectKey(change)}~`;
    return new Set(
      this.view$
        .get('open')()
        .filter((v) => v.startsWith(prefix))
        .map((v) => v.slice(prefix.length)),
    );
  }

  protected toggleRun(change: ChangeSetChange, run: string): void {
    const value = `${subjectKey(change)}~${run}`;
    const open = this.view$.get('open')();
    const next = open.includes(value)
      ? open.filter((v) => v !== value)
      : [...open, value].slice(-MAX_OPEN);
    this.view$.set({ open: next }, { replace: true });
  }

  protected summaryOf(change: ChangeSetChange) {
    return this.reviewContext.summaryOf(subjectKey(change));
  }

  protected subjectId(change: ChangeSetChange): string {
    const s = change.attributes.subject;
    switch (s.type) {
      case 'module':
        return s.moduleId;
      case 'manual':
        return s.manualId;
      case 'config':
        return 'openfolia.yaml';
      case 'term':
        return s.termId;
      case 'design':
        return s.designId;
      case 'template':
        return `templates/${s.templateId}/${s.path}`;
    }
  }

  /** "Manual", or the module's language. */
  protected subjectKind(change: ChangeSetChange): string {
    const s = change.attributes.subject;
    switch (s.type) {
      case 'module':
        return languageName(this.language.locale(), s.lang);
      case 'manual':
        return this.t('editor.review.diff.manual');
      case 'config':
        return this.t('editor.review.diff.config');
      case 'term':
        return this.t('editor.review.diff.term');
      case 'design':
        return this.t('editor.review.diff.design');
      case 'template':
        return this.t('editor.review.diff.template');
    }
  }

  protected shortCounts(s: ItemSummary) {
    return [
      {
        key: 'editor.review.counts.added',
        symbol: '+',
        count: s.counts.added,
        tone: 'text-success',
      },
      {
        key: 'editor.review.counts.changed',
        symbol: '~',
        count: s.counts.changed + s.fields,
        tone: 'text-info',
      },
      {
        key: 'editor.review.counts.removed',
        symbol: '−',
        count: s.counts.removed,
        tone: 'text-destructive',
      },
      {
        key: 'editor.review.counts.moved',
        symbol: '↕',
        count: s.counts.moved,
        tone: 'text-info',
      },
    ].filter((c) => c.count > 0);
  }

  // Moving through the changes.
  protected readonly keys = {
    next: REVIEW_KEYS.next[0],
    previous: REVIEW_KEYS.previous[0],
    comment: REVIEW_KEYS.comment[0],
  };
  /** `c` starts a thread: offered to who may write here. */
  protected readonly canComment = computed(() => this.comments.canWrite());
  /** How many changes the page shows now (counted where they are drawn). */
  protected readonly hunkCount = signal(0);
  /** The change moved to last, from 0; -1 before any. */
  protected readonly current = signal(-1);
  protected readonly position = computed(() => {
    const total = this.hunkCount();
    const at = this.current();
    return at >= 0 && at < total
      ? this.t('editor.review.nav.position', { at: at + 1, total })
      : this.t('editor.review.nav.total', { total });
  });

  private hunks(): HTMLElement[] {
    const root = this.changesFrame()?.nativeElement as HTMLElement | undefined;
    if (!root) return [];
    return [...root.querySelectorAll<HTMLElement>('[data-hunk]')].filter(
      (el) => !el.closest('[inert]'),
    );
  }

  /** Moves to the next (1) or previous (-1) change, marked and in view, with the focus on it. */
  protected step(delta: 1 | -1): void {
    const list = this.hunks();
    if (list.length === 0) return;
    for (const el of list) el.removeAttribute('data-current');
    const from = this.current();
    const next =
      from < 0 || from >= list.length
        ? delta > 0
          ? 0
          : list.length - 1
        : Math.min(list.length - 1, Math.max(0, from + delta));
    this.current.set(next);
    const el = list[next] as HTMLElement;
    el.setAttribute('data-current', '');
    const reduce = window.matchMedia?.(
      '(prefers-reduced-motion: reduce)',
    ).matches;
    el.scrollIntoView?.({
      block: 'center',
      behavior: reduce ? 'auto' : 'smooth',
    });
    el.focus({ preventScroll: true });
  }

  /**
   * `j`/`n` next change, `k`/`p` previous, `c` a thread on the change moved to; never while
   * typing or with a modifier held.
   */
  protected onKey(event: KeyboardEvent): void {
    if (
      event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      event.isComposing ||
      event.defaultPrevented
    )
      return;
    // The target is the document itself when nothing has the focus.
    const target = event.target instanceof Element ? event.target : null;
    if (
      target?.closest(
        'input, textarea, select, [contenteditable], [role=dialog], [role=alertdialog], [role=menu], [role=listbox], [role=combobox]',
      )
    )
      return;
    if (!this.selected()) return;
    if (REVIEW_KEYS.comment.some((key) => key === event.key)) {
      // A thread on the change moved to, when it takes one.
      const el = this.hunks()[this.current()];
      const button = el?.querySelector<HTMLButtonElement>(
        '[data-slot=comment-button]',
      );
      if (!button) return;
      event.preventDefault();
      button.click();
      return;
    }
    const delta = REVIEW_KEYS.next.some((key) => key === event.key)
      ? 1
      : REVIEW_KEYS.previous.some((key) => key === event.key)
        ? -1
        : 0;
    if (!delta) return;
    event.preventDefault();
    this.step(delta);
  }

  /**
   * Makes the transition, eagerly: the change set and its approvals show the outcome at once and
   * go back to what they were, with a toast offering to try again, if the API refuses.
   */
  protected async run(
    name: TransitionName,
    text = this.comment(),
  ): Promise<void> {
    const cs = this.selected();
    if (!cs || this.busy() || this.switching()) return;
    // A read of the change set still on its way would show it as it was before.
    const mine = ++this.selectedRuns;
    // That read never finishes its own loading.
    this.reviewLoading.set(false);
    const me = this.me.me();
    const before = { changeSet: cs, review: this.review() };
    const after = expectedAfter(name, me, cs, before.review);
    const comment = text.trim();
    this.busy.set(true);
    this.selected.set(after.changeSet);
    this.review.set(after.review);
    try {
      const doc = await firstValueFrom(
        this.api.act(
          ROUTES[name],
          { path: { changeSetId: cs.id } },
          comment ? { meta: { comment } } : undefined,
        ),
      );
      if (this.selected()?.id === cs.id) {
        this.selected.set(doc.data);
        // Approve and sign-off say where the review stands; the others are read again.
        const review = (doc as { meta?: { review?: ReviewMeta } }).meta?.review;
        if (review) this.review.set(review);
        // A read of it begun meanwhile (another person acting now, #633) may have been answered
        // before this went through, with the state before it: it is dropped and read again,
        // after this, for whoever acts now. Another change set chosen meanwhile: its own read
        // on its way replaces this one.
        if (this.selectedRuns === mine) {
          if (!review) void this.loadReview(cs.id);
        } else if (this.selectedId() === cs.id) {
          void this.loadSelected(cs.id);
        }
        if (this.comment().trim() === comment) this.comment.set('');
      }
      // Merged into a line: which one is said by its lines, read first if they are not yet.
      if (
        name === 'merge' &&
        cs.attributes.baseRef !== 'main' &&
        !this.lines.known()
      )
        await this.lines.refresh();
      const onLine =
        name === 'merge' && this.lines.lineOf(cs.attributes.baseRef) !== null;
      // Whoever may edit content may carry it forward (the API: its author, or an editor
      // covering all it changed); a publisher who may not is told who can.
      const mayCarry = onLine && this.me.me().permissions.has('content.edit');
      this.toast.success(
        translated(
          mayCarry
            ? 'editor.carryForward.merged'
            : onLine
              ? 'editor.carryForward.mergedOther'
              : DONE[name],
          {
            title: cs.attributes.title,
            line: this.lines.label(cs.attributes.baseRef),
          },
        ),
        // Merged into an older product version: carrying it forward is offered, never done (#250).
        mayCarry
          ? {
              actionLabel: translated('editor.carryForward.action'),
              onAction: () => void this.carryForward(doc.data),
            }
          : {},
      );
      this.reloadList();
      void this.session.refresh();
    } catch (error) {
      if (this.selected()?.id === cs.id) {
        this.selected.set(before.changeSet);
        this.review.set(before.review);
      }
      const failure = toApiError(error);
      if (failure.code === 'base-rewritten') {
        // Rewritten since it was read (a race): said in the same words, with the way out.
        this.updates.offerMove(
          {
            id: cs.id,
            title: cs.attributes.title,
            baseRef: cs.attributes.baseRef,
          },
          isAuthor(this.me.me(), cs),
        );
        if (this.selected()?.id === cs.id) void this.loadSelected(cs.id);
        return;
      }
      this.toast.error(
        this.failureText(
          translated(FAILED[name], { title: cs.attributes.title }),
          failure,
        ),
        retryable(failure)
          ? {
              actionLabel: translated('editor.session.retry'),
              onAction: () => this.retry(name, text, cs.id),
            }
          : {},
      );
      // What the API knows now (a head that moved is back in draft, say).
      if (this.selected()?.id === cs.id) void this.loadSelected(cs.id);
      this.reloadList();
    } finally {
      this.busy.set(false);
    }
  }

  /**
   * Renames the change set shown, eagerly: the new title is shown at once (here, in the list and
   * in the header's picker) and goes back, with a toast (a retry where one can succeed), if the API refuses.
   */
  protected async rename(change: ChangeSetRename): Promise<void> {
    const cs = this.selected();
    if (!cs) return;
    const shown = (attributes: {
      title: string;
      description: string | null;
    }) => {
      if (this.selected()?.id === cs.id) {
        this.selected.update(
          (now) =>
            now && { ...now, attributes: { ...now.attributes, ...attributes } },
        );
      }
      this.listDoc.update(
        (doc) =>
          doc && {
            ...doc,
            data: doc.data.map((item) =>
              item.id === cs.id
                ? { ...item, attributes: { ...item.attributes, ...attributes } }
                : item,
            ),
          },
      );
    };
    shown(change);
    const renamed = await this.session.rename(cs.id, change, (done) => {
      // From the toast's retry as well: the page shows what the API answered.
      if (this.selected()?.id === cs.id) this.selected.set(done);
      this.reloadList();
    });
    if (!renamed) {
      shown({
        title: cs.attributes.title,
        description: cs.attributes.description,
      });
    }
  }

  /**
   * Takes one module or manual out of the change set shown: asks first, naming it and saying
   * what is lost (nothing here brings it back), then puts it back as it is on the base, taking
   * its lock again only when the change set lost it. The diff shows the rest; a refusal says why.
   */
  protected takeOut(change: ChangeSetChange): void {
    const cs = this.selected();
    if (!cs || this.takeOutBlocked()) return;
    const name = this.summaryOf(change)?.title || this.subjectId(change);
    const params = { name, ref: this.lines.label(cs.attributes.baseRef) };
    this.dialogs.confirm({
      zTitle: this.t('editor.review.takeOut.title', params),
      zDescription: this.t(TAKE_OUT_TEXT[change.meta.change], params),
      zOkText: this.t('editor.review.takeOut.confirm'),
      zOkDestructive: change.meta.change !== 'removed',
      zOnOk: () => void this.takeOutNow(cs, change, name),
    });
  }

  private async takeOutNow(
    cs: ChangeSet,
    change: ChangeSetChange,
    name: string,
  ): Promise<void> {
    const subject = change.attributes.subject;
    this.takingOut.set(change.id);
    const revert = () =>
      firstValueFrom(
        this.api.act(
          '/change-sets/{changeSetId}/reverts',
          { path: { changeSetId: cs.id } },
          { data: { type: 'Revert', attributes: { subjects: [subject] } } },
        ),
      );
    try {
      try {
        await revert();
      } catch (error) {
        // The lock lapsed or was taken over: take it (back) and try once more. Asked for only
        // then, since one the change set deleted may be out of the actor's scope to lock anew.
        if (toApiError(error).code !== 'lock-required') throw error;
        await firstValueFrom(
          this.api.post(
            '/change-sets/{changeSetId}/locks',
            { data: { type: 'Lock', attributes: { subject } } },
            { path: { changeSetId: cs.id } },
          ),
        );
        await revert();
      }
      this.toast.success(translated('editor.review.takeOut.done', { name }));
      this.reloadChanges();
      this.reloadList();
    } catch (error) {
      const failure = toApiError(error);
      this.toast.error(
        this.failureText(
          translated('editor.review.takeOut.failed', { name }),
          failure,
        ),
        retryable(failure)
          ? {
              actionLabel: translated('editor.session.retry'),
              onAction: () => {
                if (this.selected()?.id === cs.id && !this.takeOutBlocked()) {
                  void this.takeOutNow(cs, change, name);
                }
              },
            }
          : {},
      );
      // What the API knows now (submitted meanwhile, say).
      if (this.selected()?.id === cs.id) void this.loadSelected(cs.id);
      this.reloadChanges();
    } finally {
      this.takingOut.set(null);
    }
  }

  /**
   * A toast's Retry, for the change set that failed only: with another one chosen since, it is
   * shown again rather than acted on, so nothing is approved or merged unseen.
   */
  private retry(name: TransitionName, text: string, id: string): void {
    if (this.selectedId() === id && this.selected()?.id === id) {
      void this.run(name, text);
      return;
    }
    this.view$.set({ cs: id, ...CHANGE_SET_PARAMS_BUT_CS });
  }

  /** "Carry forward to current" (#250): the new draft on main opens in the review. */
  protected carryForward(cs: ChangeSet): Promise<string | null> {
    return this.carry.carry({
      id: cs.id,
      title: cs.attributes.title,
      baseRef: cs.attributes.baseRef,
    });
  }

  /** Shows another change set (the one superseding it, #471), in the list of drafts. */
  protected openChangeSet(id: string): void {
    this.view$.set({
      state: 'draft',
      page: 1,
      cs: id,
      ...CHANGE_SET_PARAMS_BUT_CS,
    });
  }

  protected asChangeSet(item: unknown): ChangeSet {
    return item as ChangeSet;
  }

  protected asChange(item: unknown): ChangeSetChange {
    return item as ChangeSetChange;
  }

  /**
   * Its author is a contributor (#137): a person whose roles hold neither `content.review` nor
   * `content.approve`, as `GET /me` (the person themself) or the users the API lists
   * (`GET /demo/users`, their `meta.permissions`) say; unknown (no list outside demo mode) is
   * no label.
   */
  protected byContributor(cs: ChangeSet): boolean {
    const author = cs.attributes.author;
    if (author.kind !== 'user') return false;
    const me = this.me.me();
    const permissions =
      me.kind === 'user' && me.id === author.id
        ? me.permissions
        : this.demo.users().find((u) => u.id === author.id)?.permissions;
    return permissions !== undefined && contributesOnly(permissions);
  }

  protected authorOf(cs: ChangeSet): string {
    return this.nameOf(cs.attributes.author.kind, cs.attributes.author.id);
  }

  protected statusOf(cs: ChangeSet): ContentStatus {
    const state = cs.attributes.state;
    return state === 'merged'
      ? 'released'
      : state === 'abandoned'
        ? 'deprecated'
        : state;
  }
}
