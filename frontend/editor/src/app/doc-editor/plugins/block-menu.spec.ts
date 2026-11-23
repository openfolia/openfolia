import { TextSelection } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';

import { doc, insideText, p, testEditor } from '../testing/test-editor';
import { BlockDrag, blockDragKey } from './block-drag';
import {
  BlockMenu,
  blockMenuPos,
  closeBlockMenu,
  type BlockMenuRequest,
} from './block-menu';

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

/** An editor with the grip and the menu; `opened` collects what the menu was asked to show. */
function menuEditor(content = doc(p('a'), p('b'), p('c'))) {
  const opened: BlockMenuRequest[] = [];
  const editor = testEditor(content, [
    BlockDrag,
    BlockMenu.configure({
      open: (_view: EditorView, request) => opened.push(request),
    }),
  ]);
  const grip = () =>
    editor.view.dom.querySelector<HTMLElement>('[data-testid="block-grip"]');
  const hover = (pos: number) =>
    editor.view.dispatch(
      editor.state.tr.setMeta(blockDragKey, { hoverPos: pos }),
    );
  const lifted = () =>
    editor.view.dom.parentElement?.querySelector(
      '[data-testid="block-lifted"]',
    ) ?? null;
  return { editor, opened, grip, hover, lifted };
}

function key(view: EditorView, init: KeyboardEventInit): boolean {
  const event = new KeyboardEvent('keydown', {
    bubbles: true,
    cancelable: true,
    ...init,
  });
  view.dom.dispatchEvent(event);
  return event.defaultPrevented;
}

describe('the grip’s click', () => {
  it('opens the menu for its block, against the grip, and keeps the grip there while open', () => {
    const { editor, opened, grip, hover } = menuEditor();
    hover(3);
    pointer('pointerdown', grip()!, 40);
    // A wobble smaller than the slop is still a click.
    pointer('pointermove', window, 42, 1);
    pointer('pointerup', window, 42, 1);
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({ pos: 3, keyboard: false });
    expect(opened[0]?.anchor).toBe(grip());
    expect(grip()?.getAttribute('data-state')).toBe('open');
    expect(blockMenuPos(editor.state)).toBe(3);

    // The pointer goes off to the menu: the block keeps its grip.
    editor.view.dispatch(
      editor.state.tr.setMeta(blockDragKey, { hoverPos: null }),
    );
    expect(grip()).not.toBeNull();
    closeBlockMenu(editor.view);
    expect(blockMenuPos(editor.state)).toBeNull();
    expect(grip()).toBeNull();
  });

  it('starts a drag instead once the press moves, and opens no menu', () => {
    const { opened, grip, hover, lifted } = menuEditor();
    hover(0);
    pointer('pointerdown', grip()!, 10);
    expect(lifted()).toBeNull();
    pointer('pointermove', window, 30);
    expect(lifted()).not.toBeNull();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    pointer('pointerup', window, 30);
    expect(opened).toEqual([]);
  });

  it('opens nothing in a read-only document', () => {
    const { editor, opened, grip, hover } = menuEditor();
    editor.setEditable(false);
    hover(0);
    const g = grip();
    if (g) {
      pointer('pointerdown', g, 10);
      pointer('pointerup', window, 10);
    }
    expect(opened).toEqual([]);
    expect(blockMenuPos(editor.state)).toBeNull();
  });
});

describe('the menu from the keyboard', () => {
  it.each([
    ['Shift+F10', { key: 'F10', shiftKey: true }],
    ['the context-menu key', { key: 'ContextMenu' }],
  ])('opens with %s for the block the caret is in', (_name, init) => {
    const { editor, opened } = menuEditor();
    editor.view.dispatch(
      editor.state.tr.setSelection(
        TextSelection.create(editor.state.doc, insideText(editor, 'b')),
      ),
    );
    expect(key(editor.view, init)).toBe(true);
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({ pos: 3, keyboard: true });
  });

  it('leaves F10 alone without Shift', () => {
    const { editor, opened } = menuEditor();
    expect(key(editor.view, { key: 'F10' })).toBe(false);
    expect(opened).toEqual([]);
  });

  it('closes when its block goes', () => {
    const { editor } = menuEditor();
    editor.view.dispatch(
      editor.state.tr.setSelection(
        TextSelection.create(editor.state.doc, insideText(editor, 'b')),
      ),
    );
    key(editor.view, { key: 'ContextMenu' });
    expect(blockMenuPos(editor.state)).toBe(3);
    // Something before it changes: the menu follows its block.
    editor.view.dispatch(editor.state.tr.insertText('x', 1));
    expect(blockMenuPos(editor.state)).toBe(4);
    editor.view.dispatch(editor.state.tr.delete(4, 7));
    expect(blockMenuPos(editor.state)).toBeNull();
  });
});
