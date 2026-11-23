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
  CaretGaps,
  gapPositions,
  withCaretGaps,
  withoutCaretGaps,
} from './caret-gaps';
import { toggleList } from './structure';

describe('caret gaps in a stored document', () => {
  it('adds a blank line before a leading block without text, between two, and at the end', () => {
    expect(withCaretGaps(doc(ref(), list(false, 'x')))).toEqual(
      doc(p(), ref(), p(), list(false, 'x'), p()),
    );
  });

  it('adds nothing beside text, headings and sections', () => {
    const plain = doc(p('a'), ref(), p('b'), sec('S', ref(), p('c')));
    expect(withCaretGaps(plain)).toEqual(plain);
  });

  it('adds them in every section, after the last block and before the subsections', () => {
    expect(withCaretGaps(doc(sec('S', ref(), sec('T', p('t')))))).toEqual(
      doc(sec('S', ref(), p(), sec('T', p('t')))),
    );
  });

  it('gives an empty document a line', () => {
    expect(withCaretGaps(doc())).toEqual(doc(p()));
  });

  it('takes out exactly what it added', () => {
    for (const original of [
      doc(ref(), list(true, 'x')),
      doc(p('a'), ref(), p('b')),
      doc(list(false, 'x')),
      doc(p('only')),
      doc(sec('S', ref(), sec('T', ref()))),
    ]) {
      expect(withoutCaretGaps(withCaretGaps(original))).toEqual(original);
    }
  });

  it('drops every blank paragraph of a flow, typed or left over', () => {
    expect(withoutCaretGaps(doc(p('a'), p(), p('b')))).toEqual(
      doc(p('a'), p('b')),
    );
    expect(
      withoutCaretGaps(doc(ref(), p(), sec('S', p(), p('b'), p()))),
    ).toEqual(doc(ref(), sec('S', p('b'))));
    // The model stores no empty paragraph: a document of nothing else is empty.
    expect(withoutCaretGaps(doc(p(), p()))).toEqual({ type: 'doc' });
  });
});

describe('the caret gap plugin', () => {
  it('finds no gaps in a document that has them', () => {
    const editor = testEditor(withCaretGaps(doc(ref(), sec('S', ref()))), [
      CaretGaps,
    ]);
    expect(gapPositions(editor.state.doc)).toEqual([]);
  });

  it('adds the line after a list made at the end, in one undo step with it', () => {
    const editor = testEditor(doc(p('a'), p('b')), [CaretGaps]);
    editor.commands.setTextSelection(insideText(editor, 'b'));
    toggleList(false)(editor.state, editor.view.dispatch);
    expect(blocks(editor)).toEqual(['p:a', 'list:b', 'p:']);
    editor.commands.undo();
    expect(blocks(editor)).toEqual(['p:a', 'p:b']);
  });
});
