import type { Schema } from '../api';
import type { TextChange } from '../doc-editor/text-fields';
import { findingMessage } from '../doc-editor/writing/finding-text';
import type { PlacedFinding } from '../doc-editor/writing/writing-checks';

// The suggestions the module editor's Suggestions tab lists (#247, #573): the writing checks'
// findings while typing (`writing`: forbidden and deprecated terms, style rules) and the
// model-based style review's (#248, `style`), as one kind of item. Framework-free;
// `suggestions-panel.component.ts` is the UI.

export type StyleSuggestion = Schema<'StyleSuggestion'>;

/**
 * The longest message and text shown (`capped`): the model's answer is untrusted, and the API caps
 * it too. Applying uses the full text.
 */
export const MAX_SHOWN_MESSAGE = 1_000;
export const MAX_SHOWN_TEXT = 2_000;

/** One suggestion on a range of one field's text. */
export interface SuggestionItem {
  readonly id: string;
  /**
   * Where it comes from: `style`, the model-based style review; `writing`, the writing checks in
   * the editor (its `id` is the finding's).
   */
  readonly kind: 'style' | 'writing';
  /** A writing check's severity (a style suggestion has none). */
  readonly severity?: 'warning' | 'blocking';
  readonly blockId: string;
  readonly field: StyleSuggestion['field'];
  readonly range: { readonly start: number; readonly end: number };
  readonly original: string;
  /** The text to put in; null: a remark without a fix. */
  readonly replacement: string | null;
  readonly message: string;
  /**
   * The field's whole text the suggestion was made for. Applying it is refused once the field
   * reads otherwise. Null: the editor had no such field (only "Dismiss" then).
   */
  readonly expected: string | null;
  /** Its place among the list's items, kept when an item comes back with Undo. */
  readonly order: number;
}

/** `value` cut to `max` characters for showing (an ellipsis marks the cut). */
export const capped = (value: string, max: number): string =>
  value.length > max ? `${value.slice(0, max - 1)}…` : value;

/**
 * The items of a style review's suggestions, against the editor's text when the review was asked
 * for (`textOf`, a field's plain text or null). One whose range does not hold its `original` in
 * that text is made against text that changed already: it has no `expected`.
 */
export function styleItems(
  suggestions: readonly StyleSuggestion[],
  textOf: (blockId: string, field: string) => string | null,
): SuggestionItem[] {
  return suggestions.map((s, order) => {
    const text = textOf(s.blockId, s.field);
    const fits =
      text !== null && text.slice(s.range.start, s.range.end) === s.original;
    return {
      id: s.id,
      kind: 'style',
      blockId: s.blockId,
      field: s.field,
      range: { start: s.range.start, end: s.range.end },
      original: s.original,
      replacement: s.replacement,
      message: capped(s.message, MAX_SHOWN_MESSAGE),
      expected: fits ? text : null,
      order,
    };
  });
}

/**
 * The items of the writing checks' findings (#247), in document order, with their messages in
 * the UI language. A finding without a fix (a sentence's length) has no replacement.
 */
export function writingItems(
  findings: readonly PlacedFinding[],
  t: (key: string, params?: Record<string, unknown>) => string,
): SuggestionItem[] {
  return findings.map((f, order) => ({
    id: f.id,
    kind: 'writing',
    severity: f.severity,
    blockId: f.blockId,
    field: f.field,
    range: { start: f.start, end: f.end },
    original: f.text,
    replacement: f.replacement ?? null,
    message: findingMessage(f, t),
    expected: f.fieldText,
    order,
  }));
}

/** Whether two items are on the same field. */
export const sameField = (a: SuggestionItem, b: SuggestionItem): boolean =>
  a.blockId === b.blockId && a.field === b.field;

/** The change applying `item` makes; null when it has none to make. */
export function changeOf(item: SuggestionItem): TextChange | null {
  if (item.replacement === null || item.expected === null) return null;
  return {
    blockId: item.blockId,
    field: item.field,
    range: item.range,
    original: item.original,
    replacement: item.replacement,
    expected: item.expected,
  };
}

/**
 * The text of `item`'s field once it is applied: `expected` with the range replaced. Only for an
 * item `changeOf` gives a change for.
 */
export function textAfter(item: SuggestionItem): string {
  const text = item.expected ?? '';
  return (
    text.slice(0, item.range.start) +
    (item.replacement ?? '') +
    text.slice(item.range.end)
  );
}

/**
 * The other items once `applied` is in: those on its field before or after its range now expect
 * the new text (and move with it); those overlapping it no longer fit (no `expected`).
 */
export function afterApplied(
  items: readonly SuggestionItem[],
  applied: SuggestionItem,
): SuggestionItem[] {
  const text = textAfter(applied);
  const { start, end } = applied.range;
  const delta = (applied.replacement ?? '').length - (end - start);
  return items
    .filter((i) => i.id !== applied.id)
    .map((i) => {
      if (!sameField(i, applied) || i.expected === null) return i;
      if (i.range.end <= start) return { ...i, expected: text };
      if (i.range.start >= end) {
        return {
          ...i,
          expected: text,
          range: { start: i.range.start + delta, end: i.range.end + delta },
        };
      }
      return { ...i, expected: null };
    });
}

/** The change that takes `applied` back out, on the text it left. */
export function undoOf(applied: SuggestionItem): TextChange {
  const length = (applied.replacement ?? '').length;
  return {
    blockId: applied.blockId,
    field: applied.field,
    range: { start: applied.range.start, end: applied.range.start + length },
    original: applied.replacement ?? '',
    replacement: applied.original,
    expected: textAfter(applied),
  };
}

/**
 * The list once `applied` is taken back out: the items of its field as they were before
 * (`before`), the others as they are now (`now`), in their order.
 */
export function afterUndone(
  now: readonly SuggestionItem[],
  before: readonly SuggestionItem[],
  applied: SuggestionItem,
): SuggestionItem[] {
  return [
    ...now.filter((i) => !sameField(i, applied)),
    ...before.filter((i) => sameField(i, applied)),
  ].sort((a, b) => a.order - b.order);
}
