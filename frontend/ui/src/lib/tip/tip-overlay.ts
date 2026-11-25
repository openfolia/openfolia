import {
  type GlobalPositionStrategy,
  Overlay,
  OverlayContainer,
  type OverlayRef,
  type PositionStrategy,
  type ScrollStrategy,
} from '@angular/cdk/overlay';
import { LiveAnnouncer } from '@angular/cdk/a11y';
import { ComponentPortal } from '@angular/cdk/portal';
import {
  type ComponentRef,
  DOCUMENT,
  inject,
  Injectable,
  Injector,
  NgZone,
} from '@angular/core';

import { createTriggerOverlay } from '../core/trigger-overlay';
import { buildDropdownPositions } from '../dropdown-menu/dropdown-positions';
import {
  type TipAction,
  TipCardComponent,
  type TipContent,
} from './tip-card.component';
import { arrowFor, type Box, centredTop, clearOf } from './tip-geometry';

/**
 * How long the card fades and scales in or out (`duration-150` on the card). The overlay is
 * detached after this long, so tests advance timers by this amount.
 */
export const TIP_ANIMATION_MS = 150;

/** Why an open tip went: the person chose on it, pressed Escape, or its anchor scrolled out of view. */
export type TipCloseReason = 'action' | 'escape' | 'hidden' | 'closed';

/** The room the spotlight leaves around its anchor, in pixels. */
export const SPOTLIGHT_PADDING = 6;

/**
 * Elements a centred card keeps clear of (a sandbox's banner, say): the card goes below them.
 * Set the attribute on any element that must stay readable while a tour step is centred.
 */
export const KEEP_CLEAR_ATTRIBUTE = 'data-tip-keep-clear';

export interface TipOpenOptions {
  /** The element the card points at; null centres the card in the window. */
  readonly anchor: HTMLElement | null;
  readonly content: TipContent;
  /**
   * A tour step (#868): the page is dimmed around a soft cut-out over the anchor (or wholly, for
   * a centred step), and Escape ends it from anywhere on the page, not only inside the card.
   */
  readonly spotlight?: boolean;
  /**
   * Whether the card takes the focus as it opens (the default). False leaves it where it is: a
   * tour step that comes while the person types in the field it asks for (issue 869).
   */
  readonly focus?: boolean;
  /**
   * What the card must not cover (the sentence the person is changing, issue 869): its text,
   * asked again as the page scrolls or the caret moves. A card that would cover it moves below it
   * (or above, where there is no room below).
   */
  readonly keepClear?: () => HTMLElement | null;
  /** A choice on the card. The card stays open: the caller closes it or moves it on. */
  readonly onAction: (action: TipAction) => void;
  /**
   * The anchor left the page (a list drew its rows again): the caller points the card again
   * (`update`) or closes it. Asked once per anchor. Without it, the card goes
   * (`onDismiss('hidden')`).
   */
  readonly onAnchorGone?: () => void;
  /** Called once, when the card starts to go (not for `close()` the caller made itself). */
  readonly onDismiss: (reason: 'escape' | 'hidden') => void;
}

/** An open tip: moved on to another anchor and content (a tour's next step), or closed. */
export interface TipRef {
  /** The card's element while it is attached. */
  readonly element: HTMLElement | null;
  /** The element it points at now, or null while centred. */
  readonly anchor: HTMLElement | null;
  /** Swaps the content and the anchor: the card fades out and in again at its new place. */
  update(anchor: HTMLElement | null, content: TipContent): void;
  /** Closes it (exit animation, then detached); focus goes back where it was before it opened. */
  close(): void;
  readonly closed: boolean;
}

/** The classes the card's enter and exit animations hang on (`data-open`, `data-closed`). */
const MOTION = [
  'duration-150',
  'data-open:animate-in',
  'data-open:fade-in-0',
  'data-open:zoom-in-95',
  'data-closed:animate-out',
  'data-closed:fade-out-0',
  'data-closed:zoom-out-95',
  'motion-reduce:animate-none',
];

/**
 * The spotlight's colours (`.of-tour-spotlight` in `ui.css` holds the rest): the page dimmed by
 * a ring as wide as the window, in the dialogs' scrim colours (a little lighter, so the page
 * still reads as context), and a 2 px edge in the accent around the cut-out. An empty cut-out (a
 * centred step) loses the edge.
 */
const SPOTLIGHT_CLASSES = [
  'of-tour-spotlight',
  'ring-[200vmax]',
  'ring-foreground/30',
  'dark:ring-background/70',
  'ring-offset-2',
  'ring-offset-ring/70',
  'data-empty:ring-offset-0',
];

/** The gap between the card and its anchor: room for the arrow, and for the spotlight's edge. */
const GAP = 16;
/**
 * The card starts this far before its anchor along the side it opens on, so the arrow points out
 * of the card's first line instead of its rounded corner.
 */
const LEAD = -12;

/**
 * Shows a tip (#222) beside the element it is about: a `TipCardComponent` in an overlay placed
 * by `createTriggerOverlay` (it follows the element on scroll, flips where there is no room and
 * closes once the element has scrolled out of view), or centred in the window for a tip about
 * the whole page. One at a time: opening another closes the one before.
 *
 * - The card sits below its anchor, or beside it for an anchor in the sidebar (on the side away
 *   from it), never over it; a small arrow on its edge points at the anchor.
 * - A tour step (`spotlight`) dims the page around a cut-out over the anchor, in the theme's
 *   scrim colours (`.of-tour-spotlight` in `ui.css`); the cut-out glides from one step's anchor
 *   to the next. A centred step goes below anything marked `data-tip-keep-clear`.
 * - The card, the arrow and the cut-out follow the page on scroll and resize, and follow the anchor
 *   when the page moves it otherwise (a list loading in above it, its rows sliding: issue 903),
 *   frame by frame, so the card glides with a row that slides and settles once after a jump. An
 *   anchor that left the page is told to the caller (`onAnchorGone`), to point the card again;
 *   without it, the card goes (`onDismiss('hidden')`).
 * - The card fades and scales in and out (150 ms), at once under reduced motion; the cut-out
 *   moves at once too.
 * - Focus moves into the card as it opens, so it is announced (a dialog named by its title and
 *   described by its text), and goes back where it was when it closes, if it is still in the card
 *   or nowhere. A card that opens without the focus (`focus: false`) is announced politely
 *   instead, through the one live region the page shares (CDK's `LiveAnnouncer`).
 * - A card keeps clear of `keepClear` (the person's own edit), moving below or above it.
 * - Escape closes it (`onDismiss('escape')`): pressed in the card, or anywhere for a tour step.
 * - The page stays usable around it: neither the card nor the dimmed page takes its clicks.
 */
@Injectable({ providedIn: 'root' })
export class TipOverlay {
  private readonly overlay = inject(Overlay);
  private readonly container = inject(OverlayContainer);
  private readonly injector = inject(Injector);
  private readonly document = inject(DOCUMENT);
  private readonly zone = inject(NgZone);
  private readonly announcer = inject(LiveAnnouncer);

  private current: OpenTip | null = null;

  open(options: TipOpenOptions): TipRef {
    this.current?.close();
    const tip = new OpenTip(this, options);
    this.current = tip;
    return tip;
  }

  /** @internal The open tip ended. */
  ended(tip: OpenTip): void {
    if (this.current === tip) this.current = null;
  }

  /** @internal */
  reducedMotion(): boolean {
    return (
      this.document.defaultView?.matchMedia?.(
        '(prefers-reduced-motion: reduce)',
      ).matches ?? true
    );
  }

  /** @internal The strategies for a card at `anchor`, or centred. */
  strategies(
    anchor: HTMLElement | null,
    onHidden: () => void,
  ): { position: PositionStrategy; scroll: ScrollStrategy } {
    if (!anchor) {
      return {
        position: this.overlay
          .position()
          .global()
          .centerHorizontally()
          .centerVertically(),
        scroll: this.overlay.scrollStrategies.reposition(),
      };
    }
    const rtl = this.document.documentElement.dir === 'rtl';
    // Beside an anchor in the sidebar, so the card covers none of its neighbours.
    const beside = anchor.closest('[data-sidebar="sidebar"]') !== null;
    const { positionStrategy, scrollStrategy } = createTriggerOverlay(
      this.injector,
      {
        origin: anchor,
        positions: buildDropdownPositions(
          beside ? 'inline-end' : 'bottom',
          'start',
          GAP,
          rtl,
          LEAD,
        ),
        onTriggerHidden: () => this.zone.run(onHidden),
        // The page's own gutter on a phone, so the card lines up with the content.
        viewportMargin: 16,
      },
    );
    return { position: positionStrategy, scroll: scrollStrategy };
  }

  /** @internal */
  create(position: PositionStrategy, scroll: ScrollStrategy): OverlayRef {
    const ref = this.overlay.create({
      positionStrategy: position,
      scrollStrategy: scroll,
      hasBackdrop: false,
    });
    ref.addPanelClass(['isolate', 'z-50']);
    return ref;
  }

  /** @internal The overlay container, where the spotlight goes under the card. */
  containerElement(): HTMLElement {
    return this.container.getContainerElement();
  }

  /** @internal Says a card's words without moving the focus (the shared polite live region). */
  announce(message: string): void {
    void this.announcer.announce(message, 'polite');
  }

  /** @internal */
  get doc(): Document {
    return this.document;
  }

  /** @internal */
  get inj(): Injector {
    return this.injector;
  }

  /** @internal */
  get ngZone(): NgZone {
    return this.zone;
  }
}

class OpenTip implements TipRef {
  private overlayRef: OverlayRef | null = null;
  private card: ComponentRef<TipCardComponent> | null = null;
  private subscriptions: { unsubscribe(): void }[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private frame = 0;
  /** The frame that looks for the anchor having moved (`follow`). */
  private watch = 0;
  /** Where the anchor was when the card was last placed. */
  private placedAt: DOMRect | null = null;
  /** The anchor whose leaving the page was last told (`onAnchorGone`), so it is told once. */
  private gone: HTMLElement | null = null;
  private readonly returnFocus: HTMLElement | null;
  private readonly spotlight: HTMLElement | null;
  private readonly removeListeners: () => void;
  private current: HTMLElement | null;
  /** The content last announced or focused, so the same card is not announced twice. */
  private announced: string | null = null;
  closed = false;

  constructor(
    private readonly host: TipOverlay,
    private readonly options: TipOpenOptions,
  ) {
    const doc = host.doc;
    const active = doc.activeElement;
    this.returnFocus =
      active instanceof HTMLElement && active !== doc.body ? active : null;
    this.current = options.anchor;
    this.spotlight = options.spotlight ? this.makeSpotlight() : null;
    const view = doc.defaultView;
    const onChange = () => this.schedule();
    host.ngZone.runOutsideAngular(() => {
      view?.addEventListener('resize', onChange, { passive: true });
      doc.addEventListener('scroll', onChange, {
        capture: true,
        passive: true,
      });
      // The caret moved, or the sentence it is in grew a line: the card keeps clear of it.
      if (options.keepClear) doc.addEventListener('selectionchange', onChange);
    });
    this.removeListeners = () => {
      view?.removeEventListener('resize', onChange);
      doc.removeEventListener('scroll', onChange, { capture: true });
      doc.removeEventListener('selectionchange', onChange);
    };
    this.attach(options.anchor, options.content, options.focus ?? true);
    host.ngZone.runOutsideAngular(() => this.follow());
  }

  get element(): HTMLElement | null {
    return this.card?.instance.element ?? null;
  }

  get anchor(): HTMLElement | null {
    return this.current;
  }

  update(anchor: HTMLElement | null, content: TipContent): void {
    if (this.closed) return;
    const hadFocus = this.hasFocus();
    this.current = anchor;
    // The cut-out glides to the new anchor while the card fades out.
    this.placeSpotlight();
    this.leave(() => {
      this.detach();
      this.attach(anchor, content, hadFocus);
    });
  }

  close(): void {
    this.end(null);
  }

  private end(reason: 'escape' | 'hidden' | null): void {
    if (this.closed) return;
    this.closed = true;
    this.host.ended(this);
    this.removeListeners();
    cancelAnimationFrame(this.frame);
    cancelAnimationFrame(this.watch);
    const hadFocus =
      this.hasFocus() || this.host.doc.activeElement === this.host.doc.body;
    if (reason) this.options.onDismiss(reason);
    this.spotlight?.removeAttribute('data-open');
    this.leave(() => {
      this.detach();
      this.spotlight?.remove();
    });
    if (hadFocus && this.returnFocus?.isConnected) {
      this.returnFocus.focus({ preventScroll: true });
    }
  }

  private hasFocus(): boolean {
    const active = this.host.doc.activeElement;
    return !!active && !!this.overlayRef?.overlayElement.contains(active);
  }

  private attach(
    anchor: HTMLElement | null,
    content: TipContent,
    focus = true,
  ): void {
    const { position, scroll } = this.host.strategies(anchor, () =>
      this.end('hidden'),
    );
    const ref = this.host.create(position, scroll);
    this.overlayRef = ref;
    const card = ref.attach(
      new ComponentPortal(TipCardComponent, null, this.host.inj),
    );
    this.card = card;
    card.setInput('content', content);
    const element = card.instance.element;
    element.classList.add(...MOTION);
    element.toggleAttribute('data-centred', !anchor);
    element.setAttribute('data-open', '');
    this.subscriptions.push(
      card.instance.action.subscribe((action) => this.options.onAction(action)),
      ref.keydownEvents().subscribe((event) => {
        // The overlay's dispatcher hands it every key of the page: a tip takes only one in the
        // card, a tour step any the page has not handled itself.
        if (event.key !== 'Escape') return;
        const inCard =
          event.target instanceof Node && element.contains(event.target);
        if (!inCard && (!this.options.spotlight || event.defaultPrevented))
          return;
        event.preventDefault();
        event.stopPropagation();
        this.end('escape');
      }),
    );
    card.changeDetectorRef.detectChanges();
    ref.updatePosition();
    this.sync();
    // Placed: from now on a move to keep clear of the person's edit glides.
    element.classList.add(
      'transition-[translate]',
      'motion-reduce:transition-none',
    );
    if (focus) element.focus({ preventScroll: true });
    else if (this.announced !== content.id) this.announceCard(element);
    this.announced = content.id;
  }

  /** The card's title and text, said politely: it came without the focus, so nothing else says them. */
  private announceCard(element: HTMLElement): void {
    const text = (attribute: string) => {
      const id = element.getAttribute(attribute);
      return id
        ? (element.querySelector(`[id="${id}"]`)?.textContent?.trim() ?? '')
        : '';
    };
    const message = [text('aria-labelledby'), text('aria-describedby')]
      .filter(Boolean)
      .join('. ');
    if (message) this.host.announce(message);
  }

  /**
   * Looks once a frame for the anchor having moved in the layout, which no scroll or resize event
   * tells (issue 903): a list that loads in above it, rows that slide. A moved anchor places the
   * card, the arrow and the cut-out again; an anchor gone from the page is told
   * (`onAnchorGone`), or ends the card.
   * `shortcut: a frame-by-frame read of one box while a card is open, cheap next to a frame's
   * layout; an IntersectionObserver around the anchor's box would wake only on a move, if a page
   * ever opens many at once.`
   */
  private follow(): void {
    const view = this.host.doc.defaultView;
    if (this.closed || !view) return;
    this.watch = view.requestAnimationFrame(() => {
      this.watch = 0;
      const anchor = this.current;
      if (anchor && !anchor.isConnected) {
        if (!this.options.onAnchorGone) {
          this.host.ngZone.run(() => this.end('hidden'));
          return;
        }
        if (this.gone !== anchor) {
          this.gone = anchor;
          this.host.ngZone.run(() => this.options.onAnchorGone?.());
        }
      } else if (
        anchor &&
        // A card on its way out (between steps) stays where it was.
        !this.element?.hasAttribute('data-closed') &&
        moved(anchor.getBoundingClientRect(), this.placedAt)
      ) {
        this.overlayRef?.updatePosition();
        this.sync();
      }
      this.follow();
    });
  }

  /** One `sync` on the next frame, however many scroll and resize events come before it. */
  private schedule(): void {
    if (this.frame || this.closed) return;
    const view = this.host.doc.defaultView;
    if (!view) return;
    this.frame = view.requestAnimationFrame(() => {
      this.frame = 0;
      this.overlayRef?.updatePosition();
      this.sync();
    });
  }

  /** Puts the arrow, the cut-out and a centred card where the page now has them. */
  private sync(): void {
    const ref = this.overlayRef;
    const card = this.card;
    // A card on its way out (between steps) is not placed again: the next one is.
    if (!ref || !card || card.instance.element.hasAttribute('data-closed'))
      return;
    const anchor = this.current;
    this.placedAt = anchor?.getBoundingClientRect() ?? null;
    // The pane, not the card: the card is scaled while it animates in.
    const box = ref.overlayElement.getBoundingClientRect();
    if (!anchor) {
      const view = this.host.doc.defaultView;
      const height = view?.innerHeight ?? 0;
      const top = centredTop(box.height, height, this.keepClearBottom());
      const strategy = ref.getConfig().positionStrategy as
        GlobalPositionStrategy | undefined;
      strategy?.top(`${top}px`);
      ref.updatePosition();
      card.instance.arrow.set(null);
    } else {
      // Asked from where CDK put the pane (the card moves inside it), so it does not chase itself.
      const keep = this.options.keepClear?.();
      const shift = keep
        ? clearOf(
            box,
            textExtent(keep),
            this.host.doc.defaultView?.innerHeight ?? 0,
            GAP,
          )
        : 0;
      card.instance.element.style.translate = shift ? `0 ${shift}px` : '';
      // Moved clear of the person's edit, it no longer sits by its anchor: no arrow, the
      // spotlight shows what it is about.
      card.instance.arrow.set(
        shift ? null : arrowFor(box, anchor.getBoundingClientRect()),
      );
    }
    card.changeDetectorRef.detectChanges();
    this.placeSpotlight();
  }

  /** The lowest edge of what a centred card keeps clear of, or 0. */
  private keepClearBottom(): number {
    let bottom = 0;
    for (const element of Array.from(
      this.host.doc.querySelectorAll<HTMLElement>(`[${KEEP_CLEAR_ATTRIBUTE}]`),
    )) {
      const rect = element.getBoundingClientRect();
      if (rect.height > 0) bottom = Math.max(bottom, rect.bottom);
    }
    return bottom;
  }

  private makeSpotlight(): HTMLElement {
    const spotlight = this.host.doc.createElement('div');
    spotlight.classList.add(...SPOTLIGHT_CLASSES);
    spotlight.setAttribute('aria-hidden', 'true');
    spotlight.dataset['slot'] = 'tip-spotlight';
    const container = this.host.containerElement();
    container.insertBefore(spotlight, container.firstChild);
    // Placed before it shows, so it fades in where it belongs instead of gliding there.
    this.placeSpotlight(spotlight);
    // Forces the start state, so the fade in runs.
    void spotlight.offsetWidth;
    spotlight.setAttribute('data-open', '');
    return spotlight;
  }

  private placeSpotlight(spotlight = this.spotlight): void {
    if (!spotlight) return;
    const anchor = this.current;
    const view = this.host.doc.defaultView;
    const box: Box = anchor
      ? withinWindow(
          padded(anchor.getBoundingClientRect()),
          view?.innerWidth ?? 0,
          view?.innerHeight ?? 0,
        )
      : {
          // Centred: the cut-out closes to a point in the middle, so the whole page is dimmed.
          top: (view?.innerHeight ?? 0) / 2,
          left: (view?.innerWidth ?? 0) / 2,
          width: 0,
          height: 0,
        };
    spotlight.toggleAttribute('data-empty', !anchor);
    spotlight.style.top = `${box.top}px`;
    spotlight.style.left = `${box.left}px`;
    spotlight.style.width = `${box.width}px`;
    spotlight.style.height = `${box.height}px`;
  }

  /** Plays the exit animation, then `done`; at once under reduced motion. */
  private leave(done: () => void): void {
    clearTimeout(this.timer);
    const element = this.element;
    if (!element || this.host.reducedMotion()) {
      done();
      return;
    }
    element.removeAttribute('data-open');
    element.setAttribute('data-closed', '');
    this.timer = setTimeout(done, TIP_ANIMATION_MS);
  }

  private detach(): void {
    for (const s of this.subscriptions) s.unsubscribe();
    this.subscriptions = [];
    this.overlayRef?.dispose();
    this.overlayRef = null;
    this.card = null;
  }
}

/**
 * A box kept inside the window, `SPOTLIGHT_PADDING` from its edges: a lit anchor wider than the
 * screen (a table row on a phone, scrolling sideways in its own frame) shows a closed edge
 * instead of running off it.
 */
export function withinWindow(box: Box, width: number, height: number): Box {
  if (width <= 0 || height <= 0) return box;
  const left = Math.max(box.left, SPOTLIGHT_PADDING);
  const top = Math.max(box.top, SPOTLIGHT_PADDING);
  const right = Math.min(box.left + box.width, width - SPOTLIGHT_PADDING);
  const bottom = Math.min(box.top + box.height, height - SPOTLIGHT_PADDING);
  return {
    left,
    top,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
  };
}

/**
 * Where an element's text is (a paragraph's words, not the whole width of its column), so a card
 * beside a short sentence is not moved for the empty end of its line; the element's box where
 * the browser cannot say.
 */
function textExtent(element: HTMLElement): Box {
  const range = element.ownerDocument.createRange?.();
  range?.selectNodeContents(element);
  const text =
    typeof range?.getBoundingClientRect === 'function'
      ? range.getBoundingClientRect()
      : null;
  return text && text.height > 0 ? text : element.getBoundingClientRect();
}

/** Whether the anchor's box is no longer where the card was placed beside it (half a pixel's leeway). */
function moved(now: DOMRect, placed: DOMRect | null): boolean {
  if (!placed) return true;
  return (
    Math.abs(now.top - placed.top) > 0.5 ||
    Math.abs(now.left - placed.left) > 0.5 ||
    Math.abs(now.width - placed.width) > 0.5 ||
    Math.abs(now.height - placed.height) > 0.5
  );
}

/** A box grown by the spotlight's padding on every side. */
function padded(rect: Box): Box {
  return {
    top: rect.top - SPOTLIGHT_PADDING,
    left: rect.left - SPOTLIGHT_PADDING,
    width: rect.width + SPOTLIGHT_PADDING * 2,
    height: rect.height + SPOTLIGHT_PADDING * 2,
  };
}
