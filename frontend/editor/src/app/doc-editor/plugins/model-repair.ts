import { Extension } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { Plugin, PluginKey, type Transaction } from '@tiptap/pm/state';
import {
  EditorLimitError,
  normalizeEditorDoc,
  type NormalizeOptions,
} from '@openfolia/content-editor-model';

// The repair step of `@openfolia/content-editor-model` (`normalizeEditorDoc`), kept up as the document
// changes: a new block (a split paragraph, a pasted one, a new list item) gets a valid ID of its
// own, an ID seen twice is kept by the first block, text is canonical. So what the editor holds
// is always a fixed point of the repair, and `fromEditor` sees it as it is. The patch is as small
// as the difference: an attribute change keeps the node (and the caret in it); only content
// that differs is replaced.

const key = new PluginKey('docEditorModelRepair');

/** Writes `next` over `current` (at `pos`, -1 for the document) into `tr`, node by node. */
function patch(
  tr: Transaction,
  current: ProseMirrorNode,
  next: ProseMirrorNode,
  pos: number,
): void {
  if (current.eq(next)) return;
  const isDoc = pos < 0;
  const contentStart = isDoc ? 0 : pos + 1;
  if (current.type !== next.type) {
    tr.replaceWith(
      tr.mapping.map(pos),
      tr.mapping.map(pos + current.nodeSize),
      next,
    );
    return;
  }
  if (!sameAttrs(current, next)) {
    if (isDoc) {
      for (const [name, value] of Object.entries(next.attrs))
        tr.setDocAttribute(name, value);
    } else {
      tr.setNodeMarkup(tr.mapping.map(pos), null, next.attrs, next.marks);
    }
  }
  if (current.content.eq(next.content)) return;
  const sameShape =
    !current.inlineContent &&
    current.childCount === next.childCount &&
    current.content.content.every(
      (child, i) => !child.isText && child.type === next.child(i).type,
    );
  if (!sameShape) {
    tr.replaceWith(
      tr.mapping.map(contentStart),
      tr.mapping.map(contentStart + current.content.size),
      next.content,
    );
    return;
  }
  current.forEach((child, offset, i) => {
    patch(tr, child, next.child(i), contentStart + offset);
  });
}

const sameAttrs = (a: ProseMirrorNode, b: ProseMirrorNode) =>
  JSON.stringify(a.attrs) === JSON.stringify(b.attrs);

/**
 * The repair of `doc` as a transaction on `tr`, or false when there is nothing to repair. A
 * document over a cap is left as it is: `fromEditor` names the cap.
 */
export function repairInto(
  tr: Transaction,
  options: NormalizeOptions = {},
): boolean {
  const { doc } = tr;
  let repaired: ProseMirrorNode;
  try {
    repaired = doc.type.schema.nodeFromJSON(
      normalizeEditorDoc(doc.toJSON(), options),
    );
  } catch (error) {
    if (error instanceof EditorLimitError) return false;
    throw error;
  }
  if (repaired.eq(doc)) return false;
  patch(tr, doc, repaired, -1);
  return tr.docChanged;
}

export interface ModelRepairOptions {
  /** New block IDs (tests make them predictable); the package's random ones by default. */
  newId?: NormalizeOptions['newId'];
}

export const ModelRepair = Extension.create<ModelRepairOptions>({
  name: 'modelRepair',
  addOptions() {
    return {};
  },
  addProseMirrorPlugins() {
    const options: NormalizeOptions = this.options.newId
      ? { newId: this.options.newId }
      : {};
    return [
      new Plugin({
        key,
        appendTransaction(transactions, _old, state) {
          if (!transactions.some((tr) => tr.docChanged)) return null;
          const tr = state.tr;
          // An appended transaction joins the undo step of the change that needed it.
          return repairInto(tr, options) ? tr : null;
        },
      }),
    ];
  },
});
