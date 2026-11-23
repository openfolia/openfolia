import {
  Fragment,
  type Node as ProseMirrorNode,
  type NodeType,
  type Schema,
} from '@tiptap/pm/model';
import {
  TextSelection,
  type Command,
  type EditorState,
  type Transaction,
} from '@tiptap/pm/state';

import { isFlow, isSection, isTitle } from './flow';

// The structure of the content model, edited as text styles: a section heading is a section's
// title, and the section holds what follows it, as a heading does in a word processor. Turning
// a line of text into a heading or back, and lines into a list and back, changes the tree, never
// the order of what is read. Each change is one transaction (one undo) and keeps the block's ID
// on the node that takes its place; new nodes have none until the repair step gives them one.

type Dispatch = ((tr: Transaction) => void) | undefined;

const nodeType = (schema: Schema, name: string): NodeType => {
  const type = schema.nodes[name];
  if (!type) throw new Error(`the schema has no ${name}`);
  return type;
};

/** Inline content for a title: line breaks become spaces, as a title has one line. */
function titleContent(schema: Schema, content: Fragment): Fragment {
  const out: ProseMirrorNode[] = [];
  content.forEach((node) => {
    out.push(
      node.type.name === 'hardBreak' ? schema.text(' ', node.marks) : node,
    );
  });
  return Fragment.fromArray(out);
}

/** Puts the caret `offset` into the text block that starts at `pos`. */
function caretInto(tr: Transaction, pos: number, offset: number): void {
  const block = tr.doc.nodeAt(pos);
  if (!block?.isTextblock) return;
  tr.setSelection(
    TextSelection.create(
      tr.doc,
      pos + 1 + Math.min(offset, block.content.size),
    ),
  );
}

/** The position of this very node (not an equal one) in `doc`, or -1. */
function positionOf(doc: ProseMirrorNode, target: ProseMirrorNode): number {
  let at = -1;
  doc.descendants((node, pos) => {
    if (at >= 0) return false;
    if (node === target) at = pos;
    return at < 0;
  });
  return at;
}

/**
 * The paragraph at the caret becomes a section heading: a section with the paragraph's text as
 * its title, holding the blocks after it in its flow (the subsections that follow stay its
 * siblings). Only for a paragraph directly in a flow.
 */
export const paragraphToSection: Command = (state, dispatch) => {
  const { $from } = state.selection;
  if ($from.parent.type.name !== 'paragraph' || $from.depth < 1) return false;
  const flow = $from.node(-1);
  if (!isFlow(flow)) return false;
  if (!dispatch) return true;

  const paragraph = $from.parent;
  const index = $from.index(-1);
  const { schema } = state;
  const taken: ProseMirrorNode[] = [];
  for (
    let i = index + 1;
    i < flow.childCount && !isSection(flow.child(i));
    i += 1
  )
    taken.push(flow.child(i));
  const section = nodeType(schema, 'section').create(
    { id: paragraph.attrs['id'] },
    [
      nodeType(schema, 'title').create(
        null,
        titleContent(schema, paragraph.content),
      ),
      ...taken,
    ],
  );
  const from = $from.before();
  const to =
    from +
    paragraph.nodeSize +
    taken.reduce((size, node) => size + node.nodeSize, 0);
  const tr = state.tr.replaceWith(from, to, section);
  caretInto(tr, from + 1, $from.parentOffset);
  dispatch(tr.scrollIntoView());
  return true;
};

/** Appends `blocks` to the deepest last section of `section` (itself, when it has none). */
function appendDeep(
  section: ProseMirrorNode,
  blocks: readonly ProseMirrorNode[],
): ProseMirrorNode {
  const last = section.lastChild;
  if (last && isSection(last)) {
    return section.copy(
      section.content.replaceChild(
        section.childCount - 1,
        appendDeep(last, blocks),
      ),
    );
  }
  return section.copy(section.content.append(Fragment.fromArray([...blocks])));
}

/**
 * The section heading at the caret becomes a line of text, and the section's blocks follow it
 * where the text now stands: at the end of the section before it (its deepest last one), or
 * among the flow's blocks when it was the first section there. Its subsections stay where they
 * stood in the reading order, one level up when nothing is left to hold them at their own.
 */
export const sectionToParagraph: Command = (state, dispatch) => {
  const { $from } = state.selection;
  if (!isTitle($from.parent) || $from.depth < 2) return false;
  if (!dispatch) return true;

  const section = $from.node(-1);
  const flow = $from.node(-2);
  const index = $from.index(-2);
  const sectionPos = $from.before(-1);
  const { schema } = state;
  const paragraph = nodeType(schema, 'paragraph').create(
    { id: section.attrs['id'] },
    $from.parent.content,
  );
  const blocks: ProseMirrorNode[] = [paragraph];
  const subsections: ProseMirrorNode[] = [];
  section.forEach((child, _offset, i) => {
    if (i > 0) (isSection(child) ? subsections : blocks).push(child);
  });
  const previous = index > 0 ? flow.child(index - 1) : null;
  const tr = state.tr;
  if (previous && isSection(previous)) {
    const merged = appendDeep(previous, blocks);
    tr.replaceWith(
      sectionPos - previous.nodeSize,
      sectionPos + section.nodeSize,
      merged.copy(merged.content.append(Fragment.fromArray(subsections))),
    );
  } else {
    tr.replaceWith(sectionPos, sectionPos + section.nodeSize, [
      ...blocks,
      ...subsections,
    ]);
  }
  caretInto(tr, positionOf(tr.doc, paragraph), $from.parentOffset);
  dispatch(tr.scrollIntoView());
  return true;
};

/** The list around the caret's item text: the list, its position and the item. */
function listAround(state: EditorState) {
  const { $from } = state.selection;
  if ($from.parent.type.name !== 'itemText' || $from.depth < 3) return null;
  return { list: $from.node(-2), pos: $from.before(-2), item: $from.node(-1) };
}

/** Whether the caret is in a list of this kind, for a toolbar button's pressed state. */
export function inList(state: EditorState, ordered: boolean): boolean {
  const around = listAround(state);
  return !!around && around.list.attrs['ordered'] === ordered;
}

/**
 * A list at the caret. In a list of the other kind, the list switches kind; in one of this kind,
 * it becomes paragraphs again (each item's text, then the item's blocks); on paragraphs, the
 * selected run of sibling paragraphs becomes the list, one item each.
 */
export function toggleList(ordered: boolean): Command {
  return (state, dispatch) => {
    const around = listAround(state);
    if (!around) return wrapInList(state, dispatch, ordered);
    const { list, pos, item } = around;
    if (list.attrs['ordered'] !== ordered) {
      dispatch?.(state.tr.setNodeMarkup(pos, null, { ...list.attrs, ordered }));
      return true;
    }
    return unwrapList(state, dispatch, list, pos, item);
  };
}

function unwrapList(
  state: EditorState,
  dispatch: Dispatch,
  list: ProseMirrorNode,
  pos: number,
  caretItem: ProseMirrorNode,
): boolean {
  const { $from } = state.selection;
  const paragraphType = nodeType(state.schema, 'paragraph');
  const out: ProseMirrorNode[] = [];
  let caretParagraph: ProseMirrorNode | null = null;
  list.forEach((item) => {
    const paragraph = paragraphType.create(
      { id: item.attrs['id'] },
      item.firstChild?.content ?? Fragment.empty,
    );
    if (item === caretItem) caretParagraph = paragraph;
    out.push(paragraph);
    item.forEach((child, _offset, i) => {
      if (i > 0) out.push(child);
    });
  });
  const parent = $from.node(-3);
  const index = $from.index(-3);
  if (!parent.canReplace(index, index + 1, Fragment.fromArray(out)))
    return false;
  if (!dispatch) return true;
  const tr = state.tr.replaceWith(pos, pos + list.nodeSize, out);
  if (caretParagraph)
    caretInto(tr, positionOf(tr.doc, caretParagraph), $from.parentOffset);
  dispatch(tr.scrollIntoView());
  return true;
}

function wrapInList(
  state: EditorState,
  dispatch: Dispatch,
  ordered: boolean,
): boolean {
  const { $from, $to } = state.selection;
  if ($from.parent.type.name !== 'paragraph' || $from.depth < 1) return false;
  const depth = $from.depth - 1;
  const parent = $from.node(depth);
  const first = $from.index(depth);
  // The run of paragraphs from the caret's to the selection's end, in the same parent.
  const wanted =
    $to.depth > depth && $to.node(depth) === parent ? $to.index(depth) : first;
  let last = first;
  while (last < wanted && parent.child(last + 1).type.name === 'paragraph')
    last += 1;

  const { schema } = state;
  const items: ProseMirrorNode[] = [];
  for (let i = first; i <= last; i += 1) {
    const paragraph = parent.child(i);
    items.push(
      nodeType(schema, 'listItem').create({ id: paragraph.attrs['id'] }, [
        nodeType(schema, 'itemText').create(null, paragraph.content),
      ]),
    );
  }
  const list = nodeType(schema, 'list').create({ ordered }, items);
  if (!parent.canReplace(first, last + 1, Fragment.from(list))) return false;
  if (!dispatch) return true;
  const from = $from.before();
  let to = from;
  for (let i = first; i <= last; i += 1) to += parent.child(i).nodeSize;
  const tr = state.tr.replaceWith(from, to, list);
  // The caret's paragraph is the first item: past the list's and the item's openings.
  caretInto(tr, from + 2, $from.parentOffset);
  dispatch(tr.scrollIntoView());
  return true;
}
