import type { Editor, JSONContent } from '@tiptap/core';
import { closeHistory } from '@tiptap/pm/history';
import type { Node as ProseMirrorNode, ResolvedPos } from '@tiptap/pm/model';
import { NodeSelection, type EditorState } from '@tiptap/pm/state';
import type { Block } from '@openfolia/content-model/core';
import {
  fromEditor,
  normalizeEditorDoc,
  type EditorNode,
} from '@openfolia/content-editor-model';

import { docBlocksOf } from '../blocks/doc-blocks-context';
import { withoutCaretGaps } from '../plugins/caret-gaps';
import {
  isBlank,
  isFlow,
  isStepFlow,
  isStepText,
  isTitle,
} from '../plugins/flow';
import { snippetReference, withoutIds } from './snippet-blocks';

// "Save as snippet" (#309): the blocks a selection covers become a snippet module of their own,
// and a reference to it takes their place. The page asks for the snippet's title, type and ID and
// creates it (`DocBlockSettings.saveSnippet`); only once it exists does the reference go in, in
// one undo step, so a creation that fails leaves the document as it was.

/** Why the selection cannot be saved as a snippet: translation keys. */
export const SNIPPET_REFUSALS = {
  /** A section or a module reference: a snippet holds one or a few blocks of text. */
  tooLarge: 'editor.docEditor.saveSnippet.tooLarge',
  /** Nothing but blank lines. */
  empty: 'editor.docEditor.saveSnippet.empty',
  /** A block the content model can't hold yet (an empty list item, cell or heading). */
  incomplete: 'editor.docEditor.saveSnippet.incomplete',
  /** No reference may stand where the blocks are. */
  noPlace: 'editor.docEditor.saveSnippet.noPlace',
} as const;

/** The run of blocks a selection covers: siblings in one flow, from `from` to `to`. */
export interface SnippetRange {
  readonly from: number;
  readonly to: number;
  /** The blocks in the run, blank lines left out: what the snippet holds, with their IDs. */
  readonly nodes: readonly ProseMirrorNode[];
}

/** What can be saved: the run and its blocks for the snippet (with new IDs), or why not. */
export type SnippetSource =
  | {
      readonly ok: true;
      readonly range: SnippetRange;
      readonly blocks: readonly Block[];
    }
  | { readonly ok: false; readonly reason: string };

/** How the reference went in once the snippet was saved. */
export type SnippetPlacement =
  /** The reference stands in the blocks' place. */
  | 'placed'
  /** The blocks were changed, moved or deleted meanwhile: left as they are. */
  | 'changed'
  /** The editor is gone or read-only now. */
  | 'gone';

/** What the page is handed to save a snippet: its blocks, and how to put the reference in. */
export interface SnippetSaveRequest {
  readonly blocks: readonly Block[];
  /** Puts a reference to `moduleId` in the blocks' place, in one undo step. */
  readonly place: (moduleId: string) => SnippetPlacement;
}

/** What holds blocks besides the flows: a variant block, a safety notice, a note, an FAQ entry. */
const HOLDERS = new Set(['variant', 'safety', 'admonition', 'faq']);

/** What leads a holder and is no block of it: a title, a step's text, a hazard, a question. */
const isLead = (node: ProseMirrorNode) =>
  isTitle(node) ||
  isStepText(node) ||
  node.type.name === 'hazard' ||
  node.type.name === 'question';

/**
 * The run of blocks from the one holding `$from` to the one holding `$to`, in the innermost flow,
 * procedure step or block container holding both where a module reference may take their place.
 * A title, a step's text or a hazard in the run stands for what it leads, one level out; so does
 * a run no reference may replace (steps of a procedure: the procedure). Blank lines at either end
 * are left out.
 */
function rangeOf(
  state: EditorState,
  $from: ResolvedPos,
  $to: ResolvedPos,
): SnippetRange | null {
  const reference = state.schema.nodes['moduleRef'];
  if (!reference) return null;
  const shared = $from.sharedDepth($to.pos);
  for (let depth = shared; depth >= 0; depth -= 1) {
    const holder = $from.node(depth);
    if (
      !isFlow(holder) &&
      !isStepFlow($from, depth) &&
      !HOLDERS.has(holder.type.name)
    )
      continue;
    let first = $from.index(depth);
    let last = $to.index(depth);
    // A selection ending right after a block (a whole block selected) ends with that block.
    if (last > first && $to.pos === $to.posAtIndex(last, depth)) last -= 1;
    last = Math.min(last, holder.childCount - 1);
    let lead = false;
    for (let i = first; i <= last; i += 1) {
      if (isLead(holder.child(i))) lead = true;
    }
    if (lead || first > last) continue;
    while (first <= last && isBlank(holder.child(first))) first += 1;
    while (last >= first && isBlank(holder.child(last))) last -= 1;
    if (first > last) return { from: 0, to: 0, nodes: [] };
    const nodes: ProseMirrorNode[] = [];
    for (let i = first; i <= last; i += 1) {
      const child = holder.child(i);
      if (!isBlank(child)) nodes.push(child);
    }
    // Too large is said as such, wherever it stands; anything else needs a place for the reference.
    if (
      !nodes.some(tooLarge) &&
      !holder.canReplaceWith(first, last + 1, reference)
    )
      continue;
    return {
      from: $from.posAtIndex(first, depth),
      to: $from.posAtIndex(last + 1, depth),
      nodes,
    };
  }
  return null;
}

/** Whether `node` is or holds a section or a module reference (`snippet-too-large`). */
function tooLarge(node: ProseMirrorNode): boolean {
  if (node.type.name === 'section' || node.type.name === 'moduleRef')
    return true;
  let found = false;
  node.descendants((child) => {
    if (found) return false;
    if (child.type.name === 'section' || child.type.name === 'moduleRef')
      found = true;
    return !found;
  });
  return found;
}

/** The blocks of the run as the content model has them, every block ID a new one. */
function blocksOf(nodes: readonly ProseMirrorNode[], lang: string): Block[] {
  const doc: JSONContent = {
    type: 'doc',
    attrs: {
      schemaVersion: 1,
      moduleId: 'snippet',
      meta: { title: 'snippet', type: 'snippet', lang, facets: {} },
    },
    content: nodes.map((n) => withoutIds(n.toJSON() as EditorNode)),
  };
  return fromEditor(withoutCaretGaps(normalizeEditorDoc(doc) as JSONContent))
    .blocks;
}

/**
 * What a snippet saved from the selection would hold: the blocks the selection covers (for a
 * block's menu, `pos`: that block, or the selection's run when it holds the block), or why they
 * can't be one.
 */
export function snippetSource(
  state: EditorState,
  pos: number | null = null,
): SnippetSource {
  const { selection, doc } = state;
  let range: SnippetRange | null = null;
  const node = pos === null ? null : doc.nodeAt(pos);
  if (node && pos !== null) {
    const around = selection.empty
      ? null
      : rangeOf(state, selection.$from, selection.$to);
    range =
      around && around.from <= pos && pos < around.to
        ? around
        : rangeOf(state, doc.resolve(pos), doc.resolve(pos + node.nodeSize));
  } else if (pos === null) {
    range = rangeOf(state, selection.$from, selection.$to);
  }
  if (!range) return { ok: false, reason: SNIPPET_REFUSALS.noPlace };
  if (range.nodes.length === 0)
    return { ok: false, reason: SNIPPET_REFUSALS.empty };
  if (range.nodes.some(tooLarge))
    return { ok: false, reason: SNIPPET_REFUSALS.tooLarge };
  const attrs = doc.attrs as { meta?: { lang?: unknown } };
  const lang = typeof attrs.meta?.lang === 'string' ? attrs.meta.lang : 'en';
  try {
    return { ok: true, range, blocks: blocksOf(range.nodes, lang) };
  } catch {
    return { ok: false, reason: SNIPPET_REFUSALS.incomplete };
  }
}

/**
 * Why "Save as snippet" can't run now (a translation key), or null when it can: the page's
 * reason first (no draft revision, no snippet type), then the selection's. Undefined when the
 * page offers no snippets at all (the action is not shown).
 */
export function saveSnippetBlocked(
  editor: Editor,
  pos: number | null = null,
): string | null | undefined {
  const context = docBlocksOf(editor);
  const saver = context?.settings().saveSnippet;
  if (!saver || !context.editable()) return undefined;
  if (saver.blocked) return saver.blocked;
  const source = snippetSource(editor.state, pos);
  return source.ok ? null : source.reason;
}

/**
 * Puts a reference to `moduleId` in place of the blocks `range` held, found again by their IDs
 * (the document may have changed meanwhile), in one undo step, the reference selected. The blocks
 * must still stand together and unchanged; else nothing changes.
 */
export function placeSnippet(
  editor: Editor,
  range: SnippetRange,
  moduleId: string,
): SnippetPlacement {
  if (editor.isDestroyed || !editor.isEditable) return 'gone';
  const { state } = editor;
  const ids = range.nodes.map((n) => n.attrs['id'] as unknown);
  if (ids.some((id) => typeof id !== 'string' || !id)) return 'changed';
  // The first block, by its ID, in whichever flow it stands now.
  let start = -1;
  state.doc.descendants((node, pos) => {
    if (start >= 0) return false;
    if (node.attrs['id'] === ids[0] && node.eq(range.nodes[0]!)) {
      start = pos;
      return false;
    }
    return true;
  });
  if (start < 0) return 'changed';
  const $start = state.doc.resolve(start);
  const parent = $start.parent;
  let index = $start.index();
  let end = start;
  // The rest follow it, unchanged, blank lines between them aside.
  for (let i = 0; i < range.nodes.length; i += 1) {
    let child = parent.maybeChild(index);
    while (i > 0 && child && isBlank(child)) {
      end += child.nodeSize;
      index += 1;
      child = parent.maybeChild(index);
    }
    if (!child || !child.eq(range.nodes[i]!)) return 'changed';
    end += child.nodeSize;
    index += 1;
  }
  const reference = snippetReference(state.schema, moduleId);
  const first = $start.index();
  if (!parent.canReplaceWith(first, index, reference.type)) return 'changed';
  const tr = state.tr.replaceWith(start, end, reference);
  tr.setSelection(NodeSelection.create(tr.doc, start));
  editor.view.dispatch(closeHistory(tr).scrollIntoView());
  return 'placed';
}

/**
 * "Save as snippet": hands the blocks the selection covers (or the block at `pos`, from its menu)
 * to the page, which asks for the snippet's title, type and ID and creates it; the reference goes
 * in once it exists. False when it can't run now (`saveSnippetBlocked` says why).
 */
export function saveAsSnippet(
  editor: Editor,
  pos: number | null = null,
): boolean {
  if (saveSnippetBlocked(editor, pos) !== null) return false;
  const saver = docBlocksOf(editor)?.settings().saveSnippet;
  const source = snippetSource(editor.state, pos);
  if (!saver || !source.ok) return false;
  const { range } = source;
  saver.save({
    blocks: source.blocks,
    place: (moduleId) => placeSnippet(editor, range, moduleId),
  });
  return true;
}
