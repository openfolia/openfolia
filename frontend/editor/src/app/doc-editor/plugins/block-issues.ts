import { Extension } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';

// Problems found in a module (the server's validation issues, the editor's own "cannot be saved
// yet") are shown at their blocks: the block gets a marker class and its problem as a
// description. The host hands them over by block ID (`setBlockIssues`); the decorations follow
// the block as the document changes.

export interface BlockIssue {
  /** The block's (or list item's) ID. */
  readonly at: string;
  /** `draft`: a normal step of writing (a block not finished yet), shown calmly, never in red. */
  readonly severity: 'error' | 'warning' | 'draft';
  /** What the person reads, in the UI language. */
  readonly text: string;
}

const key = new PluginKey<DecorationSet>('docEditorBlockIssues');

/** The node with this ID: its position, or null. */
export function findBlock(
  doc: ProseMirrorNode,
  id: string,
): { pos: number; node: ProseMirrorNode } | null {
  let found: { pos: number; node: ProseMirrorNode } | null = null;
  doc.descendants((node, pos) => {
    if (found) return false;
    if (node.attrs['id'] === id) {
      found = { pos, node };
      return false;
    }
    return true;
  });
  return found;
}

function decorations(
  doc: ProseMirrorNode,
  issues: readonly BlockIssue[],
): DecorationSet {
  const byBlock = new Map<string, BlockIssue[]>();
  for (const issue of issues) {
    byBlock.set(issue.at, [...(byBlock.get(issue.at) ?? []), issue]);
  }
  if (byBlock.size === 0) return DecorationSet.empty;
  const out: Decoration[] = [];
  doc.descendants((node, pos) => {
    const id = node.attrs['id'];
    const own = typeof id === 'string' ? byBlock.get(id) : undefined;
    if (own) {
      // The worst one sets the colour: an error, else a warning, else a draft.
      const severity = own.some((i) => i.severity === 'error')
        ? 'error'
        : own.some((i) => i.severity === 'warning')
          ? 'warning'
          : 'draft';
      out.push(
        Decoration.node(pos, pos + node.nodeSize, {
          class: `doc-editor-issue doc-editor-issue-${severity}`,
          'data-issue': own.map((i) => i.text).join('\n'),
          title: own.map((i) => i.text).join('\n'),
        }),
      );
    }
    return true;
  });
  return DecorationSet.create(doc, out);
}

/** Shows `issues` at their blocks in place of the ones shown so far. */
export function setBlockIssues(
  view: EditorView,
  issues: readonly BlockIssue[],
): void {
  view.dispatch(
    view.state.tr.setMeta(key, issues).setMeta('addToHistory', false),
  );
}

/** The issues shown now (for tests). */
export function blockIssueDecorations(state: EditorState): DecorationSet {
  return key.getState(state) ?? DecorationSet.empty;
}

export const BlockIssues = Extension.create({
  name: 'blockIssues',
  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key,
        state: {
          init: () => DecorationSet.empty,
          apply(tr, set) {
            const issues = tr.getMeta(key) as BlockIssue[] | undefined;
            if (issues) return decorations(tr.doc, issues);
            return set.map(tr.mapping, tr.doc);
          },
        },
        props: {
          decorations: (state) => key.getState(state),
        },
      }),
    ];
  },
});
