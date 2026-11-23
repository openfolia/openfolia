import type { Editor } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';

import { canMove, textLevelOf } from './editor-commands';
import { EditorHandle } from './editor-handle';
import { doc, inside, p, sec, testEditor } from './testing/test-editor';

function focusable(editor: Editor) {
  let focused = true;
  Object.defineProperty(editor, 'isFocused', { get: () => focused });
  return (value: boolean) => (focused = value);
}

describe('EditorHandle.state', () => {
  it('reports the remembered block while the focus is in the toolbar', () => {
    const editor = testEditor(
      doc(p('first'), sec('second', p('body')), sec('third', p('more'))),
    );
    const setFocused = focusable(editor);
    const handle = new EditorHandle(editor);
    editor.view.dispatch(
      editor.state.tr.setSelection(
        // Into the section's heading.
        TextSelection.create(editor.state.doc, inside(editor, 1) + 1),
      ),
    );
    setFocused(false);
    // Leaving the editor resets its selection to the start.
    editor.view.dispatch(
      editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 1)),
    );
    expect(textLevelOf(editor.state)).toBe(0);
    expect(textLevelOf(handle.state())).toBe(1);
    // The remembered section can go down past the next one; the paragraph at the start can't go up.
    expect(canMove(handle.state(), false)).toBe(true);
    expect(canMove(editor.state, true)).toBe(false);
  });

  it('is the live state while the editor has focus', () => {
    const editor = testEditor(doc(p('first')));
    focusable(editor);
    const handle = new EditorHandle(editor);
    expect(handle.state()).toBe(editor.state);
  });
});
