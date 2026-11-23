import { Extension, type Editor, type Range } from '@tiptap/core';
import { PluginKey } from '@tiptap/pm/state';
import type { ResolvedPos } from '@tiptap/pm/model';
import Suggestion, {
  type SuggestionKeyDownProps,
  type SuggestionProps,
} from '@tiptap/suggestion';

import {
  filterSlashItems,
  SLASH_ITEMS,
  type SlashItem,
  type SlashText,
} from './slash-items';

/** What the menu is told while a `/query` is being typed. */
export interface SlashMenuState {
  items: readonly SlashItem[];
  /** Why an item can't run at the caret, by its ID: it shows disabled, with the reason. */
  reasons: ReadonlyMap<string, SlashText>;
  query: string;
  /** The list's accessible name (a translation key); "Insert a block" when not given. */
  label?: string;
  /** What an empty list says (a translation key taking `query`); "No block matches" when not given. */
  empty?: string;
  /** Runs the chosen item in place of the typed `/query`; nothing for a disabled one. */
  choose: (item: SlashItem) => void;
  /** Anchors the menu's element at the caret; returns the function that lets it go. */
  mount: (element: HTMLElement) => () => void;
}

/**
 * The menu's side of the slash command, implemented by the UI (an Angular component here): the
 * extension stays free of any framework.
 */
export interface SlashMenuView {
  open(state: SlashMenuState): void;
  update(state: SlashMenuState): void;
  /** True when the menu used the key (arrows, Enter, Escape). */
  keyDown(event: KeyboardEvent): boolean;
  close(): void;
}

export interface SlashCommandOptions {
  items: readonly SlashItem[];
  /** The menu; without one, `/` is just a character. */
  view: SlashMenuView | null;
  /** Translates an item's label key, so the query matches what the person reads. */
  translate: (
    key: string,
    params?: Readonly<Record<string, unknown>>,
  ) => string;
}

export const slashCommandKey = new PluginKey('docEditorSlashCommand');

/** The character that opens the slash menu (the shortcut reference lists it). */
export const SLASH_CHAR = '/';

type Props = SuggestionProps<SlashItem, SlashItem>;

function toState(props: Props): SlashMenuState {
  const { state } = props.editor;
  const reasons = new Map<string, SlashText>();
  for (const item of props.items) {
    const reason = item.reason?.(state);
    if (reason) reasons.set(item.id, reason);
  }
  return {
    items: props.items,
    reasons,
    query: props.query,
    choose: (item) => {
      if (!reasons.has(item.id)) props.command(item);
    },
    mount: (element) => props.mount(element),
  };
}

/** Where a slash may open the menu: a paragraph, a procedure step's text, or neither. */
function slashPlace($pos: ResolvedPos): 'paragraph' | 'step' | null {
  if ($pos.parent.type.name === 'paragraph') return 'paragraph';
  return $pos.parent.type.name === 'itemText' &&
    $pos.depth >= 3 &&
    $pos.node(-2).type.name === 'procedure'
    ? 'step'
    : null;
}

/** Typing `/` opens a menu of blocks to insert; the text after it filters the menu. */
export const SlashCommand = Extension.create<SlashCommandOptions>({
  name: 'slashCommand',
  addOptions() {
    return { items: SLASH_ITEMS, view: null, translate: (key) => key };
  },
  addProseMirrorPlugins() {
    const view = this.options.view;
    const all = this.options.items;
    const translate = this.options.translate;
    if (!view) return [];
    return [
      Suggestion<SlashItem, SlashItem>({
        pluginKey: slashCommandKey,
        editor: this.editor,
        char: SLASH_CHAR,
        // In a paragraph, and in a procedure step's text for what a step offers (its result): a
        // slash in a heading or a list item is text.
        allow: ({ state, range }) => {
          const where = slashPlace(state.doc.resolve(range.from));
          return (
            where === 'paragraph' ||
            (where === 'step' && all.some((item) => item.inStep))
          );
        },
        items: ({ query, editor }) =>
          filterSlashItems(
            all.filter(
              (item) =>
                (slashPlace(editor.state.selection.$from) === 'step'
                  ? item.inStep === true
                  : true) &&
                (item.available?.(editor.state, editor) ?? true),
            ),
            query,
            translate,
          ),
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
