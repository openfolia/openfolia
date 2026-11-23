import type { Editor, JSONContent } from '@tiptap/core';
import type { Command } from '@tiptap/pm/state';
import {
  fromEditor,
  normalizeEditorDoc,
  toEditor,
} from '@openfolia/content-editor-model';
import {
  parseModule,
  printModule,
  type Module,
} from '@openfolia/content-model';

import {
  blocks,
  doc,
  insideText,
  list,
  p,
  sec,
  testEditor,
} from '../testing/test-editor';
import {
  demoteHeading,
  demoteRefusalAt,
  headingCap,
  headingRefusal,
  HeadingLevels,
  promoteHeading,
  promoteRefusalAt,
  setHeadingCap,
  setHeadingLevel,
  textLevelAt,
} from './heading-levels';
import { CaretGaps } from './caret-gaps';
import { ModelKeys } from './model-keys';
import { ModelRepair } from './model-repair';
import { TableKeys } from './table-editing';

const run = (editor: Editor, command: Command) =>
  command(editor.state, editor.view.dispatch);

const caret = (editor: Editor, text: string, offset = 0) =>
  editor.commands.setTextSelection(insideText(editor, text) + offset);

const editorOn = (content: JSONContent, cap?: number) =>
  testEditor(content, [
    HeadingLevels.configure(cap === undefined ? {} : { cap }),
    TableKeys,
    ModelKeys,
  ]);

/** Presses a key in the editor, as the keymap sees it; whether a handler took it. */
function press(editor: Editor, key: string, shift = false): boolean {
  const event = new KeyboardEvent('keydown', { key, shiftKey: shift });
  let handled = false;
  editor.view.someProp('handleKeyDown', (handler) => {
    if (handler(editor.view, event)) handled = true;
    return handled;
  });
  return handled;
}

const variant = (...content: JSONContent[]): JSONContent => ({
  type: 'variant',
  content,
});

describe('the heading level at the caret', () => {
  it('is the depth of the section: 1 at the top, one more in each section', () => {
    const editor = editorOn(doc(p('text'), sec('A', sec('B', sec('C')))));
    caret(editor, 'text');
    expect(textLevelAt(editor.state)).toBe(0);
    for (const [title, level] of [
      ['A', 1],
      ['B', 2],
      ['C', 3],
    ] as const) {
      caret(editor, title);
      expect(textLevelAt(editor.state)).toBe(level);
    }
  });

  it('is none in a list item or a variant block', () => {
    const editor = editorOn(doc(list(false, 'item'), variant(p('inside'))));
    caret(editor, 'item');
    expect(textLevelAt(editor.state)).toBeNull();
    caret(editor, 'inside');
    expect(textLevelAt(editor.state)).toBeNull();
  });
});

describe('demoting a heading (Tab)', () => {
  it('moves it into the section before it, as its last subsection, with its blocks and subsections', () => {
    const editor = editorOn(
      doc(
        sec('A', p('a'), sec('A1')),
        sec('B', p('b'), sec('B1', p('b1'))),
        sec('C'),
      ),
    );
    caret(editor, 'B', 1);
    expect(run(editor, demoteHeading)).toBe(true);
    expect(blocks(editor)).toEqual([
      's:A[p:a, s:A1[], s:B[p:b, s:B1[p:b1]]]',
      's:C[]',
    ]);
    // The caret stays where it was in the heading.
    expect(textLevelAt(editor.state)).toBe(2);
    expect(editor.state.selection.$from.parent.textContent).toBe('B');
    expect(editor.state.selection.$from.parentOffset).toBe(1);
  });

  it('is refused for the first section of its flow: there is nothing to go under', () => {
    const editor = editorOn(doc(p('intro'), sec('A'), sec('B')));
    caret(editor, 'A');
    expect(demoteRefusalAt(editor.state)).toBe('noPrevious');
    const before = editor.getJSON();
    expect(run(editor, demoteHeading)).toBe(false);
    // Tab stays in the editor, and changes nothing.
    expect(press(editor, 'Tab')).toBe(true);
    expect(editor.getJSON()).toEqual(before);
  });

  it('is refused past the cap, for the heading or its deepest subsection', () => {
    const deep = editorOn(doc(sec('A', sec('B', sec('C'), sec('D')))));
    caret(deep, 'D');
    expect(demoteRefusalAt(deep.state)).toBe('cap');
    expect(run(deep, demoteHeading)).toBe(false);

    const tall = editorOn(doc(sec('A'), sec('B', sec('B1', sec('B2')))));
    caret(tall, 'B');
    // B would go to 2, B2 to 4.
    expect(demoteRefusalAt(tall.state)).toBe('cap');
  });

  it('follows the configured cap, within the model’s own depth', () => {
    const editor = editorOn(doc(sec('A', sec('B', sec('C'), sec('D')))), 4);
    expect(headingCap(editor.state)).toBe(4);
    caret(editor, 'D');
    expect(run(editor, demoteHeading)).toBe(true);
    expect(blocks(editor)).toEqual(['s:A[s:B[s:C[s:D[]]]]']);

    setHeadingCap(editor.view, 2);
    expect(headingCap(editor.state)).toBe(2);
    setHeadingCap(editor.view, 99);
    expect(headingCap(editor.state)).toBe(5);
    // Setting the cap is no edit: undo takes back the demote.
    editor.commands.undo();
    expect(blocks(editor)).toEqual(['s:A[s:B[s:C[], s:D[]]]']);
  });

  it('comes back exactly with one undo, one step per level change', () => {
    const start = doc(sec('A', sec('A1', p('x'))), sec('B', p('b')));
    const editor = editorOn(start);
    const before = editor.getJSON();
    caret(editor, 'B');
    expect(press(editor, 'Tab')).toBe(true);
    const once = editor.getJSON();
    expect(press(editor, 'Tab')).toBe(true);
    expect(blocks(editor)).toEqual(['s:A[s:A1[p:x, s:B[p:b]]]']);
    editor.commands.undo();
    expect(editor.getJSON()).toEqual(once);
    editor.commands.undo();
    expect(editor.getJSON()).toEqual(before);
  });
});

describe('promoting a heading (Shift+Tab)', () => {
  it('moves it out of its parent, right after it; the sections after it become its subsections', () => {
    const editor = editorOn(
      doc(sec('A', p('a'), sec('A1'), sec('B', p('b'), sec('B1')), sec('C'))),
    );
    caret(editor, 'B', 1);
    expect(run(editor, promoteHeading)).toBe(true);
    // The reading order stays: a, A1, B, b, B1, C. C keeps its level (2), now under B.
    expect(blocks(editor)).toEqual([
      's:A[p:a, s:A1[]]',
      's:B[p:b, s:B1[], s:C[]]',
    ]);
    expect(textLevelAt(editor.state)).toBe(1);
    expect(editor.state.selection.$from.parentOffset).toBe(1);
  });

  it('is refused for a Heading 1', () => {
    const editor = editorOn(doc(sec('A')));
    caret(editor, 'A');
    expect(promoteRefusalAt(editor.state)).toBe('top');
    expect(run(editor, promoteHeading)).toBe(false);
    expect(press(editor, 'Tab', true)).toBe(true);
    expect(blocks(editor)).toEqual(['s:A[]']);
  });

  it('comes back exactly with one undo', () => {
    const editor = editorOn(doc(sec('A', sec('B', p('b')), sec('C'))));
    const before = editor.getJSON();
    caret(editor, 'B');
    expect(press(editor, 'Tab', true)).toBe(true);
    editor.commands.undo();
    expect(editor.getJSON()).toEqual(before);
  });
});

describe('making a paragraph a Heading n', () => {
  it('makes a section at that depth, holding what follows up to the next heading of its level or above', () => {
    const start = () =>
      editorOn(doc(sec('A', p('x'), p('y'), p('z'), sec('A1', p('w')))));

    const h2 = start();
    caret(h2, 'y');
    expect(run(h2, setHeadingLevel(2))).toBe(true);
    expect(blocks(h2)).toEqual(['s:A[p:x, s:y[p:z], s:A1[p:w]]']);

    const h1 = start();
    caret(h1, 'y', 1);
    expect(run(h1, setHeadingLevel(1))).toBe(true);
    // A1 keeps its level (2): it is now in y.
    expect(blocks(h1)).toEqual(['s:A[p:x]', 's:y[p:z, s:A1[p:w]]']);
    expect(textLevelAt(h1.state)).toBe(1);
    expect(h1.state.selection.$from.parentOffset).toBe(1);
  });

  it('never skips a level: a Heading 3 needs a Heading 2 around the caret', () => {
    const editor = editorOn(doc(p('top'), sec('A', p('in a'))));
    caret(editor, 'top');
    expect(headingRefusal(editor.state, 2)).toBe('skip');
    caret(editor, 'in a');
    expect(headingRefusal(editor.state, 2)).toBeNull();
    expect(headingRefusal(editor.state, 3)).toBe('skip');
    expect(run(editor, setHeadingLevel(3))).toBe(false);
  });

  it('is refused past the cap', () => {
    const editor = editorOn(doc(sec('A', sec('B', sec('C', p('deep'))))));
    caret(editor, 'deep');
    expect(headingRefusal(editor.state, 4)).toBe('cap');
    expect(headingRefusal(editor.state, 3)).toBeNull();
  });

  it('is refused inside a variant block or a list', () => {
    const editor = editorOn(
      doc(sec('A', variant(p('inside'))), list(false, 'item')),
    );
    caret(editor, 'inside');
    expect(headingRefusal(editor.state, 1)).toBe('notHere');
    expect(headingRefusal(editor.state, 2)).toBe('notHere');
    caret(editor, 'item');
    expect(headingRefusal(editor.state, 1)).toBe('notHere');
  });

  it('is one undo step', () => {
    const editor = editorOn(doc(sec('A', p('x'), p('y'))));
    const before = editor.getJSON();
    caret(editor, 'y');
    run(editor, setHeadingLevel(1));
    editor.commands.undo();
    expect(editor.getJSON()).toEqual(before);
  });
});

describe('changing a heading to another level', () => {
  it('moves it several levels in one step, or refuses it whole', () => {
    const editor = editorOn(doc(sec('A', sec('A1')), sec('B')));
    caret(editor, 'B');
    expect(headingRefusal(editor.state, 3)).toBeNull();
    expect(run(editor, setHeadingLevel(3))).toBe(true);
    expect(blocks(editor)).toEqual(['s:A[s:A1[s:B[]]]']);
    expect(run(editor, setHeadingLevel(1))).toBe(true);
    expect(blocks(editor)).toEqual(['s:A[s:A1[]]', 's:B[]']);
    editor.commands.undo();
    expect(blocks(editor)).toEqual(['s:A[s:A1[s:B[]]]']);

    const flat = editorOn(doc(sec('A'), sec('B')));
    caret(flat, 'B');
    // Into A as a Heading 2, but no Heading 2 there to go under for a 3.
    expect(headingRefusal(flat.state, 3)).toBe('noPrevious');
    expect(run(flat, setHeadingLevel(3))).toBe(false);
    expect(blocks(flat)).toEqual(['s:A[]', 's:B[]']);
  });
});

describe('one undo step, with the editor’s own plugins appending to the change', () => {
  it('takes back the heading and the caret gap and repair that came with it, together', () => {
    const editor = testEditor(doc(list(false, 'item'), p('Foo')), [
      HeadingLevels,
      CaretGaps,
      ModelRepair,
    ]);
    caret(editor, 'Foo');
    const before = blocks(editor);
    expect(run(editor, setHeadingLevel(1))).toBe(true);
    // The caret gap after the list came with the heading, in the same step.
    expect(blocks(editor)).toEqual(['p:', 'list:item', 'p:', 's:Foo[]']);
    editor.commands.undo();
    // One undo takes the heading back (the gap before the list, which the editor keeps around
    // any list, stays).
    expect(blocks(editor)).toEqual(['p:', ...before]);
  });

  it('keeps typing after a level change a step of its own', () => {
    const editor = testEditor(doc(sec('A'), sec('B')), [
      HeadingLevels,
      CaretGaps,
      ModelRepair,
    ]);
    caret(editor, 'B', 1);
    expect(run(editor, demoteHeading)).toBe(true);
    const demoted = blocks(editor);
    expect(demoted).toEqual(['s:A[s:B[]]']);
    editor.commands.insertContent('x');
    expect(blocks(editor)).toEqual(['s:A[s:Bx[]]']);
    editor.commands.undo();
    expect(blocks(editor)).toEqual(demoted);
  });
});

describe('Tab and Shift+Tab outside a heading', () => {
  it('still nest and lift list items', () => {
    const editor = editorOn(doc(list(false, 'one', 'two')));
    caret(editor, 'two');
    expect(press(editor, 'Tab')).toBe(true);
    expect(editor.state.selection.$from.node(-3).type.name).toBe('listItem');
    expect(press(editor, 'Tab', true)).toBe(true);
    expect(editor.state.selection.$from.node(-3).type.name).not.toBe(
      'listItem',
    );
  });

  it('are left alone in a paragraph', () => {
    const editor = editorOn(doc(p('text')));
    caret(editor, 'text');
    expect(press(editor, 'Tab')).toBe(false);
    expect(press(editor, 'Tab', true)).toBe(false);
  });
});

describe('the AsciiDoc round trip', () => {
  it('keeps the headings made in the editor at their depth', () => {
    const module: Module = {
      schemaVersion: 1,
      id: 'levels',
      meta: { title: 'Levels', type: 'concept', lang: 'en', facets: {} },
      blocks: ['one', 'two', 'three', 'body'].map((text) => ({
        type: 'paragraph' as const,
        id: text,
        content: [{ type: 'text' as const, text }],
      })),
    };
    const editor = editorOn(toEditor(module) as JSONContent);
    for (const [text, level] of [
      ['one', 1],
      ['two', 2],
      ['three', 3],
    ] as const) {
      caret(editor, text);
      expect(run(editor, setHeadingLevel(level))).toBe(true);
    }
    const edited = fromEditor(normalizeEditorDoc(editor.getJSON()));
    const source = printModule(edited);
    expect(source).toContain('\n== one\n');
    expect(source).toContain('\n=== two\n');
    expect(source).toContain('\n==== three\n');
    expect(parseModule(source, { id: 'levels' })).toEqual(edited);
  });
});
