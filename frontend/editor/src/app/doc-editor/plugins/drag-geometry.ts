// The arithmetic of moving a block: which place a dragged block goes to, how fast the editor
// scrolls near its edges, and how far blocks slide after a keyboard move. Plain numbers in, plain
// numbers out, so it is tested without a browser.

/** A block's place on screen. */
export interface BlockBox {
  top: number;
  height: number;
}

/** A drop target placed on screen: where the slot's top would stand if it went there. */
export interface PlacedTarget {
  pos: number;
  /** Targets on one boundary (`boundaryOf`) are one place on screen, at different depths. */
  boundary: number;
  level: number | null;
  refusal: string | null;
  home: boolean;
  top: number;
}

/**
 * The target a dragged block whose copy's top is at `copyTop` goes to: the one whose slot would
 * stand nearest. For a section (`preferred`, the level the pointer asks for), the places of one
 * boundary count as one, and among them it takes an allowed one at the level nearest to
 * `preferred`; when none of them is allowed, the refused one (the cap's first) says why.
 */
export function chooseTarget<T extends PlacedTarget>(
  targets: readonly T[],
  copyTop: number,
  preferred: number | null,
): T | null {
  let best: T[] = [];
  let distance = Infinity;
  const groups = new Map<number, T[]>();
  for (const target of targets) {
    const key = preferred === null ? target.pos : target.boundary;
    const group = groups.get(key);
    if (group) group.push(target);
    else groups.set(key, [target]);
  }
  for (const group of groups.values()) {
    const top = Math.min(...group.map((target) => target.top));
    const d = Math.abs(top - copyTop);
    if (d < distance) {
      distance = d;
      best = group;
    }
  }
  const allowed = best.filter((target) => !target.refusal);
  if (!allowed.length)
    return best.find((target) => target.refusal === 'cap') ?? best[0] ?? null;
  if (preferred === null) return allowed[0] ?? null;
  const gap = (target: T) => Math.abs((target.level ?? preferred) - preferred);
  return allowed.reduce((a, b) => (gap(b) < gap(a) ? b : a));
}

/**
 * How far to scroll (px, this frame) with the pointer at `y` near an edge of the scroll area
 * from `top` to `bottom`: faster the closer it comes, nothing outside the edge zones.
 */
export function autoScrollStep(
  y: number,
  top: number,
  bottom: number,
  zone = 48,
  fastest = 16,
): number {
  const size = Math.min(zone, (bottom - top) / 3);
  if (size <= 0) return 0;
  const pull = (depth: number) =>
    Math.ceil(fastest * Math.min(1, Math.max(0, depth) / size));
  if (y < top + size) return -pull(top + size - y);
  if (y > bottom - size) return pull(y - (bottom - size));
  return 0;
}

/** Where the block now at `index` stood before a move of `from` to `to`. */
export function indexBefore(index: number, from: number, to: number): number {
  if (index === to) return from;
  if (from < to && index >= from && index < to) return index + 1;
  if (to < from && index > to && index <= from) return index - 1;
  return index;
}

/**
 * For a move already made (`from` to `to`), how far each block, in the new order, must be
 * pushed back to stand where it stood before: the first frame of the slide into place.
 */
export function flipShifts(
  topsBefore: readonly number[],
  topsAfter: readonly number[],
  from: number,
  to: number,
): number[] {
  return topsAfter.map(
    (top, index) => (topsBefore[indexBefore(index, from, to)] ?? top) - top,
  );
}
