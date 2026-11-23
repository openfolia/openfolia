import type { Editor, JSONContent } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';

import {
  blocks,
  doc,
  insideText,
  p,
  ref,
  testEditor,
} from '../testing/test-editor';
import { BlankLines, strayBlanks } from './blank-lines';
import { CaretGaps } from './caret-gaps';
import { ModelKeys } from './model-keys';

// jsdom lays nothing out: ProseMirror asks for rectangles when it scrolls the caret into view.
beforeAll(() => {
  const proto = Range.prototype as Partial<Range>;
  proto.getClientRects ??= () => [] as unknown as DOMRectList;
  proto.getBoundingClientRect ??= () => new DOMRect();
});

const variant = (...content: JSONContent[]): JSONContent => ({
  type: 'variant',
  content,
});

function editorOn(content: JSONContent, animate = false) {
  return testEditor(content, [
    CaretGaps,
    BlankLines.configure({ animate: () => animate }),
    ModelKeys,
  ]);
}

const caretAt = (editor: Editor, pos: number) =>
  editor.view.dispatch(
    editor.state.tr.setSelection(TextSelection.create(editor.state.doc, pos)),
  );

function press(editor: Editor, key: string) {
  editor.view.dom.dispatchEvent(
    new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
  );
}

describe('blank lines', () => {
  it('keeps only the blank line holding the caret', () => {
    // a = 0..3, three blanks at 3, 5 and 7, b at 9.
    const editor = editorOn(doc(p('a'), p(), p(), p(), p('b')));
    caretAt(editor, 6);
    expect(blocks(editor)).toEqual(['p:a', 'p:', 'p:b']);
    expect(editor.state.selection.$from.parent.childCount).toBe(0);
    // The caret leaves it: it goes too.
    caretAt(editor, insideText(editor, 'a'));
    expect(blocks(editor)).toEqual(['p:a', 'p:b']);
  });

  it('keeps one blank line where a caret could not land otherwise', () => {
    const editor = editorOn(doc(p('a'), ref(), p(), p(), ref(), p('b')));
    caretAt(editor, insideText(editor, 'a'));
    expect(blocks(editor)).toEqual(['p:a', 'ref', 'p:', 'ref', 'p:b']);
    expect(strayBlanks(editor.state)).toEqual([]);
  });

  it('keeps the only block of a container, and its place to type', () => {
    const editor = editorOn(doc(p('a'), variant(p(), p()), p('b')));
    caretAt(editor, insideText(editor, 'a'));
    expect(editor.state.doc.child(1).childCount).toBe(1);
  });

  it('moves on with Enter on a blank line, and stacks none at the end', () => {
    const editor = editorOn(doc(p('a'), p('b')));
    caretAt(editor, insideText(editor, 'a') + 1);
    press(editor, 'Enter');
    expect(blocks(editor)).toEqual(['p:a', 'p:', 'p:b']);
    // Enter again: on to "b", and the blank line it left goes.
    press(editor, 'Enter');
    expect(blocks(editor)).toEqual(['p:a', 'p:b']);
    expect(editor.state.selection.$from.parent.textContent).toBe('b');
    // At the end: one blank line, never a second.
    caretAt(editor, insideText(editor, 'b') + 1);
    press(editor, 'Enter');
    press(editor, 'Enter');
    press(editor, 'Enter');
    expect(blocks(editor)).toEqual(['p:a', 'p:b', 'p:']);
  });

  it('opens a line before a paragraph with the caret in it, so it stays', () => {
    const editor = editorOn(doc(p('a'), p('b')));
    caretAt(editor, insideText(editor, 'b'));
    press(editor, 'Enter');
    expect(blocks(editor)).toEqual(['p:a', 'p:', 'p:b']);
    expect(editor.state.selection.$from.parent.childCount).toBe(0);
  });

  it('undoes exactly what was typed, never the tidying', () => {
    const editor = editorOn(doc(p('a'), p('b')));
    caretAt(editor, insideText(editor, 'a') + 1);
    press(editor, 'Enter');
    editor.commands.insertContent('x');
    expect(blocks(editor)).toEqual(['p:a', 'p:x', 'p:b']);
    caretAt(editor, insideText(editor, 'b'));
    editor.commands.undo();
    expect(blocks(editor)).toEqual(['p:a', 'p:b']);
  });

  it('brings back text deleted from a line the caret then left, in one undo', () => {
    const editor = editorOn(doc(p('aaa'), p('hello'), p('bbb')));
    const start = insideText(editor, 'hello');
    editor.view.dispatch(editor.state.tr.delete(start, start + 5));
    caretAt(editor, insideText(editor, 'aaa'));
    expect(blocks(editor)).toEqual(['p:aaa', 'p:bbb']);
    editor.commands.undo();
    expect(blocks(editor)).toEqual(['p:aaa', 'p:hello', 'p:bbb']);
  });

  it('keeps a blank line an undo brought back while there is something to redo', () => {
    const editor = editorOn(doc(p('a'), p(), p('b')));
    caretAt(editor, insideText(editor, 'a') + 3); // in the blank line
    editor.commands.insertContent('x');
    editor.commands.undo();
    expect(blocks(editor)).toEqual(['p:a', 'p:', 'p:b']);
    caretAt(editor, insideText(editor, 'b'));
    // It waits: tidied now, the redo would lose the x.
    expect(blocks(editor)).toEqual(['p:a', 'p:', 'p:b']);
    expect(editor.commands.redo()).toBe(true);
    expect(blocks(editor)).toEqual(['p:a', 'p:x', 'p:b']);
  });

  it('leaves a read-only document as it is', () => {
    const editor = editorOn(doc(p('a'), p(), p(), p('b')));
    editor.setEditable(false);
    caretAt(editor, insideText(editor, 'a'));
    expect(blocks(editor)).toEqual(['p:a', 'p:', 'p:', 'p:b']);
  });

  it('lets a blank line collapse before it goes, unless the caret comes back', () => {
    vi.useFakeTimers();
    try {
      const editor = editorOn(doc(p('a'), p(), p('b')), true);
      caretAt(editor, 4);
      caretAt(editor, insideText(editor, 'a'));
      const blank = () =>
        editor.view.dom.querySelector('.doc-editor-blank-leaving');
      expect(blank()).not.toBeNull();
      expect(blocks(editor)).toEqual(['p:a', 'p:', 'p:b']);
      // Back in it before it went: it stays.
      caretAt(editor, 4);
      vi.advanceTimersByTime(300);
      expect(blank()).toBeNull();
      expect(blocks(editor)).toEqual(['p:a', 'p:', 'p:b']);
      // Away again, for good.
      caretAt(editor, insideText(editor, 'b'));
      vi.advanceTimersByTime(300);
      expect(blocks(editor)).toEqual(['p:a', 'p:b']);
      // The collapse joined no undo step of its own: one undo, and the line is back.
      editor.commands.undo();
      expect(blocks(editor)).toEqual(['p:a', 'p:', 'p:b']);
    } finally {
      vi.useRealTimers();
    }
  });
});
