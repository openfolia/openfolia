import { Extension, type JSONContent } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { Plugin, PluginKey, type Transaction } from '@tiptap/pm/state';

import { isSection } from './flow';

// The editor needs a blank line where a caret can land around a block with no text of its own
// (a list, a placeholder) in a flow (`flow.ts`: the document or a section): before such a block
// when the one before it has no text either, and after the last block before the subsections.
// Only the editor needs them: `withCaretGaps` adds them when a document is loaded, the plugin
// keeps them as the document changes, and `withoutCaretGaps` takes them out of what the editor
// hands on, so they are never stored and an edit that is undone hands on nothing new.

/** Children of a flow a caret lands in directly: text, a section's title, a section. */
const CARET_TYPES = new Set(['paragraph', 'title', 'section']);
const FLOW_TYPES = new Set(['doc', 'section']);

const hasCaretJson = (node: JSONContent | undefined) =>
  !!node?.type && CARET_TYPES.has(node.type);

const isBlankJson = (node: JSONContent) =>
  node.type === 'paragraph' && !node.content?.length;

/** Where a gap goes among a flow's children: before these indexes (`length`: at the end). */
export function gapIndexes<T>(
  children: readonly T[],
  hasCaret: (child: T | undefined) => boolean,
  isSectionChild: (child: T) => boolean,
  isDoc: boolean,
): number[] {
  const out: number[] = [];
  let end = children.length;
  children.forEach((child, index) => {
    if (end === children.length && isSectionChild(child)) end = index;
  });
  for (let index = 0; index < end; index += 1) {
    if (!hasCaret(children[index]) && !hasCaret(children[index - 1]))
      out.push(index);
  }
  // After the last block, before the subsections: a document of nothing gets a line too.
  const last = children[end - 1];
  if ((end > 0 && !hasCaret(last)) || (isDoc && children.length === 0))
    out.push(end);
  return out;
}

/** `doc` with a blank paragraph wherever a caret could not land otherwise, in every flow. */
export function withCaretGaps(doc: JSONContent): JSONContent {
  const fill = (node: JSONContent): JSONContent => {
    if (!node.type || !FLOW_TYPES.has(node.type)) return node;
    const children = (node.content ?? []).map(fill);
    const gaps = new Set(
      gapIndexes(
        children,
        hasCaretJson,
        (child) => child.type === 'section',
        node.type === 'doc',
      ),
    );
    const out: JSONContent[] = [];
    children.forEach((child, index) => {
      if (gaps.has(index)) out.push({ type: 'paragraph' });
      out.push(child);
    });
    if (gaps.has(children.length)) out.push({ type: 'paragraph' });
    return { ...node, content: out };
  };
  return fill(doc);
}

/**
 * The inverse of `withCaretGaps`, for what the editor hands on: every blank paragraph of a flow
 * goes. A gap the editor added, one that stopped being needed when the blocks around it moved,
 * and a blank line a person typed alike: the content model has no empty paragraph to store, and
 * the next load puts back the gaps it needs. Blank paragraphs elsewhere (a list item's blocks)
 * stay, for `fromEditor` to report.
 */
export function withoutCaretGaps(doc: JSONContent): JSONContent {
  const strip = (node: JSONContent): JSONContent => {
    if (!node.type || !FLOW_TYPES.has(node.type) || !node.content) return node;
    const content = node.content
      .filter((child) => !isBlankJson(child))
      .map(strip);
    const { content: _content, ...rest } = node;
    return content.length ? { ...rest, content } : rest;
  };
  return strip(doc);
}

/** Whether a caret lands in this child of a flow directly. */
export const hasCaret = (node: ProseMirrorNode | undefined) =>
  !!node && CARET_TYPES.has(node.type.name);

/** The positions wanting a blank paragraph, in every flow, last first, so inserting keeps the rest valid. */
export function gapPositions(doc: ProseMirrorNode): number[] {
  const positions: number[] = [];
  const visit = (flow: ProseMirrorNode, start: number) => {
    const children: ProseMirrorNode[] = [];
    const starts: number[] = [];
    flow.forEach((child, offset) => {
      children.push(child);
      starts.push(start + offset);
      if (isSection(child)) visit(child, start + offset + 1);
    });
    for (const index of gapIndexes(
      children,
      hasCaret,
      isSection,
      flow === doc,
    )) {
      positions.push(starts[index] ?? start + flow.content.size);
    }
  };
  visit(doc, 0);
  return positions.sort((a, b) => b - a);
}

const key = new PluginKey('docEditorCaretGaps');

const changedDoc = (transactions: readonly Transaction[]) =>
  transactions.some((tr) => tr.docChanged);

/** Keeps the gaps as the document changes, in the same undo step as the change. */
export const CaretGaps = Extension.create({
  name: 'caretGaps',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key,
        appendTransaction(transactions, _old, state) {
          if (!changedDoc(transactions)) return null;
          const positions = gapPositions(state.doc);
          if (positions.length === 0) return null;
          const paragraph = state.schema.nodes['paragraph'];
          if (!paragraph) return null;
          const tr = state.tr;
          for (const pos of positions) tr.insert(pos, paragraph.create());
          // An appended transaction joins the undo step of the change that needed it.
          return tr;
        },
      }),
    ];
  },
});
