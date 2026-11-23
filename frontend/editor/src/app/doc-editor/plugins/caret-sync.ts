import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';

/**
 * ProseMirror's DOM observer, which `EditorView` keeps but its typings leave out: `flush()` reads
 * the browser's selection (and any pending DOM changes) into the state, as a `selectionchange`
 * event would; nothing when the selection is where the state already has it.
 */
interface DomObserver {
  forceFlush(): void;
  flush(): void;
}

/**
 * Takes the browser's selection into the editor's state now, rather than when its
 * `selectionchange` event comes. A click places the browser's caret at once, but that event comes
 * a moment later (later still on a loaded machine): a key pressed in between acted on the caret
 * before the click (#490), and a transaction dispatched in between (a hover moving the grip) drew
 * that old caret back into the page, so the click was lost. Returns whether the state changed.
 */
export function readDomSelection(view: EditorView): boolean {
  const observer = (view as unknown as { domObserver?: Partial<DomObserver> })
    .domObserver;
  if (
    view.isDestroyed ||
    view.composing ||
    typeof observer?.flush !== 'function' ||
    typeof observer.forceFlush !== 'function'
  )
    return false;
  const before = view.state;
  // A flush already scheduled runs now; otherwise `flush` reads the selection itself.
  observer.forceFlush();
  observer.flush();
  return view.state !== before;
}

const caretSyncKey = new PluginKey('docEditorCaretSync');

/**
 * A click's caret is the selection as soon as the press is let go, and a key always acts on the
 * caret the person sees: both read the browser's selection first (`readDomSelection`).
 */
export const CaretSync = Extension.create({
  name: 'caretSync',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: caretSyncKey,
        props: {
          handleDOMEvents: {
            mouseup(view) {
              readDomSelection(view);
              return false;
            },
            keydown(view, event) {
              // 229: a key the input method is composing with; the composition reads the DOM.
              if (event.keyCode !== 229) readDomSelection(view);
              return false;
            },
          },
        },
      }),
    ];
  },
});
