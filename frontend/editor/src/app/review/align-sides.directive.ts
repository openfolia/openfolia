import {
  afterNextRender,
  DestroyRef,
  Directive,
  ElementRef,
  inject,
} from '@angular/core';

/** The attribute a row of either side carries: what it is matched by on the other side. */
export const ALIGN_ATTR = 'data-align';
/** The attribute of a box that scrolls sideways (a code block, a table): scrolled together. */
export const HSCROLL_ATTR = 'data-hscroll';

/** Past this many pairs in one row, the rest are left where they are (the page stays quick). */
const MAX_PAIRS = 400;

/** A row of one side, as the aligning sees it. */
export interface AlignRow {
  readonly key: string;
  /** Its top, measured now (it moves as the rows above it are pushed down). */
  top(): number;
  /** Pushes it down by this much (0: as laid out). */
  push(by: number): void;
}

/**
 * Lines up the rows both sides have: each pair, in order, gets the same top, the side whose row
 * is higher pushed down by the difference. Only pairs in the same order on both sides are lined
 * up (a row moved between them is not), each measured after the ones above it moved.
 */
export function alignPairs(
  left: readonly AlignRow[],
  right: readonly AlignRow[],
): number {
  for (const row of [...left, ...right]) row.push(0);
  const rightAt = new Map(right.map((r, i) => [r.key, i]));
  let after = -1;
  let pairs = 0;
  for (const l of left) {
    const i = rightAt.get(l.key);
    if (i === undefined || i <= after) continue;
    after = i;
    const r = right[i] as AlignRow;
    const delta = r.top() - l.top();
    if (delta > 0.5) l.push(delta);
    else if (delta < -0.5) r.push(-delta);
    if (++pairs >= MAX_PAIRS) break;
  }
  return pairs;
}

/**
 * On a row of side by side (two columns, before and after): lines up the blocks both columns
 * show, inside containers too (a section's paragraphs, a variant block's content, a procedure's
 * steps), by pushing the higher one down (`alignPairs`), again whenever either column changes
 * size (an image loaded, a run unfolded, the width changed). The columns are in one scroller, so
 * they scroll together; a box that scrolls sideways (a code block, a table) scrolls its
 * counterpart on the other side with it.
 */
@Directive({ selector: '[ofAlignSides]' })
export class AlignSidesDirective {
  constructor() {
    const host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
    const destroyRef = inject(DestroyRef);
    let frame = 0;
    const pushed = new Map<HTMLElement, number>();
    const column = (i: number): HTMLElement | null =>
      (host.children[i] as HTMLElement | undefined) ?? null;
    const rowsOf = (col: HTMLElement | null): AlignRow[] =>
      col
        ? [...col.querySelectorAll<HTMLElement>(`[${ALIGN_ATTR}]`)]
            // The column's own row is the pair the grid lines up already.
            .filter((el) => el.parentElement?.closest(`[${ALIGN_ATTR}]`))
            .map((el) => ({
              key: el.getAttribute(ALIGN_ATTR) ?? '',
              top: () => el.getBoundingClientRect().top,
              push: (by: number) => {
                if ((pushed.get(el) ?? 0) === by) return;
                pushed.set(el, by);
                el.style.marginBlockStart = by ? `${by}px` : '';
              },
            }))
        : [];
    const align = () => {
      frame = 0;
      alignPairs(rowsOf(column(0)), rowsOf(column(1)));
    };
    const later = () => {
      if (!frame) frame = requestAnimationFrame(align);
    };
    const observer =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(later);
    afterNextRender(() => {
      for (const child of host.children) observer?.observe(child);
      align();
    });
    // A box scrolled sideways: its counterpart (the same row's on the other side) follows.
    let syncing = false;
    const onScroll = (event: Event) => {
      const box = event.target as HTMLElement | null;
      if (syncing || !box?.hasAttribute?.(HSCROLL_ATTR)) return;
      const row = box.closest(`[${ALIGN_ATTR}]`);
      const key = row?.getAttribute(ALIGN_ATTR);
      const side = [column(0), column(1)].findIndex((c) => c?.contains(box));
      const other = column(side === 0 ? 1 : 0);
      if (!other || side < 0) return;
      const rows = key
        ? [...other.querySelectorAll(`[${ALIGN_ATTR}]`)].filter(
            (el) => el.getAttribute(ALIGN_ATTR) === key,
          )
        : [other];
      const twin = rows[0]?.querySelector<HTMLElement>(`[${HSCROLL_ATTR}]`);
      if (!twin) return;
      syncing = true;
      twin.scrollLeft = box.scrollLeft;
      requestAnimationFrame(() => (syncing = false));
    };
    host.addEventListener('scroll', onScroll, true);
    destroyRef.onDestroy(() => {
      observer?.disconnect();
      cancelAnimationFrame(frame);
      host.removeEventListener('scroll', onScroll, true);
    });
  }
}
