import { Extension, type Editor, type Range } from '@tiptap/core';
import { PluginKey, type EditorState } from '@tiptap/pm/state';
import Suggestion, {
  type SuggestionKeyDownProps,
  type SuggestionProps,
} from '@tiptap/suggestion';

import { canInsertInline } from '../inline/inline-edit';
import { PLACEHOLDER_LABELS } from '../inline/placeholders';
import type { SlashMenuState, SlashMenuView } from './slash-command';
import { filterSlashItems, type SlashItem } from './slash-items';

import type { PlaceholderKey } from '@openfolia/content-model/core';

export interface PlaceholderCommandOptions {
  /** The placeholders offered, in this order; none: `{` is just a character. */
  keys: readonly PlaceholderKey[];
  /** The menu (the slash menu's, which shows one list at a time). */
  view: SlashMenuView | null;
  translate: (
    key: string,
    params?: Readonly<Record<string, unknown>>,
  ) => string;
}

export const placeholderCommandKey = new PluginKey('docEditorPlaceholders');

/** Whether a placeholder may go at the selection: in a line of text, not in code. */
export function canInsertPlaceholder(state: EditorState): boolean {
  return canInsertInline(state, 'placeholder');
}

/** Puts a placeholder of `key` in place of `range` (the typed `{query}`). */
export function insertPlaceholder(
  editor: Editor,
  range: Range,
  key: PlaceholderKey,
): void {
  editor
    .chain()
    .focus()
    .deleteRange(range)
    .insertContent([{ type: 'placeholder', attrs: { key } }])
    .run();
}

/** The `{` menu's rows: one per placeholder, its name as the label and its key as the hint. */
export function placeholderItems(
  keys: readonly PlaceholderKey[],
): readonly SlashItem[] {
  return keys.map((key): SlashItem => ({
    id: `placeholder:${key}`,
    label: PLACEHOLDER_LABELS[key],
    hint: 'editor.docEditor.placeholder.keyHint',
    hintParams: { key },
    icon: 'lucideBraces',
    terms: [key, ...key.split('-')],
    run: (editor, range) => insertPlaceholder(editor, range, key),
  }));
}

/**
 * Typing `{` in a page design region (#393) opens a menu of the placeholders it may hold; the
 * text after it filters the menu, Enter or a click puts the chosen one in as a chip. Only the
 * keys given are offered, so an unknown placeholder can never be typed in. Escape, a space or a
 * key that matches nothing leaves the `{` as text.
 */
export const PlaceholderCommand = Extension.create<PlaceholderCommandOptions>({
  name: 'placeholderCommand',
  addOptions() {
    return { keys: [], view: null, translate: (key) => key };
  },
  addProseMirrorPlugins() {
    const { view, keys, translate } = this.options;
    if (!view || keys.length === 0) return [];
    const all = placeholderItems(keys);
    type Props = SuggestionProps<SlashItem, SlashItem>;
    const toState = (props: Props): SlashMenuState => ({
      items: props.items,
      reasons: new Map(),
      query: props.query,
      label: 'editor.docEditor.placeholder.menu',
      empty: 'editor.docEditor.placeholder.empty',
      choose: (item) => props.command(item),
      mount: (element) => props.mount(element),
    });
    return [
      Suggestion<SlashItem, SlashItem>({
        pluginKey: placeholderCommandKey,
        editor: this.editor,
        char: '{',
        allowedPrefixes: null,
        allow: ({ state }) => canInsertPlaceholder(state),
        items: ({ query }) => filterSlashItems(all, query, translate),
        command: ({
          editor,
          range,
          props: item,
        }: {
          editor: Editor;
          range: Range;
          props: SlashItem;
        }) => item.run(editor, range),
        floatingUi: { strategy: 'fixed' },
        render: () => ({
          onStart: (props: Props) => view.open(toState(props)),
          onUpdate: (props: Props) => view.update(toState(props)),
          onKeyDown: ({ event }: SuggestionKeyDownProps) => view.keyDown(event),
          onExit: () => view.close(),
        }),
      }),
    ];
  },
});
