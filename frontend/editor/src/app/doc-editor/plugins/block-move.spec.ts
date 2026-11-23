import { NodeSelection, TextSelection } from '@tiptap/pm/state';

import {
  blocks,
  doc,
  inside,
  insideText,
  list,
  p,
  ref,
  sec,
  testEditor,
} from '../testing/test-editor';
import {
  BLOCK_MOVED,
  blockPlace,
  canMoveBlock,
  moveBlockTo,
  moveSelectedBlock,
} from './block-move';
import { BlockMoveKeys } from './block-move-keys';
import { CaretGaps } from './caret-gaps';
import { HeadingLevels } from './heading-levels';
import { ModelRepair } from './model-repair';

type TestEditor = ReturnType<typeof testEditor>;

function caretAt(editor: TestEditor, pos: number) {
  editor.view.dispatch(
    editor.state.tr.setSelection(TextSelection.create(editor.state.doc, pos)),
  );
}

const caretIn = (editor: TestEditor, index: number, offset = 0) =>
  caretAt(editor, inside(editor, index) + offset);

describe('moving a block', () => {
  it('moves the block to another position in its flow and keeps the caret inside it', () => {
    const editor = testEditor(doc(p('one'), p('two'), p('three')));
    caretIn(editor, 0, 2);
    const end = editor.state.doc.content.size;
    expect(moveBlockTo(editor.view, 0, end)).toBe(true);
    expect(blocks(editor)).toEqual(['p:two', 'p:three', 'p:one']);
    const { $from } = editor.state.selection;
    expect($from.parent.textContent).toBe('one');
    expect($from.parentOffset).toBe(2);
  });

  it('refuses a move onto itself', () => {
    const editor = testEditor(doc(p('one'), p('two')));
    expect(moveBlockTo(editor.view, 0, 0)).toBe(false);
    expect(moveBlockTo(editor.view, 0, 5)).toBe(false);
    expect(blocks(editor)).toEqual(['p:one', 'p:two']);
  });

  it('marks its transaction so the selection memory follows the block', () => {
    const editor = testEditor(doc(p('one'), p('two')));
    caretIn(editor, 0);
    const metas: unknown[] = [];
    editor.on('transaction', ({ transaction }) =>
      metas.push(transaction.getMeta(BLOCK_MOVED)),
    );
    moveBlockTo(editor.view, 0, editor.state.doc.content.size);
    expect(metas).toContain(true);
  });

  it('closes up two blank gaps the block leaves touching', () => {
    const editor = testEditor(doc(p('a'), p(), ref(), p(), p('b')));
    // The reference goes to the end: the blanks either side of where it stood would touch.
    const at = inside(editor, 2) - 1;
    moveBlockTo(editor.view, at, editor.state.doc.content.size);
    expect(blocks(editor)).toEqual(['p:a', 'p:', 'p:b', 'ref']);
  });
});

describe('undoing a move', () => {
  it('puts the block and the caret back where they were', () => {
    const editor = testEditor(doc(p('a'), p('b'), p('c')));
    caretIn(editor, 2, 1);
    const before = editor.state.selection.from;
    moveSelectedBlock(editor.view, true);
    expect(blocks(editor)).toEqual(['p:a', 'p:c', 'p:b']);
    editor.commands.undo();
    expect(blocks(editor)).toEqual(['p:a', 'p:b', 'p:c']);
    expect(editor.state.selection.from).toBe(before);
  });

  it('moves a selected placeholder and keeps it selected', () => {
    const editor = testEditor(doc(p('a'), ref(), p('b')));
    const at = inside(editor, 1) - 1;
    editor.view.dispatch(
      editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, at)),
    );
    expect(moveSelectedBlock(editor.view, true)).toBe(true);
    expect(blocks(editor)).toEqual(['ref', 'p:a', 'p:b']);
    const { selection } = editor.state;
    expect(selection instanceof NodeSelection && selection.node.type.name).toBe(
      'moduleRef',
    );
  });
});

describe('one step up or down', () => {
  it('steps over blank gaps, which would change nothing to see', () => {
    const editor = testEditor(doc(p('first'), p(), ref(), p(), p('last')));
    caretIn(editor, 4);
    expect(moveSelectedBlock(editor.view, true)).toBe(true);
    expect(blocks(editor)).toEqual(['p:first', 'p:', 'p:last', 'ref', 'p:']);
  });

  it('cannot go past either end', () => {
    const editor = testEditor(doc(p('first'), p('second')));
    caretIn(editor, 0);
    expect(canMoveBlock(editor.state, true)).toBe(false);
    expect(canMoveBlock(editor.state, false)).toBe(true);
    expect(moveSelectedBlock(editor.view, true)).toBe(false);
    caretIn(editor, 1);
    expect(canMoveBlock(editor.state, false)).toBe(false);
  });

  it('counts the place among what a reader sees', () => {
    const editor = testEditor(doc(p('a'), p(), ref(), p(), p('b')));
    caretIn(editor, 4);
    expect(blockPlace(editor.state)).toEqual({ position: 3, total: 3 });
  });

  it('moves with Alt+Up and Alt+Down and announces it', () => {
    const onMoved = vi.fn();
    const editor = testEditor(doc(p('a'), p('b'), p('c')), [
      BlockMoveKeys.configure({ onMoved }),
    ]);
    // A real key event: TipTap's keyboardShortcut command replays steps but not the selection.
    const press = (key: string) =>
      editor.view.dom.dispatchEvent(
        new KeyboardEvent('keydown', { key, altKey: true, bubbles: true }),
      );
    caretIn(editor, 2);
    press('ArrowUp');
    expect(blocks(editor)).toEqual(['p:a', 'p:c', 'p:b']);
    expect(onMoved).toHaveBeenCalledOnce();
    press('ArrowDown');
    expect(blocks(editor)).toEqual(['p:a', 'p:b', 'p:c']);
    expect(onMoved).toHaveBeenCalledTimes(2);
  });
});

describe('moving within a section', () => {
  const nested = () =>
    testEditor(
      doc(
        p('intro'),
        sec('One', p('a'), list(false, 'item'), p('b'), sec('Inner', p('x'))),
        sec('Two', p('c')),
      ),
    );

  it('moves a block among the blocks of its own section', () => {
    const editor = nested();
    caretAt(editor, insideText(editor, 'b'));
    expect(moveSelectedBlock(editor.view, true)).toBe(true);
    expect(blocks(editor)[1]).toBe('s:One[p:a, p:b, list:item, s:Inner[p:x]]');
    expect(editor.state.selection.$from.parent.textContent).toBe('b');
  });

  it("crosses a section's edges: past its last block into the subsection, past its first out", () => {
    const editor = nested();
    caretAt(editor, insideText(editor, 'b'));
    expect(moveSelectedBlock(editor.view, false)).toBe(true);
    expect(blocks(editor)[1]).toBe('s:One[p:a, list:item, s:Inner[p:b, p:x]]');
    expect(editor.state.selection.$from.parent.textContent).toBe('b');
    caretAt(editor, insideText(editor, 'a'));
    expect(moveSelectedBlock(editor.view, true)).toBe(true);
    expect(blocks(editor).slice(0, 2)).toEqual(['p:intro', 'p:a']);
  });

  it('moves into the next section, and back with one undo each, with the plugins that append', () => {
    const editor = testEditor(
      doc(sec('One', p('a'), p('b')), sec('Two', p('c'))),
      [HeadingLevels, CaretGaps, ModelRepair],
    );
    caretAt(editor, insideText(editor, 'b'));
    // Typed just before: the move is still an undo step of its own.
    editor.commands.insertContent('!');
    expect(moveSelectedBlock(editor.view, false)).toBe(true);
    expect(blocks(editor)).toEqual(['s:One[p:a]', 's:Two[p:!b, p:c]']);
    editor.commands.undo();
    expect(blocks(editor)).toEqual(['s:One[p:a, p:!b]', 's:Two[p:c]']);
    editor.commands.undo();
    expect(blocks(editor)).toEqual(['s:One[p:a, p:b]', 's:Two[p:c]']);
  });

  it('moves a section into the neighbouring section, keeping its level', () => {
    const editor = testEditor(
      doc(sec('One', sec('A', p('x'))), sec('Two', sec('B', p('y')))),
      [HeadingLevels],
    );
    caretAt(editor, insideText(editor, 'B'));
    expect(moveSelectedBlock(editor.view, true)).toBe(true);
    expect(blocks(editor)).toEqual(['s:One[s:A[p:x], s:B[p:y]]', 's:Two[]']);
    expect(editor.state.selection.$from.parent.textContent).toBe('B');
  });

  it('moves a whole section among its sibling sections, from its heading', () => {
    const editor = nested();
    caretAt(editor, insideText(editor, 'Two'));
    expect(blockPlace(editor.state)).toEqual({ position: 2, total: 2 });
    expect(moveSelectedBlock(editor.view, true)).toBe(true);
    expect(blocks(editor)).toEqual([
      'p:intro',
      's:Two[p:c]',
      's:One[p:a, list:item, p:b, s:Inner[p:x]]',
    ]);
    // A section never moves above the blocks of its flow.
    expect(canMoveBlock(editor.state, true)).toBe(false);
  });

  it('moves the list as a whole from inside an item', () => {
    const editor = nested();
    caretAt(editor, insideText(editor, 'item'));
    expect(moveSelectedBlock(editor.view, true)).toBe(true);
    expect(blocks(editor)[1]).toBe('s:One[list:item, p:a, p:b, s:Inner[p:x]]');
  });
});
