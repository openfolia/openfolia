import type { Editor } from '@tiptap/core';
import { closeHistory } from '@tiptap/pm/history';
import { type EditorState, TextSelection } from '@tiptap/pm/state';

import { docBlocksOf } from '../blocks/doc-blocks-context';
import type { TermChoice } from './writing-aids';

// The term picker's side in the editor (#247): "/" Term and the Insert menu's Term open the
// page's picker (`DocBlockSettings.pickTerm`) and put the chosen term's preferred variant in at
// the caret (in place of the selection), linked to the term (the `term` mark, #245), in one undo
// step. Framework-free.

/** Whether the page offers the term picker and the document may be changed. */
export function canPickTerm(editor: Editor): boolean {
  const context = docBlocksOf(editor);
  return !!context?.settings().pickTerm && context.editable();
}

/** Whether a linked term may go at the selection: text that takes the term mark, not code. */
export function canInsertTerm(state: EditorState): boolean {
  const type = state.schema.marks['term'];
  const { $from, $to } = state.selection;
  const parent = $from.parent;
  return (
    !!type &&
    parent.inlineContent &&
    $from.sameParent($to) &&
    !parent.type.spec.code &&
    parent.type.allowsMarkType(type)
  );
}

/**
 * Puts `choice` in at the selection, linked to its term, the caret after it, in one undo step;
 * false when it cannot go there. The text takes the marks around it, except a link, code or
 * another term's link.
 */
export function insertTerm(editor: Editor, choice: TermChoice): boolean {
  const { state } = editor;
  const type = state.schema.marks['term'];
  if (!type || !choice.text || !canInsertTerm(state)) return false;
  const { from, to, $from } = state.selection;
  const kept = (state.storedMarks ?? $from.marks()).filter(
    (m) => !['link', 'code', 'term'].includes(m.type.name),
  );
  const node = state.schema.text(choice.text, [
    ...kept,
    type.create({ termId: choice.termId }),
  ]);
  const tr = state.tr.replaceWith(from, to, node);
  tr.setSelection(TextSelection.create(tr.doc, from + node.nodeSize));
  tr.removeStoredMark(type);
  editor.view.dispatch(closeHistory(tr).scrollIntoView());
  return true;
}

/**
 * Opens the term picker and inserts the choice where the selection was. Resolves to whether a
 * term went in: not when the picker is cancelled or missing, or the editor went or became
 * read-only meanwhile.
 */
export async function pickAndInsertTerm(editor: Editor): Promise<boolean> {
  const pick = docBlocksOf(editor)?.settings().pickTerm;
  if (!pick || !canPickTerm(editor) || !canInsertTerm(editor.state))
    return false;
  const bookmark = editor.state.selection.getBookmark();
  const choice = await pick();
  if (!choice || editor.isDestroyed || !canPickTerm(editor)) return false;
  editor.commands.focus();
  const selection = bookmark.resolve(editor.state.doc);
  editor.view.dispatch(editor.state.tr.setSelection(selection));
  return insertTerm(editor, choice);
}
