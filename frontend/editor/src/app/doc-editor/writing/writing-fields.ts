import type { Node as ProseMirrorNode } from '@tiptap/pm/model';

import { type Inline, plainTextOf } from '@openfolia/content-model/core';

// The text fields the writing checks read (#247), found in the editor's document as the content
// model's translatable units name them: a paragraph's `content` (in any block, a table cell
// too), a list item's or step's `content`, a section's, procedure's, table's or image's `title`,
// a safety notice's `hazard`, an FAQ entry's `question`, an image callout's `legend`. Code blocks
// and passthroughs hold no checked text, as in the API's checks. An image's alt text and an
// attachment's name and description are attributes, checked by the API's checks only.
// Framework-free.

/** A field's name, as `TRANSLATABLE_FIELDS` has it (the inline ones). */
export type CheckedFieldName =
  'content' | 'title' | 'hazard' | 'question' | 'legend';

/** A text field of the document: the inline container that holds it, and whose field it is. */
export interface CheckedField {
  /** The block, list item, step or callout the field belongs to. */
  readonly blockId: string;
  readonly field: CheckedFieldName;
  /** The position of the inline container (a paragraph, an item's text, a title, …). */
  readonly pos: number;
  readonly node: ProseMirrorNode;
}

const TITLED = new Set(['section', 'procedure', 'table', 'image']);

/** Which field an inline container is, inside `parent`; null for one the checks do not read. */
function fieldOf(
  node: ProseMirrorNode,
  parent: ProseMirrorNode | null,
): { blockId: string; field: CheckedFieldName } | null {
  const own = (n: ProseMirrorNode | null) => {
    const id = n?.attrs['id'];
    return typeof id === 'string' ? id : '';
  };
  switch (node.type.name) {
    case 'paragraph':
      return { blockId: own(node), field: 'content' };
    case 'itemText':
      return { blockId: own(parent), field: 'content' };
    case 'title':
      return parent && TITLED.has(parent.type.name)
        ? { blockId: own(parent), field: 'title' }
        : null;
    case 'hazard':
      return { blockId: own(parent), field: 'hazard' };
    case 'question':
      return { blockId: own(parent), field: 'question' };
    case 'callout':
      return { blockId: own(node), field: 'legend' };
    default:
      return null;
  }
}

/** Every checked field of `doc`, in document order. A field without an ID yet is left out. */
export function checkedFields(doc: ProseMirrorNode): CheckedField[] {
  const out: CheckedField[] = [];
  doc.descendants((node, pos, parent) => {
    if (node.isInline) return false;
    if (node.type.name === 'literal' || node.type.name === 'passthrough')
      return false;
    if (!node.inlineContent) return true;
    const found = fieldOf(node, parent);
    if (found && found.blockId) out.push({ ...found, pos, node });
    return false;
  });
  return out;
}

/** The field holding position `pos` (the caret), when it is a checked one. */
export function fieldAt(
  doc: ProseMirrorNode,
  pos: number,
): CheckedField | null {
  const $pos = doc.resolve(Math.max(0, Math.min(pos, doc.content.size)));
  const node = $pos.parent;
  if (!node.inlineContent || $pos.depth < 1) return null;
  for (let d = $pos.depth - 1; d >= 0; d--) {
    const name = $pos.node(d).type.name;
    if (name === 'literal' || name === 'passthrough') return null;
  }
  const parent = $pos.depth >= 1 ? $pos.node($pos.depth - 1) : null;
  const found = fieldOf(node, parent);
  return found && found.blockId ? { ...found, pos: $pos.before(), node } : null;
}

/** An inline node as the content model's inline for the checks: text with its code mark. */
function inlineOf(node: ProseMirrorNode): Inline {
  if (node.isText) {
    const code = node.marks.some((m) => m.type.name === 'code');
    return {
      type: 'text',
      text: node.text ?? '',
      ...(code ? { marks: [{ type: 'code' }] } : {}),
    } as Inline;
  }
  return { type: node.type.name, ...node.attrs } as unknown as Inline;
}

/** A field's inline content as the checks read it. */
export function fieldContent(node: ProseMirrorNode): Inline[] {
  const out: Inline[] = [];
  node.forEach((child) => out.push(inlineOf(child)));
  return out;
}

/** The plain-text length of one inline child, as `plainTextOf` counts it. */
function plainLength(child: ProseMirrorNode): number {
  return child.isText
    ? (child.text?.length ?? 0)
    : plainTextOf([inlineOf(child)]).text.length;
}

/**
 * The document range of plain-text offsets `[start, end)` in the field at `pos`; null when they
 * do not fall in its text (an atom in between is fine: the range covers it).
 */
export function rangeIn(
  node: ProseMirrorNode,
  pos: number,
  start: number,
  end: number,
): { from: number; to: number } | null {
  let at = 0;
  let from: number | null = null;
  let to: number | null = null;
  node.forEach((child, offset) => {
    const length = plainLength(child);
    const childPos = pos + 1 + offset;
    if (child.isText) {
      if (from === null && start >= at && start < at + length)
        from = childPos + (start - at);
      if (to === null && end > at && end <= at + length)
        to = childPos + (end - at);
    }
    at += length;
  });
  return from !== null && to !== null && to > from ? { from, to } : null;
}

/** The plain-text offset of document position `docPos` in the field at `pos`. */
export function offsetIn(
  node: ProseMirrorNode,
  pos: number,
  docPos: number,
): number {
  let at = 0;
  let result = -1;
  node.forEach((child, offset) => {
    if (result >= 0) return;
    const childPos = pos + 1 + offset;
    if (docPos <= childPos) {
      result = at;
      return;
    }
    const length = plainLength(child);
    if (child.isText && docPos < childPos + child.nodeSize) {
      result = at + (docPos - childPos);
      return;
    }
    at += length;
  });
  return result >= 0 ? result : at;
}
