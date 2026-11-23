import {
  AllSelection,
  NodeSelection,
  Selection,
  TextSelection,
  type EditorState,
} from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';

import { keyboardTarget } from './drop-rules';
import {
  allowedRange,
  blockAround,
  flowNode,
  isBlank,
  type FlowBlock,
} from './flow';
import { ownUndoStep } from './heading-levels';

// Moving a block (`flow.ts`), within its flow or into another where `drop-rules.ts` lets it go:
// the one move behind the pointer's drag, Alt+Up/Down and the toolbar's buttons.

/** Set on a move's transaction: the selection follows the block, wherever the focus is. */
export const BLOCK_MOVED = 'docEditorBlockMoved';

/**
 * Moves the block at `from` to the position `to` (in the document as it is now: a place
 * `drop-rules.ts` allows). The selection keeps its place inside the block, and a blank gap the
 * block leaves behind does not stack up against another. One transaction and an undo step of its
 * own, so one undo puts it back.
 */
export function moveBlockTo(
  view: EditorView,
  from: number,
  to: number,
): boolean {
  const node = view.state.doc.nodeAt(from);
  if (!node || (to >= from && to <= from + node.nodeSize)) return false;
  const { selection } = view.state;
  const wasNode = selection instanceof NodeSelection;
  const offset = selection.from - from;
  // Starting in it counts: a selection running on past it collapses into it and stays with it.
  const inBlock =
    selection.from >= from && selection.from < from + node.nodeSize;

  // One transaction, so undo puts the selection back where it was before the move. A selected
  // block steps aside first: deleting the selected node would leave the selection nowhere.
  const tr = view.state.tr;
  if (wasNode) {
    tr.setSelection(
      Selection.findFrom(tr.doc.resolve(0), 1, true) ??
        new AllSelection(tr.doc),
    );
  }
  tr.delete(from, from + node.nodeSize);
  const site = tr.mapping.map(from);
  const at = tr.mapping.map(to);
  tr.insert(at, node);
  const moved = tr.mapping.slice(1).map(at, -1);

  if (inBlock) {
    const target = moved + offset;
    tr.setSelection(
      wasNode
        ? NodeSelection.create(tr.doc, target)
        : TextSelection.near(
            tr.doc.resolve(Math.min(target, tr.doc.content.size)),
          ),
    );
  }

  // Where it came from, two blanks may now touch: the gaps either side of it.
  const left = tr.mapping.slice(1).map(site);
  const $left = tr.doc.resolve(left);
  if (isBlank($left.nodeBefore) && isBlank($left.nodeAfter)) {
    tr.delete(left, left + ($left.nodeAfter?.nodeSize ?? 2));
  }
  view.dispatch(ownUndoStep(tr).setMeta(BLOCK_MOVED, inBlock));
  return true;
}

/** The block the selection is in, as `flow.ts` sees it. */
export function selectedBlock(state: EditorState): FlowBlock | null {
  return blockAround(state.selection.$from);
}

/**
 * Where the selection's block stands among what a reader sees of its flow: its own kind (blocks
 * or sections), no blank gaps but itself.
 */
export function blockPlace(state: EditorState): {
  position: number;
  total: number;
} {
  const block = selectedBlock(state);
  if (!block) return { position: 1, total: 1 };
  const flow = flowNode(state.doc, block.flow);
  const range = allowedRange(flow, block.index);
  let position = 1;
  let total = 0;
  flow.forEach((node, _offset, i) => {
    if (!range || i < range.first || i > range.last) return;
    if (isBlank(node) && i !== block.index) return;
    total += 1;
    if (i < block.index) position += 1;
  });
  return { position, total: Math.max(total, 1) };
}

/**
 * Whether the selection's block can move one step that way (`keyboardTarget`; `frame`: at a
 * container's edge, the container moves instead).
 */
export function canMoveBlock(
  state: EditorState,
  up: boolean,
  frame = true,
): boolean {
  return keyboardTarget(state, up, frame) !== null;
}

/**
 * One step for the selection's block: past the next block of its kind that is not a blank gap,
 * or across its flow's edge into the neighbouring one. False when it cannot go that way.
 */
export function moveSelectedBlock(
  view: EditorView,
  up: boolean,
  frame = true,
): boolean {
  const step = keyboardTarget(view.state, up, frame);
  return step ? moveBlockTo(view, step.from, step.to) : false;
}
