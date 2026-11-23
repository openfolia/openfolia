import { TestBed } from '@angular/core/testing';
import type { JSONContent } from '@tiptap/core';
import { NodeSelection, TextSelection } from '@tiptap/pm/state';
import {
  fromEditor,
  normalizeEditorDoc,
  toEditor,
} from '@openfolia/content-editor-model';
import type { Module } from '@openfolia/content-model/core';
import { provideZard } from '@openfolia/ui/core';

import { BlockEditorComponent } from '../block-editor.component';
import { canInsertBlock, insertBlockAt } from '../editor-commands';
import { withoutCaretGaps } from '../plugins/caret-gaps';
import { SAMPLE_MODULE } from '../sample-module';
import { SLASH_ITEMS } from '../slash/slash-items';
import { insideText } from '../testing/test-editor';
import { advance } from '../../testing/fake-time';

// jsdom lays nothing out and its ranges have no rectangles; ProseMirror asks for them when a
// command scrolls the caret into view.
beforeAll(() => {
  const proto = Range.prototype as Partial<Range>;
  proto.getClientRects ??= () => [] as unknown as DOMRectList;
  proto.getBoundingClientRect ??= () => new DOMRect();
});

const t = (text: string) => ({ type: 'text' as const, text });

const MODULE: Module = {
  ...SAMPLE_MODULE,
  blocks: [
    { type: 'paragraph', id: 'one', content: [t('One.')] },
    { type: 'pageBreak', id: 'break' },
    { type: 'paragraph', id: 'two', content: [t('Two.')] },
    {
      type: 'admonition',
      id: 'note',
      kind: 'note',
      blocks: [{ type: 'paragraph', id: 'in-note', content: [t('Noted.')] }],
    },
  ],
};

async function mount(module: Module = MODULE) {
  // Fake time: the editor, its menus and change detection run on timers; a fixed real wait
  // ends before they have run on a busy machine (#562).
  vi.useFakeTimers();
  TestBed.configureTestingModule({ providers: [provideZard()] });
  const fixture = TestBed.createComponent(BlockEditorComponent);
  fixture.componentRef.setInput('value', toEditor(module));
  let last: JSONContent | null = null;
  fixture.componentInstance.changed.subscribe((d) => (last = d));
  await advance();
  const editor = fixture.componentInstance.editor!;
  const el = fixture.nativeElement as HTMLElement;
  /** Runs what is due within 30 ms of the fake clock (the menus' and the editor's own
   * timers), then renders. */
  const settle = () => advance(30);
  const known = new Set(module.blocks.map((b) => b.id));
  /** The module's blocks as the editor hands them on: type and ID (`new` for a new block). */
  const model = () =>
    fromEditor(
      normalizeEditorDoc(last ?? withoutCaretGaps(editor.getJSON())),
    ).blocks.map((b) => `${b.type}:${known.has(b.id) ? b.id : 'new'}`);
  const caretIn = (text: string) =>
    editor.view.dispatch(
      editor.state.tr.setSelection(
        TextSelection.create(editor.state.doc, insideText(editor, text)),
      ),
    );
  return { fixture, editor, el, settle, model, caretIn };
}

/** The position of the first page break in the document. */
function breakPos(editor: BlockEditorComponent['editor']): number {
  let pos = -1;
  editor!.state.doc.descendants((node, at) => {
    if (pos < 0 && node.type.name === 'pageBreak') pos = at;
    return pos < 0;
  });
  return pos;
}

afterEach(() => {
  for (const pane of document.querySelectorAll('.cdk-overlay-pane'))
    pane.remove();
});

describe('the page break block in the editor', () => {
  it('shows a labelled dashed rule, not editable, and round-trips unchanged', async () => {
    const { el, editor } = await mount();
    const dom = el.querySelector<HTMLElement>('[data-node="pageBreak"]')!;
    expect(dom.getAttribute('contenteditable')).toBe('false');
    const rule = dom.querySelector('of-page-break-block')!;
    expect(rule.getAttribute('role')).toBe('separator');
    expect(rule.getAttribute('aria-label')).toBe('Page break (PDF)');
    expect(rule.textContent?.trim()).toBe('Page break (PDF)');
    expect(
      fromEditor(normalizeEditorDoc(withoutCaretGaps(editor.getJSON()))),
    ).toEqual(MODULE);
  });

  it('is inserted from the Insert menu after the block at the caret, selected', async () => {
    const { editor, model, caretIn } = await mount();
    caretIn('Two.');
    expect(canInsertBlock(editor.state, 'pageBreak')).toBe(true);
    expect(insertBlockAt(editor, 'pageBreak')).toBe(true);
    expect(model()).toEqual([
      'paragraph:one',
      'pageBreak:break',
      'paragraph:two',
      'pageBreak:new',
      'admonition:note',
    ]);
    expect(editor.state.selection).toBeInstanceOf(NodeSelection);
    expect((editor.state.selection as NodeSelection).node.type.name).toBe(
      'pageBreak',
    );
  });

  it('goes after a notice, never into it: a page breaks only between the blocks of a module or section', async () => {
    const { editor, model, caretIn } = await mount();
    caretIn('Noted.');
    expect(insertBlockAt(editor, 'pageBreak')).toBe(true);
    expect(model()).toEqual([
      'paragraph:one',
      'pageBreak:break',
      'paragraph:two',
      'admonition:note',
      'pageBreak:new',
    ]);
  });

  it('is offered in the "/" menu, and put in place of the line typed there', async () => {
    const { editor, model } = await mount({
      ...MODULE,
      blocks: [{ type: 'paragraph', id: 'one', content: [t('One.')] }],
    });
    const slash = SLASH_ITEMS.find((item) => item.id === 'pageBreak')!;
    const end = editor.state.doc.content.size - 1;
    editor.commands.setTextSelection(end);
    editor.commands.insertContent('/page');
    const to = editor.state.selection.from;
    expect(slash.available?.(editor.state, editor) ?? true).toBe(true);
    slash.run(editor, { from: to - '/page'.length, to });
    expect(model()).toEqual(['paragraph:one', 'pageBreak:new']);
  });

  it('is deleted and moved whole, like any other block', async () => {
    const { editor, model } = await mount();
    editor.view.dispatch(
      editor.state.tr.setSelection(
        NodeSelection.create(editor.state.doc, breakPos(editor)),
      ),
    );
    editor.view.dom.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'ArrowDown',
        altKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(model()).toEqual([
      'paragraph:one',
      'paragraph:two',
      'pageBreak:break',
      'admonition:note',
    ]);
    editor.view.dispatch(
      editor.state.tr.setSelection(
        NodeSelection.create(editor.state.doc, breakPos(editor)),
      ),
    );
    editor.commands.deleteSelection();
    expect(model()).toEqual([
      'paragraph:one',
      'paragraph:two',
      'admonition:note',
    ]);
  });
});
