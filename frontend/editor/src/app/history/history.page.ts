import type { LocalizedText } from '@openfolia/content-model/core';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { TranslocoPipe } from '@jsverse/transloco';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideRotateCcw } from '@ng-icons/lucide';
import { firstValueFrom, map } from 'rxjs';

import { ZardButtonComponent } from '@openfolia/ui/button';
import { injectTranslate } from '@openfolia/ui/i18n';
import { type ListFrameError } from '@openfolia/ui/list-frame';
import {
  SegmentedComponent,
  type SegmentedOption,
} from '@openfolia/ui/segmented';
import { PageHelpComponent } from '@openfolia/ui/shell';
import { FadeInDirective, RefreshingDirective } from '@openfolia/ui/smooth';
import {
  ErrorStateComponent,
  NoAccessStateComponent,
  SkeletonRowsComponent,
} from '@openfolia/ui/states';

import {
  ApiClient,
  ReadRef,
  toApiError,
  type ApiError,
  type Schema,
} from '../api';
import { apiErrorText, UiTexts } from '../i18n';
import { ImageSources } from '../images/image-sources';
import { GuardDirective } from '../permissions/guard.directive';
import { MeService } from '../permissions/me';
import { PermissionService } from '../permissions/permission.service';
import {
  compareManual,
  ManualDiffBodyComponent,
  type ManualSides,
} from '../review/manual-diff-body.component';
import {
  compareModule,
  ModuleDiffBodyComponent,
  type DiffView,
  type ModuleSides,
} from '../review/module-diff-body.component';
import { ReviewComments } from '../review/review-comments';
import { ReviewContext } from '../review/review-context';
import { ChangeSetSession } from '../session/change-set-session';
import { ChangeSetUrl } from '../session/change-set-url';
import {
  idParam,
  injectQueryState,
  intParam,
  listParam,
  oneOfParam,
} from '../view-state';
import { HistoryListComponent, type RowLink } from './history-list.component';
import {
  injectPersonName,
  loadHistory,
  revisionOf,
  shortCommit,
  subjectKeyOf,
  versionBefore,
  type HistorySubject,
  type ModuleVersion,
  type ModuleVersionPage,
} from './history-model';
import { VersionRestore } from './version-restore';

const COMMIT = /^[0-9a-f]{40}$/;
/** A run of unchanged blocks opened (`?open=`): its first block's ID. */
const RUN = /^[A-Za-z0-9_:.-]{1,200}$/;
/** At most this many opened runs are kept in the address. */
const MAX_OPEN = 32;
/** Two columns do not fit a phone: side by side is offered from a wider screen on. */
const NARROW = '(max-width: 767px)';

/** The diff views as the address names them (`?diff=`), as on the review screen. */
const DIFF_PARAMS = {
  inline: undefined,
  side: 'side-by-side',
  rendered: 'rendered',
} as const satisfies Readonly<Record<DiffView, string | undefined>>;

const HISTORY_PARAMS = {
  /** The version shown (a commit); the newest when left out. */
  version: idParam(COMMIT),
  /** The version it is compared against; the one before it when left out. */
  base: idParam(COMMIT),
  diff: oneOfParam(['side-by-side', 'rendered'] as const),
  page: intParam(1, { min: 1 }),
  open: listParam(RUN, { max: MAX_OPEN }),
};

/** A side of the comparison: the version, or its commit alone when it is not on the page. */
interface Side {
  readonly commit: string;
  readonly version: ModuleVersion | null;
}

/** What is compared: from `base` to `head`, the version shown. */
interface Pair {
  readonly base: Side | null;
  readonly head: Side;
  /** Whether `base` is known: chosen, or the version before read (null: there is none). */
  readonly settled: boolean;
}

/**
 * Where a side is read: a manual's version names the commit to read it at (`meta.readAt`, #410:
 * for a reader of released content only, the released commit holding it), else its own commit.
 */
function readAt(side: Side): string {
  const meta = side.version?.meta;
  return meta && 'readAt' in meta ? meta.readAt : side.commit;
}

function sameSide(a: Side | null, b: Side | null): boolean {
  return (
    a === b || (!!a && !!b && a.commit === b.commit && a.version === b.version)
  );
}

/** Pairs naming the same versions: no comparison read again. */
function samePair(a: Pair | null, b: Pair | null): boolean {
  return (
    a === b ||
    (!!a &&
      !!b &&
      a.settled === b.settled &&
      sameSide(a.base, b.base) &&
      sameSide(a.head, b.head))
  );
}

/** The two versions read: a module's or a manual's sides. */
type Compared = {
  readonly key: string;
  readonly base: string;
  readonly head: string;
} & (
  | { readonly kind: 'module'; readonly sides: ModuleSides }
  | { readonly kind: 'manual'; readonly sides: ManualSides }
);

/**
 * Screen 13, a module's history at `/content/:lang/:moduleId/history`, and a manual's (#321) at
 * `/manuals/:manualId/history`: its versions on the left (the chosen change set's branch, else
 * `main`), the chosen version compared with another on the right (`GET …/compare`), drawn by the
 * review screen's own diff (`of-module-diff-body` in its three views, `of-manual-diff-body`
 * for a manual's details and outline), without comments. "Restore … as draft" (`content.edit`)
 * puts the shown version into a working copy (`VersionRestore`). The version, the one it is
 * compared against, the view, the page and the runs opened are in the address.
 */
@Component({
  selector: 'of-history-page',
  imports: [
    RouterLink,
    PageHelpComponent,
    TranslocoPipe,
    NgIcon,
    ErrorStateComponent,
    NoAccessStateComponent,
    FadeInDirective,
    RefreshingDirective,
    SegmentedComponent,
    SkeletonRowsComponent,
    ZardButtonComponent,
    GuardDirective,
    HistoryListComponent,
    ManualDiffBodyComponent,
    ModuleDiffBodyComponent,
  ],
  providers: [ReviewContext, ReviewComments, ImageSources],
  viewProviders: [provideIcons({ lucideRotateCcw })],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'flex min-w-0 flex-col gap-4' },
  template: `
    <header class="flex flex-wrap items-end justify-between gap-3">
      <div class="flex min-w-0 flex-col gap-1">
        <a
          class="text-muted-foreground hover:text-foreground focus-visible:ring-ring w-fit rounded-sm text-sm break-words outline-none focus-visible:ring-2"
          [routerLink]="subjectLink().path"
          [queryParams]="subjectLink().query"
          data-slot="history-module"
          >{{ title() || subjectId() }}</a
        >
        <div class="flex min-w-0 items-center gap-2.5">
          <h1 class="m-0 text-2xl/8 font-medium">
            {{ 'editor.history.title' | transloco }}
          </h1>
          <!-- The history's page of the user guide (issue 221). -->
          <of-page-help />
        </div>
      </div>
      <!-- A contributor (suggestsOnly) only suggests, in their own suggestion: no Restore. -->
      @if (!suggestsOnly() && pair(); as p) {
        <button
          z-button
          zType="outline"
          type="button"
          data-slot="history-restore"
          [ofGuard]="{
            permission: 'content.edit',
            blockedReason: restoreBlocked(),
          }"
          (click)="restoreShown()"
        >
          <ng-icon
            name="lucideRotateCcw"
            data-icon="inline-start"
            aria-hidden="true"
          />
          {{
            'editor.history.restore.action'
              | transloco: { revision: sideLabel(p.head, true) }
          }}
        </button>
      }
    </header>

    @if (releasedOnly()) {
      <p
        class="text-muted-foreground m-0 text-sm"
        data-slot="history-released-only"
      >
        {{ 'editor.history.releasedOnly' | transloco }}
      </p>
    }

    <div class="flex min-w-0 flex-col gap-4 lg:flex-row lg:items-start">
      <of-history-list
        class="w-full shrink-0 lg:w-[22rem]"
        [doc]="doc()"
        [loading]="loading()"
        [error]="listError()"
        offset="16rem"
        [selectedCommit]="pair()?.head?.commit ?? null"
        [baseCommit]="pair()?.base?.commit ?? null"
        [rowLink]="rowLink"
        [compareLink]="compareLink"
        [pageLink]="choosePage"
        [retry]="reload"
        [nameOf]="nameOf"
      />

      <section
        class="border-border flex min-w-0 flex-1 flex-col overflow-hidden rounded-2xl border"
        [attr.aria-label]="'editor.history.compare.label' | transloco"
        data-slot="history-compare-view"
      >
        <header
          class="border-border flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3"
        >
          <h2 class="m-0 text-base leading-6 font-semibold break-words">
            @if (pair(); as p) {
              @if (p.base) {
                {{
                  'editor.history.compare.heading'
                    | transloco
                      : { base: sideLabel(p.base), head: sideLabel(p.head) }
                }}
              } @else {
                {{ sideLabel(p.head) }}
              }
            } @else {
              {{ 'editor.history.compare.label' | transloco }}
            }
          </h2>
          @if (subject().type === 'module') {
            <of-segmented
              [label]="'editor.review.view.label' | transloco"
              [options]="viewOptions()"
              [value]="shownView()"
              (valueChange)="chooseView($event)"
            />
          }
        </header>
        <div
          class="min-w-0 px-4 py-6 sm:px-8"
          [ofRefreshing]="comparing() && compared() !== null"
        >
          @if (compareFailure(); as f) {
            @if (f.kind === 'unauthorized' || f.status === 404) {
              <of-no-access
                [heading]="'editor.history.compare.noAccess' | transloco"
              />
            } @else {
              <of-error-state
                [kind]="f.kind"
                [message]="failureText(f)"
                (retry)="compareAgain()"
              />
            }
          } @else if (compared(); as c) {
            @if (c.kind === 'module') {
              <of-module-diff-body
                ofFadeIn
                [key]="c.key"
                [lang]="lang()"
                [moduleId]="subjectId()"
                [sides]="c.sides"
                [comparison]="moduleComparison()!"
                [base]="c.base"
                [head]="c.head"
                [view]="shownView()"
                [open]="openRuns()"
                [beforeLabel]="baseLabel()"
                [afterLabel]="headLabel()"
                (toggled)="toggleRun($event)"
              />
            } @else {
              @if (manualComparison(); as mc) {
                <of-manual-diff-body
                  ofFadeIn
                  [key]="c.key"
                  [lang]="sourceLang()"
                  [comparison]="mc"
                  [base]="c.base"
                  [head]="c.head"
                  [open]="openRuns()"
                  (toggled)="toggleRun($event)"
                />
              }
            }
          } @else if (comparing() || loading()) {
            <of-skeleton-rows
              [count]="4"
              [label]="'editor.review.diff.loading' | transloco"
            />
          } @else if (!pair()) {
            <p class="text-muted-foreground m-0 text-sm">
              {{ 'editor.history.compare.none' | transloco }}
            </p>
          }
        </div>
      </section>
    </div>
  `,
})
export class HistoryPage {
  private readonly api = inject(ApiClient);
  private readonly texts = inject(UiTexts);
  private readonly readRef = inject(ReadRef);
  private readonly me = inject(MeService);
  private readonly review = inject(ReviewContext);
  private readonly changeSets = inject(ChangeSetSession);
  private readonly restorer = inject(VersionRestore);
  protected readonly suggestsOnly = inject(PermissionService).suggestsOnly;
  private readonly route = inject(ActivatedRoute);
  private readonly t = injectTranslate();
  protected readonly csLink = inject(ChangeSetUrl);
  protected readonly nameOf = injectPersonName();
  private readonly query = injectQueryState(HISTORY_PARAMS);

  /** A module's history (`:lang/:moduleId`), or a manual's (`:manualId`). */
  protected readonly subject = toSignal(
    this.route.paramMap.pipe(
      map((p): HistorySubject => {
        const manualId = p.get('manualId');
        return manualId !== null
          ? { type: 'manual', manualId }
          : {
              type: 'module',
              lang: p.get('lang') ?? '',
              moduleId: p.get('moduleId') ?? '',
            };
      }),
    ),
    {
      initialValue: { type: 'module', lang: '', moduleId: '' },
      equal: (a, b) => subjectKeyOf(a) === subjectKeyOf(b),
    },
  );
  /** The module's language; '' for a manual. */
  protected readonly lang = computed(() => {
    const s = this.subject();
    return s.type === 'module' ? s.lang : '';
  });
  /** The module's or manual's ID. */
  protected readonly subjectId = computed(() => {
    const s = this.subject();
    return s.type === 'module' ? s.moduleId : s.manualId;
  });
  /**
   * A manual's history read by someone without `content.read.draft` lists only released versions
   * (#410): said above the list.
   */
  protected readonly releasedOnly = computed(
    () =>
      this.subject().type === 'manual' &&
      !this.me.me().permissions.has('content.read.draft'),
  );
  /** Module titles in a manual's outline are read in the source language. */
  protected readonly sourceLang = computed(
    () => this.review.config()?.languages.source ?? 'en',
  );
  /** Where the title leads: the module editor, or the manual builder on the manual. */
  protected readonly subjectLink = computed(() => {
    const s = this.subject();
    const cs = this.csLink.params();
    return s.type === 'module'
      ? { path: ['/content', s.lang, s.moduleId], query: cs }
      : { path: ['/manuals'], query: { ...cs, manual: s.manualId } };
  });

  protected readonly doc = signal<ModuleVersionPage | null>(null);
  protected readonly loading = signal(true);
  private readonly failure = signal<ApiError | null>(null);
  private readonly reloads = signal(0);
  /** The subject's title as read (its newest version's, at the branch); '' until known. */
  private readonly storedTitle = signal<LocalizedText>('');
  /** The title shown: a manual's may be one per language (#731), shown in the interface language. */
  protected readonly title = computed(() =>
    this.texts.text(this.storedTitle()),
  );

  protected readonly listError = computed((): ListFrameError | null => {
    const f = this.failure();
    return f ? { kind: f.kind, message: this.failureText(f) } : null;
  });

  /** The versions of the page shown, newest first. */
  private readonly versions = computed(() => this.doc()?.data ?? []);
  /** Every version read so far, by commit (a chosen one may be on another page). */
  private readonly seen = signal<ReadonlyMap<string, ModuleVersion>>(new Map());
  private remember(versions: readonly ModuleVersion[]): void {
    this.seen.update((m) => {
      const next = new Map(m);
      for (const v of versions) next.set(v.attributes.commit, v);
      return next;
    });
  }

  /**
   * The version before each version shown, by its commit (null: there is none, or it could not
   * be read), for when the address names no base; read when off the page.
   */
  private readonly before = signal<ReadonlyMap<string, ModuleVersion | null>>(
    new Map(),
  );
  /** The module `seen` and `before` hold versions of. */
  private versionsOf = '';
  /** The newest version's commit at the branch read (null: none; undefined: not known yet). */
  private readonly newest = signal<string | null | undefined>(undefined);

  /** The two versions compared: the version shown (`head`) and the one before or chosen. */
  protected readonly pair = computed(
    (): Pair | null => {
      const versions = this.versions();
      const wanted = this.query.get('version')();
      const headCommit = wanted ?? versions[0]?.attributes.commit;
      if (!headCommit) return null;
      const seen = this.seen();
      // Read so far, else on the page shown (`seen` is emptied while another branch is read).
      const versionOf = (commit: string): ModuleVersion | null =>
        seen.get(commit) ??
        versions.find((v) => v.attributes.commit === commit) ??
        null;
      const head: Side = {
        commit: headCommit,
        version: versionOf(headCommit),
      };
      const chosenBase = this.query.get('base')();
      if (chosenBase && chosenBase !== headCommit) {
        const base: Side = {
          commit: chosenBase,
          version: versionOf(chosenBase),
        };
        // From the chosen version to the version shown, as the address names them: the diff
        // reads as what the shown version changed against the chosen one.
        return { base, head, settled: true };
      }
      const before = this.before().get(headCommit);
      if (before) {
        return {
          base: { commit: before.attributes.commit, version: before },
          head,
          settled: true,
        };
      }
      return { base: null, head, settled: this.before().has(headCommit) };
    },
    { equal: samePair },
  );

  protected readonly compared = signal<Compared | null>(null);
  protected readonly comparing = signal(false);
  protected readonly compareFailure = signal<ApiError | null>(null);
  private readonly compareRuns = signal(0);

  protected readonly moduleComparison = computed(() => {
    const c = this.compared();
    return c?.kind === 'module'
      ? compareModule(c.sides, this.review.config())
      : null;
  });
  protected readonly manualComparison = computed(() => {
    const c = this.compared();
    return c?.kind === 'manual'
      ? compareManual(c.sides, this.review.config())
      : null;
  });

  protected readonly openRuns = computed(
    (): ReadonlySet<string> => new Set(this.query.get('open')()),
  );

  protected readonly narrow = signal(false);
  protected readonly view = computed((): DiffView => {
    const diff = this.query.get('diff')();
    return diff === 'side-by-side'
      ? 'side'
      : diff === 'rendered'
        ? 'rendered'
        : 'inline';
  });
  /** The view drawn: side by side falls back to inline on a narrow screen. */
  protected readonly shownView = computed((): DiffView =>
    this.narrow() && this.view() === 'side' ? 'inline' : this.view(),
  );
  protected readonly viewOptions = computed((): SegmentedOption[] => [
    { value: 'inline', label: this.t('editor.review.view.inline') },
    ...(this.narrow()
      ? []
      : [{ value: 'side', label: this.t('editor.review.view.side') }]),
    { value: 'rendered', label: this.t('editor.review.view.rendered') },
  ]);

  protected readonly baseLabel = computed(() => {
    const p = this.pair();
    return p?.base ? this.sideLabel(p.base) : null;
  });
  protected readonly headLabel = computed(() => {
    const p = this.pair();
    return p ? this.sideLabel(p.head) : null;
  });

  /** The lock another change set holds on the module, if the person may know of it. */
  private readonly lockedElsewhere = signal(false);

  /** Why Restore is blocked now (a translation key), or null. */
  protected readonly restoreBlocked = computed((): string | null => {
    if (this.restorer.busy()) return 'editor.history.restore.busy';
    if (this.changeSets.switching()) return 'editor.changeSet.switchingReason';
    const listed = this.changeSets.status();
    if (listed === 'error') return 'editor.history.restore.changeSetsFailed';
    if (listed !== 'ready') return 'editor.history.restore.changeSets';
    const head = this.pair()?.head;
    const version = head?.version;
    if (!version) return 'editor.history.restore.loading';
    if (version.meta.unreadable) return 'editor.history.restore.unreadable';
    const manual = this.subject().type === 'manual';
    if (version.meta.change === 'removed') {
      return manual
        ? 'editor.history.restore.removedManualVersion'
        : 'editor.history.restore.removedVersion';
    }
    const newest = this.newest();
    if (newest === undefined) return 'editor.history.restore.loading';
    if (newest === version.attributes.commit) {
      return 'editor.history.restore.current';
    }
    if (this.lockedElsewhere()) {
      return manual
        ? 'editor.history.restore.lockedElsewhereManual'
        : 'editor.history.restore.lockedElsewhere';
    }
    return null;
  });

  protected readonly rowLink: RowLink = (version) => ({
    path: [],
    query: { version: version.attributes.commit, base: null, open: null },
    merge: true,
  });
  protected readonly compareLink: RowLink = (version) => ({
    path: [],
    query: {
      base: version.attributes.commit,
      version: this.pair()?.head.commit ?? null,
      open: null,
    },
    merge: true,
  });
  protected readonly choosePage = (page: number): void =>
    this.query.set({ page });
  protected readonly reload = (): void => this.reloads.update((n) => n + 1);

  constructor() {
    const destroyRef = inject(DestroyRef);
    const narrowQuery = window.matchMedia?.(NARROW);
    const onNarrow = () => this.narrow.set(!!narrowQuery?.matches);
    onNarrow();
    narrowQuery?.addEventListener('change', onNarrow);
    destroyRef.onDestroy(() =>
      narrowQuery?.removeEventListener('change', onNarrow),
    );

    void this.loadConfig();
    // The page of versions: again for another module, page, branch or person.
    effect(() => {
      const subject = this.subject();
      const page = this.query.get('page')();
      const ref = this.readRef.ref();
      const me = this.me.me();
      this.readRef.moves();
      this.reloads();
      if (!this.subjectId() || (subject.type === 'module' && !subject.lang)) {
        return;
      }
      // What is read, and by whom: versions read for another are not shown again.
      const key = `${subjectKeyOf(subject)}@${ref ?? ''}#${me.kind}:${me.id}`;
      untracked(() => void this.loadPage(subject, page, key));
    });
    // The version before the shown one, when the address names no base.
    effect(() => {
      const doc = this.doc();
      const head =
        this.query.get('version')() ?? doc?.data[0]?.attributes.commit;
      if (!doc || !head || this.query.get('base')()) return;
      untracked(() => void this.loadBefore(doc, head));
    });
    // The comparison of the pair.
    effect(() => {
      const pair = this.pair();
      this.compareRuns();
      untracked(() => void this.compare(pair));
    });
    // Whether another change set holds the module's lock.
    effect(() => {
      const subject = this.subject();
      this.changeSets.value();
      this.changeSets.options();
      this.changeSets.status();
      this.me.me();
      if (!this.subjectId()) return;
      untracked(() => void this.loadLock(subject));
    });
  }

  /** A side's name: "v3", or (`full`) "version 3" for running text. */
  protected sideLabel(side: Side, full = false): string {
    if (!side.version) {
      return this.t('editor.history.commit', {
        commit: shortCommit(side.commit),
      });
    }
    const r = revisionOf(side.version, full);
    return this.t(r.key, r.params);
  }

  protected failureText(error: ApiError): string {
    const text = apiErrorText(error);
    return this.t(text.key, text.params);
  }

  protected chooseView(value: string): void {
    if (value === 'inline' || value === 'side' || value === 'rendered') {
      this.query.set({ diff: DIFF_PARAMS[value] });
    }
  }

  protected toggleRun(run: string): void {
    const open = this.query.get('open')();
    const next = open.includes(run)
      ? open.filter((v) => v !== run)
      : [...open, run].slice(-MAX_OPEN);
    this.query.set({ open: next }, { replace: true });
  }

  protected compareAgain(): void {
    this.compareRuns.update((n) => n + 1);
  }

  protected restoreShown(): void {
    const head = this.pair()?.head;
    if (!head?.version || this.restoreBlocked() || this.suggestsOnly()) return;
    void this.restorer.restore({
      subject: this.subject(),
      // Where the version is read (`meta.readAt`): its own commit for a reader of drafts.
      commit: readAt(head),
      label: this.sideLabel(head, true),
      title: this.title() || this.subjectId(),
    });
  }

  private async loadConfig(): Promise<void> {
    try {
      const doc = await firstValueFrom(this.api.get('/config'));
      this.review.storedConfig.set(doc.data.attributes);
    } catch {
      // Labels fall back to the IDs.
    }
  }

  private pageRuns = 0;
  private async loadPage(
    subject: HistorySubject,
    page: number,
    key: string,
  ): Promise<void> {
    const run = ++this.pageRuns;
    if (this.versionsOf !== key) {
      // Another module, branch or person: the versions read so far are not this one's.
      this.versionsOf = key;
      this.seen.set(new Map());
      this.before.set(new Map());
      this.newest.set(undefined);
    }
    this.loading.set(true);
    this.failure.set(null);
    try {
      const doc = await loadHistory(this.api, subject, page);
      if (run !== this.pageRuns) return;
      // A page past the end (a shorter history now): the last one instead.
      const last = Math.max(1, doc.meta.page.lastPage);
      if (page > last) {
        this.query.set({ page: last }, { replace: true });
        return;
      }
      this.remember(doc.data);
      this.doc.set(doc);
      if (page === 1) {
        this.newest.set(doc.data[0]?.attributes.commit ?? null);
      } else if (this.newest() === undefined) {
        void this.loadNewest(subject, key);
      }
      // A version the address names that was never read (no version of this module, or one on
      // a page not opened here): the newest is shown instead. One read on another page stays.
      const wanted = this.query.get('version')();
      if (wanted && !this.seen().has(wanted)) {
        this.query.set(
          { version: undefined, base: undefined, open: [] },
          { replace: true },
        );
      }
      if (page === 1) void this.loadTitle(subject, doc);
    } catch (error) {
      if (run !== this.pageRuns) return;
      this.doc.set(null);
      this.failure.set(toApiError(error));
    } finally {
      if (run === this.pageRuns) this.loading.set(false);
    }
  }

  /** The newest version's commit, for a page other than the first. */
  private async loadNewest(
    subject: HistorySubject,
    key: string,
  ): Promise<void> {
    try {
      const one = await loadHistory(this.api, subject, 1, 1);
      if (this.versionsOf !== key) return;
      this.newest.set(one.data[0]?.attributes.commit ?? null);
    } catch {
      // Restore stays blocked as loading; the next page read tries again.
    }
  }

  /** The title of the newest version that has it (a deleted one: the one before). */
  private async loadTitle(
    subject: HistorySubject,
    doc: ModuleVersionPage,
  ): Promise<void> {
    const version = doc.data.find((v) => v.meta.change !== 'removed');
    if (!version) return;
    const ref = readAt({ commit: version.attributes.commit, version });
    try {
      const title =
        subject.type === 'module'
          ? (
              await firstValueFrom(
                this.api.get('/modules/{lang}/{id}', {
                  path: { lang: subject.lang, id: subject.moduleId },
                  query: { ref },
                }),
              )
            ).data.attributes.title
          : (
              await firstValueFrom(
                this.api.get('/manuals/{id}', {
                  path: { id: subject.manualId },
                  query: { ref },
                }),
              )
            ).data.attributes.title;
      if (subjectKeyOf(this.subject()) === subjectKeyOf(subject)) {
        this.storedTitle.set(title);
      }
    } catch {
      // The ID stands in.
    }
  }

  private async loadBefore(
    doc: ModuleVersionPage,
    head: string,
  ): Promise<void> {
    const at = doc.data.findIndex((v) => v.attributes.commit === head);
    const read = this.before();
    // Read once; one found missing only off its page is read again on it.
    if (read.get(head) || (read.has(head) && at < 0)) return;
    const subject = this.versionsOf;
    const known = (version: ModuleVersion | null) => {
      // A module left meanwhile: its versions are not this one's.
      if (this.versionsOf !== subject) return;
      if (version) this.remember([version]);
      this.before.update((m) => new Map(m).set(head, version));
    };
    if (at < 0) {
      // On another page: the version before is not known here; it is shown on its own.
      known(null);
      return;
    }
    const page = doc.meta.page;
    const index = (page.currentPage - 1) * page.perPage + at;
    try {
      const version = await versionBefore(this.api, this.subject(), doc, index);
      known(version);
    } catch {
      // Compared with nothing: the version is shown on its own.
      known(null);
    }
  }

  private compareRun = 0;
  private async compare(pair: Pair | null): Promise<void> {
    const run = ++this.compareRun;
    this.compareFailure.set(null);
    if (!pair) {
      this.compared.set(null);
      this.comparing.set(false);
      return;
    }
    // The pair is complete once the version before is known (or there is none).
    if (!pair.settled) {
      this.comparing.set(true);
      return;
    }
    const subject = this.subject();
    this.comparing.set(true);
    try {
      const compared = await this.read(subject, pair);
      if (run !== this.compareRun) return;
      this.compared.set(compared);
    } catch (error) {
      if (run !== this.compareRun) return;
      this.compared.set(null);
      this.compareFailure.set(toApiError(error));
    } finally {
      if (run === this.compareRun) this.comparing.set(false);
    }
  }

  /** The two sides of `pair`: compared, or the oldest version on its own (all of it added). */
  private async read(subject: HistorySubject, pair: Pair): Promise<Compared> {
    const key = subjectKeyOf(subject);
    const head = pair.head.commit;
    if (subject.type === 'module') {
      const path = { lang: subject.lang, id: subject.moduleId };
      if (pair.base) {
        const doc = await firstValueFrom(
          this.api.get('/modules/{lang}/{id}/compare', {
            path,
            query: { base: pair.base.commit, head },
          }),
        );
        return {
          kind: 'module',
          key,
          sides: {
            before: doc.data.attributes.base,
            after: doc.data.attributes.head,
          },
          base: doc.data.meta.base,
          head: doc.data.meta.head,
        };
      }
      const doc = await firstValueFrom(
        this.api.get('/modules/{lang}/{id}', { path, query: { ref: head } }),
      );
      return {
        kind: 'module',
        key,
        sides: { before: null, after: doc.data.attributes },
        base: head,
        head,
      };
    }
    const path = { id: subject.manualId };
    const headAt = readAt(pair.head);
    if (pair.base) {
      const doc = await firstValueFrom(
        this.api.get('/manuals/{id}/compare', {
          path,
          query: { base: readAt(pair.base), head: headAt },
        }),
      );
      return {
        kind: 'manual',
        key,
        sides: {
          before: doc.data.attributes.base,
          after: doc.data.attributes.head,
        },
        base: doc.data.meta.base,
        head: doc.data.meta.head,
      };
    }
    const doc = await firstValueFrom(
      this.api.get('/manuals/{id}', { path, query: { ref: headAt } }),
    );
    return {
      kind: 'manual',
      key,
      sides: { before: null, after: doc.data.attributes },
      base: headAt,
      head: headAt,
    };
  }

  private lockRuns = 0;
  private async loadLock(subject: HistorySubject): Promise<void> {
    const run = ++this.lockRuns;
    try {
      const page = await firstValueFrom(
        this.api.get('/locks', {
          query: {
            'filter[subject]': subjectKeyOf(subject),
            'page[size]': 1,
          },
        }),
      );
      if (run !== this.lockRuns) return;
      const open = this.restorer.openChangeSet();
      this.lockedElsewhere.set(
        page.data.some(
          (lock: Schema<'LockResource'>) =>
            lock.relationships.changeSet.data.id !== open,
        ),
      );
    } catch {
      // Not known: the restore itself says so if a lock is in the way.
      if (run === this.lockRuns) this.lockedElsewhere.set(false);
    }
  }
}
