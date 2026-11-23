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
import { Router } from '@angular/router';
import { TranslocoPipe } from '@jsverse/transloco';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideCircleCheck,
  lucideCircleSlash,
  lucideCircleX,
  lucideLoaderCircle,
  lucidePackage,
  lucideStar,
} from '@ng-icons/lucide';
import { firstValueFrom } from 'rxjs';

import { ZardBadgeComponent } from '@openfolia/ui/badge';
import { ZardButtonComponent } from '@openfolia/ui/button';
import {
  DatePipe,
  injectTranslate,
  RelativeTimePipe,
  type TranslatedText,
} from '@openfolia/ui/i18n';
import {
  ListFrameComponent,
  ListItemDirective,
  ListTableDirective,
} from '@openfolia/ui/list-frame';
import { ZardSelectImports } from '@openfolia/ui/select';
import { PageHeaderComponent } from '@openfolia/ui/shell';
import {
  FadeInDirective,
  SidePanelComponent,
  SidePanelContentDirective,
} from '@openfolia/ui/smooth';
import { ZardTableImports } from '@openfolia/ui/table';

import {
  ApiClient,
  pageQuery,
  toApiError,
  type ApiError,
  type Response,
} from '../api';
import { injectPersonName } from '../history/history-model';
import { apiErrorText } from '../i18n';
import { GuardDirective } from '../permissions/guard.directive';
import { MeService } from '../permissions/me';
import { PermissionService } from '../permissions/permission.service';
import { Generation } from '../shared/generation';
import { idParam, injectQueryState, intParam, oneOfParam } from '../view-state';
import { CreateReleaseDialogComponent } from './create-release-dialog.component';
import { MaintenanceActions } from './maintenance-actions';
import { MaintenanceTabComponent } from './maintenance-tab.component';
import { frameOffset } from './frame-offset';
import { ReleaseActions } from './release-actions';
import { ReleasePanelComponent } from './release-panel.component';
import { ReleaseProgress } from './release-progress';
import { ReleaseSource } from './release-source';
import { ReleaseTabsComponent } from './release-tabs.component';
import {
  inProgress,
  POLL_MS,
  PROGRESS_BADGE,
  progressBadgeKey,
  progressKey,
  progressParams,
  progressKind,
  type OutputProgress,
  RELEASE_ID,
  RELEASE_PAGE_SIZES,
  RELEASE_STATES,
  releaseStateOf,
  STATE_BADGE,
  STATE_TEXT,
  type ReleaseItem,
  type ReleaseState,
} from './releases-model';
import { WithdrawReleaseDialogComponent } from './withdraw-dialog.component';

type ReleaseDoc = Response<'/releases'>;

/** What the list is read for: the filters and the page. */
interface ReleaseQuery {
  readonly product: string | undefined;
  readonly state: ReleaseState | undefined;
  readonly page: number;
  readonly size: number;
}

/** Space kept below the frame: the page's bottom padding. */
const BELOW_FRAME_PX = 32;
/** A product (a facet value's ID). */
const PRODUCT = /^[a-z0-9][a-z0-9_-]{0,99}$/;

/**
 * Screen 16, the releases (`/releases`): every release, newest first, withdrawn ones too, with
 * its product and product version, how far its files are ("12 of 14 files ready", failures
 * named), its state as a badge with a word and who cut it when; filtered by product and state.
 * Choosing a row opens its panel (`of-release-panel`) beside the list, its page holds the rest
 * (`/releases/:id`). "New release" (`release.publish`) opens screen 15. The filters, the page,
 * the chosen release and the open dialog are in the address.
 */
@Component({
  selector: 'of-releases-page',
  imports: [
    TranslocoPipe,
    NgIcon,
    DatePipe,
    RelativeTimePipe,
    FadeInDirective,
    PageHeaderComponent,
    ListFrameComponent,
    ListItemDirective,
    ListTableDirective,
    SidePanelComponent,
    SidePanelContentDirective,
    ZardBadgeComponent,
    ZardButtonComponent,
    ZardSelectImports,
    ZardTableImports,
    GuardDirective,
    ReleasePanelComponent,
    ReleaseTabsComponent,
    WithdrawReleaseDialogComponent,
    CreateReleaseDialogComponent,
    MaintenanceTabComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [ReleaseSource, ReleaseProgress],
  viewProviders: [
    provideIcons({
      lucideCircleCheck,
      lucideCircleSlash,
      lucideCircleX,
      lucideLoaderCircle,
      lucidePackage,
      lucideStar,
    }),
  ],
  host: { class: 'flex min-w-0 flex-col gap-4' },
  template: `
    <of-page-header [title]="'editor.releases.title' | transloco">
      <button
        z-button
        type="button"
        data-slot="new-release"
        [ofGuard]="{ permission: 'release.publish' }"
        (click)="openCreate()"
      >
        <ng-icon
          name="lucidePackage"
          data-icon="inline-start"
          aria-hidden="true"
        />
        {{ 'editor.releases.new' | transloco }}
      </button>
    </of-page-header>
    <of-release-tabs [current]="tab()" />

    @if (tab() === 'maintenance') {
      <of-maintenance-tab
        ofFadeIn
        [page]="view.get('linesPage')()"
        [size]="view.get('linesSize')()"
        [version]="linesVersion()"
        (pageChange)="view.set({ linesPage: $event })"
        (sizeChange)="view.set({ linesSize: $event, linesPage: 1 })"
      />
    } @else {
      <div class="flex flex-wrap items-center gap-2">
        <z-select
          class="w-auto max-w-72 min-w-36"
          zPosition="popper"
          data-slot="product-filter"
          [zPrefix]="'editor.releases.filter.product' | transloco"
          [zAriaLabel]="'editor.releases.filter.product' | transloco"
          [zValue]="view.get('product')() ?? ''"
          (zSelectionChange)="setProduct($event)"
        >
          <z-select-item zValue="">{{
            'editor.releases.filter.all' | transloco
          }}</z-select-item>
          @for (p of source.products(); track p.id) {
            <z-select-item [zValue]="p.id">{{ p.label }}</z-select-item>
          }
        </z-select>
        <z-select
          class="w-auto min-w-36"
          zPosition="popper"
          data-slot="state-filter"
          [zPrefix]="'editor.releases.filter.state' | transloco"
          [zAriaLabel]="'editor.releases.filter.state' | transloco"
          [zValue]="view.get('state')() ?? ''"
          (zSelectionChange)="setState($event)"
        >
          <z-select-item zValue="">{{
            'editor.releases.filter.all' | transloco
          }}</z-select-item>
          @for (s of states; track s) {
            <z-select-item [zValue]="s">{{
              stateText[s] | transloco
            }}</z-select-item>
          }
        </z-select>
      </div>

      <div class="flex min-w-0 flex-col gap-4 lg:flex-row lg:items-start">
        <of-list-frame
          #frame
          class="min-h-64 min-w-0 flex-1"
          [label]="'editor.releases.table.label' | transloco"
          [items]="doc()?.data ?? []"
          [page]="doc()?.meta?.page ?? null"
          [loading]="loading()"
          [error]="frameError()"
          [offset]="offset()"
          [pageSizes]="pageSizes"
          [emptyTitle]="
            (filtered()
              ? 'editor.releases.empty.filteredTitle'
              : 'editor.releases.empty.title'
            ) | transloco
          "
          [emptyDescription]="
            (filtered()
              ? 'editor.releases.empty.filteredDescription'
              : 'editor.releases.empty.description'
            ) | transloco
          "
          (pageChange)="view.set({ page: $event })"
          (pageSizeChange)="view.set({ size: $event, page: 1 })"
          (retry)="reload()"
        >
          <ng-template ofListTable let-items>
            <table z-table class="min-w-[44rem] table-fixed">
              <thead z-table-header class="bg-background sticky top-0 z-10">
                <tr z-table-row>
                  <th z-table-head class="w-[26%]">
                    {{ 'editor.releases.table.product' | transloco }}
                  </th>
                  <th z-table-head class="w-[17%]">
                    {{ 'editor.releases.table.version' | transloco }}
                  </th>
                  <th z-table-head>
                    {{ 'editor.releases.table.files' | transloco }}
                  </th>
                  <th z-table-head class="w-32">
                    {{ 'editor.releases.table.state' | transloco }}
                  </th>
                  <th z-table-head class="w-[17%]">
                    {{ 'editor.releases.table.published' | transloco }}
                  </th>
                </tr>
              </thead>
              <tbody z-table-body>
                @for (r of asReleases(items); track r.id) {
                  @let chosen = r.id === selectedId();
                  @let s = stateOf(r);
                  <tr
                    z-table-row
                    [ofListItem]="r"
                    class="cursor-pointer"
                    data-slot="release-row"
                    [attr.data-state]="chosen ? 'selected' : null"
                    [attr.aria-current]="chosen ? 'true' : null"
                    (click)="select(r)"
                  >
                    <td z-table-cell class="align-top whitespace-normal">
                      <button
                        type="button"
                        class="text-foreground focus-visible:ring-ring/50 rounded-sm text-start font-medium [overflow-wrap:anywhere] outline-none hover:underline focus-visible:ring-[3px]"
                        [attr.aria-current]="chosen ? 'true' : null"
                        [attr.aria-label]="
                          'editor.releases.table.open'
                            | transloco: { name: name(r) }
                        "
                        (click)="$event.stopPropagation(); select(r)"
                      >
                        {{ source.productLabel(r.attributes.product) }}
                      </button>
                    </td>
                    <td z-table-cell class="align-top whitespace-normal">
                      <span class="flex flex-wrap items-center gap-1.5">
                        <span class="[overflow-wrap:anywhere]">{{
                          r.attributes.revision
                        }}</span>
                        @if (r.attributes.major) {
                          <z-badge zType="warning" class="gap-1">
                            <ng-icon name="lucideStar" aria-hidden="true" />
                            {{ 'editor.releases.major' | transloco }}
                          </z-badge>
                        }
                      </span>
                    </td>
                    <td
                      z-table-cell
                      class="text-muted-foreground align-top text-sm whitespace-normal"
                      data-slot="progress"
                    >
                      @if (progress.of(r.id); as p) {
                        @for (k of [kind(p)]; track k) {
                          <z-badge
                            ofFadeIn
                            class="gap-1"
                            [zType]="progressBadge[k]"
                            [attr.data-progress]="k"
                            [attr.title]="progressText(p)"
                          >
                            @switch (k) {
                              @case ('preparing') {
                                <ng-icon
                                  name="lucideLoaderCircle"
                                  class="animate-spin motion-reduce:animate-none"
                                  aria-hidden="true"
                                />
                              }
                              @case ('rendering') {
                                <ng-icon
                                  name="lucideLoaderCircle"
                                  class="animate-spin motion-reduce:animate-none"
                                  aria-hidden="true"
                                />
                              }
                              @case ('failed') {
                                <ng-icon
                                  name="lucideCircleX"
                                  aria-hidden="true"
                                />
                              }
                              @case ('ready') {
                                <ng-icon
                                  name="lucideCircleCheck"
                                  aria-hidden="true"
                                />
                              }
                            }
                            <span class="tabular-nums">{{ badgeText(p) }}</span>
                          </z-badge>
                        }
                      } @else if (progress.failed(r.id)) {
                        {{ 'editor.releases.progress.unknown' | transloco }}
                      } @else {
                        <span
                          class="bg-muted inline-block h-4 w-28 animate-pulse rounded motion-reduce:animate-none"
                          aria-hidden="true"
                        ></span>
                      }
                    </td>
                    <td z-table-cell class="align-top">
                      <z-badge [zType]="stateBadge[s]" class="gap-1">
                        <ng-icon
                          [name]="
                            s === 'withdrawn'
                              ? 'lucideCircleSlash'
                              : 'lucideCircleCheck'
                          "
                          aria-hidden="true"
                        />
                        {{ stateText[s] | transloco }}
                      </z-badge>
                    </td>
                    <td
                      z-table-cell
                      class="text-muted-foreground align-top text-sm whitespace-normal"
                    >
                      <span
                        class="block"
                        [attr.title]="
                          r.attributes.publishedAt | ofDate: dateTime
                        "
                        >{{ r.attributes.publishedAt | ofRelativeTime }}</span
                      >
                      <span class="block text-xs break-words">{{
                        person(r.attributes.publishedBy)
                      }}</span>
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </ng-template>
        </of-list-frame>

        <!-- Beside the list it grows and shrinks; stacked under it (narrow) it only fades. -->
        <of-side-panel
          class="[--of-side-panel-closed-width:100%] [--of-side-panel-width:100%] lg:[--of-side-panel-closed-width:0px] lg:[--of-side-panel-gap:1rem] lg:[--of-side-panel-width:20rem] xl:[--of-side-panel-width:22rem]"
        >
          <ng-template [ofSidePanelContent]="selected()" let-r>
            <aside
              class="border-border bg-card overflow-y-auto rounded-xl border p-4"
              data-slot="release-panel"
              [style.max-height]="'calc(100dvh - ' + offset() + ')'"
              [attr.aria-label]="'editor.releases.panel.label' | transloco"
            >
              <of-release-panel
                [release]="r"
                [name]="name(r)"
                [progress]="progress.of(r.id)"
                (closed)="view.set({ release: undefined })"
                (withdraw)="openWithdraw()"
                (startMaintenance)="startMaintenance(r)"
                (showMaintenance)="showMaintenance()"
              />
            </aside>
          </ng-template>
        </of-side-panel>
      </div>
    }

    <of-withdraw-release-dialog
      [(open)]="withdrawOpen"
      [name]="selected() ? name(selected()!) : ''"
      [busy]="withdrawing()"
      [error]="withdrawError()"
      (withdraw)="withdraw($event)"
    />

    <of-create-release-dialog
      [open]="view.get('create')() === 'open' && canPublish()"
      (openChange)="setCreate($event)"
      (created)="created($event)"
    />
  `,
})
export class ReleasesPage {
  private readonly api = inject(ApiClient);
  private readonly me = inject(MeService);
  private readonly permissions = inject(PermissionService);
  private readonly router = inject(Router);
  private readonly actions = inject(ReleaseActions);
  private readonly t = injectTranslate();
  private readonly nameOf = injectPersonName();
  protected readonly source = inject(ReleaseSource);
  protected readonly progress = inject(ReleaseProgress);

  protected readonly view = injectQueryState({
    product: idParam(PRODUCT),
    state: oneOfParam(RELEASE_STATES),
    page: intParam(1),
    size: intParam(RELEASE_PAGE_SIZES[0], { only: RELEASE_PAGE_SIZES }),
    release: idParam(RELEASE_ID),
    create: oneOfParam(['open'] as const),
    tab: oneOfParam(['maintenance'] as const),
    linesPage: intParam(1),
    linesSize: intParam(RELEASE_PAGE_SIZES[0], { only: RELEASE_PAGE_SIZES }),
  });
  protected readonly pageSizes = RELEASE_PAGE_SIZES;
  protected readonly states = RELEASE_STATES;
  protected readonly stateText = STATE_TEXT;
  protected readonly stateBadge = STATE_BADGE;
  protected readonly dateTime: Intl.DateTimeFormatOptions = {
    dateStyle: 'medium',
    timeStyle: 'short',
  };

  protected readonly doc = signal<ReleaseDoc | null>(null);
  protected readonly loading = signal(false);
  private readonly failure = signal<ApiError | null>(null);
  private readonly reloads = signal(0);
  /** The chosen release when it is not on the page (a link to it). */
  private readonly outside = signal<ReleaseItem | null>(null);
  /** Reads of `outside`: one started before another, or for the person before, never lands. */
  private readonly outsideReads = new Generation();
  protected readonly withdrawOpen = signal(false);
  protected readonly withdrawing = signal(false);
  protected readonly withdrawError = signal('');
  private readonly frame = viewChild('frame', { read: ElementRef });
  protected readonly offset = frameOffset(this.frame, BELOW_FRAME_PX, () =>
    this.doc(),
  );
  private runs = 0;
  private readFor: string | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;

  protected readonly selectedId = this.view.get('release');
  private readonly maintenance = inject(MaintenanceActions);
  /** Bumped when a line was started here: the Maintenance tab reads its page again. */
  protected readonly linesVersion = signal(0);
  /** Lines need `content.read.draft` (a line's branch holds unreleased fixes). */
  protected readonly canReadLines = computed(
    () =>
      this.permissions.state({ permission: 'content.read.draft' }).kind ===
      'enabled',
  );
  /** The tab shown: the releases, or the maintenance lines for whoever may read them. */
  protected readonly tab = computed(() =>
    this.view.get('tab')() === 'maintenance' && this.canReadLines()
      ? 'maintenance'
      : 'releases',
  );
  /** "New release" opens (also from the address) only for whoever may publish. */
  protected readonly canPublish = computed(
    () =>
      this.permissions.state({ permission: 'release.publish' }).kind ===
      'enabled',
  );
  protected readonly selected = computed(() => {
    const id = this.selectedId();
    if (!id) return null;
    return (
      this.doc()?.data.find((r) => r.id === id) ??
      (this.outside()?.id === id ? this.outside() : null)
    );
  });

  protected readonly filtered = computed(
    () =>
      this.view.get('product')() !== undefined ||
      this.view.get('state')() !== undefined,
  );

  protected readonly frameError = computed(() => {
    const failure = this.failure();
    if (!failure) return null;
    const text = apiErrorText(failure);
    return { kind: failure.kind, message: this.t(text.key, text.params) };
  });

  protected readonly person = (who: { kind: string; id: string }) =>
    this.nameOf(who.kind, who.id);

  constructor() {
    effect(() => {
      const query = {
        product: this.view.get('product')(),
        state: this.view.get('state')(),
        page: this.view.get('page')(),
        size: this.view.get('size')(),
      };
      const who = this.me.me().id;
      this.reloads();
      untracked(() => {
        // Whoever acts now: what was read for someone else is read anew.
        if (who !== this.readFor) {
          this.readFor = who;
          this.outsideReads.end();
          this.outside.set(null);
          this.progress.clear();
          this.source.forget();
          void this.source.readConfig();
        }
        void this.load(query);
      });
    });
    // A chosen release that is not on this page (a link): read on its own.
    effect(() => {
      const id = this.selectedId();
      const onPage = this.doc()?.data.some((r) => r.id === id) ?? false;
      if (!id || onPage || !this.doc()) return;
      untracked(() => void this.readOutside(id));
    });
    inject(DestroyRef).onDestroy(() => {
      this.runs++;
      clearTimeout(this.timer);
    });
  }

  protected asReleases(items: readonly unknown[]): readonly ReleaseItem[] {
    return items as readonly ReleaseItem[];
  }

  protected stateOf(release: ReleaseItem): ReleaseState {
    return releaseStateOf(release);
  }

  protected kind = progressKind;
  protected readonly progressBadge = PROGRESS_BADGE;

  protected progressText(progress: OutputProgress): string {
    return this.t(progressKey(progress), progressParams(progress));
  }

  /** The badge's short word: "Preparing", "4 of 9", "Ready", "2 failed", "No files". */
  protected badgeText(progress: OutputProgress): string {
    return this.t(progressBadgeKey(progress), progressParams(progress));
  }

  protected name(release: ReleaseItem): string {
    return this.t('editor.releases.name', {
      product: this.source.productLabel(release.attributes.product),
      version: release.attributes.revision,
    });
  }

  protected select(release: ReleaseItem): void {
    this.view.set({
      release: this.selectedId() === release.id ? undefined : release.id,
    });
  }

  protected setProduct(value: string | string[]): void {
    const product = Array.isArray(value) ? value[0] : value;
    this.view.set({ product: product || undefined, page: 1 });
  }

  protected setState(value: string | string[]): void {
    const state = RELEASE_STATES.find(
      (s) => s === (Array.isArray(value) ? value[0] : value),
    );
    this.view.set({ state, page: 1 });
  }

  protected reload(): void {
    this.reloads.update((n) => n + 1);
  }

  protected openCreate(): void {
    this.view.set({ create: 'open' });
  }

  protected setCreate(open: boolean): void {
    if (!open && this.view.get('create')())
      this.view.set({ create: undefined });
  }

  protected created(release: ReleaseItem): void {
    void this.router.navigate(['/releases', release.id]);
  }

  protected showMaintenance(): void {
    this.view.set({ tab: 'maintenance', linesPage: 1 });
  }

  /** "Start maintenance" on a release (#250): a line to fix that product version on. */
  protected async startMaintenance(release: ReleaseItem): Promise<void> {
    const line = await this.maintenance.start(release, this.name(release), () =>
      this.showMaintenance(),
    );
    if (line) this.linesVersion.update((n) => n + 1);
  }

  protected openWithdraw(): void {
    this.withdrawError.set('');
    this.withdrawOpen.set(true);
  }

  protected async withdraw(reason: string): Promise<void> {
    const release = this.selected();
    if (!release || this.withdrawing()) return;
    this.withdrawing.set(true);
    this.withdrawError.set('');
    try {
      const withdrawn = await this.actions.withdraw(
        release,
        this.name(release),
        reason,
      );
      this.replace(withdrawn);
      this.withdrawOpen.set(false);
      // Filtered by status: the release no longer belongs on this page.
      if (this.view.get('state')()) this.reload();
    } catch (text) {
      const message = text as TranslatedText;
      this.withdrawError.set(this.t(message.key, message.params));
    } finally {
      this.withdrawing.set(false);
    }
  }

  /** The release as the API now has it, in place on the page (and the panel). */
  private replace(release: ReleaseItem): void {
    const doc = this.doc();
    if (doc) {
      this.doc.set({
        ...doc,
        // Its files are as they were: a cut or withdrawal answer does not count them.
        data: doc.data.map((r) =>
          r.id === release.id ? { ...release, meta: r.meta } : r,
        ),
      });
    }
    if (this.outside()?.id === release.id) this.outside.set(release);
  }

  private async readOutside(id: string): Promise<void> {
    const live = this.outsideReads.start();
    try {
      const release = await this.source.release(id);
      if (live() && this.selectedId() === id) {
        this.outside.set(release);
        this.progress.take([release]);
      }
    } catch {
      // Gone, or not to be read: the address forgets it.
      if (live() && this.selectedId() === id)
        this.view.set({ release: undefined }, { replace: true });
    }
  }

  /**
   * Counts the files of the releases shown again while any of them still renders: the page's list
   * read again, one request however many render (#481), its rows left as they are. A release
   * whose files could not be counted is left out (it says so); a list that cannot be read now is
   * tried again next time, and a newer read or leaving the page ends the chain.
   */
  private poll(query: ReleaseQuery, run = this.runs): void {
    clearTimeout(this.timer);
    if (run !== this.runs) return;
    const rendering = (this.doc()?.data ?? []).some(
      (r) => !this.progress.failed(r.id) && inProgress(this.progress.of(r.id)),
    );
    if (!rendering) return;
    this.timer = setTimeout(() => {
      if (run !== this.runs) return;
      void this.list(query)
        .then(
          (doc) => {
            if (run !== this.runs) return;
            const shown = new Set(this.doc()?.data.map((r) => r.id));
            this.progress.take(doc.data.filter((r) => shown.has(r.id)));
          },
          () => undefined,
        )
        .then(() => this.poll(query, run));
    }, POLL_MS * 2);
  }

  private list(query: ReleaseQuery): Promise<ReleaseDoc> {
    return firstValueFrom(
      this.api.get('/releases', {
        query: {
          ...(query.product ? { 'filter[product]': query.product } : {}),
          ...(query.state ? { 'filter[state]': query.state } : {}),
          ...pageQuery({ number: query.page, size: query.size }),
        },
      }),
    );
  }

  private async load(query: ReleaseQuery): Promise<void> {
    const run = ++this.runs;
    clearTimeout(this.timer);
    this.loading.set(true);
    this.failure.set(null);
    try {
      const doc = await this.list(query);
      if (run !== this.runs) return;
      const last = Math.max(1, doc.meta.page.lastPage);
      if (doc.data.length === 0 && query.page > last) {
        this.view.set({ page: last }, { replace: true });
        return;
      }
      this.doc.set(doc);
      // The list counts every release's files (#481): no read per release.
      this.progress.take(doc.data);
      this.poll(query, run);
    } catch (error) {
      if (run !== this.runs) return;
      this.failure.set(toApiError(error));
    } finally {
      if (run === this.runs) this.loading.set(false);
    }
  }
}
