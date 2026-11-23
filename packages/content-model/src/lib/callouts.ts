import type { Block, Callout, CalloutPoint, Image } from './blocks.js';
import type { Condition } from './condition.js';
import type { CalloutRef } from './inline.js';
import type { ResolvedManual } from './resolve.js';
import { ownInlineContent } from './term-links.js';
import { walk } from './walk.js';

/*
 * Image callouts (#498): numbered markers on an image, each with its legend
 * text. Schema-free, so `@openfolia/content-model/core` has them.
 */

/** The most callouts one image holds. */
export const MAX_CALLOUTS = 100;

/**
 * How an image's callouts are numbered: `reading`, top to bottom in rows,
 * left to right in a row (the default); `manual`, in the order the image
 * stores them (the author's).
 */
export const CALLOUT_ORDERS = ['reading', 'manual'] as const;
export type CalloutOrder = (typeof CALLOUT_ORDERS)[number];

/**
 * Where an image's legend is printed (#546): `below` the image (the
 * default), `beside` it (at the end of the line: the right in left-to-right
 * text, the left in right-to-left text), or `none` (the markers only; the
 * text refers to them).
 */
export const CALLOUT_LEGENDS = ['below', 'beside', 'none'] as const;
export type CalloutLegend = (typeof CALLOUT_LEGENDS)[number];

/**
 * The height of a row in reading order, as a share of the image's height:
 * markers whose `y` falls into the same band of this height count as one
 * row and are read left to right.
 */
export const CALLOUT_ROW_BAND = 0.05;

/**
 * The smallest text size, in points, a legend beside its image shrinks to in
 * print before what still does not fit is cut off (#548): the configuration's
 * `pdf.calloutLabelMinSize`, from `MIN_CALLOUT_LABEL_SIZE` to
 * `MAX_CALLOUT_LABEL_SIZE`.
 */
export const DEFAULT_CALLOUT_LABEL_MIN_SIZE = 6;
export const MIN_CALLOUT_LABEL_SIZE = 4;
export const MAX_CALLOUT_LABEL_SIZE = 12;

/**
 * Whether a resolved manual prints a legend beside an image (#548): its PDF's
 * layout then reports a legend it cuts off (`callout-label-overflow`).
 */
export function hasLegendBeside(manual: ResolvedManual): boolean {
  const visit = (entries: ResolvedManual['entries']): boolean =>
    entries.some((entry) =>
      entry.kind === 'module'
        ? [...walk(entry.blocks)].some(
            ({ kind, node }) =>
              kind === 'block' &&
              node.type === 'image' &&
              node.calloutLegend === 'beside' &&
              (node.callouts?.length ?? 0) > 0,
          )
        : visit(entry.entries),
    );
  return visit(manual.entries);
}

/** Decimal places a coordinate keeps (`normalizeModule`, the AsciiDoc file): 1/10,000 of the image. */
export const COORDINATE_DECIMALS = 4;

/** A coordinate rounded to `COORDINATE_DECIMALS` places. */
export function roundCoordinate(value: number): number {
  const factor = 10 ** COORDINATE_DECIMALS;
  // `+ 0`: never -0, which the file cannot tell from 0.
  return Math.round(value * factor) / factor + 0;
}

/** Where a callout's number is drawn: its label, or its anchor when it has no label. */
export function markerPoint(callout: Callout): CalloutPoint {
  return callout.label ?? callout.anchor;
}

/** A callout with the number it reads as. */
export interface NumberedCallout {
  readonly callout: Callout;
  /** 1, 2, 3, …: counted over the visible callouts only, so there are no gaps. */
  readonly number: number;
}

/**
 * An image's callouts with their numbers, in number order. Numbers are never
 * stored: they count from 1 over the callouts `visible` keeps (by default
 * every one), in the image's order (`calloutOrder`): reading order (rows of
 * `CALLOUT_ROW_BAND` top to bottom, left to right in a row, by
 * `markerPoint`; ties in the stored order) or the stored order.
 */
export function numberCallouts(
  image: Pick<Image, 'callouts' | 'calloutOrder'>,
  visible: (callout: Callout) => boolean = () => true,
): NumberedCallout[] {
  const shown = (image.callouts ?? [])
    .map((callout, index) => ({ callout, index }))
    .filter(({ callout }) => visible(callout));
  if (image.calloutOrder !== 'manual') {
    shown.sort((a, b) => {
      const p = markerPoint(a.callout);
      const q = markerPoint(b.callout);
      return (
        rowOf(p.y) - rowOf(q.y) || p.x - q.x || p.y - q.y || a.index - b.index
      );
    });
  }
  return shown.map(({ callout }, i) => ({ callout, number: i + 1 }));
}

function rowOf(y: number): number {
  // The bottom edge (y = 1) belongs to the last row, not a row of its own.
  // In whole units of the last decimal place a coordinate keeps, so a band edge such as 0.3
  // starts its row (0.3 / 0.05 is 5.999… in floating point).
  const unit = 10 ** COORDINATE_DECIMALS;
  return Math.min(
    Math.floor(Math.round(y * unit) / Math.round(CALLOUT_ROW_BAND * unit)),
    Math.ceil(1 / CALLOUT_ROW_BAND) - 1,
  );
}

/**
 * Callout numbers by callout ID, for the callouts a variant shows: `holds`
 * says whether a callout's condition holds (a callout without one always
 * shows).
 */
export function calloutNumbers(
  image: Pick<Image, 'callouts' | 'calloutOrder'>,
  holds: (when: Condition) => boolean = () => true,
): Map<string, number> {
  return new Map(
    numberCallouts(image, (c) => c.when === undefined || holds(c.when)).map(
      ({ callout, number }) => [callout.id, number],
    ),
  );
}

/** A callout reference in content (`calloutRef`). */
export interface CalloutRefAt {
  /** The image block it names. */
  readonly image: string;
  readonly callout: string;
  /** The block (or list item) the reference is in. */
  readonly blockId: string;
}

/**
 * Every callout reference in `blocks`, in document order, at any depth
 * (titles, legends and list items included; module references are not
 * followed).
 */
export function* calloutRefs(
  blocks: readonly Block[],
): Generator<CalloutRefAt> {
  for (const { node } of walk(blocks)) {
    for (const content of ownInlineContent(node)) {
      for (const inline of content) {
        if (inline.type === 'calloutRef') {
          yield {
            image: inline.block,
            callout: inline.callout,
            blockId: node.id,
          };
        }
      }
    }
  }
}

/** The images of `blocks` by ID, at any depth (variant blocks included). */
export function imagesById(blocks: readonly Block[]): Map<string, Image> {
  const images = new Map<string, Image>();
  for (const { node } of walk(blocks)) {
    if ('type' in node && node.type === 'image') images.set(node.id, node);
  }
  return images;
}

/** The number a callout reference reads as in a resolved manual; undefined when it has none. */
export function calloutNumber(
  manual: Pick<ResolvedManual, 'callouts'>,
  ref: Pick<CalloutRef, 'block' | 'callout'>,
): number | undefined {
  const callouts = manual.callouts;
  if (!callouts || !Object.hasOwn(callouts, ref.block)) return undefined;
  const numbers = callouts[ref.block] as Record<string, number>;
  return Object.hasOwn(numbers, ref.callout) ? numbers[ref.callout] : undefined;
}
