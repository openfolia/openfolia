import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import type { EditorState, Transaction } from '@tiptap/pm/state';

import {
  type Inline,
  isTextRange,
  type PlainText,
  plainTextOf,
} from '@openfolia/content-model/core';

// A block's text fields in the editor's document, as the content model's translatable units name
// them (`translatableUnits`: a block ID and a field), read as plain text (`plainTextOf`) and
// changed by a range of that plain text. The style review (#248, #573) names its suggestions this
// way: a paragraph's `content`, a section's `title`, an image's `alt`, an image callout's
// `legend` (the callout's own ID), … Framework-free; the module editor's suggestion list is the UI.

/** A part of a unit: which of a block's texts. As `TRANSLATABLE_FIELDS` in the content model. */
export type TextFieldName =
  | 'content'
  | 'title'
  | 'alt'
  | 'hazard'
  | 'question'
  | 'name'
  | 'description'
  | 'legend';

/** Where a field's text is: inline content of a node, or a plain-string attribute of one. */
type FieldPlace =
  | {
      readonly kind: 'inline';
      /** The position of the node whose content is the field (a paragraph, a title, a callout). */
      readonly pos: number;
      readonly node: ProseMirrorNode;
    }
  | {
      readonly kind: 'attr';
      /** The position of the block holding the attribute. */
      readonly pos: number;
      readonly node: ProseMirrorNode;
      readonly attr: 'alt' | 'name' | 'description';
    };

/** A field found in the document: where it is and its plain text. */
export interface TextField {
  readonly place: FieldPlace;
  readonly plain: PlainText;
}

/** The node with `id` (a block, a list item, a callout) and its position; the first in order. */
function nodeWithId(
  doc: ProseMirrorNode,
  id: string,
): { node: ProseMirrorNode; pos: number } | null {
  if (!id) return null;
  let found: { node: ProseMirrorNode; pos: number } | null = null;
  doc.descendants((node, pos) => {
    if (found) return false;
    if (node.isInline) return false;
    if (node.attrs['id'] === id) {
      found = { node, pos };
      return false;
    }
    return true;
  });
  return found;
}

/** The first child of `node` of type `type`, with its position. */
function childOf(
  node: ProseMirrorNode,
  pos: number,
  type: string,
): { node: ProseMirrorNode; pos: number } | null {
  let found: { node: ProseMirrorNode; pos: number } | null = null;
  node.forEach((child, offset) => {
    if (!found && child.type.name === type) {
      found = { node: child, pos: pos + 1 + offset };
    }
  });
  return found;
}

/** Which node holds `field` of a block of `type`: itself, a child of that type, or an attribute. */
function placeOf(
  node: ProseMirrorNode,
  pos: number,
  field: string,
): FieldPlace | null {
  const type = node.type.name;
  const inChild = (child: string): FieldPlace | null => {
    const found = childOf(node, pos, child);
    return found ? { kind: 'inline', ...found } : null;
  };
  switch (field) {
    case 'content':
      if (type === 'paragraph') return { kind: 'inline', node, pos };
      if (type === 'listItem') return inChild('itemText');
      return null;
    case 'legend':
      return type === 'callout' ? { kind: 'inline', node, pos } : null;
    case 'title':
      return ['section', 'procedure', 'table', 'image'].includes(type)
        ? inChild('title')
        : null;
    case 'hazard':
      return type === 'safety' ? inChild('hazard') : null;
    case 'question':
      return type === 'faq' ? inChild('question') : null;
    case 'alt':
      return type === 'image' ? { kind: 'attr', node, pos, attr: 'alt' } : null;
    case 'name':
    case 'description':
      return type === 'attachment'
        ? { kind: 'attr', node, pos, attr: field }
        : null;
    default:
      return null;
  }
}

/** An inline node as the content model's inline it stands for (enough for its plain text). */
function inlineOf(node: ProseMirrorNode): Inline {
  return node.isText
    ? { type: 'text', text: node.text ?? '' }
    : ({ type: node.type.name, ...node.attrs } as unknown as Inline);
}

/** The plain text of an inline container, and each child's plain-text start. */
function inlinePlain(node: ProseMirrorNode): {
  plain: PlainText;
  starts: number[];
} {
  const content: Inline[] = [];
  const starts: number[] = [];
  let at = 0;
  node.forEach((child) => {
    const inline = inlineOf(child);
    starts.push(at);
    at += plainTextOf([inline]).text.length;
    content.push(inline);
  });
  return { plain: plainTextOf(content), starts };
}

/** The field `field` of the block (or list item, or callout) `blockId`; null when there is none. */
export function findTextField(
  doc: ProseMirrorNode,
  blockId: string,
  field: string,
): TextField | null {
  const found = nodeWithId(doc, blockId);
  if (!found) return null;
  const place = placeOf(found.node, found.pos, field);
  if (!place) return null;
  if (place.kind === 'attr') {
    const value = place.node.attrs[place.attr];
    return {
      place,
      plain: { text: typeof value === 'string' ? value : '', atoms: [] },
    };
  }
  return { place, plain: inlinePlain(place.node).plain };
}

/** A change of a range of a field's plain text, as a suggestion names it. */
export interface TextChange {
  readonly blockId: string;
  readonly field: string;
  readonly range: { readonly start: number; readonly end: number };
  /** What the range must still hold. */
  readonly original: string;
  readonly replacement: string;
  /**
   * The whole field's plain text the change was made for: when the field reads otherwise now, the
   * change is refused (`changed`), even where the range itself still holds `original`.
   */
  readonly expected: string;
}

/** Why a change was not made: the field is gone, or its text is no longer what it was made for. */
export type TextChangeRefusal = 'missing' | 'changed';

/** The document position of plain-text offset `at` inside the text child it falls in. */
function positionIn(
  container: ProseMirrorNode,
  containerPos: number,
  starts: readonly number[],
  at: number,
  side: 'start' | 'end',
): number | null {
  let result: number | null = null;
  container.forEach((child, childOffset, index) => {
    if (result !== null || !child.isText) return;
    const start = starts[index] ?? 0;
    const end = start + (child.text?.length ?? 0);
    if (side === 'start' ? at >= start && at < end : at > start && at <= end) {
      result = containerPos + 1 + childOffset + (at - start);
    }
  });
  return result;
}

/**
 * The transaction that makes `change` (one step, so one Undo takes it back), or why not. The
 * field must still read `change.expected` and the range `change.original`; the range must be
 * typed text (`isTextRange`). The replacement takes the marks of the text it replaces.
 */
export function textChange(
  state: EditorState,
  change: TextChange,
): { readonly tr: Transaction } | { readonly refused: TextChangeRefusal } {
  const field = findTextField(state.doc, change.blockId, change.field);
  if (!field) return { refused: 'missing' };
  const { start, end } = change.range;
  if (
    field.plain.text !== change.expected ||
    !isTextRange(field.plain, start, end) ||
    field.plain.text.slice(start, end) !== change.original
  ) {
    return { refused: 'changed' };
  }
  const { place } = field;
  // The replacement takes the marks of what it replaces, never those toggled at the caret.
  const tr = state.tr.setStoredMarks(null);
  if (place.kind === 'attr') {
    const text = field.plain.text;
    tr.setNodeAttribute(
      place.pos,
      place.attr,
      text.slice(0, start) + change.replacement + text.slice(end),
    );
    return { tr };
  }
  const { starts } = inlinePlain(place.node);
  const from = positionIn(place.node, place.pos, starts, start, 'start');
  const to = positionIn(place.node, place.pos, starts, end, 'end');
  if (from === null || to === null || to <= from) return { refused: 'changed' };
  if (change.replacement.length === 0) tr.delete(from, to);
  else tr.insertText(change.replacement, from, to);
  return { tr };
}

/** The image block that holds the callout `calloutId`, by its ID; null when none does. */
export function imageOfCallout(
  doc: ProseMirrorNode,
  calloutId: string,
): string | null {
  const found = nodeWithId(doc, calloutId);
  if (!found || found.node.type.name !== 'callout') return null;
  const parent = doc.resolve(found.pos).parent;
  return parent.type.name === 'image' ? String(parent.attrs['id'] ?? '') : null;
}
