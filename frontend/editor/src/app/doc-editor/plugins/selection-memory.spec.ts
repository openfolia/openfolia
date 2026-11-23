import type { Editor } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';

import { doc, inside, p, testEditor } from '../testing/test-editor';
import { moveBlockTo } from './block-move';
import { SelectionMemory } from './selection-memory';

function remembering(editor: Editor, focused: () => boolean) {
  const memory = new SelectionMemory();
  Object.defineProperty(editor, 'isFocused', { get: focused });
  editor.on('transaction', ({ transaction }) =>
    memory.note(editor, transaction),
  );
  return memory;
}

const select = (editor: Editor, from: number, to = from) =>
  editor.view.dispatch(
    editor.state.tr.setSelection(
      TextSelection.create(editor.state.doc, from, to),
    ),
  );

describe('SelectionMemory', () => {
  it('remembers the selection made while the editor has focus', () => {
    const editor = testEditor(doc(p('alpha'), p('beta')));
    let focused = true;
    const memory = remembering(editor, () => focused);
    select(editor, inside(editor, 1) + 1, inside(editor, 1) + 3);
    focused = false;
    // Leaving the editor resets the selection to the start.
    select(editor, 1);
    expect(memory.current(editor).from).toBe(inside(editor, 1) + 1);
    memory.restore(editor);
    expect(editor.state.selection.from).toBe(inside(editor, 1) + 1);
    expect(editor.state.selection.to).toBe(inside(editor, 1) + 3);
  });

  it('maps the remembered place through a change made without focus', () => {
    const editor = testEditor(doc(p('alpha'), p('beta')));
    let focused = true;
    const memory = remembering(editor, () => focused);
    select(editor, inside(editor, 1) + 2);
    focused = false;
    editor.view.dispatch(editor.state.tr.insertText('xx', 1));
    expect(memory.current(editor).from).toBe(inside(editor, 1) + 2);
  });

  it('follows a moved block even without focus', () => {
    const editor = testEditor(doc(p('alpha'), p('beta')));
    let focused = true;
    const memory = remembering(editor, () => focused);
    select(editor, 3);
    focused = false;
    moveBlockTo(editor.view, 0, editor.state.doc.content.size);
    expect(memory.current(editor).$from.parent.textContent).toBe('alpha');
  });

  it('restores nothing before anything was remembered', () => {
    const editor = testEditor(doc(p('alpha')));
    const memory = new SelectionMemory();
    const before = editor.state.selection;
    memory.restore(editor);
    expect(editor.state.selection.eq(before)).toBe(true);
  });
});
