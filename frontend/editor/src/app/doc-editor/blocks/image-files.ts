import { Extension, type Editor } from '@tiptap/core';
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import type { EditorView } from '@tiptap/pm/view';

import { canPickImage, insertImage, pickAndInsertImage } from './doc-blocks';

// An image file dropped on the document or pasted into it opens the image picker with that file
// already uploading, so its alt text and size are set there, as for any image; the image goes
// where it was dropped (under a step's text, when dropped on one) or at the caret.

/**
 * The kinds of picture the image picker uploads (its `UPLOAD_TYPES`); any other file is left to
 * the editor's own handling.
 */
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg']);

/**
 * The image file a paste or drop carries, or null: none when it carries text too (an office app
 * puts a picture of copied text beside the text; the text is what is meant).
 */
function carriedImage(data: DataTransfer | null | undefined): File | null {
  if (!data || data.getData?.('text/plain')?.trim()) return null;
  return imageFile(data.files);
}

/** The first image among `files`, or null. */
export function imageFile(
  files: FileList | readonly File[] | null | undefined,
): File | null {
  for (const file of Array.from(files ?? []))
    if (IMAGE_TYPES.has(file.type)) return file;
  return null;
}

/**
 * Puts the caret at `pos` (a drop's place) and opens the picker with `file`; resolves to whether
 * an image was inserted.
 */
async function insertFileAt(
  editor: Editor,
  file: File,
  pos: number | null,
): Promise<boolean> {
  if (pos !== null) {
    const { state } = editor;
    editor.view.dispatch(state.tr.setSelection(caretAt(state.doc, pos)));
  }
  return pickAndInsertImage(editor, file);
}

/** The caret nearest `pos`, inside the document. */
const caretAt = (doc: ProseMirrorNode, pos: number) =>
  TextSelection.near(doc.resolve(Math.min(Math.max(pos, 0), doc.content.size)));

const imageFilesKey = new PluginKey('docEditorImageFiles');

/** Whether an image file may be taken here: the page has a picker and an image fits. */
function takes(editor: Editor): boolean {
  return canPickImage(editor) && insertImage(null)(editor.state);
}

export const ImageFiles = Extension.create({
  name: 'docEditorImageFiles',
  addProseMirrorPlugins() {
    const editor = this.editor;
    return [
      new Plugin({
        key: imageFilesKey,
        props: {
          handleDrop(view: EditorView, event: DragEvent, _slice, moved) {
            if (moved) return false;
            const file = carriedImage(event.dataTransfer);
            if (!file || !canPickImage(editor)) return false;
            const at = view.posAtCoords({
              left: event.clientX,
              top: event.clientY,
            });
            // Only where an image can go: anywhere else the drop is left to the editor.
            const there = at
              ? view.state.apply(
                  view.state.tr.setSelection(caretAt(view.state.doc, at.pos)),
                )
              : view.state;
            if (!insertImage(null)(there)) return false;
            event.preventDefault();
            void insertFileAt(editor, file, at?.pos ?? null);
            return true;
          },
          handlePaste(_view, event) {
            const file = carriedImage(event.clipboardData);
            if (!file || !takes(editor)) return false;
            event.preventDefault();
            void insertFileAt(editor, file, null);
            return true;
          },
        },
      }),
    ];
  },
});
