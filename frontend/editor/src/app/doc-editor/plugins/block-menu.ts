import { Extension } from '@tiptap/core';
import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';

import { flowBlockAt } from './block-actions';
import { selectedBlock } from './block-move';

// The block actions menu: a click on a block's grip (a press without movement; pressing and
// moving drags), or Shift+F10 or the context-menu key in the editor, opens it for that block.
// While it is open the block keeps its grip, so the menu has its trigger to stand by. The menu
// itself is the page's (`BlockMenuComponent`); this only says when and for which block.

/** Which block the menu is open for: the position it starts at, or null when it is closed. */
export interface BlockMenuState {
  readonly pos: number | null;
}

export const blockMenuKey = new PluginKey<BlockMenuState>('docEditorBlockMenu');

/** What opens the menu: the block, the grip to stand by, and whether the keyboard asked. */
export interface BlockMenuRequest {
  readonly pos: number;
  readonly anchor: HTMLElement;
  readonly keyboard: boolean;
}

export interface BlockMenuOptions {
  /** Shows the menu; null: there is none (a click on the grip then does nothing). */
  open: ((view: EditorView, request: BlockMenuRequest) => void) | null;
}

/** How far (px) a press may move and still be a click, not a drag. */
export const CLICK_SLOP = 4;

/** The block the menu is open for, or null. */
export function blockMenuPos(state: EditorState): number | null {
  return blockMenuKey.getState(state)?.pos ?? null;
}

/**
 * Opens the menu for the block at `pos`: its grip stays in place as the menu's trigger. False
 * when there is no menu, the document can't be changed or there is no block there.
 */
export function openBlockMenu(
  view: EditorView,
  pos: number,
  keyboard: boolean,
): boolean {
  const plugin = blockMenuKey.get(view.state);
  const open = (plugin?.spec as { open?: BlockMenuOptions['open'] } | undefined)
    ?.open;
  if (
    view.isDestroyed ||
    !open ||
    !view.editable ||
    !flowBlockAt(view.state, pos)
  )
    return false;
  view.dispatch(view.state.tr.setMeta(blockMenuKey, { pos }));
  // The grip is drawn at the block now; without one (no drag plugin), the block stands in.
  const grip = view.dom.querySelector<HTMLElement>('.doc-editor-grip');
  const block = view.nodeDOM(pos);
  const anchor =
    grip ?? (block instanceof HTMLElement ? block : (view.dom as HTMLElement));
  grip?.setAttribute('data-state', 'open');
  open(view, { pos, anchor, keyboard });
  return true;
}

/** The menu closed: the grip goes back to following the pointer and the caret. */
export function closeBlockMenu(view: EditorView): void {
  if (view.isDestroyed || blockMenuPos(view.state) === null) return;
  view.dom
    .querySelector('.doc-editor-grip[data-state="open"]')
    ?.removeAttribute('data-state');
  view.dispatch(view.state.tr.setMeta(blockMenuKey, { pos: null }));
}

/** The keys that open the block actions menu of the selected block: the menu key, or Shift+F10. */
export function isBlockMenuKey(
  event: Pick<
    KeyboardEvent,
    'key' | 'shiftKey' | 'altKey' | 'ctrlKey' | 'metaKey'
  >,
): boolean {
  return (
    event.key === 'ContextMenu' ||
    (event.key === 'F10' &&
      event.shiftKey &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey)
  );
}

/**
 * Tells a click from a drag on the grip: a press that moves `CLICK_SLOP` px or more starts
 * `drag` (with the press's own event, and the move that got it there handed on to the drag's
 * own listeners); one let go before that is a `click`.
 */
export function pressGrip(
  press: PointerEvent,
  drag: (press: PointerEvent) => void,
  click: () => void,
): void {
  const target = press.target as Node | null;
  const win = target?.ownerDocument?.defaultView ?? window;
  const { clientX: x, clientY: y } = press;
  const stop = () => {
    win.removeEventListener('pointermove', onMove);
    win.removeEventListener('pointerup', onUp);
    win.removeEventListener('pointercancel', stop);
  };
  // Only the pointer that pressed: a second finger neither drags nor clicks.
  const same = (event: PointerEvent) =>
    event.pointerId === undefined || event.pointerId === press.pointerId;
  function onMove(event: PointerEvent) {
    if (!same(event)) return;
    if (Math.hypot(event.clientX - x, event.clientY - y) < CLICK_SLOP) return;
    stop();
    drag(press);
    // Listeners added during this event miss it: the drag hears the same move once more.
    const Event = event.constructor as typeof MouseEvent;
    win.dispatchEvent(new Event(event.type, event));
  }
  function onUp(event: PointerEvent) {
    if (!same(event)) return;
    stop();
    click();
  }
  win.addEventListener('pointermove', onMove);
  win.addEventListener('pointerup', onUp);
  win.addEventListener('pointercancel', stop);
}

export const BlockMenu = Extension.create<BlockMenuOptions>({
  name: 'blockMenu',
  addOptions() {
    return { open: null };
  },
  addProseMirrorPlugins() {
    const { open } = this.options;
    return [
      new Plugin<BlockMenuState>({
        key: blockMenuKey,
        open,
        state: {
          init: () => ({ pos: null }),
          apply(tr, value) {
            const meta = tr.getMeta(blockMenuKey) as BlockMenuState | undefined;
            if (meta) return meta;
            if (value.pos === null || !tr.docChanged) return value;
            // The block moved or went: the menu follows it while it is there.
            const mapped = tr.mapping.mapResult(value.pos, 1);
            return { pos: mapped.deleted ? null : mapped.pos };
          },
        },
        props: {
          handleKeyDown(view, event) {
            if (!isBlockMenuKey(event)) return false;
            const block = selectedBlock(view.state);
            if (!block) return false;
            if (!openBlockMenu(view, block.pos, true)) return false;
            event.preventDefault();
            return true;
          },
        },
      }),
    ];
  },
});
