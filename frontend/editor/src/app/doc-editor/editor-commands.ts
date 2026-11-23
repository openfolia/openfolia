import { isActive, type Editor } from '@tiptap/core';
import type { Command, EditorState } from '@tiptap/pm/state';

import { blockPlace, canMoveBlock } from './plugins/block-move';
import { slidingMove } from './plugins/block-slide';
import {
  addColumn,
  addRow,
  deleteColumn,
  deleteRow,
  deleteTable,
  mergeDown,
  mergeRight,
  setColumnAlign,
  splitCell,
  toggleHeaderRow,
  type ColumnAlign,
} from './plugins/table-editing';
import {
  demoteHeading,
  headingCap,
  headingRefusal,
  promoteHeading,
  setHeadingLevel,
  textLevelAt,
  type HeadingRefusal,
} from './plugins/heading-levels';
import { inList, sectionToParagraph, toggleList } from './plugins/structure';
import type { injectTranslate } from '@openfolia/ui/i18n';
import {
  canPickAttachment,
  canPickImage,
  INSERT_BLOCK,
  insertAttachment,
  insertImage,
  pickAndInsertAttachment,
  pickAndInsertImage,
  type DocBlockType,
} from './blocks/doc-blocks';

/** A translate function (`injectTranslate()` from `@openfolia/ui`). */
export type Translate = ReturnType<typeof injectTranslate>;

// What the toolbar and the bubble do, and what they show as active, in one place: plain
// functions on the editor, tested without any UI. The names are the content model's.

/** Runs a ProseMirror command on the editor, with the focus in the document. */
export function runCommand(editor: Editor, command: Command): boolean {
  editor.commands.focus();
  return command(editor.state, editor.view.dispatch, editor.view);
}

/** The level of a line of text: 0 for text (a paragraph), n for a Heading n. */
export type TextLevel = number;

/**
 * The text styles the picker offers: text, then Heading 1 down to the cap. Each label is a
 * translation key with its parameters.
 */
export function textStyles(state: EditorState): readonly {
  level: TextLevel;
  label: string;
  params: { level: number };
}[] {
  const styles = [
    {
      level: 0,
      label: 'editor.docEditor.style.paragraph',
      params: { level: 0 },
    },
  ];
  for (let level = 1; level <= headingCap(state); level += 1)
    styles.push({
      level,
      label: 'editor.docEditor.style.heading',
      params: { level },
    });
  return styles;
}

/**
 * The style of the text the selection starts in: 0 for text (a paragraph anywhere), n for a
 * Heading n; null for anything else (a list item…).
 */
export function textLevelOf(state: EditorState): TextLevel | null {
  if (state.selection.$from.parent.type.name === 'paragraph') return 0;
  return textLevelAt(state);
}

/** The translation key and parameters of the text style at a level (Text, Heading n). */
export function textStyleLabel(level: TextLevel | null): {
  key: string;
  params: { level: number };
} {
  if (level === null)
    return {
      key: 'editor.docEditor.toolbar.textStyleNone',
      params: { level: 0 },
    };
  return level === 0
    ? { key: 'editor.docEditor.style.paragraph', params: { level } }
    : { key: 'editor.docEditor.style.heading', params: { level } };
}

/**
 * Why the text at the caret can't take that style, or null when it can (or already has it):
 * text from a heading always can; a heading level by `headingRefusal`.
 */
export function textStyleRefusal(
  state: EditorState,
  level: TextLevel,
): HeadingRefusal | null {
  const current = textLevelOf(state);
  if (current === null) return 'notHere';
  if (level === 0) return null;
  return headingRefusal(state, level);
}

/** Turns the text at the caret into that style; false when it can't be (or already is). */
export function setTextLevel(editor: Editor, level: TextLevel): boolean {
  const current = textLevelOf(editor.state);
  if (current === null || current === level) return false;
  if (level === 0) return runCommand(editor, sectionToParagraph);
  return runCommand(editor, setHeadingLevel(level));
}

/** Tab: the heading at the caret one level down. */
export function demote(editor: Editor): boolean {
  return runCommand(editor, demoteHeading);
}

/** Shift+Tab: the heading at the caret one level up. */
export function promote(editor: Editor): boolean {
  return runCommand(editor, promoteHeading);
}

export type Mark = 'strong' | 'emphasis' | 'code' | 'ui' | 'sub' | 'sup';

export function toggleMark(editor: Editor, mark: Mark): boolean {
  return editor.chain().focus().toggleMark(mark).run();
}

export type Wrap = 'bulletList' | 'orderedList';

export function toggleWrap(editor: Editor, wrap: Wrap): boolean {
  return runCommand(editor, toggleList(wrap === 'orderedList'));
}

/** Whether the caret is in a list of that kind. */
export function wrapActive(state: EditorState, wrap: Wrap): boolean {
  return inList(state, wrap === 'orderedList');
}

/** Moves the selection's block one step; the announcement for it, or null. */
export function moveBlock(
  editor: Editor,
  up: boolean,
  t: Translate,
): string | null {
  if (!slidingMove(editor.view, up)) return null;
  editor.commands.focus();
  return movedMessage(editor, t);
}

export function canMove(state: EditorState, up: boolean): boolean {
  return canMoveBlock(state, up);
}

/** Whether a mark or node is active at the selection of `state`. */
export function activeIn(state: EditorState, name: string): boolean {
  return isActive(state, name);
}

/** What a screen reader hears after a move. */
export function movedMessage(editor: Editor, t: Translate): string {
  return t('editor.docEditor.editor.moved', blockPlace(editor.state));
}

export type TableAction =
  | 'rowAbove'
  | 'rowBelow'
  | 'columnBefore'
  | 'columnAfter'
  | 'deleteRow'
  | 'deleteColumn'
  | 'deleteTable';

/** What can be done to the table at the caret; each label is a translation key. */
export const TABLE_ACTIONS: readonly {
  id: TableAction;
  label: string;
  command: Command;
  /** Changes rows or columns: not in a table with merged cells. */
  structural: boolean;
  /** Adds a row or a column: not in a table at the caps (#686, `tableRoom`). */
  grows?: 'row' | 'column';
  destructive?: boolean;
}[] = [
  {
    id: 'rowAbove',
    label: 'editor.docEditor.table.rowAbove',
    grows: 'row',
    command: addRow(false),
    structural: true,
  },
  {
    id: 'rowBelow',
    label: 'editor.docEditor.table.rowBelow',
    grows: 'row',
    command: addRow(true),
    structural: true,
  },
  {
    id: 'columnBefore',
    label: 'editor.docEditor.table.columnBefore',
    grows: 'column',
    command: addColumn(false),
    structural: true,
  },
  {
    id: 'columnAfter',
    label: 'editor.docEditor.table.columnAfter',
    grows: 'column',
    command: addColumn(true),
    structural: true,
  },
  {
    id: 'deleteRow',
    label: 'editor.docEditor.table.deleteRow',
    command: deleteRow,
    structural: true,
    destructive: true,
  },
  {
    id: 'deleteColumn',
    label: 'editor.docEditor.table.deleteColumn',
    command: deleteColumn,
    structural: true,
    destructive: true,
  },
  {
    id: 'deleteTable',
    label: 'editor.docEditor.table.deleteTable',
    command: deleteTable,
    structural: false,
    destructive: true,
  },
];

/** Runs a table action at the caret; false when it cannot run there. */
export function runTableAction(editor: Editor, id: TableAction): boolean {
  const action = TABLE_ACTIONS.find((a) => a.id === id);
  return !!action && runCommand(editor, action.command);
}

export type CellAction = 'mergeRight' | 'mergeDown' | 'splitCell';

/** What can be done to the caret's cell; each label is a translation key. */
export const CELL_ACTIONS: readonly {
  id: CellAction;
  label: string;
  command: Command;
}[] = [
  {
    id: 'mergeRight',
    label: 'editor.docEditor.table.mergeRight',
    command: mergeRight,
  },
  {
    id: 'mergeDown',
    label: 'editor.docEditor.table.mergeDown',
    command: mergeDown,
  },
  {
    id: 'splitCell',
    label: 'editor.docEditor.table.splitCell',
    command: splitCell,
  },
];

/** Runs a cell action at the caret; false when it cannot run there. */
export function runCellAction(editor: Editor, id: CellAction): boolean {
  const action = CELL_ACTIONS.find((a) => a.id === id);
  return !!action && runCommand(editor, action.command);
}

/** The column alignments the table menu offers; each label is a translation key. */
export const COLUMN_ALIGNS: readonly {
  id: ColumnAlign;
  label: string;
  icon: string;
}[] = [
  {
    id: 'left',
    label: 'editor.docEditor.table.alignLeft',
    icon: 'lucideAlignLeft',
  },
  {
    id: 'center',
    label: 'editor.docEditor.table.alignCenter',
    icon: 'lucideAlignCenter',
  },
  {
    id: 'right',
    label: 'editor.docEditor.table.alignRight',
    icon: 'lucideAlignRight',
  },
];

/**
 * The column alignments the table menu offers in text of `dir` (#458): a column's `left` and
 * `right` are the start and end of its text, so in right-to-left text `left` lands on the right
 * and the menu names and shows it so ("Right"), and the reverse.
 */
export function columnAligns(dir: 'ltr' | 'rtl'): typeof COLUMN_ALIGNS {
  if (dir === 'ltr') return COLUMN_ALIGNS;
  const mirror = { left: 'right', center: 'center', right: 'left' } as const;
  return COLUMN_ALIGNS.map((a) => {
    const shown = COLUMN_ALIGNS.find((b) => b.id === mirror[a.id]) ?? a;
    return { ...a, label: shown.label, icon: shown.icon };
  });
}

/** Aligns the caret's column; the alignment it has already takes it off (back to none). */
export function alignColumn(
  editor: Editor,
  align: ColumnAlign,
  current: ColumnAlign | null,
): boolean {
  return runCommand(editor, setColumnAlign(align === current ? null : align));
}

/** Turns the table's first row into its header row, or back. */
export function toggleTableHeader(editor: Editor): boolean {
  return runCommand(editor, toggleHeaderRow);
}

/** The blocks the toolbar and the slash menu insert (a passthrough is only ever imported). */
export type InsertableBlock = Exclude<DocBlockType, 'passthrough'>;

/**
 * Whether a documentation block can be inserted at the selection of `state`; an image also
 * needs the page's image picker, an attachment its attach-file dialog (`editor`).
 */
export function canInsertBlock(
  state: EditorState,
  type: InsertableBlock,
  editor?: Editor,
): boolean {
  if (type === 'image')
    return !!editor && canPickImage(editor) && insertImage(null)(state);
  if (type === 'attachment')
    return (
      !!editor && canPickAttachment(editor) && insertAttachment(null)(state)
    );
  return INSERT_BLOCK[type](state);
}

/**
 * Inserts a documentation block at the caret (a variant block takes the block at the caret in).
 * An image opens the image picker first and is inserted once chosen; an attachment the
 * attach-file dialog.
 */
export function insertBlockAt(editor: Editor, type: InsertableBlock): boolean {
  if (type === 'image') {
    if (!canInsertBlock(editor.state, 'image', editor)) return false;
    void pickAndInsertImage(editor);
    return true;
  }
  if (type === 'attachment') {
    if (!canInsertBlock(editor.state, 'attachment', editor)) return false;
    void pickAndInsertAttachment(editor);
    return true;
  }
  return runCommand(editor, INSERT_BLOCK[type]);
}
