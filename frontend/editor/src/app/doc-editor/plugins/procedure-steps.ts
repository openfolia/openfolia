import { Extension } from '@tiptap/core';
import { Fragment } from '@tiptap/pm/model';
import { TextSelection, type Command } from '@tiptap/pm/state';

// A procedure's steps are the content model's items (`listItem`): their own text, then blocks.
// They are edited as a list's items are (`model-keys.ts`: Enter adds a step, Tab makes it a
// sub-step, a procedure of its own inside the step before, Shift+Tab lifts it back) and moved as a
// flow's blocks are (`flow.ts`: by their grip and Alt+Up/Down, among the steps of their procedure).
// The model has no field for a step's result: it is the first paragraph of the step's blocks,
// which "/" Result adds. Code blocks (`literal`) take Tab as text.

/** The spaces Tab puts in a code block. */
export const CODE_INDENT = '  ';

/**
 * Adds a result to the step the caret is in (a paragraph right after the step's text, with the
 * caret in it). Refused outside a procedure's step, or when the step has one already.
 */
export const insertStepResult: Command = (state, dispatch) => {
  const { $from } = state.selection;
  if ($from.parent.type.name !== 'itemText' || $from.depth < 3) return false;
  const step = $from.node(-1);
  if ($from.node(-2).type.name !== 'procedure') return false;
  if (step.maybeChild(1)?.type.name === 'paragraph') return false;
  const paragraph = state.schema.nodes['paragraph'];
  if (!paragraph) return false;
  if (dispatch) {
    const at = $from.after();
    const tr = state.tr.insert(at, paragraph.create());
    tr.setSelection(TextSelection.create(tr.doc, at + 1));
    dispatch(tr.scrollIntoView());
  }
  return true;
};

/**
 * Tab in a procedure's step: the step becomes a sub-step, the last step of a procedure at the end
 * of the step before (that one's, when it ends in one; else a new one). Its own blocks go with it.
 * Written here rather than with ProseMirror's `sinkListItem`, which finds no list in a procedure
 * with a title. Refused in the first step (nothing before it to go into).
 */
export const sinkStep: Command = (state, dispatch) => {
  const { $from } = state.selection;
  if ($from.parent.type.name !== 'itemText' || $from.depth < 3) return false;
  if ($from.node(-2).type.name !== 'procedure') return false;
  const item = $from.node(-1);
  const itemPos = $from.before(-1);
  const before = $from.node(-2).maybeChild($from.index(-2) - 1);
  if (before?.type !== item.type) return false;
  const procedure = $from.node(-2).type;
  if (dispatch) {
    const offset = $from.pos - itemPos;
    const tr = state.tr.delete(itemPos, itemPos + item.nodeSize);
    let at: number;
    if (before.lastChild?.type === procedure) {
      // The end of the procedure the step before ends in (both before the step: not moved).
      at = itemPos - 2;
      tr.insert(at, item);
    } else {
      at = itemPos - 1;
      tr.insert(at, procedure.create(null, item));
      at += 1;
    }
    tr.setSelection(TextSelection.create(tr.doc, at + offset));
    dispatch(tr.scrollIntoView());
  }
  return true;
};

/**
 * Shift+Tab in a sub-step (a step of a procedure inside a step or a list item): the step comes
 * out, right after the step it was in; the steps after it come with it, as its sub-steps.
 * Refused where its procedure would be left with a title and no step.
 */
export const liftStep: Command = (state, dispatch) => {
  const { $from } = state.selection;
  if ($from.parent.type.name !== 'itemText' || $from.depth < 5) return false;
  const inner = $from.node(-2);
  if (inner.type.name !== 'procedure') return false;
  const outer = $from.node(-3);
  if (outer.type.name !== 'listItem') return false;
  const index = $from.index(-2);
  const firstStep = inner.firstChild?.type === outer.type ? 0 : 1;
  const item = $from.node(-1);
  const itemPos = $from.before(-1);
  const after: (typeof item)[] = [];
  for (let i = index + 1; i < inner.childCount; i += 1)
    after.push(inner.child(i));
  // What stays of the procedure: its title and the steps before; nothing, when no step stays.
  const keeps = index > firstStep;
  if (!keeps && firstStep === 1) return false;
  if (dispatch) {
    const offset = $from.pos - itemPos;
    const lifted = item.type.create(
      item.attrs,
      after.length
        ? item.content.addToEnd(inner.type.create(null, Fragment.from(after)))
        : item.content,
    );
    const innerPos = $from.before(-2);
    const outerEnd = $from.after(-3);
    const tr = state.tr;
    // The new step after the step it was in, then what stays of the procedure.
    tr.insert(outerEnd, lifted);
    if (keeps) tr.delete(itemPos, $from.end(-2));
    else tr.delete(innerPos, innerPos + inner.nodeSize);
    const at = tr.mapping.slice(1).map(outerEnd);
    tr.setSelection(TextSelection.create(tr.doc, at + offset));
    dispatch(tr.scrollIntoView());
  }
  return true;
};

/** Tab in a code block: spaces at the caret, in place of a selection within the block. */
export const indentCode: Command = (state, dispatch) => {
  const { $from, $to } = state.selection;
  if (!$from.parent.type.spec.code || !$from.sameParent($to)) return false;
  dispatch?.(state.tr.insertText(CODE_INDENT).scrollIntoView());
  return true;
};

/** Shift+Tab in a code block: up to one indent's spaces less at the start of the caret's line. */
export const outdentCode: Command = (state, dispatch) => {
  const { $from } = state.selection;
  if (!$from.parent.type.spec.code) return false;
  const text = $from.parent.textBetween(0, $from.parentOffset);
  const lineStart = text.lastIndexOf('\n') + 1;
  const line = $from.parent.textBetween(lineStart, $from.parent.content.size);
  const spaces = /^ */.exec(line)?.[0].length ?? 0;
  const remove = Math.min(spaces, CODE_INDENT.length);
  if (remove > 0 && dispatch) {
    const start = $from.start() + lineStart;
    dispatch(state.tr.delete(start, start + remove).scrollIntoView());
  }
  // Handled either way: in a code block Shift+Tab never leaves for the list keys.
  return true;
};

/** Tab and Shift+Tab in a code block; before the tables' and the lists' keys. */
export const CodeKeys = Extension.create({
  name: 'codeKeys',
  priority: 1200,
  addKeyboardShortcuts() {
    return {
      Tab: ({ editor }) => indentCode(editor.state, editor.view.dispatch),
      'Shift-Tab': ({ editor }) =>
        outdentCode(editor.state, editor.view.dispatch),
    };
  },
});
