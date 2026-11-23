import { Extension } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import {
  Plugin,
  PluginKey,
  TextSelection,
  type EditorState,
} from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

// The hint of an empty text block ("Type / for a block"): only where the caret is, a text caret
// in that very block. Never beside a block selected as a whole (an inserted reference, an image):
// a blank line before it is a caret gap, not where writing goes on, so it shows no hint (#793).
// Worked out from the state each time, so no hint is ever left behind on a line the caret left.

export interface CaretPlaceholderOptions {
  /** The hint of an empty text block, by its type and its parent's; empty for none. */
  placeholder: (node: ProseMirrorNode, parent: ProseMirrorNode) => string;
}

const key = new PluginKey('docEditorCaretPlaceholder');

/** The hint's decoration in `state`, or null when the caret is in no empty text block. */
export function caretPlaceholder(
  state: EditorState,
  placeholder: CaretPlaceholderOptions['placeholder'],
): Decoration | null {
  const { selection } = state;
  if (!(selection instanceof TextSelection) || !selection.empty) return null;
  const $caret = selection.$head;
  const node = $caret.parent;
  if (!node.isTextblock || node.content.size > 0 || $caret.depth === 0)
    return null;
  const text = placeholder(node, $caret.node($caret.depth - 1));
  if (!text) return null;
  const pos = $caret.before();
  return Decoration.node(pos, pos + node.nodeSize, {
    class: 'is-empty',
    'data-placeholder': text,
  });
}

/** Shows the hint of the empty text block holding the caret, while the editor can be changed. */
export const CaretPlaceholder = Extension.create<CaretPlaceholderOptions>({
  name: 'caretPlaceholder',
  addOptions() {
    return { placeholder: () => '' };
  },
  addProseMirrorPlugins() {
    const editor = this.editor;
    const { placeholder } = this.options;
    return [
      new Plugin({
        key,
        props: {
          decorations(state) {
            if (!editor.isEditable) return null;
            const hint = caretPlaceholder(state, placeholder);
            return hint ? DecorationSet.create(state.doc, [hint]) : null;
          },
        },
      }),
    ];
  },
});
