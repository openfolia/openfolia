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
import { Router, RouterLink } from '@angular/router';
import { TranslocoPipe } from '@jsverse/transloco';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideCircleX,
  lucideRotateCcw,
  lucideTriangleAlert,
} from '@ng-icons/lucide';
import { firstValueFrom } from 'rxjs';

import { ZardBadgeComponent } from '@openfolia/ui/badge';
import { ZardButtonComponent } from '@openfolia/ui/button';
import { injectTranslate, LanguageService } from '@openfolia/ui/i18n';
import {
  ListFrameComponent,
  ListTableDirective,
} from '@openfolia/ui/list-frame';
import {
  SegmentedComponent,
  type SegmentedOption,
} from '@openfolia/ui/segmented';
import { PageHeaderComponent } from '@openfolia/ui/shell';
import { ZardSkeletonComponent } from '@openfolia/ui/skeleton';
import { FadeInDirective, RefreshingDirective } from '@openfolia/ui/smooth';
import { EmptyStateComponent } from '@openfolia/ui/states';
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
import { apiErrorText, UiTexts } from '../i18n';
import { GuardDirective } from '../permissions/guard.directive';
import { MeService } from '../permissions/me';
import { ChangeSetSession } from '../session/change-set-session';
import { ChangeSetUrl } from '../session/change-set-url';
import { isChangeSetId } from '../session/change-set-id';
import { idParam, injectQueryState, intParam, oneOfParam } from '../view-state';
import {
  CHECK_PAGE_SIZES,
  CHECK_SEVERITIES,
  CHECK_TITLES,
  detailOf,
  fixLinkOf,
  groupChecks,
  MANUAL_ID,
  type CheckGroup,
  type CheckItem,
  type CheckSeverity,
  type Text,
} from './checks-model';

type CheckDoc = Response<'/manuals/{id}/checks'>;

/** What is checked: a manual (at the chosen change set, or the released content), or a change set. */
type Scope =
  | { readonly kind: 'manual'; readonly id: string; readonly ref: string }
  | {
      readonly kind: 'change-set';
      readonly id: string;
      /** Named by the page's own `?changeSet=` (the review screen's), not the session's choice. */
      readonly own: boolean;
    };

const sameScope = (a: Scope | null, b: Scope | null): boolean =>
  a === b ||
  (a !== null &&
    b !== null &&
    a.kind === b.kind &&
    a.id === b.id &&
    (a.kind === 'manual'
      ? b.kind === 'manual' && a.ref === b.ref
      : b.kind === 'change-set' && a.own === b.own));

/** Space kept below the frame: the note under it and the page's bottom padding. */
const BELOW_FRAME_PX = 72;

/**
 * Screen 14, the checks before review or release (`/checks`): the blocking issues and warnings of
 * a manual (`?manual=`, read at the chosen change set) or, without one, of what the chosen change
 * set changes. Counts on top, a severity filter, then the checks by module (the subject named
 * once, above its checks), each with a link to where it is fixed: the module editor at its block
 * (`?block=`), or the manual. Filter, page and size are in the address.
 */
@Component({
  selector: 'of-checks-page',
  imports: [
    RouterLink,
    TranslocoPipe,
    NgIcon,
    PageHeaderComponent,
    ListFrameComponent,
    ListTableDirective,
    EmptyStateComponent,
    SegmentedComponent,
    FadeInDirective,
    RefreshingDirective,
    ZardBadgeComponent,
    ZardButtonComponent,
    ZardSkeletonComponent,
    ZardTableImports,
    GuardDirective,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [
    provideIcons({ lucideCircleX, lucideRotateCcw, lucideTriangleAlert }),
  ],
  host: { class: 'flex min-w-0 flex-col gap-4' },
  template: `
    <div class="flex flex-col gap-1">
      <of-page-header [title]="'editor.checks.title' | transloco">
        @if (scope()) {
          <button
            z-button
            zType="outline"
            type="button"
            [zDisabled]="loading()"
            (click)="runAgain()"
          >
            <ng-icon
              name="lucideRotateCcw"
              data-icon="inline-start"
              strokeWidth="1.5"
              aria-hidden="true"
            />
            {{ 'editor.checks.runAgain' | transloco }}
          </button>
        }
        @if (scope()?.kind === 'manual') {
          <button
            z-button
            type="button"
            [ofGuard]="{
              permission: 'release.publish',
              blockedReason: releaseBlocked(),
            }"
            (click)="createRelease()"
          >
            {{ 'editor.checks.release.create' | transloco }}
          </button>
        }
      </of-page-header>
      @if (scopeText(); as text) {
        <p class="text-muted-foreground m-0 text-sm break-words">
          {{ text }}
        </p>
      }
    </div>

    @if (!scope()) {
      <div class="border-border rounded-xl border">
        <of-empty-state
          [title]="'editor.checks.noScope.title' | transloco"
          [description]="'editor.checks.noScope.description' | transloco"
        />
      </div>
    } @else {
      @let d = doc();
      @if (d) {
        <div
          ofFadeIn
          class="grid grid-cols-3 gap-2 sm:gap-3"
          [ofRefreshing]="loading()"
        >
          <div
            class="bg-destructive-muted flex min-w-0 flex-col gap-1 rounded-xl p-2.5 sm:p-3.5"
          >
            <span
              class="text-destructive text-xl/7 font-medium tabular-nums sm:text-2xl/8"
              >{{ d.meta.counts.blocking }}</span
            >
            <span
              class="flex items-start gap-1.5 text-xs break-words sm:text-sm"
            >
              <ng-icon
                name="lucideCircleX"
                class="text-destructive mt-0.5 shrink-0"
                aria-hidden="true"
              />
              {{
                'editor.checks.summary.blocking'
                  | transloco: { count: d.meta.counts.blocking }
              }}
            </span>
          </div>
          <div
            class="bg-muted flex min-w-0 flex-col gap-1 rounded-xl p-2.5 sm:p-3.5"
          >
            <span
              class="text-warning text-xl/7 font-medium tabular-nums sm:text-2xl/8"
              >{{ d.meta.counts.warning }}</span
            >
            <span
              class="flex items-start gap-1.5 text-xs break-words sm:text-sm"
            >
              <ng-icon
                name="lucideTriangleAlert"
                class="text-warning mt-0.5 shrink-0"
                aria-hidden="true"
              />
              {{
                'editor.checks.summary.warnings'
                  | transloco: { count: d.meta.counts.warning }
              }}
            </span>
          </div>
          <div
            class="bg-success-muted flex min-w-0 flex-col gap-1 rounded-xl p-2.5 sm:p-3.5"
          >
            <span
              class="text-success text-xl/7 font-medium tabular-nums sm:text-2xl/8"
              >{{ d.meta.modules.withoutIssues }}</span
            >
            <span class="text-xs break-words sm:text-sm">{{
              'editor.checks.summary.clean'
                | transloco
                  : {
                      count: d.meta.modules.withoutIssues,
                      checked: d.meta.modules.checked,
                    }
            }}</span>
          </div>
        </div>
      } @else if (loading()) {
        <div
          ofFadeIn="delayed"
          class="grid grid-cols-3 gap-2 sm:gap-3"
          aria-hidden="true"
        >
          @for (tile of [1, 2, 3]; track tile) {
            <div class="bg-muted flex flex-col gap-2 rounded-xl p-2.5 sm:p-3.5">
              <z-skeleton class="h-7 w-10" />
              <z-skeleton class="h-4 w-28" />
            </div>
          }
        </div>
      }

      @if (d || loading()) {
        <of-segmented
          class="self-start"
          [label]="'editor.checks.filter.label' | transloco"
          [options]="severityOptions()"
          [value]="severity() ?? ''"
          (valueChange)="setSeverity($event)"
        />
      }

      <of-list-frame
        #frame
        class="min-h-64 min-w-0"
        [label]="'editor.checks.table.label' | transloco"
        [items]="d?.data ?? []"
        [page]="d?.meta?.page ?? null"
        [loading]="loading()"
        [error]="frameError()"
        [offset]="offset()"
        [pageSizes]="pageSizes"
        [emptyTitle]="emptyTitle() | transloco"
        [emptyDescription]="emptyDescription() | transloco"
        (pageChange)="view.set({ page: $event })"
        (pageSizeChange)="view.set({ size: $event, page: 1 })"
        (retry)="runAgain()"
      >
        <ng-template ofListTable let-items>
          <table z-table class="min-w-[44rem] table-fixed">
            <thead z-table-header class="bg-background sticky top-0 z-10">
              <tr z-table-row>
                <th z-table-head class="w-32">
                  {{ 'editor.checks.table.severity' | transloco }}
                </th>
                <th z-table-head class="w-[28%]">
                  {{ 'editor.checks.table.check' | transloco }}
                </th>
                <th z-table-head>
                  {{ 'editor.checks.table.details' | transloco }}
                </th>
                <th z-table-head class="w-36">
                  <span class="sr-only">{{
                    'editor.checks.table.action' | transloco
                  }}</span>
                </th>
              </tr>
            </thead>
            @for (group of groupsOf(items); track group.key) {
              <tbody z-table-body>
                <tr z-table-row class="bg-muted/40 hover:bg-muted/40">
                  <th
                    z-table-cell
                    colspan="4"
                    scope="rowgroup"
                    class="text-start font-normal whitespace-normal"
                  >
                    <span
                      class="flex flex-wrap items-baseline gap-x-2 gap-y-0.5"
                    >
                      <span class="font-medium break-words">{{
                        groupTitle(group)
                      }}</span>
                      <span
                        class="text-muted-foreground text-xs [overflow-wrap:anywhere]"
                        >{{ groupDetail(group) }}</span
                      >
                      <span class="text-muted-foreground ms-auto text-xs">{{
                        groupCounts(group)
                      }}</span>
                    </span>
                  </th>
                </tr>
                @for (check of group.checks; track check.id) {
                  @let detail = detailText(check);
                  @let fix = fixLinkOf(check);
                  <tr z-table-row>
                    <td z-table-cell class="align-top">
                      @if (check.attributes.severity === 'blocking') {
                        <z-badge zType="destructive">
                          <ng-icon name="lucideCircleX" aria-hidden="true" />
                          {{ 'editor.checks.severity.blocking' | transloco }}
                        </z-badge>
                      } @else {
                        <z-badge zType="warning">
                          <ng-icon
                            name="lucideTriangleAlert"
                            aria-hidden="true"
                          />
                          {{ 'editor.checks.severity.warning' | transloco }}
                        </z-badge>
                      }
                    </td>
                    <td
                      z-table-cell
                      class="align-top font-medium break-words whitespace-normal"
                    >
                      {{ titleKey(check) | transloco }}
                    </td>
                    <td
                      z-table-cell
                      class="text-muted-foreground align-top break-words whitespace-normal [overflow-wrap:anywhere]"
                    >
                      {{ detail.key | transloco: detail.params }}
                      @if (check.meta.variants.length > 0) {
                        <span class="block text-xs">{{
                          'editor.checks.table.inVariants'
                            | transloco
                              : { variants: check.meta.variants.join(', ') }
                        }}</span>
                      }
                    </td>
                    <td z-table-cell class="text-end align-top">
                      <a
                        z-button
                        zType="outline"
                        zSize="sm"
                        [routerLink]="fix.commands"
                        [queryParams]="linkParams(fix.query)"
                        [attr.aria-label]="actionLabel(check, group)"
                        >{{
                          (check.attributes.blockId
                            ? 'editor.checks.action.goToBlock'
                            : 'editor.checks.action.open'
                          ) | transloco
                        }}</a
                      >
                    </td>
                  </tr>
                }
              </tbody>
            }
          </table>
        </ng-template>
      </of-list-frame>

      <p class="text-muted-foreground m-0 text-xs break-words">
        {{ 'editor.checks.note' | transloco }}
      </p>
    }
  `,
})
export class ChecksPage {
  private readonly api = inject(ApiClient);
  private readonly me = inject(MeService);
  private readonly changeSets = inject(ChangeSetSession);
  private readonly csLink = inject(ChangeSetUrl);
  private readonly readRef = inject(ReadRef);
  private readonly language = inject(LanguageService);
  private readonly texts = inject(UiTexts);
  private readonly t = injectTranslate();

  protected readonly view = injectQueryState({
    manual: idParam(MANUAL_ID),
    changeSet: idParam(isChangeSetId),
    severity: oneOfParam(CHECK_SEVERITIES),
    page: intParam(1),
    size: intParam(CHECK_PAGE_SIZES[0], { only: CHECK_PAGE_SIZES }),
  });
  protected readonly severity = this.view.get('severity');
  private readonly page = this.view.get('page');
  private readonly size = this.view.get('size');
  protected readonly pageSizes = CHECK_PAGE_SIZES;

  protected readonly doc = signal<CheckDoc | null>(null);
  protected readonly loading = signal(false);
  private readonly failure = signal<ApiError | null>(null);
  private readonly reloads = signal(0);
  /** The scope's title once read (a manual's, or a change set named by `?changeSet=`). */
  private readonly scopeTitle = signal<{
    readonly key: string;
    /** A manual's title may be one per language (#731): shown in the interface language. */
    readonly title: LocalizedText;
  } | null>(null);
  protected readonly offset = signal('20rem');
  private readonly frame = viewChild('frame', { read: ElementRef });
  private runs = 0;

  /** What is checked; none without a manual and with the released content chosen. */
  protected readonly scope = computed(
    (): Scope | null => {
      const manual = this.view.get('manual')();
      if (manual) {
        // Read where reads go now: the chosen change set once it may be read, else the released.
        return { kind: 'manual', id: manual, ref: this.readRef.ref() ?? '' };
      }
      // A change set the link names (under review, merged…), never made the session's choice.
      const named = this.view.get('changeSet')();
      if (named) return { kind: 'change-set', id: named, own: true };
      const chosen = this.changeSets.selected();
      return chosen ? { kind: 'change-set', id: chosen.id, own: false } : null;
    },
    { equal: sameScope },
  );

  protected readonly scopeText = computed((): string => {
    const scope = this.scope();
    if (!scope) return '';
    const changeSet = this.changeSets.selected();
    const read = this.scopeTitle();
    // The same person's last title for this subject stays until another ref's answer replaces it.
    const own = read?.key.startsWith(this.subjectKey$(scope))
      ? this.texts.text(read.title)
      : undefined;
    if (scope.kind === 'change-set') {
      return this.t('editor.checks.scope.changeSet', {
        title: (scope.own ? own : changeSet?.title) ?? scope.id,
      });
    }
    const title = own ?? scope.id;
    return scope.ref && changeSet
      ? this.t('editor.checks.scope.manualIn', {
          title,
          changeSet: changeSet.title,
        })
      : this.t('editor.checks.scope.manual', { title });
  });

  protected readonly severityOptions = computed((): SegmentedOption[] => {
    const counts = this.doc()?.meta.counts;
    return [
      {
        value: '',
        label: this.t('editor.checks.filter.all'),
        count: counts ? counts.blocking + counts.warning : null,
      },
      {
        value: 'blocking',
        label: this.t('editor.checks.filter.blocking'),
        count: counts?.blocking ?? null,
      },
      {
        value: 'warning',
        label: this.t('editor.checks.filter.warnings'),
        count: counts?.warning ?? null,
      },
    ];
  });

  private readonly router = inject(Router);

  /** The release dialog (screen 15) over the releases list. */
  protected createRelease(): void {
    void this.router.navigate(['/releases'], {
      queryParams: { create: 'open' },
    });
  }

  /** While anything blocks, the button says why not. */
  protected readonly releaseBlocked = computed((): string | null =>
    (this.doc()?.meta.counts.blocking ?? 0) > 0
      ? 'editor.checks.release.blocked'
      : null,
  );

  protected readonly frameError = computed(() => {
    const failure = this.failure();
    if (!failure) return null;
    const text = apiErrorText(failure);
    return { kind: failure.kind, message: this.t(text.key, text.params) };
  });

  protected readonly emptyTitle = computed(() => {
    const counts = this.doc()?.meta.counts;
    return counts && counts.blocking + counts.warning > 0
      ? 'editor.checks.empty.filteredTitle'
      : 'editor.checks.empty.title';
  });
  protected readonly emptyDescription = computed(() =>
    this.emptyTitle() === 'editor.checks.empty.title'
      ? 'editor.checks.empty.description'
      : 'editor.checks.empty.filteredDescription',
  );

  protected readonly fixLinkOf = fixLinkOf;

  constructor() {
    const destroyRef = inject(DestroyRef);
    effect(() => {
      const scope = this.scope();
      const severity = this.severity();
      const page = this.page();
      const size = this.size();
      this.me.me();
      this.reloads();
      // A new head of the branch read (an update from main, #466): its checks are new.
      this.readRef.moves();
      // A change set being chosen: wait for it, so the checks are read once, on it (and an
      // answer still on its way for the last scope is stale).
      const waiting =
        !(scope?.kind === 'change-set' && scope.own) &&
        (this.changeSets.switching() || this.changeSets.resolving());
      if (waiting) {
        this.runs++;
        return;
      }
      untracked(() => void this.load(scope, severity, page, size));
    });
    effect(() => {
      const scope = this.scope();
      this.me.me();
      untracked(() => void this.loadScopeTitle(scope));
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
      this.doc();
      measure();
    });
    const onResize = () => measure();
    window.addEventListener('resize', onResize);
    destroyRef.onDestroy(() => window.removeEventListener('resize', onResize));
  }

  protected runAgain(): void {
    this.reloads.update((n) => n + 1);
  }

  protected setSeverity(value: string): void {
    const severity = CHECK_SEVERITIES.find((s) => s === value);
    this.view.set({ severity, page: 1 });
  }

  protected groupsOf(items: readonly unknown[]): CheckGroup[] {
    return groupChecks(items as readonly CheckItem[]);
  }

  protected groupTitle(group: CheckGroup): string {
    if (group.title) return group.title;
    const { subject } = group;
    if (subject.type === 'manual') return subject.manualId;
    return subject.type === 'design' ? subject.designId : subject.moduleId;
  }

  /** Under the title: what it is, its ID and, for a module, its language. */
  protected groupDetail(group: CheckGroup): string {
    const { subject } = group;
    if (subject.type === 'design') {
      return this.t('editor.checks.group.design', { id: subject.designId });
    }
    return subject.type === 'manual'
      ? this.t('editor.checks.group.manual', { id: subject.manualId })
      : this.t('editor.checks.group.module', {
          id: subject.moduleId,
          language: languageName(this.language.locale(), subject.lang),
        });
  }

  /** How many of each severity the group holds on this page ("2 blocking · 1 warning"). */
  protected groupCounts(group: CheckGroup): string {
    return [
      ...(group.blocking > 0
        ? [this.t('editor.checks.group.blocking', { count: group.blocking })]
        : []),
      ...(group.warning > 0
        ? [this.t('editor.checks.group.warnings', { count: group.warning })]
        : []),
    ].join(' · ');
  }

  /** The link's accessible name: the check and where it leads. */
  protected actionLabel(check: CheckItem, group: CheckGroup): string {
    return this.t(
      check.attributes.blockId
        ? 'editor.checks.action.goToBlockLabel'
        : 'editor.checks.action.openLabel',
      { check: this.t(this.titleKey(check)), subject: this.groupTitle(group) },
    );
  }

  protected titleKey(check: CheckItem): string {
    return CHECK_TITLES[check.attributes.code];
  }

  protected detailText(check: CheckItem): Text {
    const locale = this.language.locale();
    return detailOf(check, (lang) => languageName(locale, lang));
  }

  protected linkParams(
    query: Readonly<Record<string, string>>,
  ): Record<string, string> {
    const scope = this.scope();
    // A change set the link named opens the fix in it, when the person may choose it (an open
    // one in their list); else the fix opens where they are (a merged one is in the content).
    const cs =
      scope?.kind === 'change-set' &&
      scope.own &&
      !this.changeSets.switching() &&
      this.changeSets
        .options()
        .some((o) => o.id === scope.id && !o.pending && o.branch !== null)
        ? { cs: scope.id }
        : this.csLink.params();
    return { ...cs, ...query };
  }

  private async load(
    scope: Scope | null,
    severity: CheckSeverity | undefined,
    page: number,
    size: number,
  ): Promise<void> {
    const run = ++this.runs;
    if (!scope) {
      this.doc.set(null);
      this.failure.set(null);
      this.loading.set(false);
      return;
    }
    this.loading.set(true);
    this.failure.set(null);
    const query = {
      ...(severity ? { 'filter[severity]': severity } : {}),
      ...pageQuery({ number: page, size }),
    };
    try {
      const doc = await firstValueFrom(
        scope.kind === 'manual'
          ? this.api.get('/manuals/{id}/checks', {
              path: { id: scope.id },
              query,
            })
          : this.api.get('/change-sets/{changeSetId}/checks', {
              path: { changeSetId: scope.id },
              query,
            }),
      );
      if (run !== this.runs) return;
      const last = Math.max(1, doc.meta.page.lastPage);
      if (doc.data.length === 0 && page > last) {
        // Past the end (a stale link, fewer checks now): the last page, in place of this one.
        this.view.set({ page: last }, { replace: true });
        return;
      }
      this.doc.set(doc);
    } catch (error) {
      if (run !== this.runs) return;
      this.doc.set(null);
      this.failure.set(toApiError(error));
    }
    this.loading.set(false);
  }

  /** The person and the subject: a title is shown only to whoever it was read for. */
  private subjectKey$(scope: Scope): string {
    return `${this.me.me().id}\n${scope.kind}/${scope.id}\n`;
  }

  private titleKey$(scope: Scope): string {
    return this.subjectKey$(scope) + (scope.kind === 'manual' ? scope.ref : '');
  }

  private async loadScopeTitle(scope: Scope | null): Promise<void> {
    // Read again for another person (who may not read it) and another ref (a renamed manual).
    const key = scope ? this.titleKey$(scope) : '';
    if (this.scopeTitle()?.key === key) return;
    if (!scope || (scope.kind === 'change-set' && !scope.own)) return;
    try {
      const title =
        scope.kind === 'manual'
          ? (
              await firstValueFrom(
                this.api.get('/manuals/{id}', { path: { id: scope.id } }),
              )
            ).data.attributes.title
          : (
              await firstValueFrom(
                this.api.get('/change-sets/{changeSetId}', {
                  path: { changeSetId: scope.id },
                }),
              )
            ).data.attributes.title;
      const now = this.scope();
      if (now && this.titleKey$(now) === key) {
        this.scopeTitle.set({ key, title });
      }
    } catch {
      // The checks say what went wrong; the ID stands in for the title.
    }
  }
}
