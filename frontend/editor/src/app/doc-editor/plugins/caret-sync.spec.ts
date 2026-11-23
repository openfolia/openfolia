import { TextSelection } from '@tiptap/pm/state';
import type { Editor } from '@tiptap/core';

import { doc, p, testEditor } from '../testing/test-editor';
import { BlockDrag } from './block-drag';
import { CaretSync, readDomSelection } from './caret-sync';

/** An editor in the page, focused, with its caret at the start of the first block. */
function focusedEditor(): Editor {
  // With the block grip, whose hover redraw would put the state's caret into the page.
  const editor = testEditor(doc(p('first'), p('second'), p('third')), [
    CaretSync,
    BlockDrag,
  ]);
  const host = editor.view.dom.parentElement!;
  document.body.append(host);
  onTestFinished(() => host.remove());
  editor.view.focus();
  editor.view.dispatch(
    editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 1)),
  );
  return editor;
}

/** Places the browser's caret in the text of `text`, as a click does, before any event. */
function browserCaretIn(editor: Editor, text: string, offset: number): void {
  const node = [...editor.view.dom.querySelectorAll('p')].find(
    (el) => el.textContent === text,
  )!.firstChild!;
  document.getSelection()!.collapse(node, offset);
}

/** The text block the state's caret is in, and its offset there. */
const caret = (editor: Editor) => {
  const { $head } = editor.state.selection;
  return [$head.parent.textContent, $head.parentOffset];
};

describe('the caret of a click', () => {
  it('is the selection once the press is let go, not when the selection event comes', () => {
    const editor = focusedEditor();
    browserCaretIn(editor, 'third', 2);
    expect(caret(editor)).toEqual(['first', 0]);
    editor.view.dom.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    expect(caret(editor)).toEqual(['third', 2]);
  });

  it('is read before a key acts on it', () => {
    const editor = focusedEditor();
    browserCaretIn(editor, 'second', 3);
    editor.view.dom.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Shift', bubbles: true }),
    );
    expect(caret(editor)).toEqual(['second', 3]);
  });

  it('survives a transaction dispatched before it is read', () => {
    const editor = focusedEditor();
    browserCaretIn(editor, 'third', 1);
    readDomSelection(editor.view);
    // A redraw with no selection of its own (a hover moving the grip) keeps the clicked caret.
    editor.view.dispatch(editor.state.tr.setMeta('hover', true));
    expect(caret(editor)).toEqual(['third', 1]);
    expect(document.getSelection()!.anchorNode?.textContent).toBe('third');
  });

  it('stays where it was clicked when the pointer moves on over another block', () => {
    const editor = focusedEditor();
    browserCaretIn(editor, 'third', 2);
    // Over the second block (jsdom has no layout to find it from the pointer).
    const second = editor.state.doc.child(0).nodeSize;
    vi.spyOn(editor.view, 'posAtCoords').mockReturnValue({
      pos: second + 1,
      inside: -1,
    });
    editor.view.dom.dispatchEvent(
      new MouseEvent('mousemove', { bubbles: true }),
    );
    expect(caret(editor)).toEqual(['third', 2]);
    expect(document.getSelection()!.anchorNode?.textContent).toBe('third');
  });

  it('changes nothing when the browser has the caret the state has', () => {
    const editor = focusedEditor();
    readDomSelection(editor.view);
    const before = editor.state;
    expect(readDomSelection(editor.view)).toBe(false);
    expect(editor.state).toBe(before);
  });
});
