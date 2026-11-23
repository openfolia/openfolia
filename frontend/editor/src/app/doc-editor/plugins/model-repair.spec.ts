import { normalizeEditorDoc } from '@openfolia/content-editor-model';

import { doc, insideText, p, sec, testEditor } from '../testing/test-editor';
import { ModelRepair } from './model-repair';

function repairing(...content: Parameters<typeof doc>) {
  let n = 0;
  return testEditor(doc(...content), [
    ModelRepair.configure({ newId: () => `new-${(n += 1)}` }),
  ]);
}

const ids = (editor: ReturnType<typeof testEditor>) => {
  const out: unknown[] = [];
  editor.state.doc.descendants((node) => {
    if ('id' in node.attrs) out.push(node.attrs['id']);
  });
  return out;
};

describe('the repair step as the document changes', () => {
  it('gives a split paragraph’s new half an ID, keeps the old one, and the caret', () => {
    const editor = repairing(p('onetwo', 'a'));
    editor.commands.setTextSelection(insideText(editor, 'onetwo') + 3);
    editor.commands.splitBlock();
    expect(ids(editor)).toEqual(['a', 'new-1']);
    const { $from } = editor.state.selection;
    expect($from.parent.textContent).toBe('two');
    expect($from.parentOffset).toBe(0);
  });

  it('keeps an ID seen twice for the first block only', () => {
    const editor = repairing(p('x', 'a'));
    editor.commands.insertContentAt(editor.state.doc.content.size, {
      type: 'paragraph',
      attrs: { id: 'a' },
      content: [{ type: 'text', text: 'y' }],
    });
    expect(ids(editor)).toEqual(['a', 'new-1']);
  });

  it('repairs in the same undo step as the change', () => {
    const editor = repairing(p('onetwo', 'a'));
    const before = editor.getJSON();
    editor.commands.setTextSelection(insideText(editor, 'onetwo') + 3);
    editor.commands.splitBlock();
    editor.commands.undo();
    expect(editor.getJSON()).toEqual(before);
  });

  it('leaves the editor’s document a fixed point of the repair after any change', () => {
    const editor = repairing(sec('S', p('a')));
    editor.commands.setTextSelection(insideText(editor, 'a') + 1);
    editor.commands.splitBlock();
    editor.commands.insertContent('b');
    const json = editor.getJSON();
    expect(normalizeEditorDoc(json)).toEqual(json);
    // The section and both paragraphs have IDs now.
    expect(ids(editor)).toEqual(['new-1', 'new-2', 'new-3']);
  });
});
