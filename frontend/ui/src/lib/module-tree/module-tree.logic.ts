/**
 * What may nest under a row: `none` (a leaf: nothing), `required` (a group: it always keeps at
 * least one row, so no change may leave it empty). Left out, any row may hold rows or not.
 */
export type ModuleTreeNesting = 'none' | 'required';

/** One row of the tree. The list is flat, in reading order; `level` 0 is the top. */
export interface ModuleTreeItem {
  id: string;
  title: string;
  level: number;
  nesting?: ModuleTreeNesting;
}

function levelAt(items: readonly ModuleTreeItem[], index: number): number {
  return items[index]?.level ?? 0;
}

/** The deepest level the row after `item` may have: one below it, or its own for a leaf. */
function childLevel(item: ModuleTreeItem | undefined): number {
  if (!item) return 0;
  return item.nesting === 'none' ? item.level : item.level + 1;
}

/** Whether any row says what may nest under it: then changes keep to those rules. */
function constrained(items: readonly ModuleTreeItem[]): boolean {
  return items.some((item) => item.nesting !== undefined);
}

/** First index after the item at `index` and everything nested under it. */
export function subtreeEnd(items: readonly ModuleTreeItem[], index: number) {
  let end = index + 1;
  while (end < items.length && levelAt(items, end) > levelAt(items, index))
    end++;
  return end;
}

/**
 * Keep the levels valid: the first row is at the top, no row is more than one level below its
 * predecessor, and nothing nests under a leaf.
 */
export function normalize(items: readonly ModuleTreeItem[]): ModuleTreeItem[] {
  let previous: ModuleTreeItem | undefined;
  return items.map((item) => {
    const max = previous ? childLevel(previous) : 0;
    const level = Math.max(0, Math.min(item.level, max));
    const next = level === item.level ? item : { ...item, level };
    previous = next;
    return next;
  });
}

/** Whether every group keeps a row and no leaf holds one (levels as `normalize` leaves them). */
export function isValidTree(items: readonly ModuleTreeItem[]): boolean {
  return items.every((item, i) => {
    const next = items[i + 1];
    const holds = next !== undefined && next.level > item.level;
    if (item.nesting === 'required') return holds;
    if (item.nesting === 'none') return !holds;
    return true;
  });
}

/** The same rows at the same levels. */
function sameShape(
  a: readonly ModuleTreeItem[],
  b: readonly ModuleTreeItem[],
): boolean {
  return (
    a.length === b.length &&
    a.every((item, i) => item.id === b[i]?.id && item.level === b[i]?.level)
  );
}

/** Outline numbers: "1", "1.1", "1.2", "2", … */
export function numbering(items: readonly ModuleTreeItem[]): string[] {
  const counters: number[] = [];
  return items.map((item) => {
    counters.length = item.level + 1;
    counters[item.level] = (counters[item.level] ?? 0) + 1;
    for (let i = 0; i < item.level; i++) counters[i] ??= 1;
    return counters.join('.');
  });
}

export function canIndent(items: readonly ModuleTreeItem[], index: number) {
  return changeLevel(items, index, 1) !== items;
}

export function canOutdent(items: readonly ModuleTreeItem[], index: number) {
  return changeLevel(items, index, -1) !== items;
}

/**
 * Move a row and its nested rows one level in (+1) or out (-1); an impossible change returns
 * `items` itself. Under nesting rules a change that would empty a group, nest under a leaf or
 * move other rows is refused, except that a row leaving a group with rows after it (which it
 * could not hold) moves out to just after that group.
 */
export function changeLevel(
  items: readonly ModuleTreeItem[],
  index: number,
  delta: 1 | -1,
): readonly ModuleTreeItem[] {
  const level = levelAt(items, index);
  if (index < 0 || index >= items.length) return items;
  if (
    delta === 1 ? index === 0 || level > levelAt(items, index - 1) : level === 0
  ) {
    return items;
  }
  const end = subtreeEnd(items, index);
  const next = normalize(
    items.map((item, i) =>
      i >= index && i < end ? { ...item, level: item.level + delta } : item,
    ),
  );
  if (!constrained(items)) return sameShape(next, items) ? items : next;
  if (acceptable(items, next, index, end)) return next;
  if (delta === 1) return items;
  // Out of a group past rows it cannot take along: after the group's last row instead.
  let parent = index - 1;
  while (parent >= 0 && levelAt(items, parent) >= level) parent--;
  const after = subtreeEnd(items, parent);
  return place(items, index, after - 1, level - 1) ?? items;
}

/** Each row's parent: the id of the nearest row before it with a lower level (null at the top). */
function parentsOf(
  items: readonly ModuleTreeItem[],
): Map<string, string | null> {
  const parents = new Map<string, string | null>();
  const open: ModuleTreeItem[] = [];
  for (const item of items) {
    while (open.length && (open.at(-1) as ModuleTreeItem).level >= item.level) {
      open.pop();
    }
    parents.set(item.id, open.at(-1)?.id ?? null);
    open.push(item);
  }
  return parents;
}

/** Whether every row not in `moved` has the same level and the same parent in both trees. */
function othersKept(
  before: readonly ModuleTreeItem[],
  after: readonly ModuleTreeItem[],
  moved: ReadonlySet<string>,
): boolean {
  const levels = new Map(before.map((item) => [item.id, item.level]));
  const was = parentsOf(before);
  const now = parentsOf(after);
  return after.every(
    (item) =>
      moved.has(item.id) ||
      (levels.get(item.id) === item.level &&
        was.get(item.id) === now.get(item.id)),
  );
}

/** A changed tree is acceptable when it is valid and only the rows `from`–`end` changed level or parent. */
function acceptable(
  before: readonly ModuleTreeItem[],
  after: readonly ModuleTreeItem[],
  from: number,
  end: number,
): boolean {
  if (sameShape(before, after) || !isValidTree(after)) return false;
  const moved = new Set(before.slice(from, end).map((item) => item.id));
  return othersKept(before, after, moved);
}

/**
 * The rows `from` (with its subtree) moved to where the row at `to` is now, its top row at
 * `level`, as long as that is valid and changes no other row's level or parent; null otherwise.
 */
function place(
  items: readonly ModuleTreeItem[],
  from: number,
  to: number,
  level: number,
): readonly ModuleTreeItem[] | null {
  const end = subtreeEnd(items, from);
  const moved = items.slice(from, end);
  const rest = [...items.slice(0, from), ...items.slice(end)];
  const at = to < from ? to : to - moved.length + 1;
  const shift = level - levelAt(moved, 0);
  const shifted = moved.map((item) => ({ ...item, level: item.level + shift }));
  const next = normalize([...rest.slice(0, at), ...shifted, ...rest.slice(at)]);
  const ids = new Set(moved.map((item) => item.id));
  const levels = new Map(shifted.map((item) => [item.id, item.level]));
  const kept =
    next.every(
      (item) => !ids.has(item.id) || levels.get(item.id) === item.level,
    ) && othersKept(items, next, ids);
  return kept && isValidTree(next) && !sameShape(next, items) ? next : null;
}

/**
 * Move a row with its nested rows to where the row at `to` is now (before it when moving up,
 * after it when moving down), as a drop in a flat list reports it. The moved row keeps its
 * level where that is valid and is pulled in otherwise. Dropping inside its own subtree is a
 * no-op. Under nesting rules the row lands at the level nearest its own where the tree stays
 * valid and no other row moves (dropped between a group and its first row, it joins the group);
 * where there is none, nothing changes.
 */
export function moveSubtree(
  items: readonly ModuleTreeItem[],
  from: number,
  to: number,
): readonly ModuleTreeItem[] {
  if (from === to || from < 0 || to < 0 || from >= items.length) return items;
  if (to >= items.length) to = items.length - 1;
  const end = subtreeEnd(items, from);
  if (to > from && to < end) return items;
  const moved = items.slice(from, end);
  const rest = [...items.slice(0, from), ...items.slice(end)];
  const at = to < from ? to : to - moved.length + 1;
  const maxLevel = at > 0 ? childLevel(rest[at - 1]) : 0;
  const top = levelAt(moved, 0);
  if (!constrained(items)) {
    const shift = Math.min(top, maxLevel) - top;
    const shifted = moved.map((item) => ({
      ...item,
      level: item.level + shift,
    }));
    return normalize([...rest.slice(0, at), ...shifted, ...rest.slice(at)]);
  }
  const preferred = Math.min(top, maxLevel);
  const levels = Array.from({ length: maxLevel + 1 }, (_, l) => l).sort(
    (a, b) => Math.abs(a - preferred) - Math.abs(b - preferred) || b - a,
  );
  for (const level of levels) {
    const next = place(items, from, to, level);
    if (next) return next;
  }
  return items;
}

/** Where Alt+Up / Alt+Down put a row: before the previous sibling, after the next sibling's subtree. */
export function siblingMoveTarget(
  items: readonly ModuleTreeItem[],
  index: number,
  direction: -1 | 1,
): number | null {
  const level = levelAt(items, index);
  if (direction === 1) {
    const next = subtreeEnd(items, index);
    return next < items.length && levelAt(items, next) === level
      ? subtreeEnd(items, next) - 1
      : null;
  }
  let j = index - 1;
  while (j >= 0 && levelAt(items, j) > level) j--;
  return j >= 0 && levelAt(items, j) === level ? j : null;
}

/** Position among siblings and the sibling count of every row, for `aria-posinset` / `aria-setsize`. */
export function siblingInfo(
  items: readonly ModuleTreeItem[],
): { pos: number; size: number }[] {
  return items.map((item, i) => {
    let before = 0;
    let after = 0;
    for (let j = i - 1; j >= 0 && levelAt(items, j) >= item.level; j--) {
      if (levelAt(items, j) === item.level) before++;
    }
    for (
      let j = i + 1;
      j < items.length && levelAt(items, j) >= item.level;
      j++
    ) {
      if (levelAt(items, j) === item.level) after++;
    }
    return { pos: before + 1, size: before + after + 1 };
  });
}

/**
 * Where a row being dragged from `from` would land if dropped at `to`: its level and its number
 * there, so the drop indicator can stand in the outline exactly as the row will. `null` when the
 * drop would change nothing (onto itself, inside its own subtree, or nowhere valid).
 */
export function dropPreview(
  items: readonly ModuleTreeItem[],
  from: number,
  to: number,
): { level: number; number: string } | null {
  const id = items[from]?.id;
  const next = moveSubtree(items, from, to);
  if (next === items || id === undefined) return null;
  const at = next.findIndex((item) => item.id === id);
  const landed = next[at];
  return landed
    ? { level: landed.level, number: numbering(next)[at] ?? '' }
    : null;
}
