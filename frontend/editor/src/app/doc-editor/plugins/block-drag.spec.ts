import { Editor, type JSONContent } from '@tiptap/core';

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
  createEditorExtensions,
  toEditor,
} from '@openfolia/content-editor-model';

import { layOutRows } from '../testing/lay-out';
import {
  BlockDrag,
  blockDragKey,
  LIFT_MAX,
  nextDragState,
  slidingNodes,
} from './block-drag';
import type { DragState } from './drag-state';
import { CaretGaps } from './caret-gaps';
import { HeadingLevels } from './heading-levels';
import { ModelRepair } from './model-repair';
import { withTables } from './table-editing';

const idle: DragState = { hoverPos: null, drag: null, flip: null };

/** Where the laid-out document starts: clear of the window's edges, where the editor scrolls. */
const TOP = 200;

/** The drag with the plugins that append to a move (caret gaps, repair, the undo step's end). */
const dragEditor = (content: JSONContent) =>
  testEditor(content, [
    HeadingLevels,
    CaretGaps,
    ModelRepair,
    BlockDrag.configure({
      translate: (key, params) =>
        params && Object.keys(params).length
          ? `${key} ${JSON.stringify(params)}`
          : key,
    }),
  ]);

const safety = (hazard: string, ...content: JSONContent[]): JSONContent => ({
  type: 'safety',
  attrs: { severity: 'warning' },
  content: [
    { type: 'hazard', content: [{ type: 'text', text: hazard }] },
    ...content,
  ],
});

/** Lays the document out from `TOP`: rows of 20 px with 10 px after each (`layOutRows`). */
const layOut = (editor: Editor, rows: Record<string, number> = {}) =>
  layOutRows(editor.view, TOP, rows);

function pointer(
  type: string,
  target: EventTarget,
  clientY: number,
  clientX = 0,
) {
  target.dispatchEvent(
    new MouseEvent(type, { bubbles: true, clientX, clientY, button: 0 }),
  );
}

/** The start of the block whose text (or heading) is `text`: a section for its heading. */
function blockOf(editor: Editor, text: string): number {
  const $pos = editor.state.doc.resolve(insideText(editor, text));
  return $pos.parent.type.name === 'title' ? $pos.before(-1) : $pos.before();
}

/** Lifts the block with this text (or at this position) by its grip, `into` px below its top. */
function lift(editor: Editor, block: string | number, into = 10): number {
  const pos = typeof block === 'number' ? block : blockOf(editor, block);
  editor.view.dispatch(
    editor.state.tr.setMeta(blockDragKey, { hoverPos: pos }),
  );
  layOut(editor);
  const top = (editor.view.nodeDOM(pos) as Element).getBoundingClientRect().top;
  const grip = editor.view.dom.querySelector('[data-testid="block-grip"]')!;
  pointer('pointerdown', grip, top + into);
  // A press alone is a click (the block's menu): the drag starts once the pointer moves.
  pointer('pointermove', window, top + into, 5);
  return top + into;
}

const lifted = (editor: Editor) =>
  editor.view.dom.parentElement?.querySelector<HTMLElement>(
    '[data-testid="block-lifted"]',
  ) ?? null;
const hint = (editor: Editor) =>
  lifted(editor)?.querySelector<HTMLElement>(
    '[data-testid="block-drop-hint"]',
  ) ?? null;
const slot = (editor: Editor) =>
  editor.view.dom.querySelector<HTMLElement>('[data-testid="block-slot"]');
const drag = (editor: Editor) => blockDragKey.getState(editor.state)?.drag;

describe('the block drag state', () => {
  const active = {
    source: 0,
    slot: 5,
    height: 20,
    label: null,
    offsets: [],
    sliding: false,
  };

  it('takes the fields a meta sets', () => {
    expect(nextDragState(idle, { hoverPos: 4 }, null)).toEqual({
      ...idle,
      hoverPos: 4,
    });
  });

  it('maps the hover through a change and drops a drag measured on the old document', () => {
    const state: DragState = { hoverPos: 2, drag: active, flip: null };
    expect(nextDragState(state, undefined, (pos) => pos + 3)).toEqual({
      hoverPos: 5,
      drag: null,
      flip: null,
    });
  });

  it('stays as it is on a transaction that changes nothing', () => {
    expect(nextDragState(idle, undefined, null)).toBe(idle);
  });
});

describe('the grip', () => {
  it('shows beside the block the pointer is over, hidden from assistive technology', () => {
    const editor = testEditor(doc(p('one'), p('two')), [BlockDrag]);
    editor.view.dispatch(
      editor.state.tr.setMeta(blockDragKey, { hoverPos: 5 }),
    );
    const grip = editor.view.dom.querySelector('.doc-editor-grip');
    expect(grip).not.toBeNull();
    expect(grip?.getAttribute('aria-hidden')).toBe('true');
    expect(grip?.querySelectorAll('circle').length).toBe(6);
  });

  it("shows beside the caret's block while the editor has focus and no block is hovered", () => {
    const editor = testEditor(doc(p('one'), p('two')), [BlockDrag]);
    editor.commands.setTextSelection(7);
    editor.view.dispatch(
      editor.state.tr.setMeta(blockDragKey, { focused: true }),
    );
    const anchor = editor.view.dom.querySelector('.doc-editor-grip-anchor');
    expect(anchor?.nextElementSibling?.textContent).toBe('two');
    editor.view.dispatch(
      editor.state.tr.setMeta(blockDragKey, { focused: false }),
    );
    expect(editor.view.dom.querySelector('.doc-editor-grip')).toBeNull();
  });

  it("stands before the section when the caret is in its heading, and before a section's block", () => {
    const editor = testEditor(doc(p('intro'), sec('Heading', p('body'))), [
      BlockDrag,
    ]);
    editor.view.dispatch(
      editor.state.tr.setMeta(blockDragKey, { focused: true }),
    );
    editor.commands.setTextSelection(9);
    let anchor = editor.view.dom.querySelector('.doc-editor-grip-anchor');
    expect(anchor?.nextElementSibling?.tagName).toBe('SECTION');
    editor.commands.setTextSelection(editor.state.doc.content.size - 3);
    anchor = editor.view.dom.querySelector('.doc-editor-grip-anchor');
    expect(anchor?.parentElement?.tagName).toBe('SECTION');
    expect(anchor?.nextElementSibling?.textContent).toBe('body');
  });

  it('goes when the pointer leaves the editor', () => {
    const editor = testEditor(doc(p('one')), [BlockDrag]);
    editor.view.dispatch(
      editor.state.tr.setMeta(blockDragKey, { hoverPos: 0 }),
    );
    editor.view.dom.dispatchEvent(new MouseEvent('mouseleave'));
    expect(blockDragKey.getState(editor.state)?.hoverPos).toBeNull();
    expect(editor.view.dom.querySelector('.doc-editor-grip')).toBeNull();
  });
});

describe('dragging a block', () => {
  it('folds the block away and stands a dashed slot of its height in its place', () => {
    const editor = dragEditor(doc(p('a'), p('b')));
    lift(editor, 'a');
    const [a] = [...editor.view.dom.querySelectorAll('p')];
    expect(a?.className).toContain('doc-editor-drag-source');
    expect(slot(editor)?.style.height).toBe('20px');
    expect(slot(editor)?.className).toContain('outline-dashed');
    expect(slot(editor)?.nextElementSibling).toBe(a);
    expect(document.documentElement.classList).toContain('doc-editor-dragging');
    pointer('pointerup', window, 0);
    expect(document.documentElement.classList).not.toContain(
      'doc-editor-dragging',
    );
  });

  it('drops the block where its copy is, and undoes in one step', () => {
    const editor = dragEditor(doc(p('a'), p('b'), p('c')));
    const y = lift(editor, 'a');
    expect(lifted(editor)?.textContent).toBe('a');
    // Down 60 px, onto c: the place before c (on screen where c stands) is nearest.
    pointer('pointermove', window, y + 60);
    expect(drag(editor)?.slot).toBe(blockOf(editor, 'c'));
    // With the slot there, the end stands one room (30 px) below c.
    pointer('pointermove', window, y + 90);
    pointer('pointerup', window, y + 90);
    expect(blocks(editor)).toEqual(['p:b', 'p:c', 'p:a']);
    expect(drag(editor)).toBeNull();
    expect(lifted(editor)).toBeNull();
    editor.commands.undo();
    expect(blocks(editor)).toEqual(['p:a', 'p:b', 'p:c']);
  });

  it('drags a paragraph from one section into another, and back with one undo', () => {
    const editor = dragEditor(
      doc(sec('S1', p('a'), p('b')), sec('S2', p('c'))),
    );
    const y = lift(editor, 'a');
    // a's top 230; the place after c stands at c's bottom and the gap: 350.
    pointer('pointermove', window, y + 120);
    pointer('pointerup', window, y + 120);
    expect(blocks(editor)).toEqual(['s:S1[p:b]', 's:S2[p:c, p:a]']);
    editor.commands.undo();
    expect(blocks(editor)).toEqual(['s:S1[p:a, p:b]', 's:S2[p:c]']);
  });

  it('drags a safety notice into the next section, and back with one undo', () => {
    const editor = dragEditor(
      doc(sec('S1', p('a'), safety('Hot', p('m')), p('z')), sec('S2', p('c'))),
    );
    // The notice is the block around its hazard.
    const y = lift(editor, blockOf(editor, 'Hot') - 1);
    // The notice (from 260) into S2, where c stands (390).
    pointer('pointermove', window, y + 130);
    pointer('pointerup', window, y + 130);
    expect(blocks(editor)).toEqual([
      's:S1[p:a, p:z]',
      's:S2[safety:Hotm, p:c]',
    ]);
    editor.commands.undo();
    expect(blocks(editor)).toEqual([
      's:S1[p:a, safety:Hotm, p:z]',
      's:S2[p:c]',
    ]);
  });

  it('drags a heading with its content, its level following where it lands', () => {
    const editor = dragEditor(doc(sec('S1', p('a')), sec('S2', p('b'))));
    const y = lift(editor, 'S2');
    // At the end of S1, pulled one step to the right: a Heading 2 in S1.
    pointer('pointermove', window, y - 10, 30);
    expect(drag(editor)?.label).toBe(
      'editor.docEditor.style.heading {"level":2}',
    );
    expect(slot(editor)?.textContent).toContain('"level":2');
    pointer('pointerup', window, y - 10, 30);
    expect(blocks(editor)).toEqual(['s:S1[p:a, s:S2[p:b]]']);
    editor.commands.undo();
    expect(blocks(editor)).toEqual(['s:S1[p:a]', 's:S2[p:b]']);
  });

  it('takes a heading above the sections before it, as a Heading 1', () => {
    const editor = dragEditor(doc(sec('S1', p('a')), sec('S2', p('b'))));
    const y = lift(editor, 'S2');
    pointer('pointermove', window, y - 60);
    pointer('pointerup', window, y - 60);
    expect(blocks(editor)).toEqual(['s:S2[p:b]', 's:S1[p:a]']);
  });

  it('caps the copy and the slot of a long block, fading the copy out', () => {
    const editor = dragEditor(doc(p('long'), p('b')));
    const pos = blockOf(editor, 'long');
    editor.view.dispatch(
      editor.state.tr.setMeta(blockDragKey, { hoverPos: pos }),
    );
    layOut(editor, { long: 600 });
    pointer(
      'pointerdown',
      editor.view.dom.querySelector('[data-testid="block-grip"]')!,
      TOP + 10,
    );
    pointer('pointermove', window, TOP + 10, 5);
    expect(slot(editor)?.style.height).toBe(`${LIFT_MAX}px`);
    expect(
      lifted(editor)?.querySelector('.doc-editor-lifted-capped'),
    ).not.toBeNull();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  });

  it('moves nothing in a read-only document', () => {
    const editor = dragEditor(doc(p('a'), p('b')));
    editor.setEditable(false);
    lift(editor, 'a');
    expect(drag(editor)).toBeFalsy();
    expect(lifted(editor)).toBeNull();
    editor.view.dom.dispatchEvent(
      new MouseEvent('mousemove', { bubbles: true }),
    );
    expect(blocks(editor)).toEqual(['p:a', 'p:b']);
  });

  it('lifts an exact copy of a table: its rows, its text and its columns', () => {
    const cell = (id: string, text: string) => ({
      id,
      blocks: [
        { type: 'paragraph', id: `${id}-p`, content: [{ type: 'text', text }] },
      ],
    });
    const table = toEditor({
      schemaVersion: 1,
      id: 'tables',
      meta: { title: 'Tables', type: 'concept', lang: 'en', facets: {} },
      blocks: [
        {
          type: 'table',
          id: 't',
          columns: [{ width: 2 }, { width: 1 }],
          header: true,
          rows: [
            { cells: [cell('h1', 'Item'), cell('h2', 'Max')] },
            { cells: [cell('r1', 'Members'), cell('r2', '50')] },
          ],
        },
      ],
    } as never).content![0]!;
    // The editor's own table view, which draws the columns.
    const editor = new Editor({
      element: document.createElement('div'),
      extensions: [
        ...withTables(createEditorExtensions()),
        BlockDrag.configure({ translate: (key) => key }),
      ],
      content: doc(p('a'), table),
    });
    onTestFinished(() => editor.destroy());
    const source = editor.view.nodeDOM(
      blockOf(editor, 'Item') - 3,
    ) as HTMLElement;
    expect(source.dataset['node']).toBe('table');
    lift(editor, blockOf(editor, 'Item') - 3);
    const copy = lifted(editor)!.querySelector<HTMLElement>(
      '[data-node="table"]',
    )!;
    const rows = (el: HTMLElement) =>
      el.querySelectorAll('[data-node="tableRow"]').length;
    expect(rows(copy)).toBe(rows(source));
    expect(rows(copy)).toBe(2);
    expect(copy.textContent).toBe(source.textContent);
    // The columns are the table's own style: the copy keeps them.
    expect(source.getAttribute('style')).toContain('--table-columns');
    expect(copy.getAttribute('style')).toBe(source.getAttribute('style'));
  });

  it('takes the press from the text: no selection and no editor mouse handling', () => {
    const editor = dragEditor(doc(p('a'), p('b')));
    editor.view.dispatch(
      editor.state.tr.setMeta(blockDragKey, { hoverPos: 0 }),
    );
    const grip = editor.view.dom.querySelector('[data-testid="block-grip"]')!;
    const down = new MouseEvent('mousedown', {
      bubbles: true,
      cancelable: true,
    });
    grip.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
  });

  it('puts everything back on Escape', () => {
    const editor = dragEditor(doc(p('a'), p('b')));
    const y = lift(editor, 'a');
    pointer('pointermove', window, y + 40);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    pointer('pointerup', window, y + 40);
    expect(blocks(editor)).toEqual(['p:a', 'p:b']);
    expect(drag(editor)).toBeNull();
    expect(lifted(editor)).toBeNull();
  });

  // An editor destroyed mid-drag (#333) once left the drag's window listeners behind: the next
  // Escape anywhere on the page was taken in the capture phase and never reached its own handler.
  it('lets go of the window when the editor is destroyed mid-drag', () => {
    const editor = dragEditor(doc(p('a'), p('b')));
    const host = document.body.appendChild(editor.view.dom.parentElement!);
    onTestFinished(() => host.remove());
    lift(editor, 'a');
    expect(drag(editor)).toBeTruthy();
    expect(document.documentElement.classList).toContain('doc-editor-dragging');
    const copy = lifted(editor);
    expect(copy?.isConnected).toBe(true);
    editor.destroy();
    expect(document.documentElement.classList).not.toContain(
      'doc-editor-dragging',
    );
    expect(copy?.isConnected).toBe(false);
    const field = document.body.appendChild(document.createElement('input'));
    onTestFinished(() => field.remove());
    const heard = vi.fn();
    field.addEventListener('keydown', heard);
    const escape = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    });
    field.dispatchEvent(escape);
    expect(heard).toHaveBeenCalledOnce();
    expect(escape.defaultPrevented).toBe(false);
  });
});

const variant = (...content: JSONContent[]): JSONContent => ({
  type: 'variant',
  attrs: { when: null },
  content,
});

describe('a block inside a variant block or a safety notice', () => {
  const grip = (editor: Editor) =>
    editor.view.dom.querySelector('.doc-editor-grip-anchor');

  it('has a grip of its own, inside the container; the hazard never has one', () => {
    const editor = testEditor(
      doc(p('a'), variant(p('v')), safety('Hot', p('m'))),
      [BlockDrag],
    );
    editor.view.dispatch(
      editor.state.tr.setMeta(blockDragKey, { focused: true }),
    );
    editor.commands.setTextSelection(insideText(editor, 'v'));
    expect(grip(editor)?.parentElement?.dataset['node']).toBe('variant');
    expect(grip(editor)?.nextElementSibling?.textContent).toBe('v');
    editor.commands.setTextSelection(insideText(editor, 'm'));
    expect(grip(editor)?.nextElementSibling?.textContent).toBe('m');
    // In the hazard: the notice's own grip, before it.
    editor.commands.setTextSelection(insideText(editor, 'Hot'));
    expect(
      (grip(editor)?.nextElementSibling as HTMLElement | null)?.dataset['node'],
    ).toBe('safety');
  });

  it('drags a paragraph out of a variant block into the section around it, and back with one undo', () => {
    const editor = dragEditor(
      doc(sec('S', p('a'), variant(p('v1'), p('v2')), p('z'))),
    );
    // Rows: S 200, a 230, the variant 260 (its frame 10), v1 270, v2 300, z 330.
    const y = lift(editor, 'v1');
    expect(drag(editor)?.source).toBe(blockOf(editor, 'v1'));
    // Up onto a: the place before it.
    pointer('pointermove', window, y - 40);
    expect(drag(editor)?.slot).toBe(blockOf(editor, 'a'));
    pointer('pointerup', window, y - 40);
    expect(blocks(editor)).toEqual(['s:S[p:v1, p:a, variant:v2, p:z]']);
    editor.commands.undo();
    expect(blocks(editor)).toEqual(['s:S[p:a, variant:v1v2, p:z]']);
  });

  it("drags a safety notice's last measure out, leaving the notice with its hazard", () => {
    const editor = dragEditor(doc(p('a'), safety('Hot', p('m')), p('z')));
    // Rows: a 200, the notice 230, Hot 240, m 270, z 300.
    const y = lift(editor, 'm');
    pointer('pointermove', window, y - 70);
    expect(hint(editor)?.hidden).toBe(true);
    pointer('pointerup', window, y - 70);
    expect(blocks(editor)).toEqual(['p:m', 'p:a', 'safety:Hot', 'p:z']);
    editor.commands.undo();
    expect(blocks(editor)).toEqual(['p:a', 'safety:Hotm', 'p:z']);
  });

  it("keeps a variant block's last block in it, saying why", () => {
    const editor = dragEditor(doc(p('a'), variant(p('v')), p('z')));
    const y = lift(editor, 'v');
    pointer('pointermove', window, y - 70);
    expect(hint(editor)?.hidden).toBe(false);
    expect(hint(editor)?.textContent).toBe('editor.docEditor.drop.last');
    pointer('pointerup', window, y - 70);
    expect(blocks(editor)).toEqual(['p:a', 'variant:v', 'p:z']);
    expect(editor.can().undo()).toBe(false);
  });
});

describe('a place a block cannot go', () => {
  const outline = () =>
    dragEditor(
      doc(sec('S1', p('intro'), list(false, 'one', 'two')), sec('S2', p('b'))),
    );

  it('keeps the slot at the last allowed place and says why, refusing the drop', () => {
    const editor = outline();
    // Rows: S1 200, intro 230, one 260, two 290, S2 320, b 350.
    const y = lift(editor, 'S2');
    // Up to the top: S2 would go before S1.
    pointer('pointermove', window, y - 120);
    const allowed = drag(editor)?.slot;
    expect(allowed).toBe(0);
    expect(hint(editor)?.hidden).toBe(true);
    // Over the list's second item (290, one room of 50 lower now that the slot is above it).
    pointer('pointermove', window, y + 20);
    expect(drag(editor)?.slot).toBe(allowed);
    expect(hint(editor)?.hidden).toBe(false);
    expect(hint(editor)?.textContent).toBe('editor.docEditor.drop.list');
    expect(lifted(editor)?.classList).toContain('doc-editor-lifted-refused');
    expect(document.documentElement.classList).toContain(
      'doc-editor-drag-refused',
    );
    // Released there: nothing changes.
    pointer('pointerup', window, y + 20);
    expect(blocks(editor)).toEqual(['s:S1[p:intro, list:onetwo]', 's:S2[p:b]']);
    expect(document.documentElement.classList).not.toContain(
      'doc-editor-drag-refused',
    );
    expect(editor.can().undo()).toBe(false);
  });

  it('says a heading goes after the text, between the blocks of a section', () => {
    const editor = outline();
    const y = lift(editor, 'S2');
    // Over the top of "intro": between S1's heading and its text.
    pointer('pointermove', window, y - 90);
    expect(hint(editor)?.textContent).toBe('editor.docEditor.drop.text');
    // Back below the list: allowed again, the hint gone.
    pointer('pointermove', window, y);
    expect(hint(editor)?.hidden).toBe(true);
    expect(lifted(editor)?.classList).not.toContain(
      'doc-editor-lifted-refused',
    );
    pointer('pointerup', window, y);
    expect(blocks(editor)).toEqual(['s:S1[p:intro, list:onetwo]', 's:S2[p:b]']);
  });

  it('names the cap where the heading and its subsections would go too deep', () => {
    const editor = dragEditor(
      doc(
        sec('A', sec('A1', p('x'))),
        sec('B', sec('B1', p('y'), sec('C', p('z')))),
      ),
    );
    // Rows: A 200, A1 230, x 260, B 290, B1 320, y 350, C 380, z 410; A's room is 90.
    const y = lift(editor, 'A');
    // Into B1 before C (380): A would be a Heading 3, A1 a Heading 4.
    pointer('pointermove', window, y + 180);
    expect(hint(editor)?.textContent).toBe(
      'editor.docEditor.heading.cap {"parent":2,"max":3}',
    );
    pointer('pointerup', window, y + 180);
    expect(blocks(editor)).toEqual([
      's:A[s:A1[p:x]]',
      's:B[s:B1[p:y, s:C[p:z]]]',
    ]);
  });
});

describe('what slides aside during a drag', () => {
  it("is a procedure's other steps when a step is dragged", () => {
    const step = (text: string): JSONContent => ({
      type: 'listItem',
      content: [{ type: 'itemText', content: [{ type: 'text', text }] }],
    });
    const editor = dragEditor(
      doc(p('before'), {
        type: 'procedure',
        content: [step('one'), step('two'), step('three')],
      }),
    );
    const stepAt = (text: string) =>
      editor.state.doc.resolve(insideText(editor, text)).before(-1);
    const sliding = slidingNodes(editor.state.doc, stepAt('one'));
    expect(sliding).toContain(stepAt('two'));
    expect(sliding).toContain(stepAt('three'));
    expect(sliding).toContain(blockOf(editor, 'before'));
  });
});
