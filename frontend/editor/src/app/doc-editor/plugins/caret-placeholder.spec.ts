import { Editor } from '@tiptap/core';
import { NodeSelection, TextSelection } from '@tiptap/pm/state';

import { insertModuleRef } from '../blocks/doc-blocks';
import { createEditorExtensions } from '../extensions';
import { doc, list, p, ref } from '../testing/test-editor';

// jsdom lays nothing out and its ranges have no rectangles; ProseMirror asks for them when a
// command scrolls the caret into view.
beforeAll(() => {
  const proto = Range.prototype as Partial<Range>;
  proto.getClientRects ??= () => [] as unknown as DOMRectList;
  proto.getBoundingClientRect ??= () => new DOMRect();
});

function editorOn(content: ReturnType<typeof doc>): Editor {
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: createEditorExtensions({
      slashMenu: null,
      bubble: null,
      placeholder: () => 'Type / for a block',
    }),
    content,
  });
  onTestFinished(() => editor.destroy());
  return editor;
}

/** The blocks showing the hint, by their text position in the editor's DOM. */
const hinted = (editor: Editor) =>
  [...editor.view.dom.querySelectorAll('[data-placeholder]')].map((el) => ({
    tag: el.tagName.toLowerCase(),
    text: el.getAttribute('data-placeholder'),
  }));

describe('the empty block’s hint', () => {
  it('shows on the blank line holding the caret, and only there', () => {
    const editor = editorOn(doc(p('a'), p(), p('b')));
    editor.commands.setTextSelection(4);
    expect(editor.state.selection.$head.parent.content.size).toBe(0);
    expect(hinted(editor)).toEqual([{ tag: 'p', text: 'Type / for a block' }]);
    editor.commands.setTextSelection(2);
    expect(hinted(editor)).toEqual([]);
  });

  it('shows on no caret gap beside a reference inserted on a blank line (#793)', () => {
    // A list has no text of its own to hold the caret: a reference after it gets a gap before it.
    const editor = editorOn(doc(list(false, 'x'), p()));
    const blank = editor.state.doc.content.size - 1;
    editor.commands.setTextSelection(blank);
    expect(hinted(editor)).toHaveLength(1);
    insertModuleRef(editor.state, editor.view.dispatch);
    expect(editor.state.selection).toBeInstanceOf(NodeSelection);
    const types: string[] = [];
    editor.state.doc.forEach((node) =>
      types.push(
        node.type.name === 'paragraph' && node.content.size === 0
          ? 'blank'
          : node.type.name,
      ),
    );
    // The blank line went into the reference; the caret gaps the flow needs around it (no text
    // before or after) hold no hint, as the reference is selected, not a line.
    expect(types).toEqual(['blank', 'list', 'blank', 'moduleRef', 'blank']);
    expect(hinted(editor)).toEqual([]);
  });

  it('is left behind on no line the caret left', () => {
    const editor = editorOn(doc(p(), ref(), p('b')));
    editor.commands.setTextSelection(1);
    expect(hinted(editor)).toHaveLength(1);
    editor.view.dispatch(
      editor.state.tr.setSelection(
        TextSelection.create(
          editor.state.doc,
          editor.state.doc.content.size - 1,
        ),
      ),
    );
    expect(hinted(editor)).toEqual([]);
  });
});
