import { Extension } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import {
  Plugin,
  PluginKey,
  type EditorState,
  type Transaction,
} from '@tiptap/pm/state';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';

// Inserting and removing a documentation block animates: a new block fades and grows in (its
// node view gets `doc-block-enter`), a removed one leaves a blank of its height that closes
// (a widget, `doc-block-leave`), so what follows slides up instead of jumping. A move (the same
// block, by its ID, out of one place and into another in one step) is neither. Nothing animates
// for someone who asked for less motion: the CSS holds the animations in
// `prefers-reduced-motion: no-preference`, and no blank is left at all.

/** The block types that animate: the documentation blocks with node views. */
export const ANIMATED_TYPES: ReadonlySet<string> = new Set([
  'safety',
  'faq',
  'variant',
  'moduleRef',
  'image',
  'pageBreak',
]);

/** More blocks than this removed at once (a large selection deleted) close without a blank. */
const MAX_BLANKS = 3;
/** The longest a blank stays, should its animation never end. */
const BLANK_MS = 400;

interface MotionState {
  /** Where blocks were just inserted: their node views animate in when drawn. */
  fresh: readonly number[];
  /** Where blocks were just removed (in the current document) and their IDs. */
  removed: readonly { pos: number; id: string }[];
  /** The blanks closing where blocks were removed. */
  blanks: DecorationSet;
}

type MotionMeta =
  | { kind: 'blanks'; blanks: readonly { pos: number; height: number }[] }
  | { kind: 'closed'; key: string };

const key = new PluginKey<MotionState>('docBlocksMotion');

/** Numbers the blanks, so each has a key of its own. */
let blankCount = 0;

/** The height each removed block's view had, by editor and block ID: noted as it goes. */
const departed = new WeakMap<EditorView, Map<string, number>>();

/** Notes the height of a block's view as it goes (its node view's `destroy`). */
export function noteDeparture(
  view: EditorView,
  id: unknown,
  dom: HTMLElement,
): void {
  if (typeof id !== 'string' || !dom.isConnected) return;
  const heights = departed.get(view) ?? new Map<string, number>();
  heights.set(id, dom.getBoundingClientRect().height);
  departed.set(view, heights);
}

/** Whether a block was just inserted at `pos`; a node view asks once, as it is drawn. */
export function takeFresh(view: EditorView, pos: number): boolean {
  return key.getState(view.state)?.fresh.includes(pos) ?? false;
}

const idOf = (node: ProseMirrorNode): string | null => {
  const id = node.attrs['id'];
  return typeof id === 'string' && id ? id : null;
};

/** The IDs of `node` and of every node in it. */
function idsOf(node: ProseMirrorNode): string[] {
  const ids: string[] = [];
  const own = idOf(node);
  if (own) ids.push(own);
  node.descendants((child) => {
    const id = idOf(child);
    if (id) ids.push(id);
    return true;
  });
  return ids;
}

/**
 * The outermost animated blocks wholly inside `from`..`to` of `doc`, each with its position and
 * the IDs it holds (its own and its content's); and every ID of a node wholly in the range.
 */
function blocksIn(
  doc: ProseMirrorNode,
  from: number,
  to: number,
): {
  blocks: { pos: number; id: string | null; ids: string[] }[];
  ids: Set<string>;
} {
  const blocks: { pos: number; id: string | null; ids: string[] }[] = [];
  const ids = new Set<string>();
  if (to <= from) return { blocks, ids };
  doc.nodesBetween(from, to, (node, pos) => {
    if (pos < from || pos + node.nodeSize > to) return true;
    if (ANIMATED_TYPES.has(node.type.name)) {
      // Everything inside goes with it: an animated block inside it is not one of its own.
      const held = idsOf(node);
      for (const id of held) ids.add(id);
      blocks.push({ pos, id: idOf(node), ids: held });
      return false;
    }
    const id = idOf(node);
    if (id) ids.add(id);
    return true;
  });
  return { blocks, ids };
}

/** The part of the document a transaction changed: in the old and in the new document. */
function changedRange(
  before: ProseMirrorNode,
  after: ProseMirrorNode,
): { start: number; endA: number; endB: number } | null {
  const start = before.content.findDiffStart(after.content);
  if (start === null) return null;
  const end = before.content.findDiffEnd(after.content);
  if (!end) return null;
  let { a: endA, b: endB } = end;
  const overlap = start - Math.min(endA, endB);
  if (overlap > 0) {
    endA += overlap;
    endB += overlap;
  }
  return { start, endA, endB };
}

function apply(
  tr: Transaction,
  prev: MotionState,
  before: EditorState,
): MotionState {
  let blanks = prev.blanks.map(tr.mapping, tr.doc);
  const meta = tr.getMeta(key) as MotionMeta | undefined;
  if (meta?.kind === 'closed')
    blanks = blanks.remove(
      blanks.find(undefined, undefined, (spec) => spec['key'] === meta.key),
    );
  if (meta?.kind === 'blanks') {
    blanks = blanks.add(
      tr.doc,
      meta.blanks.map(({ pos, height }, index) => {
        blankCount += 1;
        const blankKey = `blank-${blankCount}-${index}`;
        return Decoration.widget(pos, (view) => blank(view, height, blankKey), {
          side: -1,
          key: blankKey,
          ignoreSelection: true,
        });
      }),
    );
  }
  // What one change inserted or removed lasts until the view has drawn it: through the
  // transactions appended to it (IDs given by the repair step), not past the next one.
  const appended = !!tr.getMeta('appendedTransaction');
  const keptFresh = appended
    ? prev.fresh.flatMap((pos) => {
        const result = tr.mapping.mapResult(pos, 1);
        return result.deleted ? [] : [result.pos];
      })
    : [];
  const keptRemoved = appended
    ? prev.removed.map((r) => ({ ...r, pos: tr.mapping.map(r.pos, -1) }))
    : [];
  const range = tr.docChanged ? changedRange(before.doc, tr.doc) : null;
  if (!range) return { fresh: keptFresh, removed: keptRemoved, blanks };
  const old = blocksIn(before.doc, range.start, range.endA);
  const now = blocksIn(tr.doc, range.start, range.endB);
  // A block is new when it was not there before (a variant block made around a block is; the
  // block in it is not, as only the outermost are looked at). A block is gone only when nothing
  // it held is there after: one taken out of a variant block (Undo) leaves no blank.
  const fresh = now.blocks
    .filter((b) => !b.id || !old.ids.has(b.id))
    .map((b) => b.pos);
  const removed = old.blocks.flatMap((b) =>
    b.id && !b.ids.some((id) => now.ids.has(id))
      ? [{ pos: tr.mapping.map(b.pos, -1), id: b.id }]
      : [],
  );
  return {
    fresh: [...new Set([...keptFresh, ...fresh])],
    removed: [...keptRemoved, ...removed],
    blanks,
  };
}

/** A blank of the removed block's height that closes, then takes itself out. */
function blank(
  view: EditorView,
  height: number,
  blankKey: string,
): HTMLElement {
  const dom = view.dom.ownerDocument.createElement('div');
  dom.className = 'doc-block-leave';
  dom.setAttribute('aria-hidden', 'true');
  dom.setAttribute('contenteditable', 'false');
  dom.style.setProperty('--leave-height', `${height}px`);
  let closed = false;
  const close = () => {
    if (closed || view.isDestroyed) return;
    closed = true;
    view.dispatch(
      view.state.tr
        .setMeta(key, { kind: 'closed', key: blankKey } satisfies MotionMeta)
        .setMeta('addToHistory', false),
    );
  };
  dom.addEventListener('animationend', close);
  setTimeout(close, BLANK_MS);
  return dom;
}

const reducedMotion = (view: EditorView) =>
  view.dom.ownerDocument.defaultView?.matchMedia?.(
    '(prefers-reduced-motion: reduce)',
  ).matches ?? true;

/** The motion of inserted and removed documentation blocks. */
export const BlockMotion = Extension.create({
  name: 'docBlocksMotion',
  addProseMirrorPlugins() {
    return [
      new Plugin<MotionState>({
        key,
        state: {
          init: () => ({ fresh: [], removed: [], blanks: DecorationSet.empty }),
          apply: (tr, prev, before) => apply(tr, prev, before),
        },
        props: {
          decorations: (state) => key.getState(state)?.blanks,
        },
        view: () => ({
          update(view) {
            const state = key.getState(view.state);
            if (!state?.removed.length) return;
            const heights = departed.get(view);
            const blanks =
              state.removed.length > MAX_BLANKS || reducedMotion(view)
                ? []
                : state.removed.flatMap(({ pos, id }) => {
                    const height = heights?.get(id) ?? 0;
                    return height > 0 ? [{ pos, height }] : [];
                  });
            for (const { id } of state.removed) heights?.delete(id);
            // Before the next paint: the blank takes the block's place without a jump. Should
            // the document change first, the places are stale: no blank then (that change has
            // already let the removal go).
            const doc = view.state.doc;
            queueMicrotask(() => {
              if (view.isDestroyed || view.state.doc !== doc) return;
              const tr = view.state.tr.setMeta('addToHistory', false);
              tr.setMeta(key, { kind: 'blanks', blanks } satisfies MotionMeta);
              view.dispatch(tr);
            });
          },
        }),
      }),
    ];
  },
});
