import type { Extensions } from '@tiptap/core';
import type { EditorState } from '@tiptap/pm/state';
import { BubbleMenu } from '@tiptap/extension-bubble-menu';
import { UndoRedo } from '@tiptap/extensions';
import { createEditorExtensions as modelExtensions } from '@openfolia/content-editor-model';

import type { AngularHost } from './blocks/angular-node-view';
import { BlockMotion } from './blocks/block-motion';
import { withDocBlocks } from './blocks/doc-blocks';
import { ImageFiles } from './blocks/image-files';
import { InlineEditing, withInlineViews } from './inline/inline-views';
import { BlockDrag } from './plugins/block-drag';
import { BlankLines } from './plugins/blank-lines';
import { BlockIssues } from './plugins/block-issues';
import { BlockMenu, type BlockMenuOptions } from './plugins/block-menu';
import { BlockMoveKeys } from './plugins/block-move-keys';
import { CaretGaps } from './plugins/caret-gaps';
import { CaretPlaceholder } from './plugins/caret-placeholder';
import { CaretSync } from './plugins/caret-sync';
import { HeadingLevels } from './plugins/heading-levels';
import { ModelKeys } from './plugins/model-keys';
import { ModelRepair } from './plugins/model-repair';
import { PasteGuard } from './plugins/paste-guard';
import { CodeKeys } from './plugins/procedure-steps';
import { TableKeys, withTables } from './plugins/table-editing';
import { SnippetSuggestions } from './plugins/snippet-suggestions';
import { TermSuggestions } from './writing/term-suggestions';
import {
  WritingChecks,
  type WritingChecksOptions,
} from './writing/writing-checks';
import type { PlaceholderKey } from '@openfolia/content-model/core';

import { PlaceholderCommand } from './slash/placeholder-command';
import { SlashCommand, type SlashMenuView } from './slash/slash-command';
import { SLASH_ITEMS, type SlashItem } from './slash/slash-items';

export interface EditorExtensionOptions {
  /** The slash menu's UI; null leaves `/` a plain character. */
  slashMenu: SlashMenuView | null;
  /** The element the selection bubble shows; null leaves the bubble out. */
  bubble: HTMLElement | null;
  /** The empty block's hint, in the UI language (read each time it is drawn). */
  placeholder?: () => string;
  /** An empty section heading's hint, in the UI language. */
  titlePlaceholder?: () => string;
  /** An empty hazard's hint (a safety notice's first line), in the UI language. */
  hazardPlaceholder?: () => string;
  /** Where the documentation blocks' node views live; null keeps the model's HTML for them. */
  blocks?: AngularHost | null;
  /** The slash menu's, the placeholders' and the block drag's texts are translation keys: this
   * finds them as the person reads them. */
  translate?: (key: string, params?: Record<string, unknown>) => string;
  /** After a keyboard move, to announce the block's new place. */
  onMoved?: (state: EditorState) => void;
  /** Shows the block actions menu (the grip's click, Shift+F10); without it there is none. */
  blockMenu?: BlockMenuOptions['open'];
  /**
   * The deepest heading level offered (`ProjectConfig.maxHeadingLevel`); 3 when not given. A
   * later configuration sets it with `setHeadingCap`.
   */
  headingCap?: number;
  /** Mod+Shift+Enter: opens the toolbar's Insert menu; false when there is none. */
  onInsertMenu?: () => boolean;
  /** What "/" offers; every item (`SLASH_ITEMS`) when not given. */
  slashItems?: readonly SlashItem[];
  /**
   * The placeholders typing `{` offers (a page design region's editor, #393), in the slash
   * menu's UI; none (the default): `{` is just a character.
   */
  placeholders?: readonly PlaceholderKey[];
  /** For screen readers: a snippet suggested or accepted (`plugins/snippet-suggestions`). */
  announce?: (text: string) => void;
  /** A snippet suggestion that could not be accepted (the snippet could not be read). */
  onSnippetFailed?: (title: string) => void;
  /** The writing checks' findings and caret (`writing/writing-checks`, #247). */
  writing?: Partial<WritingChecksOptions>;
}

/**
 * The exact list the playground's editor runs with: the content model's schema
 * (`@openfolia/content-editor-model`, with tables as editable grids and the other blocks drawn by
 * their node views), and the behaviour on top of it, never another node type.
 */
export function createEditorExtensions(
  options: EditorExtensionOptions,
): Extensions {
  const extensions: Extensions = [
    ...withInlineViews(
      withDocBlocks(withTables(modelExtensions()), options.blocks ?? null),
    ),
    InlineEditing.configure({
      translate: options.translate ?? ((key) => key),
      onInsertMenu: options.onInsertMenu ?? (() => false),
    }),
    UndoRedo,
    ImageFiles,
    CaretPlaceholder.configure({
      placeholder: (node, parent) =>
        node.type.name === 'title'
          ? parent.type.name === 'procedure'
            ? (options.translate?.(
                'editor.docEditor.procedure.titlePlaceholder',
              ) ?? '')
            : (options.titlePlaceholder?.() ?? '')
          : node.type.name === 'hazard'
            ? (options.hazardPlaceholder?.() ?? '')
            : node.type.name === 'question'
              ? (options.translate?.(
                  'editor.docEditor.faq.questionPlaceholder',
                ) ?? '')
              : (options.placeholder?.() ?? ''),
    }),
    HeadingLevels.configure(
      options.headingCap === undefined ? {} : { cap: options.headingCap },
    ),
    CodeKeys,
    TableKeys,
    ModelKeys,
    PasteGuard,
    CaretGaps,
    CaretSync,
    BlankLines,
    ModelRepair,
    BlockDrag.configure({ translate: options.translate ?? ((key) => key) }),
    BlockMenu.configure({ open: options.blockMenu ?? null }),
    BlockIssues,
    BlockMotion,
    BlockMoveKeys.configure({ onMoved: options.onMoved ?? (() => undefined) }),
    SnippetSuggestions.configure({
      translate: options.translate ?? ((key) => key),
      announce: options.announce ?? (() => undefined),
      failed: options.onSnippetFailed ?? (() => undefined),
    }),
    TermSuggestions.configure({
      translate: options.translate ?? ((key) => key),
      announce: options.announce ?? (() => undefined),
    }),
    WritingChecks.configure({
      onFindings: options.writing?.onFindings ?? (() => undefined),
      onCaret: options.writing?.onCaret ?? (() => undefined),
      openAt: options.writing?.openAt ?? (() => false),
    }),
    SlashCommand.configure({
      items: options.slashItems ?? SLASH_ITEMS,
      view: options.slashMenu,
      translate: options.translate ?? ((key) => key),
    }),
    PlaceholderCommand.configure({
      keys: options.placeholders ?? [],
      view: options.slashMenu,
      translate: options.translate ?? ((key) => key),
    }),
  ];
  if (options.bubble) {
    extensions.push(
      BubbleMenu.configure({
        element: options.bubble,
        options: {
          placement: 'top',
          strategy: 'fixed',
          offset: 8,
          flip: true,
          shift: true,
        },
        // Over a text selection only: not in code, not over a selected block.
        shouldShow: ({ editor, state, from, to }) =>
          editor.isEditable &&
          editor.isFocused &&
          from !== to &&
          !state.selection.empty &&
          state.selection.$from.parent.isTextblock &&
          !state.selection.$from.parent.type.spec.code,
      }),
    );
  }
  return extensions;
}
