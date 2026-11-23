import type { JSONContent } from '@tiptap/core';
import type { Command } from '@tiptap/pm/state';
import type { Block, Procedure } from '@openfolia/content-model/core';
import {
  fromEditor,
  normalizeEditorDoc,
  toEditor,
} from '@openfolia/content-editor-model';

import { SAMPLE_MODULE } from '../sample-module';
import {
  insertAdmonition,
  insertAttachment,
  insertImage,
  insertLiteral,
  insertModuleRef,
  insertPageBreak,
  insertProcedure,
  insertSafety,
  insertVariant,
} from '../blocks/doc-blocks';
import { insertEntries } from '../slash/slash-items';
import { withoutCaretGaps } from './caret-gaps';
import { canMoveBlock, moveSelectedBlock } from './block-move';
import { dropTargets } from './drop-rules';
import { insertStepResult } from './procedure-steps';
import { insertTable } from './table-editing';
import { insideText, p, testEditor } from '../testing/test-editor';

// A procedure's step holds blocks under its text: an image above all, but also a note, a safety
// notice, a table, code, a sub-procedure. They are inserted there from the step's text, move
// within their step and between steps, and convert to the step's `blocks`.

const PUMP = `sha256:${'a'.repeat(64)}`;

const text = (value: string): JSONContent[] =>
  value ? [{ type: 'text', text: value }] : [];

const image = (alt: string): JSONContent => ({
  type: 'image',
  attrs: { asset: PUMP, alt, width: 50 },
});

const step = (value: string, ...rest: JSONContent[]): JSONContent => ({
  type: 'listItem',
  content: [{ type: 'itemText', content: text(value) }, ...rest],
});

const procedure = (...steps: JSONContent[]): JSONContent => ({
  type: 'procedure',
  content: steps,
});

/** A document with a module's attributes, so it converts. */
const moduleDoc = (...content: JSONContent[]): JSONContent => ({
  ...toEditor({ ...SAMPLE_MODULE, blocks: [] }),
  content,
});

type TestEditor = ReturnType<typeof testEditor>;

const model = (editor: TestEditor) =>
  fromEditor(
    normalizeEditorDoc(withoutCaretGaps(editor.getJSON() as JSONContent)),
  );

/** The model's first procedure. */
function procedureOf(editor: TestEditor): Procedure {
  const found = model(editor).blocks.find(
    (b: Block): b is Procedure => b.type === 'procedure',
  );
  if (!found) throw new Error('no procedure');
  return found;
}

/** The types of the blocks under each step's text. */
const stepBlocks = (editor: TestEditor) =>
  procedureOf(editor).steps.map((s) => s.blocks.map((b) => b.type));

const CHOICE = { asset: PUMP, alt: 'The pump', caption: '', width: 50 };
const FILE = {
  asset: PUMP,
  name: 'Wiring',
  description: '',
  fileName: 'wiring.pdf',
  mediaType: 'application/pdf',
  size: 10,
};

describe('blocks in a procedure step', () => {
  const twoSteps = () =>
    testEditor(moduleDoc(procedure(step('Open the cover.'), step('Plug in.'))));

  it.each<[string, Command, string]>([
    ['an image', insertImage(CHOICE), 'image'],
    ['a safety notice', insertSafety, 'safety'],
    ['a note', insertAdmonition, 'admonition'],
    ['a table', insertTable, 'table'],
    ['a code block', insertLiteral, 'literal'],
    ['a sub-procedure', insertProcedure, 'procedure'],
    ['a variant block', insertVariant, 'variant'],
    ['a module reference', insertModuleRef, 'moduleRef'],
    ['an attachment', insertAttachment(FILE), 'attachment'],
  ])(
    'puts %s under the step text at the caret, in that step',
    (_what, command, type) => {
      const editor = twoSteps();
      editor.commands.setTextSelection(
        insideText(editor, 'Open the cover.') + 3,
      );
      expect(command(editor.state, editor.view.dispatch)).toBe(true);
      const step = editor.state.doc.child(0).child(0);
      expect(step.type.name).toBe('listItem');
      expect(step.child(0).type.name).toBe('itemText');
      expect(step.child(1).type.name).toBe(type);
      // The other step and the procedure itself are untouched.
      expect(editor.state.doc.child(0).childCount).toBe(2);
      expect(editor.state.doc.child(0).child(1).childCount).toBe(1);
    },
  );

  it('puts a second image under the first, and an image under a sub-step’s text', () => {
    const editor = testEditor(
      moduleDoc(
        procedure(
          step(
            'Open the cover.',
            image('Cover'),
            procedure(step('Lift the latch.')),
          ),
        ),
      ),
    );
    editor.commands.setTextSelection(insideText(editor, 'Open the cover.'));
    insertImage(CHOICE)(editor.state, editor.view.dispatch);
    editor.commands.setTextSelection(insideText(editor, 'Lift the latch.'));
    insertImage(CHOICE)(editor.state, editor.view.dispatch);
    const [first] = procedureOf(editor).steps;
    expect(first?.blocks.map((b) => b.type)).toEqual([
      'image',
      'image',
      'procedure',
    ]);
    expect(
      (first?.blocks[2] as Procedure).steps[0]?.blocks.map((b) => b.type),
    ).toEqual(['image']);
  });

  it('offers every block in the Insert menu from a step’s text, a page break aside', () => {
    const editor = twoSteps();
    editor.commands.setTextSelection(insideText(editor, 'Plug in.'));
    const blocked = insertEntries(editor.state)
      .flatMap((g) => g.entries)
      .filter((e) => e.reason !== null)
      .map((e) => e.item.id);
    // Image, attachment, snippet and term wait for the page's pickers, absent here; everything
    // else is offered.
    expect(blocked.sort()).toEqual(['attachment', 'image', 'snippet', 'term']);
  });

  it('puts a page break after the procedure: a page breaks only between blocks of a flow', () => {
    const editor = twoSteps();
    editor.commands.setTextSelection(insideText(editor, 'Plug in.'));
    expect(insertPageBreak(editor.state, editor.view.dispatch)).toBe(true);
    expect(stepBlocks(editor)).toEqual([[], []]);
    expect(model(editor).blocks.map((b) => b.type)).toEqual([
      'procedure',
      'pageBreak',
    ]);
  });

  it('moves a step’s image with Alt+Up/Down within its step and into the steps around it', () => {
    const editor = testEditor(
      moduleDoc(
        procedure(
          step('One.'),
          step('Two.', image('A'), image('B')),
          step('Three.'),
        ),
      ),
    );
    const alts = () =>
      procedureOf(editor).steps.map((s) =>
        s.blocks.map((b) => (b.type === 'image' ? b.alt : b.type)),
      );
    // Select image B: the block after image A in step two.
    const two = editor.state.doc.child(0).child(1);
    const stepTwo = 1 + editor.state.doc.child(0).child(0).nodeSize;
    const imageB = stepTwo + 1 + two.child(0).nodeSize + two.child(1).nodeSize;
    editor.commands.setNodeSelection(imageB);
    expect(moveSelectedBlock(editor.view, true)).toBe(true);
    expect(alts()).toEqual([[], ['B', 'A'], []]);
    expect(moveSelectedBlock(editor.view, true)).toBe(true);
    expect(alts()).toEqual([['B'], ['A'], []]);
    editor.commands.undo();
    editor.commands.undo();
    expect(alts()).toEqual([[], ['A', 'B'], []]);
    // Down from the last block of step two: into step three, under its text.
    editor.commands.setNodeSelection(imageB);
    expect(canMoveBlock(editor.state, false)).toBe(true);
    expect(moveSelectedBlock(editor.view, false)).toBe(true);
    expect(alts()).toEqual([[], ['A'], ['B']]);
  });

  it('lets a dragged image land under any step’s text, never above it or among the steps', () => {
    const editor = testEditor(
      moduleDoc(procedure(step('One.', image('A')), step('Two.'))),
    );
    const from = 1 + 1 + editor.state.doc.child(0).child(0).child(0).nodeSize;
    expect(editor.state.doc.nodeAt(from)?.type.name).toBe('image');
    const places = dropTargets(editor.state, from).filter(
      (t) => !t.home && !t.refusal,
    );
    const inSteps = places.filter((t) => t.holder === 'listItem');
    // Under step two's text (its only place: step one's other place is its own).
    expect(inSteps).toHaveLength(1);
    const $at = editor.state.doc.resolve(inSteps[0]?.pos ?? 0);
    expect($at.parent.child(0).textContent).toBe('Two.');
    expect($at.index()).toBe(1);
    // A block never goes among a procedure's steps.
    expect(places.some((t) => t.holder === 'procedure')).toBe(false);
  });

  it('puts a block under a step’s result, which stays the step’s result', () => {
    const editor = testEditor(
      moduleDoc(
        procedure(
          step('Open the cover.', {
            type: 'paragraph',
            content: text('The cover is open.'),
          }),
        ),
      ),
    );
    editor.commands.setTextSelection(insideText(editor, 'Open the cover.'));
    expect(insertImage(CHOICE)(editor.state, editor.view.dispatch)).toBe(true);
    expect(stepBlocks(editor)).toEqual([['paragraph', 'image']]);
    editor.commands.setTextSelection(insideText(editor, 'Open the cover.'));
    expect(insertStepResult(editor.state)).toBe(false);
  });

  it('steps a block outside procedures over a procedure whole with Alt+Up/Down', () => {
    const editor = testEditor(
      moduleDoc(
        p('Before.'),
        procedure(step('One.'), step('Two.')),
        p('After.'),
      ),
    );
    editor.commands.setTextSelection(insideText(editor, 'Before.'));
    expect(moveSelectedBlock(editor.view, false)).toBe(true);
    expect(stepBlocks(editor)).toEqual([[], []]);
    expect(model(editor).blocks.map((b) => b.type)).toEqual([
      'procedure',
      'paragraph',
      'paragraph',
    ]);
    // A procedure moved past another stays a procedure of its own, never a sub-procedure.
    const two = testEditor(
      moduleDoc(procedure(step('A.')), procedure(step('B1.'), step('B2.'))),
    );
    two.commands.setTextSelection(insideText(two, 'A.'));
    // The caret in a step's text: the step moves; select the procedure itself.
    two.commands.setNodeSelection(0);
    expect(moveSelectedBlock(two.view, false)).toBe(true);
    expect(model(two).blocks.map((b) => b.type)).toEqual([
      'procedure',
      'procedure',
    ]);
    expect(
      model(two).blocks.flatMap((b) =>
        b.type === 'procedure' ? b.steps.map((s) => s.blocks.length) : [],
      ),
    ).toEqual([0, 0, 0]);
  });

  it('moves the step of a procedure in a note whole, never a block of it out of the note', () => {
    const editor = testEditor(
      moduleDoc({
        type: 'admonition',
        attrs: { kind: 'note' },
        content: [procedure(step('One.', image('A')), step('Two.'))],
      }),
    );
    const $text = editor.state.doc.resolve(insideText(editor, 'One.'));
    // The image, right after step one's text.
    const imageAt = $text.after();
    expect(editor.state.doc.nodeAt(imageAt)?.type.name).toBe('image');
    editor.commands.setNodeSelection(imageAt);
    moveSelectedBlock(editor.view, false);
    const note = model(editor).blocks[0];
    expect(note?.type).toBe('admonition');
    const inner = note?.type === 'admonition' ? note.blocks[0] : null;
    expect(inner?.type).toBe('procedure');
    // The step moved, its image with it.
    expect(
      inner?.type === 'procedure'
        ? inner.steps.map((s) => s.blocks.map((b) => b.type))
        : null,
    ).toEqual([[], ['image']]);
  });

  it('keeps a step’s block in its procedure with Alt+Up/Down, so in a variant around it too', () => {
    const editor = testEditor(
      moduleDoc(p('Before.'), {
        type: 'variant',
        attrs: { condition: null },
        content: [procedure(step('One.', image('A')), step('Two.'))],
      }),
    );
    const imageAt = editor.state.doc
      .resolve(insideText(editor, 'One.'))
      .after();
    editor.commands.setNodeSelection(imageAt);
    // First step, first block: nowhere further up within its procedure.
    expect(canMoveBlock(editor.state, true)).toBe(false);
    expect(moveSelectedBlock(editor.view, false)).toBe(true);
    const variant = editor.state.doc.child(1);
    expect(variant.type.name).toBe('variant');
    const steps = variant.child(0);
    expect(steps.child(0).childCount).toBe(1);
    expect(steps.child(1).child(1).type.name).toBe('image');
    // Last step, last block: nowhere further down.
    expect(canMoveBlock(editor.state, false)).toBe(false);
  });
});
