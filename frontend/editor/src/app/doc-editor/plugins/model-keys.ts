import { Extension, isiOS, isMacOS } from '@tiptap/core';
import {
  Fragment,
  type Node as ProseMirrorNode,
  type ResolvedPos,
} from '@tiptap/pm/model';
import {
  NodeSelection,
  TextSelection,
  type Command,
  type Transaction,
} from '@tiptap/pm/state';

import { enterOnBlank } from './blank-lines';
import { liftStep, sinkStep } from './procedure-steps';
import { sectionToParagraph } from './structure';

// The keys the content model's nodes need, which the package leaves to the editor: the marks'
// shortcuts, Enter and Tab in a list, Backspace and Delete at the edge of a block. ProseMirror's
// defaults would join across the edges the model has: delete a read-only block next to the caret
// in one keystroke, pull a section into the one before it, or hand a block's ID to a new empty
// one. These keys keep every block what it was.

/**
 * The block next to the caret across the nearest edge, when the caret is at the start (`dir`
 * -1) or end (1) of its text block and of every block around it up to that edge.
 */
function across(
  $pos: ResolvedPos,
  dir: -1 | 1,
): { pos: number; node: ProseMirrorNode; depth: number } | null {
  for (let depth = $pos.depth - 1; depth >= 0; depth -= 1) {
    const parent = $pos.node(depth);
    const index = $pos.index(depth);
    const sibling = dir < 0 ? index - 1 : index + 1;
    if (sibling >= 0 && sibling < parent.childCount) {
      const node = parent.child(sibling);
      const at = dir < 0 ? $pos.before(depth + 1) : $pos.after(depth + 1);
      return { pos: dir < 0 ? at - node.nodeSize : at, node, depth };
    }
  }
  return null;
}

/**
 * Backspace at the start or Delete at the end of a text block, next to a read-only block (an
 * atom): selects it, so the next press deletes it, knowingly. Delete before a section moves the
 * caret into its heading instead of pulling the section into the one the caret is in. Backspace
 * into a heading and Delete out of one only move the caret (text never merges with a heading);
 * a blank line next to it still goes.
 */
export const guardEdge =
  (dir: -1 | 1): Command =>
  (state, dispatch) => {
    const { $from, empty } = state.selection;
    if (!empty || !$from.parent.isTextblock) return false;
    const atEdge =
      dir < 0
        ? $from.parentOffset === 0
        : $from.parentOffset === $from.parent.content.size;
    if (!atEdge) return false;
    const next = across($from, dir);
    if (!next) return false;
    if (next.node.isAtom && next.node.isBlock) {
      dispatch?.(
        state.tr.setSelection(NodeSelection.create(state.doc, next.pos)),
      );
      return true;
    }
    if (dir > 0 && next.node.type.name === 'section') {
      dispatch?.(
        state.tr.setSelection(TextSelection.create(state.doc, next.pos + 2)),
      );
      return true;
    }
    // Text never merges into a heading or out of one: the caret crosses the edge instead. A
    // blank line still goes (it holds nothing).
    if (dir < 0 && next.node.type.name === 'title') {
      if ($from.parent.content.size === 0) return false;
      dispatch?.(
        state.tr.setSelection(
          TextSelection.create(state.doc, next.pos + next.node.nodeSize - 1),
        ),
      );
      return true;
    }
    if (dir > 0 && $from.parent.type.name === 'title') {
      // Whatever follows (a paragraph, a list…): the caret goes to its first text.
      const blank =
        next.node.type.name === 'paragraph' && next.node.content.size === 0;
      if (blank) return false;
      const target = TextSelection.findFrom(
        state.doc.resolve(next.pos),
        1,
        true,
      );
      if (target) dispatch?.(state.tr.setSelection(target));
      return true;
    }
    return false;
  };

/**
 * Enter at the start of a paragraph or list item with text: the new empty block goes before it,
 * and the block with its text keeps its place and its ID (a split would leave the ID on the empty
 * half). At the start of a section heading, an empty paragraph goes before the section where the
 * flow allows one there; elsewhere nothing happens rather than the heading text becoming body text.
 * A new blank paragraph takes the caret (a blank line the caret is not in goes, `blank-lines.ts`);
 * in a list the caret stays with the item's text.
 */
export const enterAtStart: Command = (state, dispatch) => {
  const { $from, empty } = state.selection;
  if (!empty || $from.parentOffset !== 0 || $from.parent.content.size === 0)
    return false;
  const name = $from.parent.type.name;
  const paragraph = state.schema.nodes['paragraph'];
  if (!paragraph) return false;
  let pos: number;
  let node: ProseMirrorNode | null;
  if (name === 'paragraph') {
    pos = $from.before();
    node = paragraph.create();
  } else if (name === 'itemText') {
    pos = $from.before(-1);
    node = $from.node(-1).type.createAndFill();
  } else if (name === 'title' && $from.depth >= 2) {
    pos = $from.before(-1);
    const flow = $from.node(-2);
    const index = $from.index(-2);
    node = paragraph.create();
    if (!flow.canReplace(index, index, Fragment.from(node))) return true;
  } else {
    return false;
  }
  if (!node) return false;
  if (dispatch) {
    const tr = state.tr.insert(pos, node);
    if (node.type === paragraph)
      tr.setSelection(TextSelection.create(tr.doc, pos + 1));
    dispatch(tr.scrollIntoView());
  }
  return true;
};

/** The list a Tab just made takes the kind of the list it was made in (on the same step). */
function keepNestedKind(tr: Transaction): void {
  const { $from } = tr.selection;
  if ($from.depth < 5 || $from.node(-3).type.name !== 'listItem') return;
  const inner = $from.node(-2);
  const outer = $from.node(-4);
  if (inner.attrs['ordered'] === outer.attrs['ordered']) return;
  tr.setNodeMarkup($from.before(-2), null, {
    ...inner.attrs,
    ordered: outer.attrs['ordered'],
  });
}

/**
 * Enter on an empty last item of a list leaves the list: the item goes, and an empty paragraph
 * follows the list (takes its place, when it was the only item).
 */
export const exitEmptyItem: Command = (state, dispatch) => {
  const { $from, empty } = state.selection;
  if (!empty || $from.parent.type.name !== 'itemText' || $from.depth < 3)
    return false;
  const item = $from.node(-1);
  const list = $from.node(-2);
  if ($from.parent.content.size > 0 || item.childCount > 1) return false;
  if ($from.index(-2) !== list.childCount - 1) return false;
  const paragraph = state.schema.nodes['paragraph']?.create();
  if (!paragraph) return false;
  // A procedure's title is not one of its steps.
  const titled = list.firstChild?.type.name === 'title';
  const items = list.childCount - (titled ? 1 : 0);
  // The only step of a titled procedure stays: the title can't stand alone.
  if (items === 1 && titled) return true;
  if (!dispatch) return true;
  const listPos = $from.before(-2);
  const tr = state.tr;
  if (items === 1) {
    tr.replaceWith(listPos, listPos + list.nodeSize, paragraph);
    tr.setSelection(TextSelection.create(tr.doc, listPos + 1));
  } else {
    const itemPos = $from.before(-1);
    tr.delete(itemPos, itemPos + item.nodeSize);
    const after = tr.mapping.map(listPos + list.nodeSize);
    tr.insert(after, paragraph);
    tr.setSelection(TextSelection.create(tr.doc, after + 1));
  }
  dispatch(tr.scrollIntoView());
  return true;
};

const inItemText = (name: string) => name === 'itemText';

/**
 * Backspace at the start of a block's own title (a procedure's, a table's caption): an empty one
 * goes (it is optional), the caret before it; text never merges out of it, so nothing else
 * happens.
 */
export const removeEmptyTitle: Command = (state, dispatch) => {
  const { $from } = state.selection;
  if ($from.parent.type.name !== 'title' || $from.depth < 2) return false;
  if ($from.parent.content.size > 0) return true;
  const holder = $from.node(-1);
  const rest = holder.content.cut($from.parent.nodeSize);
  if (!holder.type.validContent(rest)) return true;
  if (dispatch) {
    const tr = state.tr.delete($from.before(), $from.after());
    tr.setSelection(TextSelection.near(tr.doc.resolve($from.before())));
    dispatch(tr.scrollIntoView());
  }
  return true;
};

/** The keys TipTap's core keymap deletes backward with (joinBackward), on every platform. */
const BACKWARD_KEYS = ['Backspace', 'Mod-Backspace', 'Shift-Backspace'];

/** The keys it deletes forward with (joinForward). */
const FORWARD_KEYS = ['Delete', 'Mod-Delete'];

/** Its macOS-only ones: elsewhere these keys mean something else (history, bookmark…). */
const MAC_BACKWARD_KEYS = ['Ctrl-h', 'Alt-Backspace'];
const MAC_FORWARD_KEYS = [
  'Ctrl-d',
  'Ctrl-Alt-Backspace',
  'Alt-Delete',
  'Alt-d',
];

export const ModelKeys = Extension.create({
  name: 'modelKeys',
  addKeyboardShortcuts() {
    const { editor } = this;
    const run = (command: Command) => () =>
      command(editor.state, editor.view.dispatch, editor.view);
    const inItem = () =>
      inItemText(editor.state.selection.$from.parent.type.name);
    const inStep = () => {
      const { $from } = editor.state.selection;
      return (
        inItemText($from.parent.type.name) &&
        $from.depth >= 3 &&
        $from.node(-2).type.name === 'procedure'
      );
    };
    const backward = () => {
      const { $from, empty } = editor.state.selection;
      if (
        empty &&
        $from.parent.type.name === 'title' &&
        $from.parentOffset === 0
      )
        return $from.node(-1).type.name === 'section'
          ? run(sectionToParagraph)()
          : run(removeEmptyTitle)();
      return run(guardEdge(-1))();
    };
    const forward = () => run(guardEdge(1))();
    const mac = isMacOS() || isiOS();
    return {
      'Mod-b': () => editor.commands.toggleMark('strong'),
      'Mod-i': () => editor.commands.toggleMark('emphasis'),
      'Mod-e': () => editor.commands.toggleMark('code'),
      Enter: () =>
        run(enterOnBlank)() ||
        run(enterAtStart)() ||
        (inItem() &&
          (run(exitEmptyItem)() || editor.commands.splitListItem('listItem'))),
      Tab: () => {
        if (!inItem()) return false;
        // A procedure's step has its own (the procedure may start with a title).
        if (inStep()) return run(sinkStep)() || true;
        // In a list, Tab stays in the editor even where the item can't go deeper.
        if (!editor.can().sinkListItem('listItem')) return true;
        // Into a list the item before already ends in, the item takes that list's kind;
        // only a list the sink makes takes the kind of the list it is made in.
        const { $from } = editor.state.selection;
        const before = $from.node(-2).maybeChild($from.index(-2) - 1);
        const joins = before?.lastChild?.type.name === 'list';
        return editor
          .chain()
          .sinkListItem('listItem')
          .command(({ tr }) => {
            if (!joins) keepNestedKind(tr);
            return true;
          })
          .run();
      },
      // Only out of a nested list: an item's text can't stand outside a list.
      'Shift-Tab': () =>
        (inStep() &&
        editor.state.selection.$from.node(-3).type.name === 'listItem'
          ? run(liftStep)() || true
          : false) ||
        (inItem() &&
          editor.state.selection.$from.node(-3).type.name === 'listItem' &&
          editor.commands.liftListItem('listItem')),
      // Every key TipTap's core keymap joins with (plain, modified and the macOS variants).
      ...Object.fromEntries(
        [...BACKWARD_KEYS, ...(mac ? MAC_BACKWARD_KEYS : [])].map((key) => [
          key,
          backward,
        ]),
      ),
      ...Object.fromEntries(
        [...FORWARD_KEYS, ...(mac ? MAC_FORWARD_KEYS : [])].map((key) => [
          key,
          forward,
        ]),
      ),
    };
  },
});
