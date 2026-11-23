import { Extension } from '@tiptap/core';
import { closeHistory } from '@tiptap/pm/history';
import {
  Plugin,
  PluginKey,
  type EditorState,
  type Transaction,
} from '@tiptap/pm/state';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';

import { adaptCase } from '@openfolia/content-model/core';

import { snippetSuggestionsKey } from '../plugins/snippet-suggestions';
import { foldTerm, type TermHints, type TermOffer } from './term-hints';
import { fieldAt } from './writing-fields';
import { placeholderCommandKey } from '../slash/placeholder-command';
import { slashCommandKey } from '../slash/slash-command';

// Term suggestions while typing (#247): with the caret at the end of a word, a word (or the last
// few words) that starts an approved term's preferred variant shows the rest of it after the
// caret, as ghost text; Tab puts the preferred variant in, linked to the term (the `term` mark,
// #245), in one undo step. Words that are an approved term's allowed variant offer to link it
// (Tab), keeping the words as typed. Escape dismisses the offer for that place. Only in checked
// text fields, never in text marked as code, a link or a term already, and never while a snippet
// is suggested (#136), whose Tab comes first.

/** The most words before the caret a term is looked for in. */
export const MAX_TERM_WORDS = 4;

/** The offer shown now. */
export interface ShownTerm {
  readonly kind: 'complete' | 'link';
  readonly offer: TermOffer;
  /** The words typed: their range and text. */
  readonly from: number;
  readonly to: number;
  readonly typed: string;
  /** For a completion: the rest of the preferred variant after what was typed. */
  readonly rest: string;
}

interface TermState {
  readonly hints: TermHints | null;
  /** An offer dismissed with Escape: its words' start (mapped) and term. */
  readonly dismissed: { readonly from: number; readonly termId: string } | null;
  readonly shown: ShownTerm | null;
}

type Meta = { readonly hints: TermHints | null } | { readonly dismiss: true };

export const termSuggestionsKey = new PluginKey<TermState>(
  'docEditorTermSuggestions',
);

const WORD = /[\p{L}\p{N}\p{M}]/u;
const BLOCKING_MARKS = new Set(['code', 'link', 'term']);

/** The term offered at the caret, if any. */
export function offerAt(
  state: Pick<EditorState, 'selection' | 'doc'>,
  hints: TermHints | null,
): ShownTerm | null {
  if (!hints || hints.empty) return null;
  const { selection } = state;
  if (!selection.empty) return null;
  const $at = selection.$from;
  const parent = $at.parent;
  if (!parent.inlineContent || !fieldAt(state.doc, $at.pos)) return null;
  const offset = $at.parentOffset;
  // The caret ends a word: nothing of a word right after it.
  const after = parent.textBetween(
    offset,
    Math.min(parent.content.size, offset + 1),
    '￼',
    '￼',
  );
  if (after && WORD.test(after)) return null;
  const start = Math.max(0, offset - 200);
  const tail = parent.textBetween(start, offset, '￼', '￼');
  if (!tail || !WORD.test(tail.slice(-1))) return null;
  // The starts of the last few words, nearest last; words joined by single spaces.
  const starts: number[] = [];
  let i = tail.length;
  while (starts.length < MAX_TERM_WORDS && i > 0) {
    let j = i;
    while (j > 0 && WORD.test(tail[j - 1] ?? '')) j--;
    if (j === i) break;
    starts.push(j);
    if (j < 2 || tail[j - 1] !== ' ' || !WORD.test(tail[j - 2] ?? '')) break;
    i = j - 1;
  }
  // A "/" or "{" menu's query (an open menu is caught in `shownTerm`; this keeps a dismissed
  // one's query quiet too): "{" opens anywhere, "/" at the text's start or after a space or an
  // inline node. "and/or" is no query.
  const last = starts[0];
  if (last === undefined) return null;
  const trigger = tail[last - 1] ?? '';
  const before = last - 1 === 0 && start === 0 ? '' : (tail[last - 2] ?? '');
  if (
    trigger === '{' ||
    (trigger === '/' && (before === '' || /[\s￼]/.test(before)))
  )
    return null;
  const base = $at.pos - offset + start;
  for (const s of starts.reverse()) {
    const typed = tail.slice(s);
    const from = base + s;
    const to = $at.pos;
    let blocked = false;
    state.doc.nodesBetween(from, to, (node) => {
      if (
        node.isText &&
        node.marks.some((m) => BLOCKING_MARKS.has(m.type.name))
      )
        blocked = true;
    });
    if (blocked) continue;
    const link = hints.linkable(typed);
    if (link) return { kind: 'link', offer: link, from, to, typed, rest: '' };
    const done = hints.completion(typed);
    if (
      done &&
      foldTerm(done.preferred.slice(0, typed.length)) === foldTerm(typed)
    ) {
      return {
        kind: 'complete',
        offer: done,
        from,
        to,
        typed,
        rest: done.preferred.slice(typed.length),
      };
    }
  }
  return null;
}

function apply(tr: Transaction, value: TermState): TermState {
  const meta = tr.getMeta(termSuggestionsKey) as Meta | undefined;
  const hints = meta && 'hints' in meta ? meta.hints : value.hints;
  let dismissed = value.dismissed;
  if (meta && 'dismiss' in meta && value.shown) {
    dismissed = { from: value.shown.from, termId: value.shown.offer.termId };
  } else if (dismissed) {
    const mapped = tr.mapping.mapResult(dismissed.from);
    dismissed = mapped.deleted ? null : { ...dismissed, from: mapped.pos };
  }
  let shown = offerAt(tr, hints);
  if (
    shown &&
    dismissed &&
    dismissed.from === shown.from &&
    dismissed.termId === shown.offer.termId
  ) {
    shown = null;
  } else if (dismissed && shown?.from !== dismissed.from) {
    // Dismissed until the caret leaves those words.
    dismissed = null;
  }
  return { hints, dismissed, shown };
}

/** The offer shown now, if any (none while a snippet is suggested). */
export function shownTerm(state: EditorState): ShownTerm | null {
  if (snippetSuggestionsKey.getState(state)?.shown) return null;
  // A "/" or "{" menu open: Tab and Escape are its keys, its query no text to complete.
  if (
    [slashCommandKey, placeholderCommandKey].some(
      (key) =>
        (key.getState(state) as { active?: boolean } | undefined)?.active,
    )
  )
    return null;
  return termSuggestionsKey.getState(state)?.shown ?? null;
}

/** Hands over the terms to offer (null: none). Not an edit: no undo step. */
export function setTermHints(view: EditorView, hints: TermHints | null): void {
  if (termSuggestionsKey.getState(view.state)?.hints === hints) return;
  view.dispatch(
    view.state.tr
      .setMeta(termSuggestionsKey, { hints } satisfies Meta)
      .setMeta('addToHistory', false),
  );
}

/**
 * Accepts the offer shown: the preferred variant (in the case typed) or the words as typed,
 * linked to the term, in one undo step of its own. False when nothing is offered.
 */
export function acceptTerm(view: EditorView): boolean {
  const shown = shownTerm(view.state);
  const type = view.state.schema.marks['term'];
  if (!shown || !type || !view.editable) return false;
  const mark = type.create({ termId: shown.offer.termId });
  const tr = view.state.tr;
  let end = shown.to;
  if (shown.kind === 'complete') {
    const text = adaptCase(shown.typed, shown.offer.preferred);
    tr.insertText(text, shown.from, shown.to);
    end = shown.from + text.length;
  }
  tr.addMark(shown.from, end, mark).removeStoredMark(type);
  view.dispatch(closeHistory(tr).scrollIntoView());
  return true;
}

function ghost(
  shown: ShownTerm,
  translate: (key: string, params?: Record<string, unknown>) => string,
): HTMLElement {
  const span = document.createElement('span');
  span.className = 'doc-editor-term-ghost';
  span.contentEditable = 'false';
  span.setAttribute('aria-hidden', 'true');
  span.dataset['term'] = shown.offer.termId;
  span.dataset['kind'] = shown.kind;
  if (shown.kind === 'complete') span.textContent = shown.rest;
  const key = document.createElement('kbd');
  key.className = 'doc-editor-snippet-key';
  key.textContent = translate('editor.docEditor.snippet.tabKey');
  span.append(key);
  if (shown.kind === 'link') {
    const hint = document.createElement('span');
    hint.className = 'doc-editor-term-ghost-hint';
    hint.textContent = translate('editor.writing.term.linkHint', {
      term: shown.offer.preferred,
    });
    span.append(hint);
  }
  return span;
}

/**
 * What a key does while a term is offered: Tab accepts it, Escape dismisses it (the shortcut
 * reference lists them); null for any other key.
 */
export function termKeyAction(
  event: Pick<
    KeyboardEvent,
    'key' | 'shiftKey' | 'ctrlKey' | 'metaKey' | 'altKey'
  >,
): 'accept' | 'dismiss' | null {
  if (event.ctrlKey || event.metaKey || event.altKey) return null;
  if (event.key === 'Escape') return 'dismiss';
  return event.key === 'Tab' && !event.shiftKey ? 'accept' : null;
}

export interface TermSuggestionOptions {
  translate: (key: string, params?: Record<string, unknown>) => string;
  announce: (text: string) => void;
}

export const TermSuggestions = Extension.create<TermSuggestionOptions>({
  name: 'termSuggestions',
  // After the snippet suggestions' Tab (1000), before the lists' and tables'.
  priority: 990,
  addOptions() {
    return { translate: (key) => key, announce: () => undefined };
  },
  addProseMirrorPlugins() {
    const { translate, announce } = this.options;
    let announced = '';
    return [
      new Plugin<TermState>({
        key: termSuggestionsKey,
        state: {
          init: () => ({ hints: null, dismissed: null, shown: null }),
          apply,
        },
        view: () => ({
          update: (view) => {
            const shown = view.editable ? shownTerm(view.state) : null;
            const id = shown ? `${shown.kind}:${shown.offer.termId}` : '';
            if (shown && id !== announced)
              announce(
                translate(
                  shown.kind === 'complete'
                    ? 'editor.writing.term.completeSuggested'
                    : 'editor.writing.term.linkSuggested',
                  { term: shown.offer.preferred },
                ),
              );
            announced = id;
          },
        }),
        props: {
          decorations: (state) => {
            const shown = shownTerm(state);
            if (!shown) return null;
            return DecorationSet.create(state.doc, [
              Decoration.widget(shown.to, () => ghost(shown, translate), {
                side: 1,
                ignoreSelection: true,
                key: `term:${shown.kind}:${shown.offer.termId}:${shown.rest}`,
              }),
            ]);
          },
          handleKeyDown: (view, event) => {
            if (!view.editable || view.composing) return false;
            const action = termKeyAction(event);
            const shown = action ? shownTerm(view.state) : null;
            if (!shown) return false;
            if (action === 'dismiss') {
              view.dispatch(
                view.state.tr
                  .setMeta(termSuggestionsKey, { dismiss: true } satisfies Meta)
                  .setMeta('addToHistory', false),
              );
              return true;
            }
            if (!acceptTerm(view)) return false;
            announce(
              translate('editor.writing.term.linked', {
                term: shown.offer.preferred,
              }),
            );
            return true;
          },
        },
      }),
    ];
  },
});
