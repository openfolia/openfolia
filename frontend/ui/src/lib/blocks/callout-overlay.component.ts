import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  computed,
  inject,
  input,
  linkedSignal,
  output,
} from '@angular/core';

import { injectTranslate } from '../i18n/text.pipe';

/** A point on an image, from 0 to 1 across and down it. */
export interface CalloutOverlayPoint {
  readonly x: number;
  readonly y: number;
}

/** One callout on the picture, as the overlay draws it. */
export interface CalloutOverlayMarker {
  readonly id: string;
  /** The number it reads as; null when the chosen variant hides it (drawn faded, as "–"). */
  readonly number: number | null;
  readonly anchor: CalloutOverlayPoint;
  /** Where its number sits, with a leader line to the anchor; null: the number is at the anchor. */
  readonly label: CalloutOverlayPoint | null;
  /** Its legend's words, read with its name. */
  readonly legend: string;
}

/** A point of a callout moved (by a drag or an arrow key) to a new place. */
export interface CalloutOverlayMove {
  readonly id: string;
  readonly which: 'anchor' | 'label';
  readonly point: CalloutOverlayPoint;
}

type Handle = 'anchor' | 'label';

/** Past this many pixels a press on a handle is a drag, not a click. */
const DRAG_SLOP = 3;

/** Within the picture, to 1/10,000 of it (as the content model keeps a point). */
const clamp = (v: number) =>
  Math.round(Math.min(1, Math.max(0, v)) * 10_000) / 10_000;

/**
 * The callouts over an image (#498): a numbered marker for each, at its label with a leader line
 * to its anchor, or at its anchor. Put it over the picture (`of-image-block` projects it with
 * the `ofImageOverlay` attribute) and it takes the picture's size, so it is right at any width.
 *
 * Read-only (`editable` false) it only shows. Editable, every marker and anchor is a button in the
 * tab order, named "Callout 2, label: Inlet": focusing one selects it (`selectedChange`), dragging it
 * moves it (`move`, once, on release: while dragged only the handle and its line follow the
 * pointer, nothing else moves), the arrow keys nudge it by `step` (with Shift, by `largeStep`) and
 * Delete or Backspace removes it (`remove`). With `adding`, a click on the picture outside the
 * markers emits `add` with the point. A callout the variant hides (`number` null) is drawn
 * faded, as "–". It owns no data: the host changes the callouts and hands them back. Colours come
 * from the theme. Hovering or focusing a marker emits `hoverChange` (read-only too: the pointer
 * still goes through to the picture, and the marker under it is found by its box), and the
 * `highlighted` callout is drawn larger with a ring (#549), eased only without reduced motion;
 * nothing else animates.
 */
@Component({
  selector: 'of-callout-overlay',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'absolute inset-0 block select-none',
    'data-slot': 'callout-overlay',
    '[class.pointer-events-none]': '!editable()',
    '[attr.aria-hidden]': 'editable() ? null : "true"',
    '[attr.role]': 'editable() ? "group" : null',
    '[attr.aria-label]': 'editable() ? groupLabel() : null',
  },
  template: `
    @if (adding() && editable()) {
      <div
        class="absolute inset-0 cursor-crosshair"
        data-slot="callout-add-area"
        (pointerdown)="addDown($event)"
        (pointerup)="addUp($event)"
      ></div>
    }
    <svg
      class="pointer-events-none absolute inset-0 h-full w-full overflow-visible"
      aria-hidden="true"
      width="100%"
      height="100%"
    >
      @for (m of shown(); track m.id) {
        @if (m.label) {
          <line
            class="motion-safe:transition-[stroke-width] motion-safe:duration-150"
            [attr.x1]="m.anchor.x * 100 + '%'"
            [attr.y1]="m.anchor.y * 100 + '%'"
            [attr.x2]="m.label.x * 100 + '%'"
            [attr.y2]="m.label.y * 100 + '%'"
            [class.opacity-50]="m.number === null"
            [class.stroke-primary]="highlighted() !== m.id"
            [class.stroke-ring]="highlighted() === m.id"
            [attr.stroke-width]="highlighted() === m.id ? 3 : 1.5"
            [attr.data-highlighted]="highlighted() === m.id ? '' : null"
          />
        }
      }
    </svg>
    @for (m of shown(); track m.id) {
      @if (m.label) {
        <button
          type="button"
          class="border-background bg-primary absolute size-3 -translate-x-1/2 -translate-y-1/2 touch-none rounded-full border-2 outline-none focus-visible:ring-2 focus-visible:ring-ring"
          data-slot="callout-anchor"
          [attr.data-callout]="m.id"
          [attr.data-highlighted]="highlighted() === m.id ? '' : null"
          [class.opacity-50]="m.number === null"
          [class.ring-2]="selected() === m.id || highlighted() === m.id"
          [class.ring-ring]="selected() === m.id || highlighted() === m.id"
          [class.cursor-grab]="editable()"
          [style.left.%]="m.anchor.x * 100"
          [style.top.%]="m.anchor.y * 100"
          [attr.tabindex]="editable() ? null : -1"
          [attr.aria-label]="anchorName(m)"
          [attr.aria-keyshortcuts]="editable() ? keys : null"
          (focus)="focused(m)"
          (blur)="hover(null)"
          (pointerenter)="hover(m.id)"
          (pointerleave)="hover(null)"
          (pointerdown)="down($event, m, 'anchor')"
          (pointermove)="drag($event)"
          (pointerup)="up($event)"
          (pointercancel)="cancel()"
          (keydown)="key($event, m, 'anchor')"
        ></button>
      }
      <button
        type="button"
        class="absolute inline-flex h-6 min-w-6 -translate-x-1/2 -translate-y-1/2 touch-none items-center justify-center rounded-full border-2 px-1 text-xs font-semibold tabular-nums shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 ring-offset-background motion-safe:transition-[scale,box-shadow] motion-safe:duration-150"
        data-slot="callout-marker"
        [attr.data-callout]="m.id"
        [attr.data-highlighted]="highlighted() === m.id ? '' : null"
        [class.scale-125]="highlighted() === m.id"
        [class.ring-offset-1]="highlighted() === m.id"
        [class.border-background]="m.number !== null"
        [class.bg-primary]="m.number !== null"
        [class.text-primary-foreground]="m.number !== null"
        [class.border-dashed]="m.number === null"
        [class.border-muted-foreground]="m.number === null"
        [class.bg-muted]="m.number === null"
        [class.text-muted-foreground]="m.number === null"
        [class.ring-2]="selected() === m.id || highlighted() === m.id"
        [class.ring-ring]="selected() === m.id || highlighted() === m.id"
        [class.cursor-grab]="editable()"
        [style.left.%]="(m.label ?? m.anchor).x * 100"
        [style.top.%]="(m.label ?? m.anchor).y * 100"
        [attr.tabindex]="editable() ? null : -1"
        [attr.aria-label]="markerName(m)"
        [attr.aria-keyshortcuts]="editable() ? keys : null"
        (focus)="focused(m)"
        (blur)="hover(null)"
        (pointerenter)="hover(m.id)"
        (pointerleave)="hover(null)"
        (pointerdown)="down($event, m, m.label ? 'label' : 'anchor')"
        (pointermove)="drag($event)"
        (pointerup)="up($event)"
        (pointercancel)="cancel()"
        (keydown)="key($event, m, m.label ? 'label' : 'anchor')"
      >
        {{ m.number ?? '–' }}
      </button>
    }
  `,
})
export class CalloutOverlayComponent {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly t = injectTranslate();

  readonly markers = input<readonly CalloutOverlayMarker[]>([]);
  /** Whether the markers can be selected, moved and removed. */
  readonly editable = input(false);
  /** Whether a click on the picture adds a callout there. */
  readonly adding = input(false);
  /** The selected callout's ID. */
  readonly selected = input<string | null>(null);
  /**
   * The highlighted callout's ID (#549): its legend entry or a reference to it is hovered or
   * focused elsewhere. Drawn larger, with a ring and bolder digits, never by colour alone.
   */
  readonly highlighted = input<string | null>(null);
  /** How far an arrow key moves a point, and with Shift. */
  readonly step = input(0.01);
  readonly largeStep = input(0.05);
  /** The group's accessible name; empty: "Callouts". */
  readonly label = input('');

  readonly add = output<CalloutOverlayPoint>();
  readonly move = output<CalloutOverlayMove>();
  readonly selectedChange = output<string>();
  readonly remove = output<string>();
  /**
   * The callout under the pointer or holding the focus (a marker or an anchor, editable or not),
   * or null once it leaves: for the host to highlight its legend entry and references (#549).
   */
  readonly hoverChange = output<string | null>();

  protected readonly keys =
    'ArrowUp ArrowDown ArrowLeft ArrowRight Shift+ArrowUp Delete';

  /** The point being dragged, drawn in place of the stored one until it is let go. */
  private readonly dragged = linkedSignal<
    readonly CalloutOverlayMarker[],
    { id: string; which: Handle; point: CalloutOverlayPoint } | null
  >({
    // New callouts from the host: the moved one is drawn where it is stored now.
    source: this.markers,
    computation: () => null,
  });
  private press: {
    id: string;
    which: Handle;
    x: number;
    y: number;
    moved: boolean;
    pointer: number;
  } | null = null;
  private addPress: { x: number; y: number } | null = null;
  /** The marker the pointer is over while read-only (found by its box, see the constructor). */
  private pointed: string | null = null;

  constructor() {
    // Read-only, the overlay lets the pointer through to the picture (a click selects the image,
    // a double click edits it), so its markers take no pointer events: the one under the pointer
    // is found by its box (#549). The overlay is projected over the picture only once it is
    // shown, so the pointer is followed on the document, and only within the overlay's box.
    const doc = this.host.nativeElement.ownerDocument;
    const move = (event: PointerEvent) => {
      if (this.editable()) return;
      this.point(this.markerAt(event.clientX, event.clientY));
    };
    const leave = (event: PointerEvent) => {
      // Out of the window: nothing is under the pointer.
      if (!event.relatedTarget && !this.editable()) this.point(null);
    };
    doc.addEventListener('pointermove', move, { passive: true });
    doc.addEventListener('pointerout', leave, { passive: true });
    inject(DestroyRef).onDestroy(() => {
      doc.removeEventListener('pointermove', move);
      doc.removeEventListener('pointerout', leave);
    });
  }

  /** The callout whose marker or anchor is at this point of the screen, or null. */
  private markerAt(x: number, y: number): string | null {
    const own = this.host.nativeElement.getBoundingClientRect();
    // A marker sits on the picture's edge at most half outside it.
    const slack = 16;
    if (
      x < own.left - slack ||
      x > own.right + slack ||
      y < own.top - slack ||
      y > own.bottom + slack
    )
      return null;
    const handles = this.host.nativeElement.querySelectorAll<HTMLElement>(
      '[data-slot="callout-marker"], [data-slot="callout-anchor"]',
    );
    for (const handle of handles) {
      const box = handle.getBoundingClientRect();
      if (x >= box.left && x <= box.right && y >= box.top && y <= box.bottom)
        return handle.dataset['callout'] ?? null;
    }
    return null;
  }

  private point(id: string | null): void {
    if (id === this.pointed) return;
    this.pointed = id;
    this.hoverChange.emit(id);
  }

  protected readonly groupLabel = computed(
    () => this.label() || this.t('ui.blocks.callouts.group'),
  );

  /** The markers, the one being dragged where the pointer is. */
  protected readonly shown = computed(() => {
    const drag = this.dragged();
    return this.markers().map((m) =>
      drag && drag.id === m.id
        ? drag.which === 'anchor'
          ? { ...m, anchor: drag.point }
          : { ...m, label: drag.point }
        : m,
    );
  });

  protected anchorName(m: CalloutOverlayMarker): string {
    return this.nameOf(m, 'anchor');
  }

  protected markerName(m: CalloutOverlayMarker): string {
    return this.nameOf(m, m.label ? 'label' : 'marker');
  }

  private nameOf(
    m: CalloutOverlayMarker,
    part: 'anchor' | 'label' | 'marker',
  ): string {
    const name = this.t('ui.blocks.callouts.handle', {
      number: m.number ?? '–',
      part,
      hidden: m.number === null ? 'yes' : 'no',
    });
    return m.legend ? `${name}: ${m.legend}` : name;
  }

  /** The point under a pointer event, from 0 to 1 over the picture. */
  private pointAt(event: PointerEvent): CalloutOverlayPoint {
    const box = this.host.nativeElement.getBoundingClientRect();
    const x = box.width > 0 ? (event.clientX - box.left) / box.width : 0;
    const y = box.height > 0 ? (event.clientY - box.top) / box.height : 0;
    return { x: clamp(x), y: clamp(y) };
  }

  protected focused(m: CalloutOverlayMarker): void {
    this.hover(m.id);
    if (this.editable() && this.selected() !== m.id)
      this.selectedChange.emit(m.id);
  }

  protected hover(id: string | null): void {
    this.hoverChange.emit(id);
  }

  protected down(
    event: PointerEvent,
    m: CalloutOverlayMarker,
    which: Handle,
  ): void {
    if (!this.editable() || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    (event.currentTarget as HTMLElement).focus({ preventScroll: true });
    (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
    this.press = {
      id: m.id,
      which,
      x: event.clientX,
      y: event.clientY,
      moved: false,
      pointer: event.pointerId,
    };
  }

  protected drag(event: PointerEvent): void {
    const press = this.press;
    if (!press || press.pointer !== event.pointerId) return;
    if (
      !press.moved &&
      Math.hypot(event.clientX - press.x, event.clientY - press.y) < DRAG_SLOP
    )
      return;
    press.moved = true;
    this.dragged.set({
      id: press.id,
      which: press.which,
      point: this.pointAt(event),
    });
  }

  protected up(event: PointerEvent): void {
    const press = this.press;
    if (!press || press.pointer !== event.pointerId) return;
    event.stopPropagation();
    this.press = null;
    const drag = this.dragged();
    if (press.moved && drag) {
      this.move.emit({ id: drag.id, which: drag.which, point: drag.point });
    } else if (this.selected() !== press.id) {
      this.selectedChange.emit(press.id);
    }
    this.settle();
  }

  protected cancel(): void {
    this.press = null;
    this.dragged.set(null);
  }

  protected key(
    event: KeyboardEvent,
    m: CalloutOverlayMarker,
    which: Handle,
  ): void {
    if (!this.editable()) return;
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      event.stopPropagation();
      this.remove.emit(m.id);
      return;
    }
    const by = event.shiftKey ? this.largeStep() : this.step();
    const delta: Record<string, [number, number]> = {
      ArrowLeft: [-by, 0],
      ArrowRight: [by, 0],
      ArrowUp: [0, -by],
      ArrowDown: [0, by],
    };
    const d = Object.hasOwn(delta, event.key) ? delta[event.key] : undefined;
    if (!d || event.altKey || event.ctrlKey || event.metaKey) return;
    event.preventDefault();
    event.stopPropagation();
    // From where it is drawn: keys pressed in quick succession arrive before the host hands
    // back the moved callout, and each goes on from the last.
    const now = this.shown().find((s) => s.id === m.id) ?? m;
    const from = which === 'label' && now.label ? now.label : now.anchor;
    const point = { x: clamp(from.x + d[0]), y: clamp(from.y + d[1]) };
    this.dragged.set({ id: m.id, which, point });
    this.move.emit({ id: m.id, which, point });
    this.settle();
  }

  /** The moved point stays drawn until the host hands it back, or the next frame. */
  private settle(): void {
    const view = this.host.nativeElement.ownerDocument.defaultView;
    if (view?.requestAnimationFrame)
      view.requestAnimationFrame(() => this.dragged.set(null));
    else this.dragged.set(null);
  }

  protected addDown(event: PointerEvent): void {
    if (event.button !== 0) return;
    event.preventDefault();
    this.addPress = { x: event.clientX, y: event.clientY };
  }

  protected addUp(event: PointerEvent): void {
    const press = this.addPress;
    this.addPress = null;
    if (
      !press ||
      Math.hypot(event.clientX - press.x, event.clientY - press.y) >= DRAG_SLOP
    )
      return;
    this.add.emit(this.pointAt(event));
  }
}
