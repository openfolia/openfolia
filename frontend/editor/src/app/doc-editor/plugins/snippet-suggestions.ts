import { Extension, type Editor } from '@tiptap/core';
import { closeHistory } from '@tiptap/pm/history';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import {
  Plugin,
  PluginKey,
  type EditorState,
  type Transaction,
} from '@tiptap/pm/state';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';

import { docBlocksOf } from '../blocks/doc-blocks-context';
import {
  matchSnippet,
  type SnippetSuggestion,
} from '../snippets/snippet-match';
import { replaceWithSnippet, snippetCopy } from '../snippets/snippet-blocks';

// Snippet suggestions while typing: once a paragraph's first words are the start of a snippet's
// text, the rest of it shows after the caret as ghost text (in the line, never over it). Tab
// puts a reference to the snippet in the paragraph's place, Shift+Tab a copy of its blocks (new
// IDs), Escape dismisses it for that paragraph. One suggestion at a time, only with the caret at
// the end of a paragraph of plain text, and only where a module reference may stand. The host
// hands the snippets over (`setSnippets`): the ones the person may read, in the document's
// language, the edited module itself left out.

/** The suggestion shown now. */
export interface ShownSuggestion {
  readonly snippet: SnippetSuggestion;
  /** The rest of the snippet's text after what was typed. */
  readonly rest: string;
  /** The paragraph's position and the caret's (its end). */
  readonly from: number;
  readonly to: number;
}

interface SuggestionState {
  readonly snippets: readonly SnippetSuggestion[];
  /** A suggestion dismissed with Escape: its paragraph (mapped as the document changes) and snippet. */
  readonly dismissed: { readonly pos: number; readonly id: string } | null;
  readonly shown: ShownSuggestion | null;
}

type Meta =
  | { readonly snippets: readonly SnippetSuggestion[] }
  | { readonly dismiss: true };

export const snippetSuggestionsKey = new PluginKey<SuggestionState>(
  'docEditorSnippetSuggestions',
);

/** Hands over the snippets to suggest, in place of those so far (not an edit: no undo step). */
export function setSnippets(
  view: EditorView,
  snippets: readonly SnippetSuggestion[],
): void {
  view.dispatch(
    view.state.tr
      .setMeta(snippetSuggestionsKey, { snippets } satisfies Meta)
      .setMeta('addToHistory', false),
  );
}

/** The suggestion shown now, if any. */
export function shownSuggestion(state: EditorState): ShownSuggestion | null {
  return snippetSuggestionsKey.getState(state)?.shown ?? null;
}

/** The paragraph the caret ends, when it is one a snippet could complete. */
function paragraphAtCaret(
  state: Pick<EditorState, 'selection' | 'schema'>,
): { node: ProseMirrorNode; pos: number } | null {
  const { selection } = state;
  if (!selection.empty) return null;
  const $at = selection.$from;
  const node = $at.parent;
  if (node.type.name !== 'paragraph' || $at.depth < 1) return null;
  if ($at.parentOffset !== node.content.size || node.content.size === 0)
    return null;
  // Plain text only: an atom in the line (a text attribute, a cross-reference) is no match.
  let plain = true;
  node.forEach((child) => {
    if (!child.isText) plain = false;
  });
  if (!plain) return null;
  const reference = state.schema.nodes['moduleRef'];
  const parent = $at.node(-1);
  const index = $at.index(-1);
  if (!reference || !parent.canReplaceWith(index, index + 1, reference))
    return null;
  return { node, pos: $at.before() };
}

function suggest(
  state: Pick<EditorState, 'selection' | 'schema'>,
  snippets: readonly SnippetSuggestion[],
  dismissed: SuggestionState['dismissed'],
): ShownSuggestion | null {
  if (snippets.length === 0) return null;
  const paragraph = paragraphAtCaret(state);
  if (!paragraph) return null;
  const match = matchSnippet(paragraph.node.textContent, snippets);
  if (!match) return null;
  if (dismissed?.pos === paragraph.pos && dismissed.id === match.snippet.id)
    return null;
  return {
    snippet: match.snippet,
    rest: match.rest,
    from: paragraph.pos,
    to: paragraph.pos + paragraph.node.nodeSize,
  };
}

function apply(tr: Transaction, value: SuggestionState): SuggestionState {
  const meta = tr.getMeta(snippetSuggestionsKey) as Meta | undefined;
  const snippets = meta && 'snippets' in meta ? meta.snippets : value.snippets;
  let dismissed = value.dismissed;
  if (meta && 'dismiss' in meta && value.shown)
    dismissed = { pos: value.shown.from, id: value.shown.snippet.id };
  else if (dismissed) {
    const mapped = tr.mapping.mapResult(dismissed.pos);
    const here = paragraphAtCaret({
      selection: tr.selection,
      schema: tr.doc.type.schema,
    });
    // Dismissed until the caret leaves that paragraph.
    dismissed =
      mapped.deleted || here?.pos !== mapped.pos
        ? null
        : { pos: mapped.pos, id: dismissed.id };
  }
  const shown = suggest(
    { selection: tr.selection, schema: tr.doc.type.schema },
    snippets,
    dismissed,
  );
  return { snippets, dismissed, shown };
}

function ghost(
  shown: ShownSuggestion,
  hint: (key: string) => string,
): HTMLElement {
  const span = document.createElement('span');
  span.className = 'doc-editor-snippet-ghost';
  span.contentEditable = 'false';
  span.setAttribute('aria-hidden', 'true');
  span.dataset['snippet'] = shown.snippet.id;
  span.textContent = shown.rest;
  const key = document.createElement('kbd');
  key.className = 'doc-editor-snippet-key';
  key.textContent = hint('editor.docEditor.snippet.tabKey');
  span.append(key);
  return span;
}

export interface SnippetSuggestionOptions {
  /** Texts are translation keys: this finds them as the person reads them. */
  translate: (key: string, params?: Record<string, unknown>) => string;
  /** Says what happened (a suggestion shown, accepted) for screen readers. */
  announce: (text: string) => void;
  /** A snippet that could not be read for a copy (or put in place): the host tells the person. */
  failed: (title: string) => void;
}

/**
 * What a key does while a snippet is suggested: Tab inserts it as a reference, Shift+Tab as a
 * copy, Escape dismisses it (the shortcut reference lists them); null for any other key.
 */
export function snippetKeyAction(
  event: Pick<
    KeyboardEvent,
    'key' | 'shiftKey' | 'ctrlKey' | 'metaKey' | 'altKey'
  >,
): 'reference' | 'copy' | 'dismiss' | null {
  if (event.ctrlKey || event.metaKey || event.altKey) return null;
  if (event.key === 'Escape') return 'dismiss';
  if (event.key !== 'Tab') return null;
  return event.shiftKey ? 'copy' : 'reference';
}

/** Accepts the suggestion shown: a reference, or a copy (read through the page first). */
export async function acceptSuggestion(
  editor: Editor,
  mode: 'reference' | 'copy',
): Promise<boolean> {
  const shown = shownSuggestion(editor.state);
  if (!shown || !editor.isEditable) return false;
  if (mode === 'reference') {
    const tr = replaceWithSnippet(editor.state, shown.from, shown.to, {
      mode: 'reference',
      moduleId: shown.snippet.id,
    });
    if (!tr) return false;
    // An undo step of its own: Undo brings back the words as typed.
    editor.view.dispatch(closeHistory(tr));
    return true;
  }
  const read = docBlocksOf(editor)?.settings().moduleContent;
  const content = await read?.(shown.snippet.id);
  if (!content || editor.isDestroyed || !editor.isEditable) return false;
  // The person may have typed on meanwhile: only the same suggestion, where it is now.
  const now = shownSuggestion(editor.state);
  if (now?.snippet.id !== shown.snippet.id) return false;
  const tr = replaceWithSnippet(editor.state, now.from, now.to, {
    mode: 'copy',
    blocks: snippetCopy(editor.schema, content.blocks),
  });
  if (!tr) return false;
  // An undo step of its own: Undo brings back the words as typed.
  editor.view.dispatch(closeHistory(tr));
  return true;
}

export const SnippetSuggestions = Extension.create<SnippetSuggestionOptions>({
  name: 'snippetSuggestions',
  // Before the lists' and tables' Tab, and the other Escape handlers.
  priority: 1000,
  addOptions() {
    return {
      translate: (key) => key,
      announce: () => undefined,
      failed: () => undefined,
    };
  },
  addProseMirrorPlugins() {
    const editor = this.editor;
    const { translate, announce, failed } = this.options;
    let announced = '';
    return [
      new Plugin<SuggestionState>({
        key: snippetSuggestionsKey,
        state: {
          init: () => ({ snippets: [], dismissed: null, shown: null }),
          apply,
        },
        view: () => ({
          update: (view) => {
            const shown = shownSuggestion(view.state);
            const id = shown && view.editable ? shown.snippet.id : '';
            if (id && id !== announced)
              announce(
                translate('editor.docEditor.snippet.suggested', {
                  title: shown?.snippet.title ?? '',
                }),
              );
            announced = id;
          },
        }),
        props: {
          decorations: (state) => {
            const shown = shownSuggestion(state);
            if (!shown || !editor.isEditable) return null;
            return DecorationSet.create(state.doc, [
              Decoration.widget(shown.to - 1, () => ghost(shown, translate), {
                side: 1,
                ignoreSelection: true,
                key: `snippet:${shown.snippet.id}:${shown.rest}`,
              }),
            ]);
          },
          handleKeyDown: (view, event) => {
            const shown = shownSuggestion(view.state);
            if (!shown || !view.editable || view.composing) return false;
            const action = snippetKeyAction(event);
            if (!action) return false;
            if (action === 'dismiss') {
              view.dispatch(
                view.state.tr
                  .setMeta(snippetSuggestionsKey, {
                    dismiss: true,
                  } satisfies Meta)
                  .setMeta('addToHistory', false),
              );
              return true;
            }
            const mode = action;
            const { title } = shown.snippet;
            void acceptSuggestion(editor, mode).then(
              (done) => {
                if (done)
                  announce(
                    translate(
                      mode === 'copy'
                        ? 'editor.docEditor.snippet.copied'
                        : 'editor.docEditor.snippet.referenced',
                      { title },
                    ),
                  );
                // Not done because the person typed on is no failure; a snippet gone is.
                else if (
                  shownSuggestion(editor.state)?.snippet.id === shown.snippet.id
                )
                  failed(title);
              },
              () => failed(title),
            );
            return true;
          },
        },
      }),
    ];
  },
});
