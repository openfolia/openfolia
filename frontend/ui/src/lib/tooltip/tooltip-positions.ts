import type { PositionStrategy, OverlayRef } from '@angular/cdk/overlay';

import type { ZardTooltipPositionVariants } from './tooltip.variants';

/** Physical sides plus the logical ones, which follow the direction of the trigger. */
export type ZardTooltipSide =
  ZardTooltipPositionVariants | 'inline-start' | 'inline-end';

/** `inline-start` is the physical left in LTR and the physical right in RTL; physical sides pass through. */
export function resolveTooltipSide(
  side: ZardTooltipSide | string,
  rtl: boolean,
): ZardTooltipPositionVariants {
  if (side === 'inline-start') {
    return rtl ? 'right' : 'left';
  }
  if (side === 'inline-end') {
    return rtl ? 'left' : 'right';
  }
  return side as ZardTooltipPositionVariants;
}

export interface TooltipBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface TooltipSize {
  width: number;
  height: number;
}

export interface TooltipPlacement {
  side: ZardTooltipPositionVariants;
  /** Viewport coordinates of the tooltip body's top-left corner. */
  left: number;
  top: number;
  /**
   * Where the arrow's centre sits along the body's edge, in px from the body's start edge
   * (left for top/bottom, top for left/right): the trigger's centre, kept inside the rounded corners.
   */
  arrow: number;
}

export interface TooltipPlacementOptions {
  /** Gap between the trigger and the tooltip. */
  offset?: number;
  /** Minimum gap between the tooltip and the viewport edge. */
  margin?: number;
  /** Closest the arrow's centre may come to a corner of the body (corner radius plus the arrow's half width). */
  arrowInset?: number;
}

const OPPOSITE: Record<
  ZardTooltipPositionVariants,
  ZardTooltipPositionVariants
> = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' };

const PERPENDICULAR: Record<
  ZardTooltipPositionVariants,
  [ZardTooltipPositionVariants, ZardTooltipPositionVariants]
> = {
  top: ['left', 'right'],
  bottom: ['left', 'right'],
  left: ['top', 'bottom'],
  right: ['top', 'bottom'],
};

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), Math.max(min, max));

/**
 * Where a tooltip goes: on the preferred side when there is room for it between the trigger and
 * the viewport edge (with the margin); else on the opposite side, then on the two sides across;
 * with no room anywhere it stays on the preferred side. Whatever side it takes, the body then
 * slides along the trigger's edge to stay inside the viewport, and the arrow keeps pointing at
 * the trigger's centre.
 */
export function placeTooltip(
  trigger: TooltipBox,
  tip: TooltipSize,
  viewport: TooltipSize,
  preferred: ZardTooltipPositionVariants,
  options: TooltipPlacementOptions = {},
): TooltipPlacement {
  const { offset = 4, margin = 8, arrowInset = 12 } = options;
  const order = [
    preferred,
    OPPOSITE[preferred],
    ...PERPENDICULAR[preferred],
  ] as ZardTooltipPositionVariants[];

  const centreX = trigger.left + trigger.width / 2;
  const centreY = trigger.top + trigger.height / 2;

  const raw = (side: ZardTooltipPositionVariants) => {
    switch (side) {
      case 'top':
        return {
          left: centreX - tip.width / 2,
          top: trigger.top - offset - tip.height,
        };
      case 'bottom':
        return {
          left: centreX - tip.width / 2,
          top: trigger.top + trigger.height + offset,
        };
      case 'left':
        return {
          left: trigger.left - offset - tip.width,
          top: centreY - tip.height / 2,
        };
      case 'right':
        return {
          left: trigger.left + trigger.width + offset,
          top: centreY - tip.height / 2,
        };
    }
  };
  const fitsAlongAxis = (side: ZardTooltipPositionVariants) => {
    const p = raw(side);
    return side === 'top' || side === 'bottom'
      ? p.top >= margin && p.top + tip.height <= viewport.height - margin
      : p.left >= margin && p.left + tip.width <= viewport.width - margin;
  };
  const side = order.find(fitsAlongAxis) ?? preferred;
  const p = raw(side);
  const horizontal = side === 'top' || side === 'bottom';
  const left = horizontal
    ? clamp(p.left, margin, viewport.width - margin - tip.width)
    : p.left;
  const top = horizontal
    ? p.top
    : clamp(p.top, margin, viewport.height - margin - tip.height);
  const arrow = horizontal
    ? clamp(centreX - left, arrowInset, tip.width - arrowInset)
    : clamp(centreY - top, arrowInset, tip.height - arrowInset);

  return { side, left, top, arrow };
}

/**
 * A CDK position strategy that places the overlay with `placeTooltip`: it measures the trigger,
 * the tooltip and the viewport each time CDK asks it to apply, and reports where it went.
 */
export class ZardTooltipPositionStrategy implements PositionStrategy {
  private overlayRef?: OverlayRef;
  /** Called with every placement, so the tooltip can set its side and arrow. */
  onPlaced?: (placement: TooltipPlacement) => void;

  constructor(
    private readonly origin: HTMLElement,
    public preferred: ZardTooltipPositionVariants,
    public offset = 4,
  ) {}

  attach(overlayRef: OverlayRef): void {
    this.overlayRef = overlayRef;
  }

  apply(): void {
    const pane = this.overlayRef?.overlayElement;
    if (!pane || !pane.isConnected) {
      return;
    }
    // Measured at the origin of the viewport so the pane's width is not squeezed by its own offset.
    pane.style.left = '0px';
    pane.style.top = '0px';
    const doc = pane.ownerDocument.documentElement;
    const placement = placeTooltip(
      this.origin.getBoundingClientRect(),
      { width: pane.offsetWidth, height: pane.offsetHeight },
      { width: doc.clientWidth, height: doc.clientHeight },
      this.preferred,
      { offset: this.offset },
    );
    pane.style.left = `${placement.left}px`;
    pane.style.top = `${placement.top}px`;
    this.onPlaced?.(placement);
  }

  detach(): void {
    this.overlayRef = undefined;
  }

  dispose(): void {
    this.overlayRef = undefined;
    this.onPlaced = undefined;
  }
}
