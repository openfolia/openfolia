import type { JSONContent } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';

import {
  doc,
  insideText,
  list,
  p,
  sec,
  testEditor,
} from '../testing/test-editor';
import {
  boundaryOf,
  dropRefusalText,
  dropTargets,
  keyboardTarget,
  onlyBlanksBetween,
  sectionLevel,
  type DropTarget,
} from './drop-rules';
import { HeadingLevels } from './heading-levels';

type TestEditor = ReturnType<typeof testEditor>;

const variant = (...content: JSONContent[]): JSONContent => ({
  type: 'variant',
  attrs: { when: null },
  content,
});

const safety = (hazard: string, ...content: JSONContent[]): JSONContent => ({
  type: 'safety',
  attrs: { severity: 'warning' },
  content: [
    { type: 'hazard', content: [{ type: 'text', text: hazard }] },
    ...content,
  ],
});

const faq = (question: string, ...answer: JSONContent[]): JSONContent => ({
  type: 'faq',
  attrs: { id: null },
  content: [
    { type: 'question', content: [{ type: 'text', text: question }] },
    ...answer,
  ],
});

/** The start of the block whose text (or heading) is `text`: a section for its heading. */
function blockOf(editor: TestEditor, text: string): number {
  const $pos = editor.state.doc.resolve(insideText(editor, text));
  return $pos.parent.type.name === 'title' ? $pos.before(-1) : $pos.before();
}

/** A place as `holder index`, its holder named by its heading or text: `S1 2`, `doc 0`. */
function where(editor: TestEditor, target: DropTarget): string {
  const $pos = editor.state.doc.resolve(target.pos);
  const holder = $pos.parent;
  const name =
    holder.type.name === 'section'
      ? (holder.firstChild?.textContent ?? '')
      : holder.type.name === 'safety' || holder.type.name === 'faq'
        ? `${holder.type.name}(${holder.firstChild?.textContent ?? ''})`
        : holder.type.name;
  const level = target.level === null ? '' : ` H${target.level}`;
  const refusal = target.refusal ? ` !${target.refusal}` : '';
  return `${name} ${$pos.index()}${level}${refusal}${target.home ? ' home' : ''}`;
}

const places = (editor: TestEditor, text: string) =>
  dropTargets(editor.state, blockOf(editor, text)).map((target) =>
    where(editor, target),
  );

const caretIn = (editor: TestEditor, text: string) =>
  editor.view.dispatch(
    editor.state.tr.setSelection(
      TextSelection.create(editor.state.doc, insideText(editor, text)),
    ),
  );

describe('where a dragged block may go', () => {
  it('goes into the text of every flow, between a heading and its subsections', () => {
    const editor = testEditor(
      doc(
        p('intro'),
        sec('S1', p('a'), sec('S1.1', p('b'))),
        sec('S2', p('c')),
      ),
    );
    expect(places(editor, 'a')).toEqual([
      'doc 0',
      'doc 1',
      'S1 1 home',
      'S1.1 1',
      'S1.1 2',
      'S2 1',
      'S2 2',
    ]);
  });

  it('goes into a variant block, and into a safety notice after its hazard', () => {
    const editor = testEditor(
      doc(p('a'), variant(p('v')), safety('Hot', p('measure'))),
    );
    expect(places(editor, 'a')).toEqual([
      'doc 0 home',
      'variant 0',
      'variant 1',
      'doc 2',
      'safety(Hot) 1',
      'safety(Hot) 2',
      'doc 3',
    ]);
  });

  it('goes into an FAQ entry’s answer, after its question', () => {
    const editor = testEditor(doc(p('a'), faq('Why?', p('because'))));
    expect(places(editor, 'a')).toEqual([
      'doc 0 home',
      'faq(Why?) 1',
      'faq(Why?) 2',
      'doc 2',
    ]);
  });

  it('never goes inside itself', () => {
    const editor = testEditor(doc(p('a'), variant(p('v'), p('w'))));
    const from = blockOf(editor, 'v') - 1;
    const targets = dropTargets(editor.state, from);
    const node = editor.state.doc.nodeAt(from)!;
    expect(
      targets.some((t) => t.pos > from && t.pos < from + node.nodeSize),
    ).toBe(false);
    expect(targets.filter((t) => t.home)).toHaveLength(1);
  });
});

describe('where a block inside a variant block, a safety notice or an FAQ entry may go', () => {
  it('goes out into the flow around its container, or among its container’s blocks', () => {
    const editor = testEditor(doc(p('a'), variant(p('v1'), p('v2')), p('z')));
    expect(places(editor, 'v1')).toEqual([
      'doc 0',
      'doc 1',
      'variant 0 home',
      'variant 2',
      'doc 2',
      'doc 3',
    ]);
  });

  it('stays when it is the last block of a variant block or an FAQ answer, which can’t be empty', () => {
    const editor = testEditor(
      doc(p('a'), variant(p('v')), faq('Why?', p('because')), p('z')),
    );
    expect(places(editor, 'v')).toEqual([
      'doc 0 !last',
      'doc 1 !last',
      'variant 0 home',
      'doc 2 !last',
      'faq(Why?) 1 !last',
      'faq(Why?) 2 !last',
      'doc 3 !last',
      'doc 4 !last',
    ]);
    expect(places(editor, 'because')).toContain('faq(Why?) 1 home');
    expect(
      places(editor, 'because').filter((place) => place.includes('!')),
    ).toHaveLength(places(editor, 'because').length - 1);
  });

  it('may leave a safety notice with its hazard only: the schema takes that', () => {
    const editor = testEditor(doc(p('a'), safety('Hot', p('m')), p('z')));
    expect(places(editor, 'm')).toEqual([
      'doc 0',
      'doc 1',
      'safety(Hot) 1 home',
      'doc 2',
      'doc 3',
    ]);
  });
});

describe('where a dragged section may go', () => {
  const outline = () =>
    testEditor(
      doc(
        p('intro'),
        sec('S1', p('a'), sec('S1.1', p('b'))),
        sec('S2', p('c'), list(false, 'item')),
      ),
      [HeadingLevels],
    );

  it('goes among the sections of every flow, at the level it lands at, and is refused between blocks or in a list', () => {
    const editor = outline();
    expect(places(editor, 'S2')).toEqual([
      'doc 0 !text',
      'doc 1 H1',
      'S1 1 !text',
      'S1 2 H2',
      'S1.1 1 !text',
      'S1.1 2 H3',
      'S1 3 H2',
      'doc 2 H1 home',
    ]);
  });

  it('carries its subsections: refused where they would pass the cap', () => {
    const editor = outline();
    expect(places(editor, 'S1').filter((place) => place.includes('H'))).toEqual(
      ['doc 1 H1 home', 'S2 3 H2', 'doc 3 H1'],
    );
    // Into S2 at Heading 3 would take S1.1 to Heading 4: there is no such place to offer.
    const capped = testEditor(
      doc(sec('A', sec('A1', p('x'))), sec('B', sec('B1', p('y')))),
      [HeadingLevels],
    );
    expect(places(capped, 'A')).toContain('B1 2 H3 !cap');
  });

  it('is not refused before the blank lines that end a flow’s text, the end of it to see', () => {
    const editor = testEditor(
      doc(sec('S1', p('a'), p(), p()), sec('S2', p('c'))),
      [HeadingLevels],
    );
    expect(
      places(editor, 'S2').filter((place) => place.startsWith('S1')),
    ).toEqual(['S1 1 !text', 'S1 4 H2']);
  });

  it('is refused inside a list, a variant, a safety notice and an FAQ entry, with the reason', () => {
    const editor = testEditor(
      doc(
        list(false, 'item'),
        variant(p('v')),
        safety('Hot', p('m')),
        faq('Why?', p('because')),
        sec('S', p('s')),
      ),
      [HeadingLevels],
    );
    const refusals = dropTargets(editor.state, blockOf(editor, 'S'))
      .map((target) => target.refusal)
      .filter((refusal) => refusal && refusal !== 'text');
    expect(new Set(refusals)).toEqual(
      new Set(['list', 'variant', 'safety', 'faq']),
    );
  });

  it('follows the configured cap', () => {
    const editor = testEditor(
      doc(sec('A', sec('B', p('b'))), sec('C', p('c'))),
      [HeadingLevels.configure({ cap: 2 })],
    );
    const levels = dropTargets(editor.state, blockOf(editor, 'C'))
      .filter((t) => t.level !== null)
      .map((t) => `${t.level}${t.refusal ? '!' : ''}`);
    expect(levels).toEqual(['1', '2', '3!', '2', '1']);
  });
});

describe('the reasons', () => {
  it('reads the cap the way Tab does, and the rest as their own texts', () => {
    const editor = testEditor(doc(p('a')), [HeadingLevels]);
    expect(dropRefusalText(editor.state, 'cap', 4)).toEqual({
      key: 'editor.docEditor.heading.cap',
      params: { parent: 3, max: 3 },
    });
    expect(dropRefusalText(editor.state, 'list', 2)).toEqual({
      key: 'editor.docEditor.drop.list',
      params: {},
    });
  });
});

describe('the boundaries between places', () => {
  it('counts the ends of nested sections and the place after them as one', () => {
    const editor = testEditor(
      doc(sec('S1', p('a'), sec('S1.1', p('b'))), sec('S2', p('c'))),
    );
    const s2 = blockOf(editor, 'S2');
    expect(boundaryOf(editor.state.doc, s2 - 1)).toBe(s2);
    expect(boundaryOf(editor.state.doc, s2 - 2)).toBe(s2);
    expect(boundaryOf(editor.state.doc, s2)).toBe(s2);
  });

  it('sees only blank lines between places a move there would not show', () => {
    const editor = testEditor(doc(p('a'), p(), p('b')));
    const b = blockOf(editor, 'b');
    expect(onlyBlanksBetween(editor.state.doc, 3, b)).toBe(true);
    expect(onlyBlanksBetween(editor.state.doc, 0, b)).toBe(false);
  });

  it("counts a section's level from the top of the module", () => {
    const editor = testEditor(doc(sec('A', sec('B', sec('C')))));
    expect(sectionLevel(editor.state.doc, blockOf(editor, 'A'))).toBe(1);
    expect(sectionLevel(editor.state.doc, blockOf(editor, 'C'))).toBe(3);
  });
});

describe('Alt+Up and Alt+Down', () => {
  const editor = () =>
    testEditor(doc(p('intro'), sec('S1', p('a'), p('b')), sec('S2', p('c'))), [
      HeadingLevels,
    ]);

  it('steps past one block within the flow', () => {
    const e = editor();
    caretIn(e, 'b');
    expect(keyboardTarget(e.state, true)).toEqual({
      from: blockOf(e, 'b'),
      to: blockOf(e, 'a'),
    });
  });

  it("crosses a section's edge into the text before or after it", () => {
    const e = editor();
    caretIn(e, 'a');
    // Up past S1's heading: the last block of the module's own text.
    expect(keyboardTarget(e.state, true)?.to).toBe(blockOf(e, 'S1'));
    caretIn(e, 'b');
    // Down past S2's heading: its first block.
    expect(keyboardTarget(e.state, false)?.to).toBe(blockOf(e, 'c'));
  });

  it('moves a section among the sections of the neighbouring flow, at its own level', () => {
    const e = testEditor(
      doc(sec('A', sec('A1', p('x'))), sec('B', sec('B1', p('y')))),
      [HeadingLevels],
    );
    caretIn(e, 'B1');
    const step = keyboardTarget(e.state, true);
    // Into A, after A1: still a Heading 2.
    expect(step?.to).toBe(blockOf(e, 'B') - 1);
  });

  it('moves a block inside a container among its container’s blocks, and out at its edge', () => {
    const e = testEditor(
      doc(p('a'), variant(p('v1'), p('v2')), safety('Hot', p('c'), p('m'))),
      [HeadingLevels],
    );
    const variantAt = blockOf(e, 'v1') - 1;
    const safetyAt = blockOf(e, 'Hot') - 1;
    caretIn(e, 'v2');
    expect(keyboardTarget(e.state, true)).toEqual({
      from: blockOf(e, 'v2'),
      to: blockOf(e, 'v1'),
    });
    // Down from the last block: out, right after the variant block.
    expect(keyboardTarget(e.state, false)).toEqual({
      from: blockOf(e, 'v2'),
      to: safetyAt,
    });
    caretIn(e, 'v1');
    expect(keyboardTarget(e.state, true)).toEqual({
      from: blockOf(e, 'v1'),
      to: variantAt,
    });
    // Never above the hazard: up from the first block, out before the notice.
    caretIn(e, 'c');
    expect(keyboardTarget(e.state, true)).toEqual({
      from: blockOf(e, 'c'),
      to: safetyAt,
    });
    const m = blockOf(e, 'm');
    expect(keyboardTarget(e.state, false)?.to).toBe(
      m + e.state.doc.nodeAt(m)!.nodeSize,
    );
  });

  it('moves the container where its block can’t leave it: a variant block’s or FAQ answer’s last', () => {
    const e = testEditor(
      doc(p('a'), variant(p('v')), faq('Why?', p('because')), p('z')),
      [HeadingLevels],
    );
    caretIn(e, 'v');
    expect(keyboardTarget(e.state, true)).toEqual({
      from: blockOf(e, 'v') - 1,
      to: 0,
    });
    // The block alone (its grip's menu): it stays.
    expect(keyboardTarget(e.state, true, false)).toBeNull();
    caretIn(e, 'because');
    expect(keyboardTarget(e.state, false)?.from).toBe(blockOf(e, 'Why?') - 1);
  });

  it('moves the safety notice or FAQ entry whole from its hazard or question', () => {
    const e = testEditor(
      doc(p('a'), safety('Hot', p('m')), faq('Why?', p('because'))),
      [HeadingLevels],
    );
    caretIn(e, 'Hot');
    expect(keyboardTarget(e.state, true)).toEqual({
      from: blockOf(e, 'Hot') - 1,
      to: 0,
    });
    caretIn(e, 'Why?');
    expect(keyboardTarget(e.state, true)?.from).toBe(blockOf(e, 'Why?') - 1);
  });

  it('has nowhere to go at the edges of the module', () => {
    const e = editor();
    caretIn(e, 'intro');
    expect(keyboardTarget(e.state, true)).toBeNull();
    caretIn(e, 'c');
    expect(keyboardTarget(e.state, false)).toBeNull();
  });
});
