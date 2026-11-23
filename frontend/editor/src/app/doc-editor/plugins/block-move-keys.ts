import { Extension } from '@tiptap/core';
import type { EditorState } from '@tiptap/pm/state';

import { slidingMove } from './block-slide';

export interface BlockMoveOptions {
  /** Called after a keyboard move, to announce where the block now is. */
  onMoved: (state: EditorState) => void;
}

/** Alt+Up and Alt+Down while the editor has focus. */
export const BlockMoveKeys = Extension.create<BlockMoveOptions>({
  name: 'blockMoveKeys',
  addOptions() {
    return { onMoved: () => undefined };
  },
  addKeyboardShortcuts() {
    const move = (up: boolean) => {
      if (!this.editor.isEditable) return true;
      const moved = slidingMove(this.editor.view, up);
      if (moved) this.options.onMoved(this.editor.view.state);
      // Always handled: the browser's own Alt+arrow would otherwise leave the page.
      return true;
    };
    return {
      'Alt-ArrowUp': () => move(true),
      'Alt-ArrowDown': () => move(false),
    };
  },
});
