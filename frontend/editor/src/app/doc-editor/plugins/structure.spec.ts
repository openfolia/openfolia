import type { Editor } from '@tiptap/core';
import type { Command } from '@tiptap/pm/state';

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
import {
  paragraphToSection,
  sectionToParagraph,
  toggleList,
} from './structure';

const run = (editor: Editor, command: Command) =>
  command(editor.state, editor.view.dispatch);

const caret = (editor: Editor, text: string, offset = 0) =>
  editor.commands.setTextSelection(insideText(editor, text) + offset);

describe('a paragraph becomes a section heading', () => {
  it('holds the blocks after it, keeps the subsections that follow as its siblings, and its ID', () => {
    const editor = testEditor(
      doc(
        sec('Top', p('a'), p('head', 'h1'), ref(), p('b'), sec('Sub', p('s'))),
      ),
    );
    caret(editor, 'head', 2);
    expect(run(editor, paragraphToSection)).toBe(true);
    expect(blocks(editor)).toEqual([
      's:Top[p:a, s:head[ref, p:b], s:Sub[p:s]]',
    ]);
    const { $from } = editor.state.selection;
    expect($from.parent.type.name).toBe('title');
    expect($from.parentOffset).toBe(2);
    expect($from.node(-1).attrs['id']).toBe('h1');
  });

  it('turns line breaks into spaces, as a heading has one line', () => {
    const editor = testEditor(
      doc({
        type: 'paragraph',
        content: [
          { type: 'text', text: 'one' },
          { type: 'hardBreak' },
          { type: 'text', text: 'two' },
        ],
      }),
    );
    caret(editor, 'onetwo');
    run(editor, paragraphToSection);
    expect(blocks(editor)).toEqual(['s:one two[]']);
  });

  it('is refused outside a flow (in a list item)', () => {
    const editor = testEditor(
      doc({
        type: 'list',
        content: [
          { type: 'listItem', content: [{ type: 'itemText' }, p('inner')] },
        ],
      }),
    );
    caret(editor, 'inner');
    expect(run(editor, paragraphToSection)).toBe(false);
  });

  it('comes back exactly with one undo', () => {
    const start = doc(p('a', 'a'), p('b', 'b'), sec('S', p('c', 'c')));
    const editor = testEditor(start);
    const before = editor.getJSON();
    caret(editor, 'a');
    run(editor, paragraphToSection);
    editor.commands.undo();
    expect(editor.getJSON()).toEqual(before);
  });
});

describe('a section heading becomes a paragraph', () => {
  it('as the first section, its text and blocks join the blocks before it, its subsections go up a level', () => {
    const editor = testEditor(
      doc(p('a'), sec('S', p('b'), sec('T', p('t'))), sec('U')),
    );
    caret(editor, 'S');
    expect(run(editor, sectionToParagraph)).toBe(true);
    expect(blocks(editor)).toEqual(['p:a', 'p:S', 'p:b', 's:T[p:t]', 's:U[]']);
    expect(editor.state.selection.$from.parent.textContent).toBe('S');
  });

  it('after another section, its text and blocks go to the end of the deepest one before it', () => {
    const editor = testEditor(
      doc(sec('A', p('a'), sec('A1', p('a1'))), sec('B', p('b'), sec('B1'))),
    );
    caret(editor, 'B', 1);
    run(editor, sectionToParagraph);
    expect(blocks(editor)).toEqual(['s:A[p:a, s:A1[p:a1, p:B, p:b], s:B1[]]']);
    expect(editor.state.selection.$from.parentOffset).toBe(1);
  });

  it('turned back into a heading, gives the same document, IDs included', () => {
    const editor = testEditor(doc(p('a', 'a'), sec('S', p('b', 'b'))));
    editor.commands.command(({ tr }) => {
      tr.setNodeMarkup(3, null, { id: 's' });
      return true;
    });
    const before = editor.getJSON();
    caret(editor, 'S');
    run(editor, sectionToParagraph);
    caret(editor, 'S');
    run(editor, paragraphToSection);
    expect(editor.getJSON()).toEqual(before);
  });
});

describe('lists', () => {
  it('turns the selected run of paragraphs into one list, items keeping the paragraphs’ IDs', () => {
    const editor = testEditor(doc(p('one', 'p1'), p('two', 'p2'), ref()));
    editor.commands.setTextSelection({
      from: insideText(editor, 'one'),
      to: insideText(editor, 'two') + 1,
    });
    expect(run(editor, toggleList(true))).toBe(true);
    expect(blocks(editor)).toEqual(['list:onetwo', 'ref']);
    const listNode = editor.state.doc.child(0);
    expect(listNode.attrs['ordered']).toBe(true);
    expect(listNode.child(1).attrs['id']).toBe('p2');
  });

  it('switches the kind, then unwraps into paragraphs with the item’s blocks after its text', () => {
    const editor = testEditor(
      doc({
        type: 'list',
        attrs: { ordered: false },
        content: [
          {
            type: 'listItem',
            attrs: { id: 'i1' },
            content: [
              { type: 'itemText', content: [{ type: 'text', text: 'x' }] },
              list(false, 'nested'),
            ],
          },
        ],
      }),
    );
    caret(editor, 'x', 1);
    run(editor, toggleList(true));
    expect(editor.state.doc.child(0).attrs['ordered']).toBe(true);
    run(editor, toggleList(true));
    expect(blocks(editor)).toEqual(['p:x', 'list:nested']);
    expect(editor.state.doc.child(0).attrs['id']).toBe('i1');
    expect(editor.state.selection.$from.parentOffset).toBe(1);
  });
});
