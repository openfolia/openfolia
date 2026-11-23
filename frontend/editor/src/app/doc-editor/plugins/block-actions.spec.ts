import type { JSONContent } from '@tiptap/core';
import type { Module } from '@openfolia/content-model/core';
import { toEditor } from '@openfolia/content-editor-model';
import { TextSelection } from '@tiptap/pm/state';

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
  blockActions,
  deleteBlock,
  duplicateBlock,
  flowBlockAt,
  moveBlock,
  unwrapBlock,
} from './block-actions';
import { SAMPLE_MODULE } from '../sample-module';

// jsdom lays nothing out: ProseMirror asks for rectangles when it scrolls the caret into view.
beforeAll(() => {
  const proto = Range.prototype as Partial<Range>;
  proto.getClientRects ??= () => [] as unknown as DOMRectList;
  proto.getBoundingClientRect ??= () => new DOMRect();
});

const variant = (...content: JSONContent[]): JSONContent => ({
  type: 'variant',
  content,
});

const safety = (hazard: string, ...content: JSONContent[]): JSONContent => ({
  type: 'safety',
  content: [
    { type: 'hazard', content: [{ type: 'text', text: hazard }] },
    ...content,
  ],
});

/** The start of the root block at `index`. */
function at(editor: ReturnType<typeof testEditor>, index: number): number {
  let pos = 0;
  for (let i = 0; i < index; i += 1) pos += editor.state.doc.child(i).nodeSize;
  return pos;
}

describe('the blocks the menu acts on', () => {
  it('are the children of a flow or a container, never a title or a hazard', () => {
    const editor = testEditor(
      doc(variant(p('in')), safety('Hot', p('m')), sec('S', p('a'))),
    );
    expect(flowBlockAt(editor.state, 0)?.node.type.name).toBe('variant');
    // Inside the variant: its paragraph is a block of the variant's own flow.
    expect(flowBlockAt(editor.state, 1)?.node.textContent).toBe('in');
    const notice = at(editor, 1);
    expect(flowBlockAt(editor.state, notice)?.node.type.name).toBe('safety');
    expect(flowBlockAt(editor.state, notice + 1)).toBeNull();
    expect(
      flowBlockAt(editor.state, insideText(editor, 'm') - 1)?.node.textContent,
    ).toBe('m');
    const section = at(editor, 2);
    expect(flowBlockAt(editor.state, section)?.node.type.name).toBe('section');
    // The section's title.
    expect(flowBlockAt(editor.state, section + 1)).toBeNull();
    expect(flowBlockAt(editor.state, -1)).toBeNull();
  });

  it('offers Remove frame for a variant block only, among the containers', () => {
    const editor = testEditor(
      doc(
        variant(p('v')),
        safety('Hot', p('s')),
        list(false, 'item'),
        ref(),
        p('text'),
        sec('S', p('a')),
      ),
    );
    const unwrap = [0, 1, 2, 3, 4, 5].map(
      (index) => blockActions(editor.state, at(editor, index)).canUnwrap,
    );
    expect(unwrap).toEqual([true, false, false, false, false, false]);
  });

  it('knows which way a block can move', () => {
    const editor = testEditor(doc(p('a'), p('b'), sec('S')));
    expect(blockActions(editor.state, at(editor, 0))).toMatchObject({
      canDelete: true,
      canDuplicate: true,
      canMoveUp: false,
      canMoveDown: true,
    });
    // "b" is the last block before the sections: down, it goes into the first one's text.
    expect(blockActions(editor.state, at(editor, 1))).toMatchObject({
      canMoveUp: true,
      canMoveDown: true,
    });
    // The only section: there is nowhere to go.
    expect(blockActions(editor.state, at(editor, 2))).toMatchObject({
      canMoveUp: false,
      canMoveDown: false,
    });
  });
});

describe('the block actions', () => {
  it('move a variant block from its grip, with the caret elsewhere, not the block inside it', () => {
    const editor = testEditor(doc(p('a'), variant(p('x'), p('y')), p('b')));
    editor.view.dispatch(
      editor.state.tr.setSelection(
        TextSelection.create(editor.state.doc, insideText(editor, 'b')),
      ),
    );
    const frame = at(editor, 1);
    expect(blockActions(editor.state, frame)).toMatchObject({
      canMoveUp: true,
      canMoveDown: true,
    });
    expect(moveBlock(editor.view, frame, true)).toBe(true);
    expect(blocks(editor)).toEqual(['variant:xy', 'p:a', 'p:b']);
  });

  it('move a block inside a container among its blocks and out, never its container', () => {
    const editor = testEditor(doc(p('a'), variant(p('x'), p('y')), p('b')));
    const x = insideText(editor, 'x') - 1;
    expect(blockActions(editor.state, x)).toMatchObject({
      canMoveUp: true,
      canMoveDown: true,
    });
    expect(moveBlock(editor.view, x, false)).toBe(true);
    expect(blocks(editor)).toEqual(['p:a', 'variant:yx', 'p:b']);
    expect(moveBlock(editor.view, insideText(editor, 'y') - 1, true)).toBe(
      true,
    );
    expect(blocks(editor)).toEqual(['p:a', 'p:y', 'variant:x', 'p:b']);
    // The variant's last block stays, and its menu doesn't move the variant.
    const last = insideText(editor, 'x') - 1;
    expect(blockActions(editor.state, last)).toMatchObject({
      canMoveUp: false,
      canMoveDown: false,
    });
  });

  it('moves a section from its grip even with the caret in its body', () => {
    const editor = testEditor(doc(sec('A', p('a')), sec('B', p('b'))));
    editor.view.dispatch(
      editor.state.tr.setSelection(
        TextSelection.create(editor.state.doc, insideText(editor, 'b')),
      ),
    );
    const sectionB = at(editor, 1);
    expect(blockActions(editor.state, sectionB)).toMatchObject({
      canMoveUp: true,
      canMoveDown: false,
    });
    expect(moveBlock(editor.view, sectionB, true)).toBe(true);
    expect(blocks(editor)).toEqual(['s:B[p:b]', 's:A[p:a]']);
  });

  it('deletes a block of any type in one step that one undo takes back', () => {
    for (const content of [
      doc(p('a'), p('gone'), p('b')),
      doc(p('a'), ref(), p('b')),
      doc(p('a'), variant(p('gone')), p('b')),
      doc(p('a'), safety('Hot', p('gone')), p('b')),
      doc(p('a'), list(false, 'gone'), p('b')),
      // Sections come after the blocks.
      doc(p('a'), sec('Gone', p('gone')), sec('B')),
    ]) {
      const editor = testEditor(content);
      const before = editor.state.doc;
      expect(deleteBlock(editor.view, at(editor, 1))).toBe(true);
      expect(editor.state.doc.childCount).toBe(before.childCount - 1);
      expect(editor.state.doc.textContent).not.toContain('gone');
      editor.commands.undo();
      expect(editor.state.doc.eq(before)).toBe(true);
    }
  });

  it('closes up the blank gaps a deleted block leaves touching', () => {
    const editor = testEditor(doc(p('a'), p(), ref(), p(), p('b')));
    deleteBlock(editor.view, at(editor, 2));
    expect(blocks(editor)).toEqual(['p:a', 'p:', 'p:b']);
  });

  it('does not merge a delete into the typing just before it', () => {
    const editor = testEditor(doc(p('a'), p('b')));
    editor.commands.setTextSelection(insideText(editor, 'a') + 1);
    editor.commands.insertContent('x');
    deleteBlock(editor.view, at(editor, 1));
    editor.commands.undo();
    expect(blocks(editor)).toEqual(['p:ax', 'p:b']);
  });

  it('duplicates a block right after it, the caret in the copy', () => {
    const editor = testEditor(doc(p('a'), variant(p('v')), p('b')));
    expect(duplicateBlock(editor.view, at(editor, 1))).toBe(true);
    expect(blocks(editor)).toEqual(['p:a', 'variant:v', 'variant:v', 'p:b']);
    const { $from } = editor.state.selection;
    expect($from.node(1)).toBe(editor.state.doc.child(2));
    editor.commands.undo();
    expect(blocks(editor)).toEqual(['p:a', 'variant:v', 'p:b']);
  });

  it('duplicates a block without text of its own as a selected block', () => {
    const editor = testEditor(doc(ref('one'), p('b')));
    duplicateBlock(editor.view, 0);
    expect(blocks(editor)).toEqual(['ref', 'ref', 'p:b']);
  });

  it('takes the frame away and keeps its content', () => {
    const editor = testEditor(doc(p('a'), variant(p('x'), p('y')), p('b')));
    expect(unwrapBlock(editor.view, at(editor, 1))).toBe(true);
    expect(blocks(editor)).toEqual(['p:a', 'p:x', 'p:y', 'p:b']);
    expect(editor.state.selection.$from.parent.textContent).toBe('x');
    editor.commands.undo();
    expect(blocks(editor)).toEqual(['p:a', 'variant:xy', 'p:b']);
  });

  it('refuses to unwrap what is not a frame around blocks', () => {
    const editor = testEditor(doc(safety('Hot', p('s'))));
    expect(unwrapBlock(editor.view, 0)).toBe(false);
    expect(editor.state.doc.child(0).type.name).toBe('safety');
  });

  it('moves a block as Alt+Up and Alt+Down do, from wherever the caret was', () => {
    const editor = testEditor(doc(p('a'), p('b'), p('c')));
    editor.view.dispatch(
      editor.state.tr.setSelection(
        TextSelection.create(editor.state.doc, insideText(editor, 'a')),
      ),
    );
    expect(moveBlock(editor.view, at(editor, 2), true)).toBe(true);
    expect(blocks(editor)).toEqual(['p:a', 'p:c', 'p:b']);
    // The caret went with the block it moved.
    expect(editor.state.selection.$from.parent.textContent).toBe('c');
    expect(moveBlock(editor.view, at(editor, 0), true)).toBe(false);
    editor.commands.undo();
    expect(blocks(editor)).toEqual(['p:a', 'p:b', 'p:c']);
  });
});

describe('the block actions on the procedure, admonition, code and passthrough blocks', () => {
  const t = (text: string) => ({ type: 'text' as const, text });
  const editorOf = (blocks: Module['blocks']) =>
    testEditor(toEditor({ ...SAMPLE_MODULE, blocks }));
  const names = (editor: ReturnType<typeof testEditor>) =>
    editor.state.doc.content.content
      .map((node) => node.type.name)
      .filter((name) => name !== 'paragraph');
  /** The start of the first node of this type, and the node. */
  function find(editor: ReturnType<typeof testEditor>, type: string) {
    let found = -1;
    editor.state.doc.descendants((node, pos) => {
      if (found < 0 && node.type.name === type) found = pos;
      return found < 0;
    });
    return found;
  }
  const stepTexts = (editor: ReturnType<typeof testEditor>) => {
    const out: string[] = [];
    editor.state.doc.descendants((node) => {
      if (node.type.name === 'listItem')
        out.push(node.firstChild?.textContent ?? '');
      return node.type.name !== 'listItem';
    });
    return out;
  };
  const procedure: Module['blocks'][number] = {
    type: 'procedure',
    id: 'steps',
    title: [t('Install')],
    steps: [
      { id: 'one', content: [t('one')], blocks: [] },
      { id: 'two', content: [t('two')], blocks: [] },
    ],
  };

  it('acts on a procedure’s step: move, duplicate, delete, all undoable', () => {
    const editor = editorOf([procedure]);
    const first = find(editor, 'listItem');
    expect(flowBlockAt(editor.state, first)?.node.type.name).toBe('listItem');
    expect(blockActions(editor.state, first)).toMatchObject({
      canDelete: true,
      canDuplicate: true,
      canMoveUp: false,
      canMoveDown: true,
      canUnwrap: false,
    });
    expect(moveBlock(editor.view, first, false)).toBe(true);
    expect(stepTexts(editor)).toEqual(['two', 'one']);
    expect(duplicateBlock(editor.view, find(editor, 'listItem'))).toBe(true);
    expect(stepTexts(editor)).toEqual(['two', 'two', 'one']);
    expect(deleteBlock(editor.view, find(editor, 'listItem'))).toBe(true);
    expect(stepTexts(editor)).toEqual(['two', 'one']);
    editor.commands.undo();
    editor.commands.undo();
    editor.commands.undo();
    expect(stepTexts(editor)).toEqual(['one', 'two']);
  });

  it('keeps the only step of a titled procedure: the title can’t stand alone', () => {
    const editor = editorOf([
      { ...procedure, steps: [{ id: 'one', content: [t('one')], blocks: [] }] },
    ] as Module['blocks']);
    const only = find(editor, 'listItem');
    expect(blockActions(editor.state, only).canDelete).toBe(false);
    expect(deleteBlock(editor.view, only)).toBe(false);
    // The procedure itself goes as a whole.
    expect(deleteBlock(editor.view, find(editor, 'procedure'))).toBe(true);
    expect(names(editor)).toEqual([]);
  });

  it('takes an admonition’s frame away and keeps its text; code and passthrough are blocks like any', () => {
    const editor = editorOf([
      {
        type: 'admonition',
        id: 'tip',
        kind: 'tip',
        blocks: [{ type: 'paragraph', id: 'tip-text', content: [t('Save.')] }],
      },
      { type: 'literal', id: 'config', language: 'yaml', text: 'a: 1' },
      { type: 'passthrough', id: 'raw', format: 'html', raw: '<b>kept</b>' },
    ] as Module['blocks']);
    for (const type of ['admonition', 'literal', 'passthrough'])
      expect(blockActions(editor.state, find(editor, type))).toMatchObject({
        canDelete: true,
        canDuplicate: true,
        canUnwrap: type === 'admonition',
      });
    expect(duplicateBlock(editor.view, find(editor, 'passthrough'))).toBe(true);
    expect(duplicateBlock(editor.view, find(editor, 'literal'))).toBe(true);
    expect(names(editor)).toEqual([
      'admonition',
      'literal',
      'literal',
      'passthrough',
      'passthrough',
    ]);
    expect(unwrapBlock(editor.view, find(editor, 'admonition'))).toBe(true);
    expect(names(editor)[0]).toBe('literal');
    expect(editor.state.doc.textContent).toContain('Save.');
    expect(moveBlock(editor.view, find(editor, 'passthrough'), true)).toBe(
      true,
    );
  });
});
