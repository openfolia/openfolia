import { diffText, movedIds, type Segment } from './review-diff';

/**
 * How to read a tree for the diff: what identifies a node, what it holds, whether its own
 * content (everything but what it holds) is the same on both sides, and its texts (compared
 * word by word: a paragraph's text, an image's alt text and caption…).
 */
export interface TreeAdapter<T> {
  id(node: T): string;
  children(node: T): readonly T[];
  /** Its own content is the same on both sides (what it holds is compared on its own). */
  same(before: T, after: T): boolean;
  /** Its texts by name; compared word by word when the node changed. */
  texts(node: T): Readonly<Record<string, string>>;
}

/** Where a node stood: its parent (null: the top level), by ID. */
export interface Place {
  readonly parentId: string | null;
}

/** How a node differs between the two sides. */
export type NodeChange = 'same' | 'added' | 'removed' | 'changed';

/**
 * One node of the compared tree: on both sides, on one, or a ghost (`ghost`: the place a node
 * kept elsewhere stood before; it points at the node, `movedTo`).
 */
export interface DiffNode<T> {
  readonly id: string;
  readonly change: NodeChange;
  readonly before?: T;
  readonly after?: T;
  /**
   * Each text of the node: word by word for a changed node, else the side's text as it is (a
   * whole node added or removed is marked at the node, not word by word).
   */
  readonly texts: Readonly<Record<string, readonly Segment[]>>;
  readonly children: readonly DiffNode<T>[];
  /** Kept, but somewhere else: where it stood before (its parent there). */
  readonly movedFrom?: Place;
  /** A ghost: where the node stood before; it now stands at `movedTo`. */
  readonly ghost?: boolean;
  readonly movedTo?: Place;
  /** Added around content that was there before (a new variant block around a paragraph). */
  readonly wraps?: boolean;
  /** Removed, while what it held stays where it stood (a frame taken away). */
  readonly unwraps?: boolean;
  /**
   * Added or removed with the node around it: part of that one change, so neither marked nor
   * counted on its own.
   */
  readonly inherited?: boolean;
  /** It, or something in it, differs: never folded away with the unchanged. */
  readonly touched: boolean;
  /** A change of its own, counted once and visited by the change navigation. */
  readonly hunk: 'added' | 'removed' | 'changed' | 'moved' | null;
}

interface Seen<T> {
  readonly node: T;
  readonly parentId: string | null;
}

function index<T>(
  roots: readonly T[],
  a: TreeAdapter<T>,
): Map<string, Seen<T>> {
  const out = new Map<string, Seen<T>>();
  const walk = (list: readonly T[], parentId: string | null) => {
    for (const node of list) {
      const id = a.id(node);
      // The first of a repeated ID counts (the content model keeps IDs unique).
      if (!out.has(id)) out.set(id, { node, parentId });
      walk(a.children(node), id);
    }
  };
  walk(roots, null);
  return out;
}

/**
 * The two trees compared node by node, matched by ID: each list in the new order, with what
 * was removed (and the ghosts of what moved away) placed where it stood among the nodes both
 * sides keep. A node kept under another parent is moved, except where a new container was put
 * around it in its place (a wrap) or the container around it was taken away (an unwrap): then
 * only the container is the change.
 */
export function diffTree<T>(
  before: readonly T[],
  after: readonly T[],
  a: TreeAdapter<T>,
): DiffNode<T>[] {
  const was = index(before, a);
  const now = index(after, a);

  /** The nearest ancestor (on that side) that both sides have; null: the top level. */
  const keptAncestor = (
    side: Map<string, Seen<T>>,
    other: Map<string, Seen<T>>,
    parentId: string | null,
  ): string | null => {
    let id = parentId;
    while (id !== null && !other.has(id)) id = side.get(id)?.parentId ?? null;
    return id;
  };
  /** Kept, under another parent, because a container was added around it in place. */
  const wrapped = (id: string): boolean => {
    const old = was.get(id);
    const cur = now.get(id);
    if (!old || !cur || cur.parentId === null || was.has(cur.parentId))
      return false;
    return keptAncestor(now, was, cur.parentId) === old.parentId;
  };
  /** Kept, under another parent, because the container around it was taken away. */
  const unwrapped = (id: string): boolean => {
    const old = was.get(id);
    const cur = now.get(id);
    if (!old || !cur || old.parentId === null || now.has(old.parentId))
      return false;
    return keptAncestor(was, now, old.parentId) === cur.parentId;
  };
  const relocated = (id: string): boolean => {
    const old = was.get(id);
    const cur = now.get(id);
    return (
      !!old &&
      !!cur &&
      old.parentId !== cur.parentId &&
      !wrapped(id) &&
      !unwrapped(id)
    );
  };

  const textsOf = (node: T, op: 'same'): Record<string, Segment[]> =>
    Object.fromEntries(
      Object.entries(a.texts(node)).map(([k, v]) => [
        k,
        v ? [{ op, text: v }] : [],
      ]),
    );
  const compare = (b: T, c: T): Record<string, Segment[]> => {
    const tb = a.texts(b);
    const tc = a.texts(c);
    const keys = new Set([...Object.keys(tb), ...Object.keys(tc)]);
    return Object.fromEntries(
      [...keys].map((k) => [k, diffText(tb[k] ?? '', tc[k] ?? '')]),
    );
  };

  const one = (
    node: T,
    side: 'before' | 'after',
    kids: DiffNode<T>[],
    extra: Partial<DiffNode<T>> = {},
  ): DiffNode<T> => ({
    id: a.id(node),
    change: side === 'after' ? 'added' : 'removed',
    [side]: node,
    texts: textsOf(node, 'same'),
    children: kids,
    touched: true,
    hunk: side === 'after' ? 'added' : 'removed',
    ...extra,
  });

  const ghost = (node: T): DiffNode<T> => {
    const id = a.id(node);
    return {
      id,
      change: 'same',
      before: node,
      texts: textsOf(node, 'same'),
      children: [],
      ghost: true,
      movedTo: { parentId: now.get(id)?.parentId ?? null },
      touched: true,
      hunk: null,
    };
  };

  /** A node only the old side has: removed, with what it held. */
  const removed = (node: T): DiffNode<T> | null => {
    const id = a.id(node);
    if (now.has(id)) {
      // Kept: moved away (a ghost here), or into a wrap made in its place (shown there only).
      return wrapped(id) || unwrapped(id) ? null : ghost(node);
    }
    const unwraps = a.children(node).some((k) => unwrapped(a.id(k)));
    const kids = a
      .children(node)
      .map(removed)
      .filter((n): n is DiffNode<T> => n !== null)
      .map((k) => (unwraps ? k : inherit(k, 'removed')));
    return one(node, 'before', kids, unwraps ? { unwraps } : {});
  };

  /** What an added or removed node holds, added or removed with it: part of its change. */
  const inherit = (n: DiffNode<T>, change: NodeChange): DiffNode<T> =>
    n.change === change && !n.wraps && !n.unwraps
      ? {
          ...n,
          hunk: null,
          inherited: true,
          children: n.children.map((k) => inherit(k, change)),
        }
      : n;

  /** A node only the new side has: added, with what it holds (kept nodes among them). */
  const added = (node: T): DiffNode<T> => {
    const wraps = a.children(node).some((k) => wrapped(a.id(k)));
    const kids = a
      .children(node)
      .map((k) => visit(k))
      .map((k) => (wraps ? k : inherit(k, 'added')));
    return one(node, 'after', kids, wraps ? { wraps } : {});
  };

  /** A node of the new side. */
  const visit = (node: T, reordered = false): DiffNode<T> => {
    const id = a.id(node);
    const old = was.get(id);
    if (!old) return added(node);
    const kids = list(a.children(old.node), a.children(node));
    const own = !a.same(old.node, node);
    const moved = reordered || relocated(id);
    const touched = own || moved || kids.some((k) => k.touched);
    return {
      id,
      change: own ? 'changed' : 'same',
      before: old.node,
      after: node,
      texts: own ? compare(old.node, node) : textsOf(node, 'same'),
      children: kids,
      ...(moved && { movedFrom: { parentId: old.parentId } }),
      touched,
      hunk: own ? 'changed' : moved ? 'moved' : null,
    };
  };

  /** Two lists of siblings compared: the new order, the old side's leftovers where they stood. */
  const list = (olds: readonly T[], news: readonly T[]): DiffNode<T>[] => {
    const newIds = new Set(news.map((n) => a.id(n)));
    const oldIds = new Set(olds.map((n) => a.id(n)));
    const moved = movedIds(
      olds.map((n) => a.id(n)).filter((id) => newIds.has(id)),
      news.map((n) => a.id(n)).filter((id) => oldIds.has(id)),
    );
    const out: DiffNode<T>[] = [];
    const oldIndex = new Map(olds.map((n, i) => [a.id(n), i]));
    let b = 0;
    /**
     * The old side's nodes up to `id` (a node kept in order here), or to the end. `inclusive`
     * places that node too (a frame taken away, before what it held).
     */
    const flush = (id: string | null, inclusive = false) => {
      if (id !== null && (oldIndex.get(id) ?? -1) < b) return;
      while (b < olds.length) {
        const old = olds[b] as T;
        const oldId = a.id(old);
        b++;
        const last = oldId === id;
        if (last && !inclusive) return;
        if (newIds.has(oldId)) {
          // Kept here, but reordered: its old place.
          if (moved.has(oldId)) out.push(ghost(old));
        } else {
          const gone = removed(old);
          if (gone) out.push(gone);
        }
        if (last) return;
      }
    };
    /** The node of this old list that `id` stood in (itself, or an ancestor). */
    const oldHere = (id: string): string | null => {
      let at: string | null = id;
      while (at !== null && !oldIndex.has(at))
        at = was.get(at)?.parentId ?? null;
      return at;
    };
    for (const node of news) {
      const id = a.id(node);
      const here = oldIds.has(id);
      if (here && !moved.has(id)) flush(id);
      else if (!here && unwrapped(id)) {
        // Its frame was taken away: the frame first, where it stood.
        const frame = oldHere(id);
        if (frame !== null) flush(frame, true);
      } else if (!here && !was.has(id)) {
        // A new frame around what stood here: placed where the first of it stood.
        const first = a.children(node).find((k) => wrapped(a.id(k)));
        const at = first ? oldHere(a.id(first)) : null;
        if (at !== null) flush(at);
      }
      out.push(visit(node, here && moved.has(id)));
    }
    flush(null);
    return out;
  };

  return list(before, after);
}

/** How many changes of each kind a compared tree holds (each counted once, at its node). */
export interface ChangeCounts {
  readonly added: number;
  readonly removed: number;
  readonly changed: number;
  readonly moved: number;
}

export const NO_CHANGES: ChangeCounts = {
  added: 0,
  removed: 0,
  changed: 0,
  moved: 0,
};

export function addCounts(a: ChangeCounts, b: ChangeCounts): ChangeCounts {
  return {
    added: a.added + b.added,
    removed: a.removed + b.removed,
    changed: a.changed + b.changed,
    moved: a.moved + b.moved,
  };
}

export const totalOf = (c: ChangeCounts): number =>
  c.added + c.removed + c.changed + c.moved;

export function countChanges<T>(nodes: readonly DiffNode<T>[]): ChangeCounts {
  const c = { added: 0, removed: 0, changed: 0, moved: 0 };
  const walk = (list: readonly DiffNode<T>[]) => {
    for (const n of list) {
      if (n.hunk) c[n.hunk]++;
      walk(n.children);
    }
  };
  walk(nodes);
  return c;
}

/** A list of siblings as shown: nodes, and runs of unchanged ones folded together. */
export type Shown<T> =
  | { readonly kind: 'node'; readonly node: DiffNode<T> }
  | {
      readonly kind: 'run';
      /** The first node's ID: what keeps the run open in the address. */
      readonly key: string;
      readonly nodes: readonly DiffNode<T>[];
    };

/** Siblings with no change among them, this few, are shown whole (context, not a fold). */
const SHOWN_WHOLE = 3;

/**
 * The siblings with every run of unchanged nodes folded, keeping `context` unchanged nodes
 * next to each change. A run shorter than two stays as it is (folding one block saves nothing).
 * With nothing changed among them, a few are shown as they are (a step list beside a change),
 * more are folded together. A `pinned` node (one with review threads) is kept like a change.
 */
export function foldUnchanged<T>(
  nodes: readonly DiffNode<T>[],
  context = 1,
  pinned: (node: DiffNode<T>) => boolean = () => false,
): Shown<T>[] {
  const shown = nodes.map((n) => n.touched || pinned(n));
  if (nodes.length <= SHOWN_WHOLE && !shown.some(Boolean))
    return nodes.map((node) => ({ kind: 'node', node }));
  const keep = [...shown];
  nodes.forEach((n, i) => {
    if (!shown[i]) return;
    for (let d = 1; d <= context; d++) {
      if (i - d >= 0) keep[i - d] = true;
      if (i + d < nodes.length) keep[i + d] = true;
    }
  });
  const out: Shown<T>[] = [];
  let run: DiffNode<T>[] = [];
  const flush = () => {
    if (run.length >= 2) {
      out.push({ kind: 'run', key: (run[0] as DiffNode<T>).id, nodes: run });
    } else for (const node of run) out.push({ kind: 'node', node });
    run = [];
  };
  nodes.forEach((node, i) => {
    if (keep[i]) {
      flush();
      out.push({ kind: 'node', node });
    } else run.push(node);
  });
  flush();
  return out;
}
