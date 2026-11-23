import type {
  NodeType,
  Node as ProseMirrorNode,
  ResolvedPos,
} from '@tiptap/pm/model';
import type { EditorState } from '@tiptap/pm/state';

import { isBlank, isSection, isStep, isStepText, isTitle } from './flow';

export { isStepText };

// Where a block inserted at the caret goes ("/", the Insert menu, an image or file dropped or
// pasted): framework-free, so it is tested without a browser.

/** What holds blocks: the flows (the document, a section) and the documentation containers. */
const HOLDERS = new Set([
  'doc',
  'section',
  'variant',
  'safety',
  'admonition',
  'faq',
]);

/**
 * The block at `$pos` in the innermost flow, documentation container or procedure step holding
 * it: a paragraph in a variant block, not the variant; a step's text in its step, not the
 * procedure. A section's heading stands for its section, one flow out; a safety notice's hazard
 * and an FAQ entry's question are returned as they are.
 */
export function blockAt(
  $pos: ResolvedPos,
): { pos: number; node: ProseMirrorNode } | null {
  for (let depth = $pos.depth; depth >= 0; depth -= 1) {
    const holder = $pos.node(depth);
    const parent = depth > 0 ? $pos.node(depth - 1) : null;
    // A procedure's step holds blocks too, under its text (an image, a note, a sub-procedure…).
    if (!HOLDERS.has(holder.type.name) && !isStep(holder, parent)) continue;
    const index = $pos.index(depth);
    const node = holder.maybeChild(index);
    if (!node || isTitle(node)) continue;
    return { pos: $pos.posAtIndex(index, depth), node };
  }
  return null;
}

/**
 * Where a new block goes: in place of a blank line, else after the block at the caret, in the
 * container the caret is in (after a safety notice's hazard or an FAQ entry's question: its first block; after a step's
 * text: the first block under it). Null where the schema takes no such block there.
 */
export function placeFor(
  state: EditorState,
  type: NodeType,
): { from: number; to: number } | null {
  const block = blockAt(state.selection.$from);
  let from: number;
  let to: number;
  if (!block) {
    from = to = state.doc.content.size;
  } else if (isSection(block.node)) {
    // The caret is in the section's heading: the block is its first.
    const title = block.node.firstChild;
    from = to = block.pos + 1 + (title?.nodeSize ?? 0);
  } else if (isStepText(block.node)) {
    // Under the step's text, and under its result (the paragraph right after it) if it has one.
    const $text = state.doc.resolve(block.pos);
    const next = $text.parent.maybeChild($text.index() + 1);
    const after = block.pos + block.node.nodeSize;
    from = to = next?.type.name === 'paragraph' ? after + next.nodeSize : after;
  } else if (isBlank(block.node)) {
    from = block.pos;
    to = block.pos + block.node.nodeSize;
  } else {
    from = to = block.pos + block.node.nodeSize;
  }
  // Blocks come before a flow's sections: never after one.
  const $at = state.doc.resolve(from);
  if (!$at.parent.canReplaceWith($at.index(), $at.indexAfter(), type))
    return null;
  return { from, to };
}
