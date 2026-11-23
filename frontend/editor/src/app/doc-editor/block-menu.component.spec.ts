import { TestBed } from '@angular/core/testing';
import type { JSONContent } from '@tiptap/core';
import { NodeSelection, TextSelection } from '@tiptap/pm/state';
import { provideZard } from '@openfolia/ui/core';
import { ToastService } from '@openfolia/ui/toast';

import { BlockEditorComponent } from './block-editor.component';
import type { DocBlockSettings } from './blocks/doc-blocks-context';
import type { SnippetSaveRequest } from './snippets/save-snippet';
import { blockDragKey } from './plugins/block-drag';
import { blockMenuPos } from './plugins/block-menu';
import { blocks as allBlocks, doc, insideText, p } from './testing/test-editor';
import { advance } from '../testing/fake-time';

// jsdom lays nothing out and its ranges have no rectangles; ProseMirror asks for them when a
// command focuses the editor and scrolls the caret into view.
beforeAll(() => {
  const proto = Range.prototype as Partial<Range>;
  proto.getClientRects ??= () => [] as unknown as DOMRectList;
  proto.getBoundingClientRect ??= () => new DOMRect();
});

/** The root blocks as short names, without the editor's blank caret gaps. */
const blocks = (editor: Parameters<typeof allBlocks>[0]) =>
  allBlocks(editor).filter((block) => block !== 'p:');

const variant = (...content: JSONContent[]): JSONContent => ({
  type: 'variant',
  content,
});

async function render(value: JSONContent, settings: DocBlockSettings = {}) {
  // Fake time: the editor, its menus and change detection run on timers; a fixed real wait
  // ends before they have run on a busy machine (#562).
  vi.useFakeTimers();
  TestBed.configureTestingModule({ providers: [provideZard()] });
  const fixture = TestBed.createComponent(BlockEditorComponent);
  fixture.componentRef.setInput('value', value);
  fixture.componentRef.setInput('blocks', settings);
  await advance();
  const editor = fixture.componentInstance.editor!;
  const el = fixture.nativeElement as HTMLElement;
  const toasts = TestBed.inject(ToastService);
  /** Runs what is due within 30 ms of the fake clock (the menus' and the editor's own
   * timers), then renders. */
  const settle = () => advance(30);
  /** The menu's rows: their action and label, and whether disabled. */
  const items = () =>
    [
      ...document.querySelectorAll<HTMLElement>(
        '[role="menu"] [data-slot="dropdown-menu-item"]',
      ),
    ].map((item) => ({
      action: item.dataset['action'],
      label: item.textContent?.replace(/\s+/g, ' ').trim(),
      disabled: item.getAttribute('aria-disabled') === 'true',
      item,
    }));
  const choose = async (action: string) => {
    items()
      .find((i) => i.action === action)
      ?.item.click();
    await settle();
  };
  /** The caret into the text block with this text (or the node at a position selected), then Shift+F10. */
  const openFor = async (text: string | number) => {
    editor.view.dispatch(
      editor.state.tr.setSelection(
        typeof text === 'number'
          ? NodeSelection.create(editor.state.doc, text)
          : TextSelection.create(editor.state.doc, insideText(editor, text)),
      ),
    );
    editor.view.dom.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'F10',
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    await settle();
  };
  return { fixture, editor, el, toasts, settle, items, choose, openFor };
}

afterEach(() => {
  // The menu lives in the overlay container, outside the fixture.
  for (const pane of document.querySelectorAll('.cdk-overlay-pane'))
    pane.remove();
});

describe('the block actions menu', () => {
  it('lists the actions for the block, in words, with what can’t be done disabled', async () => {
    const { items, openFor } = await render(doc(p('a'), p('b')));
    await openFor('a');
    expect(
      items().map(({ action, label, disabled }) => ({
        action,
        label,
        disabled,
      })),
    ).toEqual([
      {
        action: 'move-up',
        label: 'Move up Alt+↑',
        disabled: true,
      },
      { action: 'move-down', label: 'Move down Alt+↓', disabled: false },
      { action: 'duplicate', label: 'Duplicate', disabled: false },
      { action: 'delete', label: 'Delete', disabled: false },
    ]);
  });

  it('offers Save as snippet when the page does, with the reason when it can’t (#309)', async () => {
    const requests: SnippetSaveRequest[] = [];
    const { items, openFor, choose, editor, settle } = await render(
      doc(
        p('a', 'b1'),
        variant(p('in', 'b2'), { type: 'moduleRef', attrs: { module: 'x' } }),
      ),
      { saveSnippet: { blocked: null, save: (r) => requests.push(r) } },
    );
    // The variant block itself, which holds a reference.
    await openFor(insideText(editor, 'in') - 2);
    const refused = items().find((i) => i.action === 'save-snippet');
    expect(refused?.disabled).toBe(true);
    expect(refused?.label).toContain('no section and no module reference');
    await choose('save-snippet');
    expect(requests).toHaveLength(0);

    await openFor('a');
    expect(items().find((i) => i.action === 'save-snippet')).toMatchObject({
      label: 'Save as snippet',
      disabled: false,
    });
    await choose('save-snippet');
    expect(requests).toHaveLength(1);
    expect(requests[0]!.blocks).toHaveLength(1);
    expect(requests[0]!.place('greeting')).toBe('placed');
    await settle();
    expect(blocks(editor)[0]).toBe('ref');
  });

  it('has no Save as snippet without the page’s saver', async () => {
    const { items, openFor } = await render(doc(p('a'), p('b')));
    await openFor('a');
    expect(items().some((i) => i.action === 'save-snippet')).toBe(false);
  });

  it('deletes the block, says so with Undo, and the toast’s Undo brings it back', async () => {
    const { editor, toasts, choose, openFor, settle } = await render(
      doc(p('a'), p('b'), p('c')),
    );
    await openFor('b');
    await choose('delete');
    expect(blocks(editor)).toEqual(['p:a', 'p:c']);
    const toast = toasts.toasts().at(-1)!;
    expect(toast.message).toEqual({
      key: 'editor.docEditor.blockMenu.deleted',
    });
    expect(toast.actionLabel).toEqual({ key: 'ui.toast.undo' });
    // The menu closed and let go of the block.
    expect(blockMenuPos(editor.state)).toBeNull();
    toasts.runAction(toast.id);
    await settle();
    expect(blocks(editor)).toEqual(['p:a', 'p:b', 'p:c']);
  });

  it('drops the toast once the document changes again: its Undo would take back that', async () => {
    const { editor, toasts, choose, openFor } = await render(
      doc(p('a'), p('b')),
    );
    await openFor('b');
    await choose('delete');
    const id = toasts.toasts().at(-1)!.id;
    editor.commands.insertContent('x');
    expect(toasts.toasts().some((t) => t.id === id)).toBe(false);
  });

  it('a delete from the menu Shift+F10 opened is one undo step', async () => {
    const { editor, choose, openFor } = await render(doc(p('a'), p('b')));
    await openFor('a');
    await choose('delete');
    expect(blocks(editor)).toEqual(['p:b']);
    editor.commands.undo();
    expect(blocks(editor)).toEqual(['p:a', 'p:b']);
  });

  it('moves, duplicates and removes a frame', async () => {
    const { editor, items, choose, openFor } = await render(
      doc(p('a'), variant(p('v'))),
    );
    await openFor('a');
    await choose('move-down');
    expect(blocks(editor)).toEqual(['variant:v', 'p:a']);
    // The caret in the variant's only paragraph: that paragraph's menu, which can't take it out.
    await openFor('v');
    expect(items().map((i) => i.action)).not.toContain('unwrap');
    expect(
      items()
        .filter((i) => i.disabled)
        .map((i) => i.action),
    ).toEqual(['move-up', 'move-down', 'delete']);
    await openFor(insideText(editor, 'v') - 2);
    expect(items().map((i) => i.action)).toContain('unwrap');
    await choose('duplicate');
    expect(blocks(editor)).toEqual(['variant:v', 'variant:v', 'p:a']);
    await openFor('a');
    expect(items().map((i) => i.action)).not.toContain('unwrap');
    await choose('move-up');
    await openFor(insideText(editor, 'v') - 2);
    await choose('unwrap');
    expect(blocks(editor)).toEqual(['p:v', 'p:a', 'variant:v']);
  });

  it('opens on a click of the grip', async () => {
    const { editor, items, settle } = await render(doc(p('a'), p('b')));
    editor.view.dispatch(
      editor.state.tr.setMeta(blockDragKey, { hoverPos: 3 }),
    );
    const grip = editor.view.dom.querySelector('[data-testid="block-grip"]')!;
    grip.dispatchEvent(
      new MouseEvent('pointerdown', { bubbles: true, button: 0 }),
    );
    window.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
    await settle();
    expect(items().map((i) => i.action)).toEqual([
      'move-up',
      'move-down',
      'duplicate',
      'delete',
    ]);
    expect(blockMenuPos(editor.state)).toBe(3);
  });
});
