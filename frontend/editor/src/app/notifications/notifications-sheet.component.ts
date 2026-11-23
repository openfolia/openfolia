import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  untracked,
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { RouterLink } from '@angular/router';
import { TranslocoPipe } from '@jsverse/transloco';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideCheckCheck,
  lucideCircleCheck,
  lucideGitMerge,
  lucideInbox,
  lucideLanguages,
  lucideLockOpen,
  lucidePackage,
  lucideSignature,
  lucideTriangleAlert,
  lucideUndo2,
  lucideX,
} from '@ng-icons/lucide';

import { ZardButtonComponent } from '@openfolia/ui/button';
import {
  DatePipe,
  injectTranslate,
  RelativeTimePipe,
} from '@openfolia/ui/i18n';
import {
  SegmentedComponent,
  type SegmentedOption,
} from '@openfolia/ui/segmented';
import { ZardSheetImports } from '@openfolia/ui/sheet';
import { FadeInDirective, RefreshingDirective } from '@openfolia/ui/smooth';
import {
  EmptyStateComponent,
  ErrorStateComponent,
  SkeletonRowsComponent,
} from '@openfolia/ui/states';

import { MeService } from '../permissions/me';
import { ChangeSetUrl } from '../session/change-set-url';
import { injectQueryState, oneOfParam } from '../view-state';
import { isNotificationsShortcut } from './notification-bell.component';
import { NotificationCenter } from './notification-center';
import {
  describe,
  groupOf,
  type NotificationItem,
  type NotificationView,
} from './notification-model';

/** `?notifications=`: the sheet is open, with all notifications or the unread ones only. */
const SHOWN = ['all', 'unread'] as const;
type Shown = (typeof SHOWN)[number];

interface Row {
  readonly item: NotificationItem;
  readonly view: NotificationView;
  readonly text: string;
  readonly unread: boolean;
  readonly query: Readonly<Record<string, string>>;
}

interface Group {
  readonly id: 'today' | 'earlier';
  readonly label: string;
  readonly rows: readonly Row[];
}

/**
 * Screen 19: the person's notifications, in a sheet from the right, opened by the bell in the
 * header or Alt+Shift+N from anywhere. Newest first, grouped by Today and Earlier; each row has
 * its kind's icon, a sentence built from its kind and payload, when it happened and, while
 * unread, a dot, a tint, a medium weight and the word "Unread" for screen readers. A click marks
 * it read and opens what it is about. "Mark all read", an "Unread only" filter, "Load more".
 *
 * Its state is in the address (`?notifications=all|unread`), so a reload or a link shows it
 * open, and Back closes it. The rows scroll inside the sheet; "Load more" stays below them.
 */
@Component({
  selector: 'of-notifications-sheet',
  imports: [
    NgTemplateOutlet,
    RouterLink,
    TranslocoPipe,
    NgIcon,
    DatePipe,
    EmptyStateComponent,
    ErrorStateComponent,
    FadeInDirective,
    RefreshingDirective,
    RelativeTimePipe,
    SegmentedComponent,
    SkeletonRowsComponent,
    ZardButtonComponent,
    ZardSheetImports,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [
    provideIcons({
      lucideCheckCheck,
      lucideCircleCheck,
      lucideGitMerge,
      lucideInbox,
      lucideLanguages,
      lucideLockOpen,
      lucidePackage,
      lucideSignature,
      lucideTriangleAlert,
      lucideUndo2,
      lucideX,
    }),
  ],
  host: { '(document:keydown)': 'onShortcut($event)' },
  template: `
    <z-sheet
      zSide="right"
      zSize="custom"
      zWidth="min(420px, 100vw)"
      class="gap-0"
      [zClosable]="false"
      [zCloseOnNavigation]="false"
      [zVisible]="visible()"
      (zVisibleChange)="visibleChange($event)"
    >
      <z-sheet-header
        class="border-border flex-row items-center justify-between gap-2 border-b px-5 py-4"
      >
        <z-sheet-title class="min-w-0 truncate text-xl/7 font-medium">{{
          'editor.notifications.title' | transloco
        }}</z-sheet-title>
        <div class="flex shrink-0 items-center gap-1">
          @if (unread() ?? 0) {
            <!-- An icon with a tooltip: the label is long in some languages and would squeeze the title. -->
            <button
              type="button"
              z-button
              zType="ghost"
              zSize="icon"
              data-testid="mark-all-read"
              [attr.aria-label]="'editor.notifications.markAll' | transloco"
              [attr.title]="'editor.notifications.markAll' | transloco"
              (click)="markAll($event)"
            >
              <ng-icon
                name="lucideCheckCheck"
                size="18"
                strokeWidth="1.5"
                aria-hidden="true"
              />
            </button>
          }
          <button
            type="button"
            z-button
            zType="ghost"
            zSize="icon"
            z-sheet-close
            [attr.aria-label]="'editor.notifications.close' | transloco"
          >
            <ng-icon
              name="lucideX"
              size="18"
              strokeWidth="1.5"
              aria-hidden="true"
            />
          </button>
        </div>
      </z-sheet-header>

      <div class="border-border border-b px-5 py-3">
        <of-segmented
          [label]="'editor.notifications.filter.label' | transloco"
          [options]="filterOptions()"
          [value]="shown() ?? 'all'"
          (valueChange)="choose($event)"
        />
      </div>

      <div
        class="min-h-0 flex-1 overflow-y-auto overscroll-contain"
        data-testid="notification-scroller"
      >
        @if (center.error(); as failure) {
          <of-error-state
            [kind]="failure.kind"
            [heading]="'editor.notifications.failed' | transloco"
            (retry)="center.retry()"
          />
        } @else if (!center.loaded() && rows().length === 0) {
          <of-skeleton-rows [count]="5" [tall]="true" />
        } @else if (rows().length === 0) {
          <of-empty-state
            ofFadeIn
            [title]="'editor.notifications.empty' | transloco"
            [description]="
              shown() === 'unread'
                ? ('editor.notifications.emptyUnread' | transloco)
                : ''
            "
          />
        } @else {
          <div [ofRefreshing]="center.loading() && !center.loaded()">
            @for (group of groups(); track group.id) {
              <section [attr.aria-labelledby]="'notifications-' + group.id">
                <h3
                  [id]="'notifications-' + group.id"
                  class="text-muted-foreground bg-popover sticky top-0 z-10 m-0 px-5 pt-3 pb-1.5 text-xs font-medium"
                >
                  {{ group.label }}
                </h3>
                <ul class="m-0 list-none p-0">
                  @for (row of group.rows; track row.item.id) {
                    <li ofFadeIn class="border-border border-b">
                      @if (row.view.link; as link) {
                        <a
                          class="hover:bg-accent focus-visible:ring-ring flex gap-3 px-5 py-3.5 no-underline outline-none focus-visible:ring-2 focus-visible:ring-inset"
                          [class.bg-accent]="row.unread"
                          [routerLink]="link.path"
                          [queryParams]="row.query"
                          [attr.data-unread]="row.unread || null"
                          (click)="open(row)"
                        >
                          <ng-container
                            *ngTemplateOutlet="
                              body;
                              context: { $implicit: row }
                            "
                          />
                        </a>
                      } @else {
                        <button
                          type="button"
                          class="hover:bg-accent focus-visible:ring-ring flex w-full gap-3 px-5 py-3.5 text-start outline-none focus-visible:ring-2 focus-visible:ring-inset"
                          [class.bg-accent]="row.unread"
                          [attr.data-unread]="row.unread || null"
                          (click)="open(row)"
                        >
                          <ng-container
                            *ngTemplateOutlet="
                              body;
                              context: { $implicit: row }
                            "
                          />
                        </button>
                      }
                    </li>
                  }
                </ul>
              </section>
            }
          </div>
        }
      </div>

      @if (center.hasMore()) {
        <div class="border-border border-t px-5 py-3">
          <button
            type="button"
            z-button
            zType="outline"
            class="w-full"
            data-testid="load-more"
            [disabled]="center.loading()"
            [attr.aria-busy]="center.loading() || null"
            (click)="center.loadMore()"
          >
            {{
              (center.loading()
                ? 'editor.notifications.loadingMore'
                : 'editor.notifications.loadMore'
              ) | transloco
            }}
          </button>
        </div>
      }
    </z-sheet>

    <ng-template #body let-row>
      <span
        class="bg-primary mt-1.5 size-2 shrink-0 rounded-full"
        [class.invisible]="!row.unread"
        aria-hidden="true"
      ></span>
      <ng-icon
        [name]="row.view.icon"
        size="18"
        strokeWidth="1.5"
        class="mt-px shrink-0"
        [class.text-destructive]="row.view.problem"
        [class.text-muted-foreground]="!row.view.problem"
        aria-hidden="true"
      />
      <span class="flex min-w-0 flex-1 flex-col gap-0.5">
        @if (row.unread) {
          <span class="sr-only">{{
            'editor.notifications.unread' | transloco
          }}</span>
        }
        <span
          class="text-foreground text-sm break-words"
          [class.font-medium]="row.unread"
          >{{ row.text }}</span
        >
        <time
          class="text-muted-foreground text-xs"
          [attr.datetime]="row.item.attributes.createdAt"
          [attr.title]="row.item.attributes.createdAt | ofDate: dateTime"
          >{{ row.item.attributes.createdAt | ofRelativeTime }}</time
        >
      </span>
    </ng-template>
  `,
})
export class NotificationsSheetComponent {
  protected readonly center = inject(NotificationCenter);
  private readonly meService = inject(MeService);
  private readonly csLink = inject(ChangeSetUrl);
  private readonly t = injectTranslate();
  private readonly view = injectQueryState({
    notifications: oneOfParam(SHOWN),
  });

  protected readonly unread = this.center.unread;
  protected readonly dateTime: Intl.DateTimeFormatOptions = {
    dateStyle: 'medium',
    timeStyle: 'short',
  };
  /** What the address asks to show; undefined: the sheet is closed. */
  protected readonly shown = this.view.get('notifications');
  /** Open only for a person acting. */
  readonly visible = computed(
    () => this.shown() !== undefined && this.meService.presence() === 'person',
  );

  protected readonly filterOptions = computed((): SegmentedOption[] => [
    { value: 'all', label: this.t('editor.notifications.filter.all') },
    {
      value: 'unread',
      label: this.t('editor.notifications.filter.unread'),
      count: this.unread(),
    },
  ]);

  protected readonly rows = computed((): Row[] => {
    const context = {
      nameOf: (who: { kind: string; id: string }) => this.center.nameOf(who),
      releaseLabel: (id: string) => this.center.releaseLabel(id),
    };
    return this.center.items().map((item) => {
      const view = describe(item, context);
      const params = { ...view.params };
      if (params['by'] === undefined && view.byFallback) {
        params['by'] = this.t(view.byFallback);
      }
      const link = view.link;
      const query = link
        ? { ...this.csLink.paramsFor(link.path), ...link.query }
        : {};
      return {
        item,
        view,
        text: this.t(view.key, params),
        unread: item.attributes.readAt === null,
        query,
      };
    });
  });

  protected readonly groups = computed((): Group[] => {
    const now = new Date();
    const today: Row[] = [];
    const earlier: Row[] = [];
    for (const row of this.rows()) {
      (groupOf(row.item.attributes.createdAt, now) === 'today'
        ? today
        : earlier
      ).push(row);
    }
    const groups: Group[] = [];
    if (today.length > 0) {
      groups.push({
        id: 'today',
        label: this.t('editor.notifications.groups.today'),
        rows: today,
      });
    }
    if (earlier.length > 0) {
      groups.push({
        id: 'earlier',
        label: this.t('editor.notifications.groups.earlier'),
        rows: earlier,
      });
    }
    return groups;
  });

  constructor() {
    // The address opens it (and picks the filter): the first page is read again each time.
    effect(() => {
      const shown = this.visible() ? this.shown() : undefined;
      // A switch of the person reads their list (NotificationCenter starts over).
      this.meService.me();
      untracked(() => {
        if (shown === undefined) this.center.hide();
        else this.center.show(shown === 'unread');
      });
    });
  }

  /** Opens it (all notifications), or closes it when open. */
  toggle(): void {
    this.view.set({ notifications: this.visible() ? undefined : 'all' });
  }

  protected visibleChange(visible: boolean): void {
    if (!visible && this.shown() !== undefined) {
      this.view.set({ notifications: undefined });
    }
  }

  protected choose(value: string): void {
    const next = SHOWN.find((s): s is Shown => s === value);
    if (next) this.view.set({ notifications: next });
  }

  /**
   * Marks everything read. The button then disappears (nothing is unread), so focus moves to
   * the close button rather than falling out of the sheet.
   */
  protected markAll(event: Event): void {
    const header = (event.currentTarget as HTMLElement).parentElement;
    header?.querySelector<HTMLElement>('[z-sheet-close]')?.focus();
    void this.center.markAllRead();
  }

  /** Marks it read; its link (when it has one) opens what it is about, closing the sheet. */
  protected open(row: Row): void {
    void this.center.markRead(row.item.id);
    if (!row.view.link) this.view.set({ notifications: undefined });
  }

  protected onShortcut(event: KeyboardEvent): void {
    if (event.defaultPrevented || event.repeat) return;
    if (!isNotificationsShortcut(event)) return;
    if (this.meService.presence() !== 'person') return;
    event.preventDefault();
    this.toggle();
  }
}
