import { closeHistory } from '@tiptap/pm/history';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import {
  NodeSelection,
  Selection,
  TextSelection,
  type EditorState,
  type Transaction,
} from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';

import { canMoveBlock } from './block-move';
import { slidingMove } from './block-slide';
import { blockAround, isBlank, isTitle } from './flow';

// What the grip's menu does to the block it belongs to: a block of a flow (`flow.ts`), of any
// type, so a node type added later is covered without a change here. Each action is one
// transaction of its own in the history (never merged with typing just before it), so one undo
// takes back exactly it.

/** The actions the menu offers for a block, and whether each can run now. */
export interface BlockActionState {
  readonly canDelete: boolean;
  readonly canDuplicate: boolean;
  readonly canMoveUp: boolean;
  readonly canMoveDown: boolean;
  /** Whether the block is a frame whose content can stand in its place ("Remove frame"). */
  readonly canUnwrap: boolean;
}

const NOTHING: BlockActionState = {
  canDelete: false,
  canDuplicate: false,
  canMoveUp: false,
  canMoveDown: false,
  canUnwrap: false,
};

/** The flow block starting at `pos`, or null when there is none there. */
export function flowBlockAt(
  state: EditorState,
  pos: number,
): { node: ProseMirrorNode; index: number; parent: ProseMirrorNode } | null {
  if (pos < 0 || pos >= state.doc.content.size) return null;
  const node = state.doc.nodeAt(pos);
  if (!node || isTitle(node)) return null;
  const $pos = state.doc.resolve(pos);
  // Only a child of a flow: what `blockAround` finds right before it.
  const block = blockAround($pos);
  if (!block || block.pos !== pos) return null;
  return { node, index: $pos.index(), parent: $pos.parent };
}

/**
 * Whether `node` is a frame around blocks that can take its place in `parent` at `index`: a
 * variant block, say; not a list, a table, a section or a safety notice, whose content holds
 * more than blocks.
 */
function unwrappable(
  parent: ProseMirrorNode,
  index: number,
  node: ProseMirrorNode,
): boolean {
  if (node.isAtom || node.isTextblock || node.childCount === 0) return false;
  let blocks = true;
  node.forEach((child) => {
    if (!child.type.isInGroup('block')) blocks = false;
  });
  return blocks && parent.canReplace(index, index + 1, node.content);
}

/** What the menu offers for the block at `pos`, as the document is now. */
export function blockActions(
  state: EditorState,
  pos: number,
): BlockActionState {
  const block = flowBlockAt(state, pos);
  if (!block) return NOTHING;
  const { node, index, parent } = block;
  const selected = withBlockSelected(state, pos);
  return {
    canDelete: parent.canReplace(index, index + 1),
    canDuplicate: parent.canReplaceWith(index + 1, index + 1, node.type),
    // That block itself: from a container's block, never its container.
    canMoveUp: canMoveBlock(selected, true, false),
    canMoveDown: canMoveBlock(selected, false, false),
    canUnwrap: unwrappable(parent, index, node),
  };
}

/**
 * A selection in the block at `pos` of `doc`: `current` when it is already there, else the first
 * place to type in it, else the block itself.
 */
function selectionIn(
  doc: ProseMirrorNode,
  pos: number,
  current: Selection | null,
  /** Only a selection that stands for this block, as a move needs (else: the block selected). */
  own = true,
): Selection {
  const node = doc.nodeAt(pos);
  const end = pos + (node?.nodeSize ?? 0);
  // Kept only when it stands for this very block: in a section, a caret in its body is in an
  // inner block, and a move would take that one instead.
  if (current && blockAround(current.$from)?.pos === pos) return current;
  const inside = node?.isAtom
    ? null
    : Selection.findFrom(doc.resolve(pos + 1), 1, true);
  // Only where it stands for this block: in a variant block, the first place to type is in the
  // block inside it, which a move would take instead.
  if (
    inside &&
    inside.from < end &&
    (!own || blockAround(inside.$from)?.pos === pos)
  )
    return inside;
  return NodeSelection.create(doc, pos);
}

function withBlockSelected(state: EditorState, pos: number): EditorState {
  return state.apply(
    state.tr.setSelection(selectionIn(state.doc, pos, state.selection)),
  );
}

/**
 * Deletes the block at `pos` in one step. The caret goes where it was, and a blank gap left
 * next to another closes up. False when it cannot go.
 */
export function deleteBlock(view: EditorView, pos: number): boolean {
  const block = flowBlockAt(view.state, pos);
  if (!block || !blockActions(view.state, pos).canDelete) return false;
  const tr = view.state.tr.delete(pos, pos + block.node.nodeSize);
  closeGaps(tr, pos);
  const at = tr.mapping.map(pos);
  tr.setSelection(TextSelection.near(tr.doc.resolve(at), -1));
  view.dispatch(closeHistory(tr).scrollIntoView());
  return true;
}

/** Two blank gaps that meet at `pos` (mapped) become one. */
function closeGaps(tr: Transaction, pos: number): void {
  const at = tr.mapping.map(pos);
  const $at = tr.doc.resolve(at);
  if (isBlank($at.nodeBefore) && isBlank($at.nodeAfter)) {
    tr.delete(at, at + ($at.nodeAfter?.nodeSize ?? 2));
  }
}

/**
 * Puts a copy of the block at `pos` right after it, in one step, with the caret in the copy
 * (the copy gets block IDs of its own from the model's repair). False when it cannot go there.
 */
export function duplicateBlock(view: EditorView, pos: number): boolean {
  const block = flowBlockAt(view.state, pos);
  if (!block || !blockActions(view.state, pos).canDuplicate) return false;
  const after = pos + block.node.nodeSize;
  const tr = view.state.tr.insert(after, block.node.copy(block.node.content));
  tr.setSelection(selectionIn(tr.doc, after, null, false));
  view.dispatch(closeHistory(tr).scrollIntoView());
  return true;
}

/** Puts the frame's content in its place, in one step; the caret at the start of it. */
export function unwrapBlock(view: EditorView, pos: number): boolean {
  const block = flowBlockAt(view.state, pos);
  if (!block || !blockActions(view.state, pos).canUnwrap) return false;
  const tr = view.state.tr.replaceWith(
    pos,
    pos + block.node.nodeSize,
    block.node.content,
  );
  tr.setSelection(TextSelection.near(tr.doc.resolve(pos), 1));
  view.dispatch(closeHistory(tr).scrollIntoView());
  return true;
}

/**
 * One step up or down for the block at `pos`, as Alt+Up/Down moves it (sliding into place): the
 * caret goes into the block first unless it is there already. False when it cannot go that way.
 */
export function moveBlock(view: EditorView, pos: number, up: boolean): boolean {
  if (!flowBlockAt(view.state, pos)) return false;
  if (!canMoveBlock(withBlockSelected(view.state, pos), up, false))
    return false;
  const selection = selectionIn(view.state.doc, pos, view.state.selection);
  if (!selection.eq(view.state.selection))
    view.dispatch(view.state.tr.setSelection(selection));
  return slidingMove(view, up, false);
}
