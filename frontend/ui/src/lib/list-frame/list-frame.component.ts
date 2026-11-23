import { CdkScrollable } from '@angular/cdk/scrolling';
import { injectTranslate } from '../i18n/text.pipe';
import { TranslocoPipe } from '@jsverse/transloco';
import { NgTemplateOutlet } from '@angular/common';
import {
  afterNextRender,
  booleanAttribute,
  ChangeDetectionStrategy,
  Component,
  computed,
  contentChild,
  DestroyRef,
  Directive,
  effect,
  ElementRef,
  forwardRef,
  inject,
  Injector,
  input,
  output,
  signal,
  TemplateRef,
  untracked,
} from '@angular/core';

import { ZardButtonComponent } from '../button/button.component';
import { ZardSelectImports } from '../select/select.imports';
import { EmptyStateComponent } from '../states/empty-state.component';
import { ErrorStateComponent } from '../states/error-state.component';
import { NoAccessStateComponent } from '../states/no-access-state.component';
import { SkeletonRowsComponent } from '../states/skeleton-rows.component';
import { type StateErrorKind } from '../states/state-kind';
import { defaultItemKey } from '../smooth/item-key';
import { FadeInDirective } from '../smooth/fade-in.directive';
import { RefreshingDirective } from '../smooth/refreshing.directive';
import { prefersReducedMotion } from '../smooth/reduced-motion';
import { ListItemDirective, ListMotion } from './list-item.directive';

/** A removed item fades out (ms) before the others close the gap. */
const LEAVE_MS = 150;
/** The items that stay slide to their new place (ms). */
const MOVE_MS = 220;
/** An added item fades in (ms), once the others have mostly made room for it. */
const ENTER_MS = 220;
const ENTER_DELAY_MS = 130;
const EASE_OUT = 'cubic-bezier(0.2, 0, 0, 1)';

/**
 * Animates one item. A table row's divider is the table's (collapsed borders), so it would stay
 * behind while the row moves or fades: while it runs, `of-list-moving` (`ui.css`) hides that
 * border and draws the divider on the row's cells, which move and fade with it.
 */
function animateItem(
  element: HTMLElement,
  keyframes: Keyframe[],
  options: KeyframeAnimationOptions,
): Animation {
  const animation = element.animate(keyframes, options);
  // Only a row that draws a divider: not one without (a summary row above its details).
  if (
    element instanceof HTMLTableRowElement &&
    (element.classList.contains(MOVING) ||
      parseFloat(getComputedStyle(element).borderBottomWidth) > 0)
  ) {
    element.classList.add(MOVING);
    const done = () => {
      if (element.getAnimations?.().some((a) => a.playState === 'running')) {
        return;
      }
      // The border comes back at once, not through the row's colour transition.
      element.style.transition = 'none';
      element.classList.remove(MOVING);
      void element.offsetHeight;
      element.style.transition = '';
    };
    // A fade-out holds (`fill: forwards`) until the row is gone: its border stays hidden too.
    const holds = options.fill === 'forwards';
    animation.finished?.then(holds ? undefined : done, done);
  }
  return animation;
}
const MOVING = 'of-list-moving';

interface Shown<T> {
  readonly items: readonly T[];
  readonly page: ListFramePage | null;
}

/**
 * The paging of a JSON:API list. Same member names as the API's `meta.page`, so an app passes
 * `document.meta.page` as it is.
 */
export interface ListFramePage {
  currentPage: number;
  lastPage: number;
  perPage: number;
  total: number;
}

/** What the frame shows when a load failed; the editor maps its `ApiError` (`kind`, `message`) onto it. */
export interface ListFrameError {
  kind: StateErrorKind;
  message: string;
}

/** The row template: `<ng-template ofListRow let-item>…</ng-template>`. */
@Directive({ selector: 'ng-template[ofListRow]' })
export class ListRowDirective {
  readonly template = inject<TemplateRef<{ $implicit: unknown }>>(TemplateRef);
}

/**
 * The table template, for a list read as a table: `<ng-template ofListTable let-items>` with a
 * `<table z-table>` that renders `items` (the current page). The frame keeps the states, the
 * scroller and the pagination; the header row should stick (`sticky top-0`). Below the table's
 * width the scroller scrolls sideways inside the frame, never the page.
 */
@Directive({ selector: 'ng-template[ofListTable]' })
export class ListTableDirective {
  readonly template =
    inject<TemplateRef<{ $implicit: readonly unknown[] }>>(TemplateRef);
}

/**
 * The grid template, for a list read as tiles (images): `<ng-template ofListGrid let-items>`
 * that lays out `items` (the current page) itself, e.g. as a CSS grid. The frame keeps the
 * states (its skeleton is a grid of tiles), the scroller and the pagination.
 */
@Directive({ selector: 'ng-template[ofListGrid]' })
export class ListGridDirective {
  readonly template =
    inject<TemplateRef<{ $implicit: readonly unknown[] }>>(TemplateRef);
}

/**
 * The frame every list sits in. Its rows scroll inside the frame (capped to the remaining
 * viewport height, `overflow-y-auto`), the pagination sits below the scroller so it is always
 * visible, and long values wrap, so a page of any size never makes the page scroll. Loading,
 * empty, error (with retry) and no-access states are built in.
 *
 * Height: the frame is capped at `100dvh` minus `offset` (the space above it: header, title,
 * filters). Inside a parent with a bounded height (the app shell) it also shrinks to fit it.
 * The scroller is positioned, so it clips what its rows position absolutely too (an `sr-only`
 * status): else that escapes to the page's scroller and stretches it into empty space where it
 * sits, deep in the list (#563). Scrolling stops at its ends (`overscroll-contain`) instead of
 * going on to scroll the page.
 *
 * Rows come from `<ng-template ofListRow let-item>`, one list item each; a list read as a table
 * gives `<ng-template ofListTable let-items>` instead, and a list of tiles
 * `<ng-template ofListGrid let-items>`.
 *
 * **When a filter adds or removes items** (the same page, some items kept), the items move
 * instead of popping: a removed one fades out, then the others slide to close the gap; the others
 * slide to make room for an added one, which then fades in. Rows of `ofListRow` take part by
 * their key (`trackBy`, by default the item's `id`); a table's rows and a grid's tiles take part
 * with `[ofListItem]="item"`. Another page, a first answer or reduced motion: at once.
 */
@Component({
  selector: 'of-list-frame',
  imports: [
    CdkScrollable,
    TranslocoPipe,
    NgTemplateOutlet,
    ZardButtonComponent,
    ZardSelectImports,
    EmptyStateComponent,
    ErrorStateComponent,
    NoAccessStateComponent,
    SkeletonRowsComponent,
    FadeInDirective,
    RefreshingDirective,
    ListItemDirective,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [
    {
      provide: ListMotion,
      useExisting: forwardRef(() => ListFrameComponent),
    },
  ],
  host: {
    class:
      'flex min-h-0 min-w-0 max-w-full flex-col overflow-hidden text-card-foreground',
    // A list of rows sits in a card; a table carries its own header band and dividers, and
    // rows that are cards of their own (`cards`) need no card around them.
    '[class.rounded-lg]': 'framed()',
    '[class.border]': 'framed()',
    '[class.border-border]': 'framed()',
    '[class.bg-card]': 'framed()',
    '[style.max-height]': 'maxHeight()',
    '[attr.aria-busy]': 'loading() || null',
  },
  template: `
    <div
      class="relative min-h-0 flex-1 overflow-y-auto overscroll-contain"
      [class.overflow-x-hidden]="!table()"
      [class.overflow-x-auto]="!!table()"
      data-slot="list-scroller"
      cdkScrollable
      role="region"
      tabindex="0"
      [attr.aria-label]="labelText()"
    >
      @if (loading() && !refreshing() && grid()) {
        <!-- First load of tiles: tiles in their place, faded in after a moment. -->
        <div
          ofFadeIn="delayed"
          role="status"
          aria-busy="true"
          data-state="loading"
        >
          <span class="sr-only">{{
            'ui.listFrame.loading' | transloco: { label: labelText() }
          }}</span>
          <div class="grid grid-cols-2 gap-3 sm:grid-cols-3" aria-hidden="true">
            @for (tile of skeletonTiles(); track $index) {
              <div
                class="border-border flex flex-col gap-2 rounded-lg border p-1.5"
              >
                <span
                  class="bg-muted aspect-[8/5] animate-pulse rounded-md motion-reduce:animate-none"
                ></span>
                <span
                  class="bg-muted mb-1 h-3 w-2/3 animate-pulse rounded-sm motion-reduce:animate-none"
                ></span>
              </div>
            }
          </div>
        </div>
      } @else if (loading() && !refreshing()) {
        <!-- First load: placeholders, faded in after a moment so a quick answer never flashes them. -->
        <of-skeleton-rows
          [count]="skeletonRows()"
          [header]="!!table()"
          [tall]="!!table()"
          [label]="'ui.listFrame.loading' | transloco: { label: labelText() }"
        />
      } @else if (error(); as err) {
        @if (err.kind === 'unauthorized') {
          <of-no-access [message]="err.message" />
        } @else {
          <of-error-state
            [kind]="err.kind"
            [message]="err.message"
            (retry)="retry.emit()"
          />
        }
      } @else if (shown().length === 0) {
        <of-empty-state
          [title]="emptyTitle() || ('ui.states.empty.title' | transloco)"
          [description]="emptyDescription()"
        >
          <ng-content select="[ofListEmpty]" />
        </of-empty-state>
      } @else if (table(); as t) {
        <!-- Reloading keeps the rows on screen, dimmed, until the new ones arrive: no jump. -->
        <div
          class="[&_tbody_tr:last-child]:border-b!"
          ofFadeIn
          [ofRefreshing]="refreshing()"
        >
          <ng-container
            [ngTemplateOutlet]="t.template"
            [ngTemplateOutletContext]="{ $implicit: shown() }"
          />
        </div>
      } @else if (grid(); as g) {
        <!-- Reloading keeps the tiles on screen, dimmed, until the new ones arrive. -->
        <div ofFadeIn [ofRefreshing]="refreshing()">
          <ng-container
            [ngTemplateOutlet]="g.template"
            [ngTemplateOutletContext]="{ $implicit: shown() }"
          />
        </div>
      } @else if (row(); as r) {
        <ul
          class="m-0 list-none p-0"
          [class.flex]="cards()"
          [class.flex-col]="cards()"
          [class.gap-2]="cards()"
          ofFadeIn
          [ofRefreshing]="refreshing()"
        >
          @for (item of shown(); track keyOf(item)) {
            <li
              class="min-w-0 break-words [overflow-wrap:anywhere]"
              [ofListItem]="item"
              [class]="
                cards()
                  ? ''
                  : 'border-b border-border px-4 py-3 last:border-b-0'
              "
            >
              <ng-container
                [ngTemplateOutlet]="r.template"
                [ngTemplateOutletContext]="{ $implicit: item }"
              />
            </li>
          }
        </ul>
      }
    </div>
    @if (page(); as p) {
      @if (
        (!loading() || refreshing()) &&
        !error() &&
        (items().length > 0 || p.currentPage > 1)
      ) {
        <nav
          class="flex flex-wrap items-center justify-between gap-2 py-2 text-sm"
          [class.border-t]="framed()"
          [class.border-border]="framed()"
          [class.bg-card]="framed()"
          [class.px-4]="framed()"
          [class.px-1]="!framed()"
          data-slot="list-pagination"
          [attr.aria-label]="'ui.listFrame.pagination' | transloco"
        >
          <span class="text-muted-foreground" aria-live="polite">
            {{
              'ui.listFrame.pageOf'
                | transloco
                  : {
                      page: p.currentPage,
                      last: p.lastPage,
                      total: p.total,
                    }
            }}
          </span>
          <span class="flex flex-wrap items-center gap-2">
            @if (pageSizes().length > 0) {
              <span class="text-muted-foreground" aria-hidden="true">{{
                'ui.listFrame.rowsPerPage' | transloco
              }}</span>
              <z-select
                class="w-20"
                zPosition="popper"
                [zAriaLabel]="'ui.listFrame.rowsPerPage' | transloco"
                [zValue]="'' + p.perPage"
                [zDisabled]="loading()"
                (zSelectionChange)="changePageSize($event)"
              >
                @for (size of pageSizes(); track size) {
                  <z-select-item [zValue]="'' + size">{{ size }}</z-select-item>
                }
              </z-select>
            }
            <button
              z-button
              zType="outline"
              zSize="sm"
              [zDisabled]="p.currentPage <= 1 || loading()"
              (click)="pageChange.emit(p.currentPage - 1)"
            >
              {{ 'ui.listFrame.previous' | transloco }}
            </button>
            <button
              z-button
              zType="outline"
              zSize="sm"
              [zDisabled]="p.currentPage >= p.lastPage || loading()"
              (click)="pageChange.emit(p.currentPage + 1)"
            >
              {{ 'ui.listFrame.next' | transloco }}
            </button>
          </span>
        </nav>
      }
    }
  `,
})
export class ListFrameComponent<T = unknown> implements ListMotion {
  /** The resources of the current page (`document.data`). */
  readonly items = input.required<readonly T[]>();
  /**
   * Tells one item from another: by default its `id`, else the item itself. A row whose key
   * stays is kept (and moves), never drawn again. A table or grid template tracks its rows by
   * the same key; set it when the items have no stable `id`.
   */
  readonly trackBy = input<(item: T) => unknown>(defaultItemKey);
  /** `document.meta.page`. */
  readonly page = input<ListFramePage | null>(null);
  readonly loading = input(false);
  readonly error = input<ListFrameError | null>(null);
  /** Names the list for assistive technology and the loading announcement. */
  /** Default: "List", translated. */
  readonly label = input('');
  /** Default: "Nothing here yet", translated. */
  readonly emptyTitle = input('');
  readonly emptyDescription = input('');
  readonly skeletonRows = input(8);
  /** The space above the frame, as a CSS length (header, title, filters). */
  readonly offset = input('10rem');

  /**
   * Each row is a card of its own (the template draws it), set apart by a gap, with no card
   * around the list: a list of change sets, of a change set's modules.
   */
  readonly cards = input(false, { transform: booleanAttribute });

  /** Offers a page size choice (a Select) with these sizes in the pagination; none, none shown. */
  readonly pageSizes = input<readonly number[]>([]);

  readonly pageChange = output<number>();
  /** The size the person chose; the app loads page 1 with it (`page[size]`). */
  readonly pageSizeChange = output<number>();
  readonly retry = output<void>();

  protected changePageSize(value: string | string[]): void {
    const size = Number(Array.isArray(value) ? value[0] : value);
    if (Number.isInteger(size) && size > 0) this.pageSizeChange.emit(size);
  }

  /** One of three: rows (`ofListRow`), a table (`ofListTable`) or tiles (`ofListGrid`). */
  protected readonly row = contentChild(ListRowDirective);
  protected readonly table = contentChild(ListTableDirective);
  protected readonly grid = contentChild(ListGridDirective);
  protected readonly skeletonTiles = computed(() =>
    Array.from({ length: this.skeletonRows() }),
  );
  private readonly t = injectTranslate();
  /** Loading again while the last answer is still on screen: keep it, dimmed, instead of placeholders. */
  /** The list sits in a card: rows that are not cards themselves, and no table or tiles. */
  protected readonly framed = computed(
    () => !this.table() && !this.grid() && !this.cards(),
  );
  protected readonly refreshing = computed(
    () => this.loading() && !this.error() && this.items().length > 0,
  );
  protected readonly labelText = computed(
    () => this.label() || this.t('ui.listFrame.label'),
  );
  protected readonly maxHeight = computed(
    () => `calc(100dvh - ${this.offset()})`,
  );

  protected keyOf(item: T): unknown {
    return this.trackBy()(item);
  }

  // --- Moving items when a filter adds or removes some -------------------------------------

  private readonly host =
    inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private readonly injector = inject(Injector);
  private readonly registered = new Set<ListItemDirective>();
  /** The last page while its removed items fade out; null: `items` as they are. */
  private readonly held = signal<readonly T[] | null>(null);
  /** What the frame draws: `items`, or the last page while its removed items fade out. */
  protected readonly shown = computed(() => this.held() ?? this.items());
  /** What is on screen (or about to be, this render). */
  private onScreen: Shown<T> | null = null;
  private leaveTimer: ReturnType<typeof setTimeout> | undefined;
  private leaving: Animation[] = [];
  /** Counts the draws: a move measured for one draw never plays on a later one. */
  private draws = 0;

  constructor() {
    effect(() => {
      const items = this.items();
      const page = this.page();
      untracked(() => this.change({ items, page }));
    });
    inject(DestroyRef).onDestroy(() => this.stopLeaving());
  }

  register(item: ListItemDirective): void {
    this.registered.add(item);
  }

  unregister(item: ListItemDirective): void {
    this.registered.delete(item);
  }

  /** Runs before the render that would draw `next` (effects run before the view): the old rows are still there to measure. */
  private change(next: Shown<T>): void {
    this.stopLeaving();
    const before = this.onScreen;
    if (!before || !this.moves(before, next)) {
      this.show(next, false);
      return;
    }
    const keys = new Set(next.items.map((item) => this.keyOf(item)));
    const leaving = this.present().filter(
      (item) => !keys.has(this.keyOf(item.item() as T)),
    );
    if (leaving.length === 0) {
      this.show(next, true);
      return;
    }
    // Keep the last page on screen while its removed items fade out, then let the rest move.
    this.held.set(before.items);
    this.leaving = leaving.map((item) =>
      animateItem(item.element, [{ opacity: 1 }, { opacity: 0 }], {
        duration: LEAVE_MS,
        easing: 'ease-in',
        fill: 'forwards',
      }),
    );
    this.leaveTimer = setTimeout(() => {
      this.leaveTimer = undefined;
      this.show({ items: this.items(), page: this.page() }, true);
    }, LEAVE_MS);
  }

  /** Draws `next`; `move`: the items that stay slide from where they were, new ones fade in. */
  private show(next: Shown<T>, move: boolean): void {
    const from = move ? this.positions() : null;
    // The fade-outs that end with this draw: their items are gone once it has rendered.
    const faded = this.leaving;
    this.leaving = [];
    const draw = ++this.draws;
    this.onScreen = next;
    this.held.set(null);
    afterNextRender(
      {
        write: () => {
          // Nothing may stay faded out (an item that was to leave but is still drawn).
          for (const animation of faded) animation.cancel();
          if (from && draw === this.draws) this.play(from);
        },
      },
      { injector: this.injector },
    );
  }

  /** Whether going from `before` to `next` moves items, rather than switching at once. */
  private moves(before: Shown<T>, next: Shown<T>): boolean {
    if (typeof this.host.animate !== 'function' || prefersReducedMotion()) {
      return false;
    }
    if (this.registered.size === 0) return false;
    if (before.items.length === 0 || next.items.length === 0) return false;
    // Another page (or page size) is another list: it switches at once, as it always did.
    if (
      (before.page?.currentPage ?? 1) !== (next.page?.currentPage ?? 1) ||
      (before.page?.perPage ?? 0) !== (next.page?.perPage ?? 0)
    ) {
      return false;
    }
    const kept = new Set(before.items.map((item) => this.keyOf(item)));
    return next.items.some((item) => kept.has(this.keyOf(item)));
  }

  private stopLeaving(): void {
    if (this.leaveTimer !== undefined) clearTimeout(this.leaveTimer);
    this.leaveTimer = undefined;
    for (const animation of this.leaving) animation.cancel();
    this.leaving = [];
  }

  /** The registered items that are on screen in this frame. */
  private present(): ListItemDirective[] {
    return [...this.registered].filter((item) =>
      this.host.contains(item.element),
    );
  }

  private scroller(): HTMLElement | null {
    return this.host.querySelector<HTMLElement>('[data-slot="list-scroller"]');
  }

  /** Each item's place inside the scroller's content, unaffected by its scrolling. */
  private positions(): Map<HTMLElement, { x: number; y: number }> {
    const scroller = this.scroller();
    const places = new Map<HTMLElement, { x: number; y: number }>();
    if (!scroller) return places;
    const origin = scroller.getBoundingClientRect();
    for (const item of this.present()) {
      places.set(item.element, this.place(item.element, scroller, origin));
    }
    return places;
  }

  private place(
    element: HTMLElement,
    scroller: HTMLElement,
    origin: DOMRect,
  ): { x: number; y: number } {
    const rect = element.getBoundingClientRect();
    return {
      x: rect.left - origin.left + scroller.scrollLeft,
      y: rect.top - origin.top + scroller.scrollTop,
    };
  }

  /** FLIP: each item that stayed starts where it was and slides to its place; new ones fade in. */
  private play(from: Map<HTMLElement, { x: number; y: number }>): void {
    const scroller = this.scroller();
    if (!scroller) return;
    const origin = scroller.getBoundingClientRect();
    const added: HTMLElement[] = [];
    let moved = false;
    for (const { element } of this.present()) {
      const was = from.get(element);
      if (!was) {
        added.push(element);
        continue;
      }
      const now = this.place(element, scroller, origin);
      const dx = was.x - now.x;
      const dy = was.y - now.y;
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
      moved = true;
      animateItem(
        element,
        [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }],
        { duration: MOVE_MS, easing: EASE_OUT },
      );
    }
    for (const element of added) {
      animateItem(element, [{ opacity: 0 }, { opacity: 1 }], {
        duration: ENTER_MS,
        delay: moved ? ENTER_DELAY_MS : 0,
        easing: 'ease-out',
        fill: 'backwards',
      });
    }
  }
}
