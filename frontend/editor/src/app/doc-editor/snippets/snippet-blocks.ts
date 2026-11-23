import type { Editor } from '@tiptap/core';
import {
  Fragment,
  Node as ProseMirrorNode,
  type Schema,
} from '@tiptap/pm/model';
import {
  NodeSelection,
  Selection,
  TextSelection,
  type EditorState,
  type Transaction,
} from '@tiptap/pm/state';
import type { Block } from '@openfolia/content-model/core';
import { toEditor, type EditorNode } from '@openfolia/content-editor-model';

import { docBlocksOf } from '../blocks/doc-blocks-context';
import { placeFor } from '../plugins/block-place';

// A snippet goes into the document in one of two ways: by reference (a module reference block,
// kept in sync with the snippet wherever it is used) or as a copy (its blocks, with new block
// IDs, so nothing links back and the copy can be changed freely).

/** How a snippet is inserted. */
export type SnippetMode = 'reference' | 'copy';

/** Every `id` in a node's JSON (blocks, list items, steps, cells) taken out: the repair gives new ones. */
export function withoutIds(node: EditorNode): EditorNode {
  const attrs = node.attrs
    ? Object.fromEntries(
        Object.entries(node.attrs).map(([k, v]) => [k, k === 'id' ? null : v]),
      )
    : undefined;
  return {
    ...node,
    ...(attrs ? { attrs } : {}),
    ...(node.content ? { content: node.content.map(withoutIds) } : {}),
  };
}

/**
 * A copy of a snippet's blocks for the editor, every block ID left empty: the editor's repair
 * (`normalizeEditorDoc`) gives each a new one in the same step, so no copied ID repeats the
 * snippet's. Throws (a `ConversionError`) for a block the editor can't hold.
 */
export function snippetCopy(
  schema: Schema,
  blocks: readonly Block[],
): Fragment {
  const doc = toEditor({
    schemaVersion: 1,
    id: 'snippet-copy',
    meta: { title: 'copy', type: 'copy', lang: 'en', facets: {} },
    blocks: [...blocks],
  });
  return Fragment.from(
    (doc.content ?? []).map((node) =>
      ProseMirrorNode.fromJSON(schema, withoutIds(node)),
    ),
  );
}

/** A module reference to the snippet. */
export function snippetReference(
  schema: Schema,
  moduleId: string,
): ProseMirrorNode {
  const type = schema.nodes['moduleRef'];
  if (!type) throw new Error('the schema has no module reference');
  return type.create({ id: null, module: moduleId });
}

/** Whether `content` may stand in `from`…`to` (the same parent). */
function fits(
  state: EditorState,
  from: number,
  to: number,
  content: Fragment,
): boolean {
  const $from = state.doc.resolve(from);
  const $to = state.doc.resolve(to);
  if ($from.parent !== $to.parent) return false;
  return $from.parent.canReplace($from.index(), $to.index(), content);
}

/**
 * Puts the snippet in place of `from`…`to` (a paragraph whose words it completes): a reference
 * with an empty line after it holding the caret, so writing goes on below; a copy with the caret
 * at the end of its text. Null when it can't stand there.
 */
export function replaceWithSnippet(
  state: EditorState,
  from: number,
  to: number,
  content:
    | { mode: 'reference'; moduleId: string }
    | { mode: 'copy'; blocks: Fragment },
): Transaction | null {
  const paragraph = state.schema.nodes['paragraph'];
  if (!paragraph) return null;
  if (content.mode === 'reference') {
    const nodes = Fragment.from([
      snippetReference(state.schema, content.moduleId),
      paragraph.create(),
    ]);
    if (!fits(state, from, to, nodes)) return null;
    const tr = state.tr.replaceWith(from, to, nodes);
    const line = from + nodes.child(0).nodeSize + 1;
    return tr.setSelection(TextSelection.create(tr.doc, line)).scrollIntoView();
  }
  if (content.blocks.childCount === 0 || !fits(state, from, to, content.blocks))
    return null;
  const tr = state.tr.replaceWith(from, to, content.blocks);
  const end = from + content.blocks.size;
  return tr
    .setSelection(Selection.near(tr.doc.resolve(end), -1))
    .scrollIntoView();
}

/** Whether the page around `editor` offers the snippet picker, and the document can be changed. */
export function canPickSnippet(editor: Editor): boolean {
  const context = docBlocksOf(editor);
  return !!context?.settings().pickModule && context.editable();
}

/** Whether a snippet can go at the caret (a module reference can: a copy then can too). */
export function canInsertSnippet(state: EditorState): boolean {
  const type = state.schema.nodes['moduleRef'];
  return !!type && placeFor(state, type) !== null;
}

/**
 * Opens the module picker for snippets and inserts the choice where the caret was: a reference,
 * selected, or a copy of its blocks with the caret at their end. Resolves to whether something
 * was inserted: not when the picker is cancelled or missing, the snippet could not be read, or
 * the editor went or became read-only meanwhile. Rejects when the snippet could not be read.
 */
export async function pickAndInsertSnippet(editor: Editor): Promise<boolean> {
  const settings = docBlocksOf(editor)?.settings();
  const pick = settings?.pickModule;
  if (!pick || !canPickSnippet(editor) || !canInsertSnippet(editor.state))
    return false;
  const choice = await pick(null, { snippet: true });
  if (!choice || editor.isDestroyed || !canPickSnippet(editor)) return false;
  let blocks: Fragment | null = null;
  if (choice.mode === 'copy') {
    const content = await settings.moduleContent?.(choice.module);
    if (!content || editor.isDestroyed || !canPickSnippet(editor)) return false;
    blocks = snippetCopy(editor.schema, content.blocks);
  } else if (choice.mode !== 'whole') {
    return false;
  }
  editor.commands.focus();
  const { state } = editor;
  const type = state.schema.nodes['moduleRef'];
  const place = type ? placeFor(state, type) : null;
  if (!place) return false;
  if (blocks) {
    if (!fits(state, place.from, place.to, blocks)) return false;
    const tr = state.tr.replaceWith(place.from, place.to, blocks);
    tr.setSelection(
      Selection.near(tr.doc.resolve(place.from + blocks.size), -1),
    );
    editor.view.dispatch(tr.scrollIntoView());
    return true;
  }
  const reference = snippetReference(state.schema, choice.module);
  const tr = state.tr.replaceWith(place.from, place.to, reference);
  tr.setSelection(NodeSelection.create(tr.doc, place.from));
  editor.view.dispatch(tr.scrollIntoView());
  return true;
}
