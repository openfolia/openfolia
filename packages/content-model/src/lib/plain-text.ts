import { placeholderText } from './placeholder.js';
import type { Inline } from './inline.js';

/** A stretch of a `PlainText` that stands for an inline node, not typed text. */
export interface PlainTextAtom {
  /** Offsets in UTF-16 code units, `start` inclusive, `end` exclusive. */
  readonly start: number;
  readonly end: number;
}

/**
 * Inline content as one string, for a reader that takes plain text (a
 * language model, a writing check): text runs as they are (marks dropped),
 * a hard break as `\n`, an attribute reference as `{name}`, a
 * cross-reference as its link text (`[xref]` without one), a keyboard
 * shortcut as its keys joined by `+`, a callout reference as `[callout]`
 * (its number depends on the manual), a page design's placeholder as
 * `[key]`. Everything but text runs is an
 * **atom**: a stretch no change may cut into or replace, since it is no
 * text the author typed. Offsets are UTF-16 code units, as in JavaScript
 * strings and the editor.
 */
export interface PlainText {
  readonly text: string;
  /** The atoms, in order, never overlapping. */
  readonly atoms: readonly PlainTextAtom[];
}

/** `content` as `PlainText`. */
export function plainTextOf(content: readonly Inline[]): PlainText {
  let text = '';
  const atoms: PlainTextAtom[] = [];
  const atom = (value: string) => {
    atoms.push({ start: text.length, end: text.length + value.length });
    text += value;
  };
  for (const node of content) {
    switch (node.type) {
      case 'text':
        text += node.text;
        break;
      case 'hardBreak':
        atom('\n');
        break;
      case 'attribute':
        atom(`{${node.name}}`);
        break;
      case 'xref':
        atom(node.text ? node.text.map((run) => run.text).join('') : '[xref]');
        break;
      case 'kbd':
        atom(node.keys.join('+'));
        break;
      case 'placeholder':
        atom(placeholderText(node.key));
        break;
      case 'calloutRef':
        atom('[callout]');
        break;
      default:
        node satisfies never;
    }
  }
  return { text, atoms };
}

/**
 * Whether `[start, end)` is a non-empty range of `plain`'s typed text: in
 * bounds, not splitting a UTF-16 surrogate pair, and not touching an atom.
 */
export function isTextRange(
  plain: PlainText,
  start: number,
  end: number,
): boolean {
  if (!Number.isInteger(start) || !Number.isInteger(end)) return false;
  if (start < 0 || end <= start || end > plain.text.length) return false;
  if (splitsPair(plain.text, start) || splitsPair(plain.text, end)) {
    return false;
  }
  return plain.atoms.every((a) => end <= a.start || start >= a.end);
}

/** Whether `at` falls between the two halves of a surrogate pair. */
function splitsPair(text: string, at: number): boolean {
  if (at <= 0 || at >= text.length) return false;
  const before = text.charCodeAt(at - 1);
  const after = text.charCodeAt(at);
  return (
    before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff
  );
}
