import { NgTemplateOutlet } from '@angular/common';
import {
  afterNextRender,
  booleanAttribute,
  type AfterRenderRef,
  ChangeDetectionStrategy,
  Component,
  computed,
  contentChild,
  DestroyRef,
  Directive,
  effect,
  ElementRef,
  inject,
  Injector,
  input,
  signal,
  TemplateRef,
  untracked,
} from '@angular/core';

import { defaultItemKey } from './item-key';
import { prefersReducedMotion } from './reduced-motion';

/** The width transition (ms), as the host's classes say. */
const MOVE_MS = 250;
/** The crossfade between two items (ms), as the layers' classes say. */
const SWAP_MS = 180;
/** Past the width transition: a closing whose `transitionend` never comes still ends. */
const LEAVE_FALLBACK_MS = MOVE_MS + 150;

/**
 * How long after a person's click or key press an opening still counts as theirs: it animates
 * and takes focus. Later (data arriving for an address, a resize) it opens at once, focus kept.
 */
const ACTION_WINDOW_MS = 1000;

/** The panel's width, also the content's while the panel grows and shrinks. */
const WIDTH = 'var(--of-side-panel-width, 20rem)';

export interface SidePanelContext<T> {
  $implicit: T;
}

/**
 * The content of a `of-side-panel`, and what it shows: null or undefined closes the panel.
 * `let-x` is the item, typed, kept on screen while the panel closes.
 *
 * `ofSidePanelContentKey` tells one item from another (by default its `id`, else the item
 * itself): a new key swaps the content with a crossfade, the same key only updates it.
 */
@Directive({ selector: 'ng-template[ofSidePanelContent]' })
export class SidePanelContentDirective<T> {
  readonly item = input<T | null | undefined>(undefined, {
    alias: 'ofSidePanelContent',
  });
  readonly ofSidePanelContentKey = input<(item: T) => unknown>(defaultItemKey);
  readonly template =
    inject<TemplateRef<SidePanelContext<NonNullable<T>>>>(TemplateRef);

  static ngTemplateContextGuard<T>(
    _directive: SidePanelContentDirective<T>,
    context: unknown,
  ): context is SidePanelContext<NonNullable<T>> {
    return true;
  }
}

interface Layer {
  readonly id: number;
  readonly key: unknown;
  readonly item: unknown;
  /** Swapped out: fading away over the item that replaced it, then removed. */
  readonly out: boolean;
  /** Swapped in over an item: fades in (an opening fades with the panel instead). */
  readonly swapIn: boolean;
}

/**
 * An inline panel beside a list (an item's details), opening and closing smoothly instead of
 * with a jump:
 *
 * - **Opening:** its width grows from nothing (250 ms) while the content fades and slides in a
 *   little, so the neighbour, a `flex-1` list, narrows with it. Focus moves into the panel.
 * - **Closing:** the reverse. The last item stays on screen, `inert`, until the width has
 *   shrunk, then the panel is gone (`display: none`). Focus goes back to what had it before the
 *   panel opened (the clicked row), when focus was in the panel.
 * - **Switching:** another item while open swaps the content in place with a short crossfade
 *   (180 ms); the panel stays open. The same item, updated, only updates.
 * - **Reduced motion:** opens, closes and swaps at once.
 * - **Not opened by the person** (created open, a deep link whose data arrives later, a resize
 *   that brings it back): open at once, focus left where it is. An opening counts as the
 *   person's within a second of a click, pointer press or key press anywhere in the page; even then focus
 *   never leaves a text field.
 * - **`takeFocus` false:** an opening leaves focus where it is (a toggle that stays beside it);
 *   a closing still gives focus back when it was in the panel.
 * - **`fill`:** the content fills the panel's height (the host stretched in its row, the content
 *   `h-full`), as a preview beside a document does.
 *
 * A neighbour that gives way while the panel opens (a column it replaces, `ofCollapseWidth`)
 * follows `opened()` and `animates()`, so both move in the same frames.
 *
 * The content keeps the panel's width while the panel grows and shrinks, so it never reflows.
 * Size it with custom properties on the host: `--of-side-panel-width` (default `20rem`);
 * `--of-side-panel-gap` (default `0px`), the parent's `gap` before the panel, closed along with
 * the width; and `--of-side-panel-closed-width` (default `0px`): `100%` where the panel is
 * stacked under the list (a narrow screen), so it only fades there.
 *
 * ```html
 * <div class="flex items-start gap-4">
 *   <of-list-frame class="min-w-0 flex-1" … />
 *   <of-side-panel class="[--of-side-panel-gap:1rem] xl:[--of-side-panel-width:21rem]">
 *     <ng-template [ofSidePanelContent]="selected()" let-item>
 *       <aside class="bg-card rounded-xl border p-4" aria-label="…">…{{ item.name }}…</aside>
 *     </ng-template>
 *   </of-side-panel>
 * </div>
 * ```
 */
@Component({
  selector: 'of-side-panel',
  imports: [NgTemplateOutlet],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    'data-slot': 'side-panel',
    '[attr.data-state]': 'state()',
    class:
      'shrink-0 overflow-clip transition-[width,margin-inline-start] duration-250 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none',
    '[class.hidden]': 'layers().length === 0',
    '[class.block]': 'layers().length > 0',
    '[style.width]':
      "expanded() ? WIDTH : 'var(--of-side-panel-closed-width, 0px)'",
    '[style.margin-inline-start]':
      "expanded() ? null : 'calc(-1 * var(--of-side-panel-gap, 0px))'",
    '(transitionend)': 'ended($event)',
  },
  template: `<div
    [class.h-full]="fill()"
    class="data-closed:opacity-0 data-closed:translate-x-3 rtl:data-closed:-translate-x-3 relative transition-[opacity,translate] duration-250 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none"
    [attr.data-closed]="expanded() ? null : ''"
    [style.width]="WIDTH"
  >
    @for (layer of layers(); track layer.id) {
      <div
        [class]="layerClass(layer)"
        [attr.data-layer]="layer.id"
        [attr.inert]="layer.out || leaving() ? '' : null"
        [attr.aria-hidden]="layer.out ? 'true' : null"
      >
        <ng-container
          *ngTemplateOutlet="
            content()?.template ?? null;
            context: { $implicit: layer.item }
          "
        />
      </div>
    }
  </div>`,
})
export class SidePanelComponent {
  /** An opening by the person moves focus into the panel; false leaves it where it is. */
  readonly takeFocus = input(true, { transform: booleanAttribute });
  /** The content fills the panel's height. */
  readonly fill = input(false, { transform: booleanAttribute });

  protected readonly WIDTH = WIDTH;
  protected readonly content = contentChild(SidePanelContentDirective);

  protected readonly layers = signal<readonly Layer[]>([]);
  /** At full width (the opening's first frame is not: it starts at none). */
  protected readonly expanded = signal(false);
  /** At full width or growing to it; false once it starts to shrink. */
  readonly opened = computed(() => this.expanded());
  /** Whether the last opening or closing moves (false: at once, as with reduced motion). */
  readonly animates = signal(false);
  /** Closing: the last item stays, inert, until the width has shrunk. */
  protected readonly leaving = signal(false);
  protected readonly state = computed(() =>
    this.layers().length === 0 ? 'closed' : this.leaving() ? 'closing' : 'open',
  );

  private readonly host =
    inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private readonly injector = inject(Injector);
  private seq = 0;
  private first = true;
  /** Had focus before the panel opened: it gets it back on close. */
  private opener: HTMLElement | null = null;
  private pending: AfterRenderRef | undefined;
  private focusPending: AfterRenderRef | undefined;
  /** When the person last clicked or pressed a key, and the control they clicked. */
  private lastAction = Number.NEGATIVE_INFINITY;
  private clicked: HTMLElement | null = null;
  private leaveTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly swapTimers = new Set<ReturnType<typeof setTimeout>>();

  constructor() {
    const act = (event: Event) => {
      this.lastAction = performance.now();
      if (event.type !== 'keydown' && event.target instanceof Element) {
        this.clicked = event.target.closest<HTMLElement>(
          'button, a[href], [tabindex], [role="option"], [role="row"]',
        );
      }
    };
    document.addEventListener('pointerdown', act, true);
    document.addEventListener('keydown', act, true);
    // A screen reader or voice control activates with a click alone.
    document.addEventListener('click', act, true);
    inject(DestroyRef).onDestroy(() => {
      document.removeEventListener('pointerdown', act, true);
      document.removeEventListener('keydown', act, true);
      document.removeEventListener('click', act, true);
      this.pending?.destroy();
      this.focusPending?.destroy();
      clearTimeout(this.leaveTimer);
      this.swapTimers.forEach(clearTimeout);
    });
    effect(() => {
      const directive = this.content();
      const item = directive?.item() ?? null;
      const keyOf = directive?.ofSidePanelContentKey() ?? defaultItemKey;
      untracked(() => this.sync(item, keyOf));
    });
  }

  protected layerClass(layer: Layer): string {
    const fill = this.fill();
    if (layer.out) {
      return `pointer-events-none absolute inset-x-0 top-0 ${fill ? 'bottom-0 ' : ''}animate-out fade-out-0 fill-mode-forwards duration-180 motion-reduce:animate-none`;
    }
    const height = fill ? 'h-full' : '';
    return layer.swapIn
      ? `${height} animate-in fade-in-0 duration-180 motion-reduce:animate-none`.trim()
      : height;
  }

  protected ended(event: TransitionEvent): void {
    if (event.target !== this.host || event.propertyName !== 'width') return;
    if (this.leaving()) this.finish();
  }

  private sync(item: unknown, keyOf: (item: never) => unknown): void {
    const first = this.first;
    this.first = false;
    const current = this.current();
    const byPerson =
      !first && performance.now() - this.lastAction <= ACTION_WINDOW_MS;
    // Opening without the person (a deep link's data arriving, a resize): at once.
    const instant = prefersReducedMotion() || (current ? first : !byPerson);

    if (item === null) {
      if (current && !this.leaving()) this.close(instant);
      return;
    }
    const key = keyOf(item as never);
    if (!current) {
      this.open(
        item,
        key,
        instant,
        byPerson && this.takeFocus() && !inTextField(),
      );
      return;
    }
    if (this.leaving()) {
      // Reopened while closing: grow back from where it is (the opener is kept).
      clearTimeout(this.leaveTimer);
      this.leaving.set(false);
      this.animates.set(!instant);
      this.expanded.set(true);
    }
    if (Object.is(key, current.key)) {
      this.layers.update((all) =>
        all.map((l) => (l.id === current.id ? { ...l, item } : l)),
      );
      return;
    }
    this.swap(current, item, key, instant);
  }

  private current(): Layer | undefined {
    return [...this.layers()].reverse().find((l) => !l.out);
  }

  private open(
    item: unknown,
    key: unknown,
    instant: boolean,
    focus: boolean,
  ): void {
    this.opener = focusedOutside(this.host) ?? this.recentlyClicked();
    this.layers.set([{ id: ++this.seq, key, item, out: false, swapIn: false }]);
    this.animates.set(!instant);
    if (instant) this.expanded.set(true);
    this.pending = afterNextRender(
      () => {
        this.pending = undefined;
        if (!instant) {
          // Shown at no width first, so the width has somewhere to grow from.
          void this.host.offsetWidth;
          this.expanded.set(true);
        }
        if (focus) this.focusIn();
      },
      { injector: this.injector },
    );
  }

  private close(instant: boolean): void {
    this.pending?.destroy();
    this.pending = undefined;
    this.focusPending?.destroy();
    this.focusPending = undefined;
    const active = document.activeElement;
    const focusWasIn =
      !active || active === document.body || this.host.contains(active);
    this.leaving.set(true);
    this.animates.set(!instant);
    this.expanded.set(false);
    if (focusWasIn && this.opener?.isConnected) {
      this.opener.focus({ preventScroll: true });
    }
    if (instant) this.finish();
    else this.leaveTimer = setTimeout(() => this.finish(), LEAVE_FALLBACK_MS);
  }

  private finish(): void {
    clearTimeout(this.leaveTimer);
    if (!this.leaving()) return;
    this.leaving.set(false);
    this.layers.set([]);
    this.opener = null;
  }

  /** The control clicked just now, outside the panel (a browser that doesn't focus on click). */
  private recentlyClicked(): HTMLElement | null {
    const clicked = this.clicked;
    return clicked &&
      clicked.isConnected &&
      !this.host.contains(clicked) &&
      performance.now() - this.lastAction <= ACTION_WINDOW_MS
      ? clicked
      : null;
  }

  private swap(
    current: Layer,
    item: unknown,
    key: unknown,
    instant: boolean,
  ): void {
    const focusWasIn = this.host.contains(document.activeElement);
    this.opener =
      focusedOutside(this.host) ?? this.recentlyClicked() ?? this.opener;
    const next: Layer = {
      id: ++this.seq,
      key,
      item,
      out: false,
      swapIn: !instant,
    };
    if (instant) {
      this.layers.set([next]);
    } else {
      this.layers.update((all) => [
        ...all.map((l) => (l.id === current.id ? { ...l, out: true } : l)),
        next,
      ]);
      const timer = setTimeout(() => {
        this.swapTimers.delete(timer);
        this.layers.update((all) => all.filter((l) => l.id !== current.id));
      }, SWAP_MS + 50);
      this.swapTimers.add(timer);
    }
    if (focusWasIn) {
      // Focus was in the content that left: it goes to the content that came.
      this.focusPending?.destroy();
      this.focusPending = afterNextRender(
        () => {
          this.focusPending = undefined;
          this.focusIn();
        },
        { injector: this.injector },
      );
    }
  }

  /** Focus to the current content's first element (made focusable if it isn't). */
  private focusIn(): void {
    const id = this.current()?.id;
    if (id === undefined) return;
    const layer = this.host.querySelector<HTMLElement>(`[data-layer="${id}"]`);
    const target =
      (layer?.firstElementChild as HTMLElement | null) ?? layer ?? null;
    if (!target) return;
    if (!target.hasAttribute('tabindex') && target.tabIndex < 0) {
      target.setAttribute('tabindex', '-1');
      target.classList.add('outline-none');
    }
    target.focus({ preventScroll: true });
  }
}

/** The focused element when it is a real one outside `host` (not the body). */
function focusedOutside(host: HTMLElement): HTMLElement | null {
  const active = document.activeElement;
  return active instanceof HTMLElement &&
    active !== document.body &&
    !host.contains(active)
    ? active
    : null;
}

/** Focus is in a field the person types in: an opening never takes it from there. */
function inTextField(): boolean {
  const active = document.activeElement;
  return (
    active instanceof HTMLElement &&
    (active.isContentEditable ||
      active instanceof HTMLTextAreaElement ||
      (active instanceof HTMLInputElement &&
        !['button', 'checkbox', 'radio', 'submit', 'reset'].includes(
          active.type,
        )))
  );
}
