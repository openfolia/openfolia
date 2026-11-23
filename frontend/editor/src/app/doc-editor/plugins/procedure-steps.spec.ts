import type { JSONContent } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';
import {
  fromEditor,
  normalizeEditorDoc,
  toEditor,
} from '@openfolia/content-editor-model';

import { SAMPLE_MODULE } from '../sample-module';

import {
  insertAdmonition,
  insertLiteral,
  insertProcedure,
} from '../blocks/doc-blocks';
import { CaretGaps, withoutCaretGaps } from './caret-gaps';
import { HeadingLevels } from './heading-levels';
import { ModelKeys, exitEmptyItem, removeEmptyTitle } from './model-keys';
import { ModelRepair } from './model-repair';
import { canMoveBlock, moveSelectedBlock } from './block-move';
import { dropTargets } from './drop-rules';
import {
  CodeKeys,
  indentCode,
  insertStepResult,
  outdentCode,
} from './procedure-steps';
import { TableKeys } from './table-editing';
import { blocks, doc, insideText, p, testEditor } from '../testing/test-editor';

const text = (value: string): JSONContent[] =>
  value ? [{ type: 'text', text: value }] : [];

/** A document with a module's attributes, so it converts. */
const moduleDoc = (...content: JSONContent[]): JSONContent => ({
  ...toEditor({ ...SAMPLE_MODULE, blocks: [] }),
  content,
});

const step = (value: string, ...rest: JSONContent[]): JSONContent => ({
  type: 'listItem',
  content: [{ type: 'itemText', content: text(value) }, ...rest],
});

const procedure = (
  title: string | null,
  ...steps: JSONContent[]
): JSONContent => ({
  type: 'procedure',
  content: [
    ...(title === null ? [] : [{ type: 'title', content: text(title) }]),
    ...steps,
  ],
});

/** The first procedure among the document's blocks (caret gaps aside). */
const firstProcedure = (json: JSONContent): JSONContent | undefined =>
  json.content?.find((c) => c.type === 'procedure');

/** The text of each step of the first procedure (its title aside). */
function steps(json: JSONContent): string[] {
  const node = firstProcedure(json);
  return (node?.content ?? [])
    .filter((c) => c.type === 'listItem')
    .map((item) =>
      (item.content?.[0]?.content ?? []).map((t) => t.text ?? '').join(''),
    );
}

/**
 * A key pressed as a person does: the view handles it and dispatches (TipTap's `keyboardShortcut`
 * command replays the steps in its own transaction, which loses the selection a command sets).
 */
function press(
  editor: ReturnType<typeof testEditor>,
  key: string,
  shiftKey = false,
): boolean {
  const event = new KeyboardEvent('keydown', {
    key,
    shiftKey,
    bubbles: true,
    cancelable: true,
  });
  editor.view.dom.dispatchEvent(event);
  return event.defaultPrevented;
}

const json = (editor: ReturnType<typeof testEditor>): JSONContent =>
  editor.getJSON() as JSONContent;

const model = (editor: ReturnType<typeof testEditor>) =>
  fromEditor(normalizeEditorDoc(withoutCaretGaps(json(editor))));

describe('inserting a note, a procedure and a code block', () => {
  it('put each in place of a blank line, the caret in its first text, and convert once filled', () => {
    const editor = testEditor(moduleDoc(p('a', 'a'), p()), [ModelRepair]);
    const at = () =>
      editor.commands.setTextSelection(editor.state.doc.content.size - 1);

    at();
    insertAdmonition(editor.state, editor.view.dispatch);
    expect(editor.state.selection.$from.node(-1).type.name).toBe('admonition');
    editor.commands.insertContent('Mind the gap.');

    editor.commands.insertContentAt(editor.state.doc.content.size, p());
    at();
    insertProcedure(editor.state, editor.view.dispatch);
    expect(editor.state.selection.$from.parent.type.name).toBe('itemText');
    editor.commands.insertContent('Open the lid.');

    editor.commands.insertContentAt(editor.state.doc.content.size, p());
    at();
    insertLiteral(editor.state, editor.view.dispatch);
    expect(editor.state.selection.$from.parent.type.name).toBe('literal');
    editor.commands.insertContent('a: 1');

    const blocksOut = model(editor).blocks;
    expect(blocksOut.map((b) => b.type)).toEqual([
      'paragraph',
      'admonition',
      'procedure',
      'literal',
    ]);
    expect(blocksOut[1]).toMatchObject({ kind: 'note' });
    expect(blocksOut[2]).toMatchObject({
      steps: [
        { content: [{ type: 'text', text: 'Open the lid.' }], blocks: [] },
      ],
    });
    expect(blocksOut[3]).toMatchObject({ text: 'a: 1' });
    expect(blocksOut[3]).not.toHaveProperty('language');
  });
});

describe('a procedure', () => {
  const editorOf = (content: JSONContent) =>
    testEditor(content, [ModelKeys, CaretGaps, ModelRepair, HeadingLevels]);

  it('adds a step with Enter and leaves the procedure from an empty last step', () => {
    const editor = editorOf(doc(procedure(null, step('One'))));
    editor.commands.setTextSelection(insideText(editor, 'One') + 3);
    editor.commands.keyboardShortcut('Enter');
    editor.commands.insertContent('Two');
    expect(steps(json(editor))).toEqual(['One', 'Two']);
    editor.commands.keyboardShortcut('Enter');
    editor.commands.keyboardShortcut('Enter');
    expect(steps(json(editor))).toEqual(['One', 'Two']);
    expect(editor.state.selection.$from.parent.type.name).toBe('paragraph');
    expect(editor.state.selection.$from.depth).toBe(1);
  });

  it('keeps the only step of a titled procedure: the title cannot stand alone', () => {
    const editor = editorOf(doc(procedure('Title', step(''))));
    editor.commands.setTextSelection(insideText(editor, 'Title') + 8);
    expect(editor.state.selection.$from.parent.type.name).toBe('itemText');
    expect(exitEmptyItem(editor.state, editor.view.dispatch)).toBe(true);
    expect(firstProcedure(json(editor))?.content?.length).toBe(2);
  });

  it('makes a step a sub-step with Tab (a procedure in the step before), and lifts it back', () => {
    const editor = editorOf(
      moduleDoc(procedure(null, step('One'), step('Two'))),
    );
    editor.commands.setTextSelection(insideText(editor, 'Two'));
    editor.commands.keyboardShortcut('Tab');
    const nested = firstProcedure(json(editor))?.content?.[0]?.content?.[1];
    expect(nested?.type).toBe('procedure');
    expect(steps({ content: [nested!] })).toEqual(['Two']);
    expect(model(editor).blocks[0]).toMatchObject({
      type: 'procedure',
      steps: [{ blocks: [{ type: 'procedure', steps: [{}] }] }],
    });
    editor.commands.keyboardShortcut('Shift-Tab');
    expect(steps(json(editor))).toEqual(['One', 'Two']);
  });

  it('makes sub-steps in a titled procedure too, joining the sub-procedure the step before ends in', () => {
    const editor = editorOf(
      moduleDoc(procedure('Title', step('One'), step('Two'), step('Three'))),
    );
    editor.commands.setTextSelection(insideText(editor, 'Two') + 1);
    press(editor, 'Tab');
    expect(editor.state.selection.$from.parent.textContent).toBe('Two');
    expect(editor.state.selection.$from.parentOffset).toBe(1);
    editor.commands.setTextSelection(insideText(editor, 'Three'));
    press(editor, 'Tab');
    expect(model(editor).blocks[0]).toMatchObject({
      type: 'procedure',
      title: [{ text: 'Title' }],
      steps: [
        {
          content: [{ text: 'One' }],
          blocks: [
            {
              type: 'procedure',
              steps: [
                { content: [{ text: 'Two' }] },
                { content: [{ text: 'Three' }] },
              ],
            },
          ],
        },
      ],
    });
    // The first step has nothing before it: Tab is kept, nothing changes.
    editor.commands.setTextSelection(insideText(editor, 'One'));
    const before = editor.state.doc;
    expect(press(editor, 'Tab')).toBe(true);
    expect(editor.state.doc.eq(before)).toBe(true);
  });

  it('lifts a sub-step out with Shift+Tab, the steps after it coming along as its sub-steps', () => {
    const editor = editorOf(
      moduleDoc(
        procedure(
          'Title',
          step('One', procedure(null, step('A'), step('B'), step('C'))),
        ),
      ),
    );
    editor.commands.setTextSelection(insideText(editor, 'B') + 1);
    press(editor, 'Tab', true);
    expect(editor.state.selection.$from.parent.textContent).toBe('B');
    expect(model(editor).blocks[0]).toMatchObject({
      steps: [
        {
          content: [{ text: 'One' }],
          blocks: [
            { type: 'procedure', steps: [{ content: [{ text: 'A' }] }] },
          ],
        },
        {
          content: [{ text: 'B' }],
          blocks: [
            { type: 'procedure', steps: [{ content: [{ text: 'C' }] }] },
          ],
        },
      ],
    });
    editor.commands.undo();
    editor.commands.setTextSelection(insideText(editor, 'A'));
    press(editor, 'Tab', true);
    // The sub-procedure is gone: every step of it came out.
    expect(steps(json(editor))).toEqual(['One', 'A']);
  });

  it('moves a step among its steps with Alt+Up/Down, after the title, and not out', () => {
    const editor = editorOf(
      doc(procedure('T', step('One'), step('Two')), p('after', 'after')),
    );
    editor.commands.setTextSelection(insideText(editor, 'Two') + 1);
    expect(canMoveBlock(editor.state, false)).toBe(false);
    expect(moveSelectedBlock(editor.view, true)).toBe(true);
    expect(steps(json(editor))).toEqual(['Two', 'One']);
    // The caret moved with it, and the title stays first.
    expect(editor.state.selection.$from.parent.textContent).toBe('Two');
    expect(firstProcedure(json(editor))?.content?.[0]?.type).toBe('title');
    expect(canMoveBlock(editor.state, true)).toBe(false);
    editor.commands.undo();
    expect(steps(json(editor))).toEqual(['One', 'Two']);
  });

  it("lets a dragged step land only among its own procedure's steps", () => {
    const editor = editorOf(
      doc(p('before', 'b'), procedure('T', step('One'), step('Two'))),
    );
    const $two = editor.state.doc.resolve(insideText(editor, 'Two'));
    const from = $two.before(-1);
    const places = dropTargets(editor.state, from).filter((t) => !t.home);
    expect(places.length).toBeGreaterThan(0);
    expect(places.every((t) => t.holder === 'procedure')).toBe(true);
    const procedureNode = $two.node(-2);
    const start = $two.start(-2);
    // Never before the title.
    expect(places.every((t) => t.pos > start)).toBe(true);
    expect(
      places.every((t) => t.pos <= start + procedureNode.content.size),
    ).toBe(true);
    expect(places.some((t) => !t.refusal)).toBe(true);
  });

  it('adds a result to a step with "/" Result, once', () => {
    const editor = editorOf(moduleDoc(procedure(null, step('One'))));
    editor.commands.setTextSelection(insideText(editor, 'One') + 3);
    expect(insertStepResult(editor.state, editor.view.dispatch)).toBe(true);
    editor.commands.insertContent('The lid is open.');
    editor.commands.setTextSelection(insideText(editor, 'One') + 1);
    expect(insertStepResult(editor.state)).toBe(false);
    expect(model(editor).blocks[0]).toMatchObject({
      steps: [
        {
          blocks: [
            {
              type: 'paragraph',
              content: [{ type: 'text', text: 'The lid is open.' }],
            },
          ],
        },
      ],
    });
  });

  it('offers a result only in a procedure step', () => {
    const editor = editorOf(
      doc({
        type: 'list',
        attrs: { ordered: true },
        content: [step('Item')],
      }),
    );
    editor.commands.setTextSelection(insideText(editor, 'Item'));
    expect(insertStepResult(editor.state)).toBe(false);
  });

  it('removes an empty title with Backspace, and never merges a title with text', () => {
    const editor = editorOf(doc(p('before', 'b'), procedure('', step('One'))));
    const titlePos = editor.state.doc.child(0).nodeSize + 2;
    editor.view.dispatch(
      editor.state.tr.setSelection(
        TextSelection.create(editor.state.doc, titlePos),
      ),
    );
    expect(editor.state.selection.$from.parent.type.name).toBe('title');
    editor.commands.keyboardShortcut('Backspace');
    expect(json(editor).content?.[1]?.content?.[0]?.type).toBe('listItem');
    expect(blocks(editor)[0]).toBe('p:before');

    const titled = editorOf(
      doc(p('before', 'b'), procedure('Title', step('One'))),
    );
    titled.commands.setTextSelection(insideText(titled, 'Title'));
    expect(removeEmptyTitle(titled.state, titled.view.dispatch)).toBe(true);
    expect(blocks(titled)).toEqual(['p:before', 'procedure:TitleOne']);
  });
});

describe('a code block', () => {
  const editorOf = (content: JSONContent) =>
    testEditor(content, [CodeKeys, TableKeys, ModelKeys]);
  const code = (value: string): JSONContent => ({
    type: 'literal',
    attrs: { language: 'yaml' },
    ...(value ? { content: text(value) } : {}),
  });

  it('takes Tab as spaces and Shift+Tab as fewer, on the caret line', () => {
    const editor = editorOf(doc(code('a:\nb: 1')));
    // The caret at the start of the second line.
    editor.commands.setTextSelection(1 + 3);
    editor.commands.keyboardShortcut('Tab');
    expect(editor.state.doc.child(0).textContent).toBe('a:\n  b: 1');
    editor.commands.keyboardShortcut('Shift-Tab');
    expect(editor.state.doc.child(0).textContent).toBe('a:\nb: 1');
    // Nothing to take back: still handled, the caret stays in the block.
    expect(outdentCode(editor.state, editor.view.dispatch)).toBe(true);
    expect(editor.state.doc.child(0).textContent).toBe('a:\nb: 1');
  });

  it('keeps Enter as a line break and refuses formatting', () => {
    const editor = editorOf(doc(code('x')));
    editor.commands.setTextSelection(2);
    editor.commands.keyboardShortcut('Enter');
    editor.commands.insertContent('y');
    expect(editor.state.doc.child(0).textContent).toBe('x\ny');
    editor.commands.selectAll();
    editor.commands.setTextSelection({ from: 1, to: 4 });
    expect(editor.commands.toggleMark('strong')).toBe(false);
  });

  it('leaves Tab to the others outside a code block', () => {
    const editor = editorOf(doc(p('text')));
    editor.commands.setTextSelection(2);
    expect(indentCode(editor.state)).toBe(false);
  });
});
