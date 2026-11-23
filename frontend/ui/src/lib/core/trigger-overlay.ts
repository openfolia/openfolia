import {
  type ConnectedOverlayPositionChange,
  type ConnectedPosition,
  FlexibleConnectedPositionStrategy,
  OverlayContainer,
  type OverlayRef,
  type ScrollStrategy,
} from '@angular/cdk/overlay';
import { coerceCssPixelValue } from '@angular/cdk/coercion';
import { Platform } from '@angular/cdk/platform';
import { ViewportRuler } from '@angular/cdk/scrolling';
import {
  DOCUMENT,
  type ElementRef,
  type Injector,
  NgZone,
} from '@angular/core';

import type { Subscription } from 'rxjs';

/**
 * The one way a panel anchored to a trigger (dropdown menu, submenu, popover, select) is placed
 * and kept in place while the page scrolls:
 *
 * - it follows the trigger: every scroll, of the window or of any container around the trigger,
 *   repositions it against the trigger's new place;
 * - it flips to another of its positions when the preferred one has no room, and is never pushed
 *   away from the trigger to stay on screen; it may only slide along the trigger's edge, and only
 *   as far as it still overlaps the trigger there;
 * - once the trigger has scrolled out of view, `onTriggerHidden` closes it.
 */
export interface TriggerOverlayOptions {
  /** The element the panel is anchored to. */
  origin: ElementRef<HTMLElement> | HTMLElement;
  /** The preferred position first, then the fallbacks, as CDK connected positions. */
  positions: ConnectedPosition[];
  /**
   * Called (inside the Angular zone) once the trigger is out of view. It closes the panel the way
   * the component always does (its exit animation included); the scroll strategy stops listening.
   */
  onTriggerHidden: () => void;
  /** The gap the panel keeps to the viewport's edges, in pixels. 8 by default. */
  viewportMargin?: number;
}

export interface TriggerOverlayStrategies {
  positionStrategy: TriggerPositionStrategy;
  scrollStrategy: FollowTriggerScrollStrategy;
}

const DEFAULT_VIEWPORT_MARGIN = 8;

/** The position and scroll strategy every trigger-anchored overlay passes to `Overlay.create`. */
export function createTriggerOverlay(
  injector: Injector,
  options: TriggerOverlayOptions,
): TriggerOverlayStrategies {
  return {
    positionStrategy: createTriggerPositionStrategy(
      injector,
      options.origin,
      options.positions,
      options.viewportMargin,
    ),
    scrollStrategy: createFollowTriggerScrollStrategy(
      injector,
      options.origin,
      options.onTriggerHidden,
    ),
  };
}

/**
 * The position half of `createTriggerOverlay`, for an overlay that swaps its position strategy
 * while it keeps its scroll strategy (the select does, for item alignment).
 */
export function createTriggerPositionStrategy(
  injector: Injector,
  origin: ElementRef<HTMLElement> | HTMLElement,
  positions: ConnectedPosition[],
  viewportMargin = DEFAULT_VIEWPORT_MARGIN,
): TriggerPositionStrategy {
  return (
    new TriggerPositionStrategy(
      toElement(origin),
      viewportMargin,
      injector.get(ViewportRuler),
      injector.get(DOCUMENT),
      injector.get(Platform),
      injector.get(OverlayContainer),
    )
      .withPositions(positions)
      // Exact positions: the panel keeps its size and flips instead of shrinking to a sliver.
      .withFlexibleDimensions(false)
      // Never pushed into the viewport: that is what tore it off its trigger on scroll.
      .withPush(false)
      .withViewportMargin(viewportMargin) as TriggerPositionStrategy
  );
}

/** The scroll half of `createTriggerOverlay`. */
export function createFollowTriggerScrollStrategy(
  injector: Injector,
  origin: ElementRef<HTMLElement> | HTMLElement,
  onTriggerHidden: () => void,
): FollowTriggerScrollStrategy {
  return new FollowTriggerScrollStrategy(
    toElement(origin),
    injector.get(DOCUMENT),
    injector.get(NgZone),
    onTriggerHidden,
  );
}

/**
 * Moves the focus to `element` without scrolling to it: where the focus goes when a panel closed
 * because its trigger scrolled away, so the page does not jump back.
 */
export function focusWithoutScrolling(
  element: HTMLElement | null | undefined,
): void {
  element?.focus({ preventScroll: true });
}

/** Whether the focus is inside the overlay's pane. */
export function overlayHasFocus(overlayRef: OverlayRef | undefined): boolean {
  const pane = overlayRef?.overlayElement;
  const active = pane?.ownerDocument.activeElement;
  return !!pane && !!active && pane.contains(active);
}

/** A span on one axis, in viewport pixels. */
export interface Span {
  start: number;
  end: number;
}

/**
 * How far to slide the panel along the trigger's edge so it stays inside `[min, max]`, without
 * ever losing its overlap with the trigger on that axis (so it never floats beside nothing).
 * A panel longer than the room left keeps its start in view.
 */
export function slideAlongTrigger(
  panel: Span,
  trigger: Span,
  min: number,
  max: number,
): number {
  let shift = 0;
  if (panel.end - panel.start > max - min || panel.start < min) {
    shift = min - panel.start;
  } else if (panel.end > max) {
    shift = max - panel.end;
  }
  // Keep at least the panel's edge over the trigger's: it slides along it, never off it.
  const lowest = trigger.start - panel.end;
  const highest = trigger.end - panel.start;
  return Math.round(Math.min(Math.max(shift, lowest), highest));
}

/** The rectangle a trigger is seen through: the viewport, or a clipping container. */
export interface ClipRect {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/** Whether `rect` lies wholly outside at least one of the rectangles it is seen through. */
export function isOutsideView(rect: ClipRect, clips: ClipRect[]): boolean {
  return clips.some(
    (clip) =>
      rect.bottom <= clip.top ||
      rect.top >= clip.bottom ||
      rect.right <= clip.left ||
      rect.left >= clip.right,
  );
}

/** Whether a connected position puts the panel above or below the trigger (else beside it). */
function isVerticalSide(position: ConnectedPosition): boolean {
  return (
    (position.originY === 'bottom' && position.overlayY === 'top') ||
    (position.originY === 'top' && position.overlayY === 'bottom')
  );
}

/**
 * CDK's flexible connected strategy without push, plus a slide along the trigger's edge: on the
 * axis across the side the panel opens on, it may move into the viewport (a narrow screen), but
 * on the axis away from the trigger it never moves.
 */
export class TriggerPositionStrategy extends FlexibleConnectedPositionStrategy {
  private appliedPosition: ConnectedPosition | null = null;
  private overlayRef?: OverlayRef;
  private readonly positionSubscription: Subscription;

  constructor(
    private readonly triggerElement: HTMLElement,
    private readonly margin: number,
    viewportRuler: ViewportRuler,
    document: Document,
    platform: Platform,
    overlayContainer: OverlayContainer,
  ) {
    super(triggerElement, viewportRuler, document, platform, overlayContainer);
    // CDK reports the position it chose only when it changes, so the last one is kept here.
    this.positionSubscription = this.positionChanges.subscribe(
      (change: ConnectedOverlayPositionChange) =>
        (this.appliedPosition = change.connectionPair),
    );
  }

  override apply(): void {
    const restoreScroll = this.resetMaxHeight();
    super.apply();
    this.fitIntoView();
    restoreScroll();
  }

  override reapplyLastPosition(): void {
    const restoreScroll = this.resetMaxHeight();
    super.reapplyLastPosition();
    this.fitIntoView();
    restoreScroll();
  }

  override detach(): void {
    this.appliedPosition = null;
    super.detach();
  }

  override dispose(): void {
    this.positionSubscription.unsubscribe();
    super.dispose();
  }

  /** Back to the overlay's own maximum height, before CDK measures the panel again. */
  private resetMaxHeight(): () => void {
    const pane = this.overlayRef?.overlayElement;
    if (!pane) {
      return () => undefined;
    }
    const own = coerceCssPixelValue(
      this.overlayRef?.getConfig().maxHeight ?? '',
    );
    if (pane.style.maxHeight === own) {
      return () => undefined;
    }
    // Capped: lifting the cap for CDK's measurement would clamp the panel's own scroll position,
    // so a list scrolled near its end would jump on every page scroll. Keep it and put it back.
    const scrolled = [...pane.querySelectorAll<HTMLElement>('*')]
      .filter((element) => element.scrollTop > 0)
      .map((element) => [element, element.scrollTop] as const);
    pane.style.maxHeight = own;
    return () => {
      for (const [element, top] of scrolled) {
        element.scrollTop = top;
      }
    };
  }

  /**
   * After CDK placed the panel: slide it along the trigger's edge into the viewport, and, when it
   * opens above or below with no side tall enough, cap its height to the room on that side (the
   * pane is a flex box, so the panel's own scroller takes the rest) instead of letting it run
   * past the viewport's edge, where its last rows could never be reached.
   */
  private fitIntoView(): void {
    const position = this.appliedPosition;
    const pane = this.overlayRef?.overlayElement;
    if (!position || !pane) {
      return;
    }

    const root = this.triggerElement.ownerDocument.documentElement;
    if (isVerticalSide(position)) {
      const box = pane.getBoundingClientRect();
      const room =
        position.overlayY === 'top'
          ? root.clientHeight - this.margin - box.top
          : box.bottom - this.margin;
      if (box.height > room && room > 0) {
        pane.style.maxHeight = `${Math.floor(room)}px`;
      }
    }

    const panel = pane.getBoundingClientRect();
    const trigger = this.triggerElement.getBoundingClientRect();
    const transform = pane.style.transform;

    if (isVerticalSide(position)) {
      const shift = slideAlongTrigger(
        { start: panel.left, end: panel.right },
        { start: trigger.left, end: trigger.right },
        this.margin,
        root.clientWidth - this.margin,
      );
      if (shift) {
        pane.style.transform = `${transform} translateX(${shift}px)`.trim();
      }
    } else {
      const shift = slideAlongTrigger(
        { start: panel.top, end: panel.bottom },
        { start: trigger.top, end: trigger.bottom },
        this.margin,
        root.clientHeight - this.margin,
      );
      if (shift) {
        pane.style.transform = `${transform} translateY(${shift}px)`.trim();
      }
    }
  }

  override attach(overlayRef: OverlayRef): void {
    this.overlayRef = overlayRef;
    super.attach(overlayRef);
  }
}

/**
 * Repositions the panel on every scroll that moves its trigger, and hands over to
 * `onTriggerHidden` once the trigger is out of view.
 *
 * It listens on the document in the capture phase, so the scroll of any container is heard, not
 * only the window's or a registered `cdkScrollable`'s; a scroll inside the panel itself is ignored.
 */
export class FollowTriggerScrollStrategy implements ScrollStrategy {
  private overlayRef: OverlayRef | null = null;
  private removeListener?: () => void;
  private clippingAncestors: HTMLElement[] = [];
  private inPanel = false;

  constructor(
    private readonly triggerElement: HTMLElement,
    private readonly document: Document,
    private readonly ngZone: NgZone,
    private readonly onTriggerHidden: () => void,
  ) {}

  attach(overlayRef: OverlayRef): void {
    this.overlayRef = overlayRef;
  }

  enable(): void {
    if (this.removeListener) {
      return;
    }
    this.clippingAncestors = clippingAncestorsOf(this.triggerElement);
    this.inPanel = !!this.triggerElement.closest('.cdk-overlay-pane');
    const onScroll = (event: Event) => this.onScroll(event);
    this.ngZone.runOutsideAngular(() =>
      this.document.addEventListener('scroll', onScroll, {
        capture: true,
        passive: true,
      }),
    );
    this.removeListener = () =>
      this.document.removeEventListener('scroll', onScroll, { capture: true });
  }

  disable(): void {
    this.removeListener?.();
    this.removeListener = undefined;
  }

  detach(): void {
    this.disable();
    this.overlayRef = null;
  }

  private onScroll(event: Event): void {
    const overlayRef = this.overlayRef;
    if (!overlayRef?.hasAttached()) {
      return;
    }
    // A scroll inside the panel itself moves nothing. Otherwise: the document's, or one of a
    // container around the trigger; for a trigger inside another panel (a submenu's row, a select
    // in a popover), any, since that panel follows a container the trigger is not in.
    const target = event.target;
    if (
      target instanceof Node &&
      target !== this.document &&
      (overlayRef.overlayElement.contains(target) ||
        (!this.inPanel && !target.contains(this.triggerElement)))
    ) {
      return;
    }

    if (this.triggerIsHidden()) {
      this.disable();
      this.ngZone.run(() => this.onTriggerHidden());
      return;
    }
    overlayRef.updatePosition();
  }

  private triggerIsHidden(): boolean {
    if (!this.triggerElement.isConnected) {
      return true;
    }
    const root = this.document.documentElement;
    const viewport: ClipRect = {
      top: 0,
      left: 0,
      bottom: root.clientHeight,
      right: root.clientWidth,
    };
    return isOutsideView(this.triggerElement.getBoundingClientRect(), [
      viewport,
      ...this.clippingAncestors.map((element) =>
        element.getBoundingClientRect(),
      ),
    ]);
  }
}

/** The ancestors that clip the trigger: any whose overflow is not `visible`. */
function clippingAncestorsOf(element: HTMLElement): HTMLElement[] {
  const view = element.ownerDocument.defaultView;
  const root = element.ownerDocument.documentElement;
  const ancestors: HTMLElement[] = [];
  for (
    let parent = element.parentElement;
    parent && parent !== root && parent !== element.ownerDocument.body;
    parent = parent.parentElement
  ) {
    const style = view?.getComputedStyle(parent);
    if (
      style &&
      (style.overflowX !== 'visible' || style.overflowY !== 'visible')
    ) {
      ancestors.push(parent);
    }
  }
  return ancestors;
}

function toElement(origin: ElementRef<HTMLElement> | HTMLElement): HTMLElement {
  return origin instanceof HTMLElement ? origin : origin.nativeElement;
}
