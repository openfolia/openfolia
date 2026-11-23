import type { TextFinding } from '@openfolia/content-model/core';

// What a writing finding says, in the UI language (#247): a term's in our own words, a style
// rule's as configured (the configuration's text, shown as text only and cut to a length), a
// sentence's length with its count. Framework-free.

/** The longest configured message or text shown (the rest is cut, with an ellipsis). */
export const MAX_SHOWN_FINDING = 500;

const cut = (value: string): string =>
  value.length > MAX_SHOWN_FINDING
    ? `${value.slice(0, MAX_SHOWN_FINDING - 1)}…`
    : value;

type Translate = (key: string, params?: Record<string, unknown>) => string;

/** The finding's message. */
export function findingMessage(f: TextFinding, t: Translate): string {
  const text = cut(f.text);
  switch (f.rule.kind) {
    case 'term':
      return t(
        f.rule.status === 'forbidden'
          ? 'editor.writing.finding.forbidden'
          : 'editor.writing.finding.deprecated',
        { text },
      );
    case 'sentence-length':
      return t('editor.writing.finding.sentence', {
        words: f.rule.words,
        max: f.rule.max,
      });
    default:
      return cut(f.message);
  }
}

/** A term variant's note, when the term gives one. */
export function findingNote(f: TextFinding): string | null {
  return f.rule.kind === 'term' && f.rule.note ? cut(f.rule.note) : null;
}

/** The severity's word (never the colour alone). */
export const severityLabel = (f: Pick<TextFinding, 'severity'>): string =>
  f.severity === 'blocking'
    ? 'editor.writing.severity.blocking'
    : 'editor.writing.severity.warning';

/** The replacement as shown: cut to a length. */
export const shownReplacement = (value: string): string => cut(value);
