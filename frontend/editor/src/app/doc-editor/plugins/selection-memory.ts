import type { Editor } from '@tiptap/core';
import type {
  Selection,
  SelectionBookmark,
  Transaction,
} from '@tiptap/pm/state';

import { BLOCK_MOVED } from './block-move';

/**
 * Where the person was in the document, kept while the focus is elsewhere. Leaving the editor (a
 * menu, tabbing to the toolbar) resets the browser's selection, and TipTap's blur handling takes
 * that over, back to the document's start; a later `focus()` only confirms it. So the place is
 * remembered from real interaction: a bookmark rather than a position, because it survives a
 * node selection and maps through a change made while the editor has no focus.
 */
export class SelectionMemory {
  private bookmark: SelectionBookmark | null = null;

  /** Call on every transaction. */
  note(editor: Editor, transaction: Transaction): void {
    const focusNoise =
      transaction.getMeta('blur') || transaction.getMeta('focus');
    // A move carries the selection along; mapped, it would stay behind at the old place.
    if ((editor.isFocused && !focusNoise) || transaction.getMeta(BLOCK_MOVED)) {
      this.bookmark = editor.state.selection.getBookmark();
    } else if (transaction.docChanged) {
      this.bookmark = this.bookmark?.map(transaction.mapping) ?? null;
    }
  }

  /** The remembered selection, in the document as it is now. */
  current(editor: Editor): Selection {
    const { doc, selection } = editor.state;
    return this.bookmark?.resolve(doc) ?? selection;
  }

  /** Puts the remembered selection back, for a command coming from outside the editor. */
  restore(editor: Editor): void {
    if (!this.bookmark) return;
    const { state, view } = editor;
    const selection = this.bookmark.resolve(state.doc);
    if (!selection.eq(state.selection))
      view.dispatch(state.tr.setSelection(selection));
  }
}
