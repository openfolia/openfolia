/** A box in viewport pixels, as `getBoundingClientRect()` gives it. */
export interface Box {
  readonly top: number;
  readonly left: number;
  readonly width: number;
  readonly height: number;
}

/** The card's edge that faces the anchor, and where along it the arrow sits (px from its start). */
export interface TipArrow {
  readonly side: 'top' | 'bottom' | 'left' | 'right';
  readonly offset: number;
}

/** How far the arrow keeps from the card's corners, so it never sits on the rounding. */
const ARROW_INSET = 18;

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), Math.max(min, max));

/**
 * The arrow from a card toward its anchor: on the card's edge that faces the anchor, as close to
 * the anchor's centre as the card's corners allow. Null when the card overlaps the anchor (no edge
 * faces it), so no arrow points at nothing.
 */
export function arrowFor(card: Box, anchor: Box): TipArrow | null {
  const along = (start: number, size: number, centre: number) =>
    Math.round(clamp(centre - start, ARROW_INSET, size - ARROW_INSET));
  const anchorX = anchor.left + anchor.width / 2;
  const anchorY = anchor.top + anchor.height / 2;
  // A pixel of slack: CDK places the card at fractional positions.
  if (card.top >= anchor.top + anchor.height - 1)
    return { side: 'top', offset: along(card.left, card.width, anchorX) };
  if (card.top + card.height <= anchor.top + 1)
    return { side: 'bottom', offset: along(card.left, card.width, anchorX) };
  if (card.left >= anchor.left + anchor.width - 1)
    return { side: 'left', offset: along(card.top, card.height, anchorY) };
  if (card.left + card.width <= anchor.left + 1)
    return { side: 'right', offset: along(card.top, card.height, anchorY) };
  return null;
}

/**
 * Where a centred card's top goes: in the middle of the window, but below anything it must keep
 * clear of (`keepClearBottom`: the lowest edge of those boxes, e.g. a sandbox banner), and never
 * past the window's bottom margin.
 */
export function centredTop(
  cardHeight: number,
  viewportHeight: number,
  keepClearBottom: number,
  margin = 16,
): number {
  const middle = (viewportHeight - cardHeight) / 2;
  const top = Math.max(middle, keepClearBottom + margin, margin);
  return Math.round(
    Math.max(margin, Math.min(top, viewportHeight - cardHeight - margin)),
  );
}

/**
 * How far a card at `card` moves, up or down, so it covers none of `keep` (the person's own edit):
 * below it, `gap` away, or above it where the window has no room below; 0 when it covers none of
 * it already, or fits neither way.
 */
export function clearOf(
  card: Box,
  keep: Box,
  viewportHeight: number,
  gap: number,
  margin = 16,
): number {
  if (keep.height === 0 || viewportHeight <= 0) return 0;
  const bottom = card.top + card.height;
  const keepBottom = keep.top + keep.height;
  const covers =
    card.left < keep.left + keep.width &&
    card.left + card.width > keep.left &&
    card.top < keepBottom &&
    bottom > keep.top;
  if (!covers) return 0;
  const down = keepBottom + gap - card.top;
  if (bottom + down <= viewportHeight - margin) return Math.round(down);
  const up = keep.top - gap - bottom;
  if (card.top + up >= margin) return Math.round(up);
  return 0;
}
