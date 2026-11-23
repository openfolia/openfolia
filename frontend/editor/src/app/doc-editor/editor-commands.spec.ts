import { TestBed } from '@angular/core/testing';
import { injectTranslate } from '@openfolia/ui/i18n';
import { TextSelection } from '@tiptap/pm/state';

import {
  columnAligns,
  COLUMN_ALIGNS,
  canMove,
  moveBlock,
  setTextLevel,
  textLevelOf,
  textStyleRefusal,
  textStyles,
  toggleMark,
  toggleWrap,
  wrapActive,
} from './editor-commands';
import {
  blocks,
  doc,
  inside,
  insideText,
  p,
  sec,
  testEditor,
} from './testing/test-editor';

describe('editor commands', () => {
  it('reads and sets the text style of the block at the caret', () => {
    const editor = testEditor(doc(p('one'), p('two')));
    editor.commands.setTextSelection(2);
    expect(textLevelOf(editor.state)).toBe(0);
    expect(setTextLevel(editor, 1)).toBe(true);
    // The heading holds what followed it.
    expect(blocks(editor)).toEqual(['s:one[p:two]']);
    expect(textLevelOf(editor.state)).toBe(1);
    expect(editor.state.selection.$from.parentOffset).toBe(1);
    expect(setTextLevel(editor, 0)).toBe(true);
    expect(blocks(editor)).toEqual(['p:one', 'p:two']);
    expect(setTextLevel(editor, 0)).toBe(false);
  });

  it('offers text and Heading 1 to the cap, each with why it cannot apply', () => {
    const editor = testEditor(doc(p('one')));
    editor.commands.setTextSelection(2);
    expect(textStyles(editor.state).map((s) => s.level)).toEqual([0, 1, 2, 3]);
    expect(textStyleRefusal(editor.state, 1)).toBeNull();
    // At the top of the module, a Heading 2 would skip a level.
    expect(textStyleRefusal(editor.state, 2)).toBe('skip');
    expect(setTextLevel(editor, 2)).toBe(false);
    expect(blocks(editor)).toEqual(['p:one']);
  });

  it('toggles each mark on the selection', () => {
    const editor = testEditor(doc(p('word')));
    for (const mark of ['strong', 'emphasis', 'code'] as const) {
      editor.commands.setTextSelection({ from: 1, to: 5 });
      toggleMark(editor, mark);
      expect(editor.isActive(mark)).toBe(true);
      toggleMark(editor, mark);
      expect(editor.isActive(mark)).toBe(false);
    }
  });

  it('wraps, switches and unwraps lists', () => {
    const editor = testEditor(doc(p('item')));
    editor.commands.setTextSelection(2);
    toggleWrap(editor, 'bulletList');
    expect(wrapActive(editor.state, 'bulletList')).toBe(true);
    toggleWrap(editor, 'orderedList');
    expect(wrapActive(editor.state, 'bulletList')).toBe(false);
    expect(wrapActive(editor.state, 'orderedList')).toBe(true);
    toggleWrap(editor, 'orderedList');
    expect(blocks(editor)).toEqual(['p:item']);
    expect(editor.state.selection.$from.parent.textContent).toBe('item');
  });

  it('moves the block and says where it went', () => {
    const editor = testEditor(doc(p('a'), p('b'), p('c')));
    editor.view.dispatch(
      editor.state.tr.setSelection(
        TextSelection.create(editor.state.doc, inside(editor, 0)),
      ),
    );
    expect(canMove(editor.state, true)).toBe(false);
    // The English texts of the test providers.
    const t = TestBed.runInInjectionContext(() => injectTranslate());
    expect(moveBlock(editor, true, t)).toBeNull();
    expect(moveBlock(editor, false, t)).toBe('Block moved to position 2 of 3');
    expect(blocks(editor)).toEqual(['p:b', 'p:a', 'p:c']);
  });

  it('moves a section and counts it among its sibling sections', () => {
    const editor = testEditor(doc(p('intro'), sec('One'), sec('Two')));
    editor.commands.setTextSelection(insideText(editor, 'Two'));
    const t = TestBed.runInInjectionContext(() => injectTranslate());
    expect(moveBlock(editor, true, t)).toBe('Block moved to position 1 of 2');
    expect(blocks(editor)).toEqual(['p:intro', 's:Two[]', 's:One[]']);
  });
});

describe('columnAligns (#458)', () => {
  it('offers left, centre and right as they are in left-to-right text', () => {
    expect(columnAligns('ltr')).toBe(COLUMN_ALIGNS);
  });

  it('names and shows each by the side it lands on in right-to-left text', () => {
    expect(columnAligns('rtl').map((a) => [a.id, a.label, a.icon])).toEqual([
      ['left', 'editor.docEditor.table.alignRight', 'lucideAlignRight'],
      ['center', 'editor.docEditor.table.alignCenter', 'lucideAlignCenter'],
      ['right', 'editor.docEditor.table.alignLeft', 'lucideAlignLeft'],
    ]);
  });
});
