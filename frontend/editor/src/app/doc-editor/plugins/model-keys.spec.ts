import type { Editor } from '@tiptap/core';
import { NodeSelection } from '@tiptap/pm/state';

import {
  blocks,
  doc,
  insideText,
  list,
  p,
  ref,
  sec,
  testEditor,
} from '../testing/test-editor';
import { ModelKeys } from './model-keys';

const press = (editor: Editor, key: string, init: KeyboardEventInit = {}) =>
  editor.view.dom.dispatchEvent(
    new KeyboardEvent('keydown', {
      key,
      bubbles: true,
      cancelable: true,
      ...init,
    }),
  );

const items = (editor: Editor) => {
  const out: string[] = [];
  editor.state.doc.descendants((node) => {
    if (node.type.name === 'itemText') out.push(node.textContent);
  });
  return out;
};

describe('the keys of the content model', () => {
  it('splits a list item with Enter, and leaves the list from an empty last item', () => {
    const editor = testEditor(doc(list(false, 'first')), [ModelKeys]);
    editor.commands.setTextSelection(insideText(editor, 'first') + 5);
    press(editor, 'Enter');
    editor.commands.insertContent('second');
    expect(items(editor)).toEqual(['first', 'second']);
    press(editor, 'Enter');
    press(editor, 'Enter');
    editor.commands.insertContent('after');
    expect(blocks(editor)).toEqual(['list:firstsecond', 'p:after']);
  });

  it('turns a list of one empty item back into a paragraph', () => {
    const editor = testEditor(doc(list(true, '')), [ModelKeys]);
    editor.commands.setTextSelection(3);
    press(editor, 'Enter');
    expect(blocks(editor)).toEqual(['p:']);
  });

  it('nests an item with Tab and lifts it back with Shift+Tab, never out of the list', () => {
    const editor = testEditor(doc(list(false, 'a', 'b')), [ModelKeys]);
    editor.commands.setTextSelection(insideText(editor, 'b'));
    press(editor, 'Tab');
    expect(editor.state.doc.child(0).childCount).toBe(1);
    press(editor, 'Tab', { shiftKey: true });
    expect(editor.state.doc.child(0).childCount).toBe(2);
    press(editor, 'Tab', { shiftKey: true });
    expect(blocks(editor)).toEqual(['list:ab']);
  });

  it('turns a heading back into text with Backspace at its start', () => {
    const editor = testEditor(doc(p('a'), sec('Head', p('b'))), [ModelKeys]);
    editor.commands.setTextSelection(insideText(editor, 'Head'));
    press(editor, 'Backspace');
    expect(blocks(editor)).toEqual(['p:a', 'p:Head', 'p:b']);
  });

  it('toggles the marks with their shortcuts', () => {
    const editor = testEditor(doc(p('word')), [ModelKeys]);
    editor.commands.setTextSelection({ from: 1, to: 5 });
    editor.commands.keyboardShortcut('Mod-b');
    expect(editor.isActive('strong')).toBe(true);
    editor.commands.keyboardShortcut('Mod-i');
    expect(editor.isActive('emphasis')).toBe(true);
    editor.commands.keyboardShortcut('Mod-e');
    expect(editor.isActive('code')).toBe(true);
    editor.commands.keyboardShortcut('Mod-b');
    expect(editor.isActive('strong')).toBe(false);
  });

  it('selects a read-only block next to the caret before deleting it, with Backspace and Delete', () => {
    const editor = testEditor(doc(p('a'), ref(), p('b')), [ModelKeys]);
    editor.commands.setTextSelection(insideText(editor, 'b'));
    press(editor, 'Backspace');
    expect(editor.state.selection).toBeInstanceOf(NodeSelection);
    expect(blocks(editor)).toEqual(['p:a', 'ref', 'p:b']);
    editor.commands.setTextSelection(insideText(editor, 'a') + 1);
    press(editor, 'Delete');
    expect(editor.state.selection).toBeInstanceOf(NodeSelection);
    expect(blocks(editor)).toEqual(['p:a', 'ref', 'p:b']);
    // The next press deletes it.
    press(editor, 'Delete');
    expect(blocks(editor)).toEqual(['p:a', 'p:b']);
  });

  it('never pulls a section into the one before it with Delete: the caret goes into its heading', () => {
    const editor = testEditor(
      doc(sec('A', p('a'), sec('A1', p('a1'))), sec('B', p('b'))),
      [ModelKeys],
    );
    const before = editor.getJSON();
    editor.commands.setTextSelection(insideText(editor, 'a1') + 2);
    press(editor, 'Delete');
    expect(editor.getJSON()).toEqual(before);
    const { $from } = editor.state.selection;
    expect($from.parent.textContent).toBe('B');
    expect($from.parentOffset).toBe(0);
  });

  it('leaves the ID with the text on Enter at the start of a paragraph or list item', () => {
    const editor = testEditor(
      doc(p('text', 'p1'), {
        type: 'list',
        attrs: { ordered: false },
        content: [
          {
            type: 'listItem',
            attrs: { id: 'i1' },
            content: [
              { type: 'itemText', content: [{ type: 'text', text: 'item' }] },
            ],
          },
        ],
      }),
      [ModelKeys],
    );
    editor.commands.setTextSelection(insideText(editor, 'text'));
    press(editor, 'Enter');
    expect(blocks(editor)[0]).toBe('p:');
    expect(editor.state.doc.child(1).attrs['id']).toBe('p1');
    // The caret goes into the new line: a blank line without it would not stay.
    expect(editor.state.selection.$from.pos).toBe(1);
    editor.commands.setTextSelection(insideText(editor, 'item'));
    press(editor, 'Enter');
    const items = editor.state.doc.child(2);
    expect(items.childCount).toBe(2);
    expect(items.child(0).attrs['id']).toBeNull();
    expect(items.child(1).attrs['id']).toBe('i1');
    expect(items.child(1).textContent).toBe('item');
  });

  it('opens a line before a section on Enter at the start of its heading, where the flow allows one', () => {
    const editor = testEditor(doc(p('a'), sec('S', p('b')), sec('T')), [
      ModelKeys,
    ]);
    editor.commands.setTextSelection(insideText(editor, 'S'));
    press(editor, 'Enter');
    expect(blocks(editor)).toEqual(['p:a', 'p:', 's:S[p:b]', 's:T[]']);
    // Between two sections no block can stand: the heading stays as it is.
    editor.commands.setTextSelection(insideText(editor, 'T'));
    const before = editor.getJSON();
    press(editor, 'Enter');
    expect(editor.getJSON()).toEqual(before);
  });

  it('nests an item of a numbered list in a numbered list', () => {
    const editor = testEditor(doc(list(true, 'a', 'b')), [ModelKeys]);
    editor.commands.setTextSelection(insideText(editor, 'b'));
    press(editor, 'Tab');
    const nested = editor.state.doc.child(0).child(0).child(1);
    expect(nested.type.name).toBe('list');
    expect(nested.attrs['ordered']).toBe(true);
  });

  it('guards the modified delete keys the same way', () => {
    const editor = testEditor(
      doc(p('a'), ref(), sec('A', p('x')), sec('B', p('b'))),
      [ModelKeys],
    );
    editor.commands.setTextSelection(insideText(editor, 'x'));
    // Backspace at the start of a section's first block: into the heading, no merge.
    press(editor, 'Backspace', { shiftKey: true });
    expect(editor.state.selection.$from.parent.type.name).toBe('title');
    const before = editor.getJSON();
    editor.commands.setTextSelection(insideText(editor, 'x') + 1);
    press(editor, 'Delete', { ctrlKey: true });
    expect(editor.getJSON()).toEqual(before);
    expect(editor.state.selection.$from.parent.textContent).toBe('B');
    editor.commands.setTextSelection(insideText(editor, 'A'));
    press(editor, 'Backspace', { ctrlKey: true });
    // A heading at its start becomes text (the plain key's behaviour), the ref stays.
    expect(blocks(editor)).toContain('ref');
  });

  it('never merges a heading with the text after it on Delete', () => {
    const editor = testEditor(doc(sec('A', p('x'))), [ModelKeys]);
    editor.commands.setTextSelection(insideText(editor, 'A') + 1);
    press(editor, 'Delete');
    expect(blocks(editor)).toEqual(['s:A[p:x]']);
    expect(editor.state.selection.$from.parent.textContent).toBe('x');
  });

  it('nests into a list the item before already has, without changing its kind', () => {
    const editor = testEditor(
      doc({
        type: 'list',
        attrs: { ordered: true },
        content: [
          {
            type: 'listItem',
            content: [
              { type: 'itemText', content: [{ type: 'text', text: 'a' }] },
              list(false, 'x'),
            ],
          },
          {
            type: 'listItem',
            content: [
              { type: 'itemText', content: [{ type: 'text', text: 'b' }] },
            ],
          },
        ],
      }),
      [ModelKeys],
    );
    // Tab on the first item of the nested list can't sink: nothing changes.
    editor.commands.setTextSelection(insideText(editor, 'x'));
    const before = editor.getJSON();
    press(editor, 'Tab');
    expect(editor.getJSON()).toEqual(before);
    editor.commands.setTextSelection(insideText(editor, 'b'));
    press(editor, 'Tab');
    const nested = editor.state.doc.child(0).child(0).child(1);
    expect(nested.attrs['ordered']).toBe(false);
    expect(nested.childCount).toBe(2);
  });

  it('never pulls a list after a heading into it on Delete', () => {
    const editor = testEditor(doc(sec('A', list(false, 'x'))), [ModelKeys]);
    const before = editor.getJSON();
    editor.commands.setTextSelection(insideText(editor, 'A') + 1);
    press(editor, 'Delete');
    expect(editor.getJSON()).toEqual(before);
    expect(editor.state.selection.$from.parent.textContent).toBe('x');
  });
});
