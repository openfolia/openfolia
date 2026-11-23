import type { EditorView } from '@tiptap/pm/view';

import { moveSelectedBlock, selectedBlock } from './block-move';
import { keyboardTarget } from './drop-rules';
import { blockAround } from './flow';
import { flipShifts } from './drag-geometry';
import {
  blockDragKey,
  flowTops,
  measure,
  motionAllowed,
  SLIDE_MS,
  type DragState,
} from './drag-state';

/** The pending end of each view's slide, so a quick second move is not cut short. */
const slideTimers = new WeakMap<EditorView, ReturnType<typeof setTimeout>>();

/**
 * Slides blocks into place after a keyboard move of child `from` to `to` of the flow starting at
 * `flow`: each is pushed back to where it stood, then let go. `topsBefore` are the flow's
 * children's tops before the move.
 */
export function slideAfterMove(
  view: EditorView,
  flow: number,
  topsBefore: readonly number[],
  from: number,
  to: number,
): void {
  const win = view.dom.ownerDocument.defaultView;
  if (!motionAllowed(win) || !win || from === to) return;
  const topsAfter = measure(view, flow).map((box) => box.top);
  // A move that also closed up a gap has a different count: no slide then, just the move.
  if (topsAfter.length !== topsBefore.length) return;
  const shifts = flipShifts(topsBefore, topsAfter, from, to);
  const flip = (state: DragState['flip']) =>
    !view.isDestroyed &&
    view.dispatch(view.state.tr.setMeta(blockDragKey, { flip: state }));
  win.clearTimeout(slideTimers.get(view));
  flip({ flow, shifts, animate: false });
  // Lay the pushed-back frame out before letting go, or the browser skips the transition.
  void view.dom.offsetHeight;
  win.requestAnimationFrame(() => {
    flip({ flow, shifts: shifts.map(() => 0), animate: true });
    slideTimers.set(
      view,
      win.setTimeout(() => flip(null), SLIDE_MS),
    );
  });
}

/**
 * One step up or down for the selection's block, sliding into place as a drag does: the move
 * behind Alt+Up/Down and the toolbar's buttons. False when it cannot go that way.
 */
export function slidingMove(
  view: EditorView,
  up: boolean,
  frame = true,
): boolean {
  const step = keyboardTarget(view.state, up, frame);
  if (!step) return false;
  // The block that moves: the selection's, or at a container's edge the container around it.
  const $at = view.state.doc.resolve(step.from);
  const block = blockAround($at);
  if (!block) return false;
  const before = flowTops(view, block.flow);
  if (!moveSelectedBlock(view, up, frame)) return false;
  // A move within the flow leaves the flow's own start where it was. The selection is in the
  // moved block, at the depth it stood at.
  const $sel = view.state.selection.$from;
  const after =
    $sel.depth > $at.depth
      ? blockAround(view.state.doc.resolve($sel.before($at.depth + 1)))
      : selectedBlock(view.state);
  if (after && after.flow === block.flow) {
    slideAfterMove(view, block.flow, before, block.index, after.index);
  }
  return true;
}
