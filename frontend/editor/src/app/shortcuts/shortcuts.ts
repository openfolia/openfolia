/**
 * Every keyboard shortcut the editor has, in one place (#447, #221): the user guide's shortcut
 * reference is generated from this file at the docs build (`frontend/docs/scripts/lib/guide-references.mjs`
 * reads it as source, so it stays plain literals), and the in-app overlay (`?`,
 * `shortcuts-overlay.component.ts`) shows it. Both write the keys with `keyCaps` (`key-caps.ts`).
 * `shortcuts.spec.ts` holds it to the code: each entry's keys are the ones its feature listens to,
 * and a key the module editor binds that is not listed here (nor in its list of plain editing
 * keys) fails the test.
 *
 * Keys are written as ProseMirror writes them: `Mod` is Cmd on Apple platforms and Ctrl
 * elsewhere, then `Alt`, `Shift`, and the key (`Mod-Shift-u`, `Alt-ArrowUp`, `/`). Alternatives
 * that do the same are listed together.
 */

/** Where a shortcut works. */
export type ShortcutArea =
  'anywhere' | 'text' | 'blocks' | 'manuals' | 'review';

export interface Shortcut {
  /** The keys, alternatives first to last (`['Mod-z']`, `['Shift-Mod-z', 'Mod-y']`). */
  readonly keys: readonly string[];
  readonly area: ShortcutArea;
  /** What it does: a whole translation key (`editor.shortcuts.<id>`). */
  readonly label: string;
}

/** The areas' names, in the order the reference shows them. */
export const SHORTCUT_AREAS: Readonly<Record<ShortcutArea, string>> = {
  anywhere: 'editor.shortcuts.areas.anywhere',
  text: 'editor.shortcuts.areas.text',
  blocks: 'editor.shortcuts.areas.blocks',
  manuals: 'editor.shortcuts.areas.manuals',
  review: 'editor.shortcuts.areas.review',
};

export const SHORTCUTS = {
  palette: {
    keys: ['Mod-k'],
    area: 'anywhere',
    label: 'editor.shortcuts.palette',
  },
  pageSearch: {
    keys: ['/'],
    area: 'anywhere',
    label: 'editor.shortcuts.pageSearch',
  },
  sidebar: {
    keys: ['Mod-b'],
    area: 'anywhere',
    label: 'editor.shortcuts.sidebar',
  },
  notifications: {
    keys: ['Alt-Shift-n'],
    area: 'anywhere',
    label: 'editor.shortcuts.notifications',
  },
  overlay: {
    keys: ['?'],
    area: 'anywhere',
    label: 'editor.shortcuts.overlay',
  },
  undo: { keys: ['Mod-z'], area: 'text', label: 'editor.shortcuts.undo' },
  redo: {
    keys: ['Shift-Mod-z', 'Mod-y'],
    area: 'text',
    label: 'editor.shortcuts.redo',
  },
  bold: { keys: ['Mod-b'], area: 'text', label: 'editor.shortcuts.bold' },
  italic: { keys: ['Mod-i'], area: 'text', label: 'editor.shortcuts.italic' },
  code: { keys: ['Mod-e'], area: 'text', label: 'editor.shortcuts.code' },
  uiLabel: {
    keys: ['Mod-Shift-u'],
    area: 'text',
    label: 'editor.shortcuts.uiLabel',
  },
  subscript: {
    keys: ['Mod-,'],
    area: 'text',
    label: 'editor.shortcuts.subscript',
  },
  superscript: {
    keys: ['Mod-.'],
    area: 'text',
    label: 'editor.shortcuts.superscript',
  },
  inlineEdit: {
    keys: ['Mod-k'],
    area: 'text',
    label: 'editor.shortcuts.inlineEdit',
  },
  lineBreak: {
    keys: ['Shift-Enter'],
    area: 'text',
    label: 'editor.shortcuts.lineBreak',
  },
  slashMenu: { keys: ['/'], area: 'text', label: 'editor.shortcuts.slashMenu' },
  snippetReference: {
    keys: ['Tab'],
    area: 'text',
    label: 'editor.shortcuts.snippetReference',
  },
  snippetCopy: {
    keys: ['Shift-Tab'],
    area: 'text',
    label: 'editor.shortcuts.snippetCopy',
  },
  snippetDismiss: {
    keys: ['Escape'],
    area: 'text',
    label: 'editor.shortcuts.snippetDismiss',
  },
  termAccept: {
    keys: ['Tab'],
    area: 'text',
    label: 'editor.shortcuts.termAccept',
  },
  termDismiss: {
    keys: ['Escape'],
    area: 'text',
    label: 'editor.shortcuts.termDismiss',
  },
  writingPopover: {
    keys: ['Alt-Enter'],
    area: 'text',
    label: 'editor.shortcuts.writingPopover',
  },
  insertMenu: {
    keys: ['Mod-Shift-Enter'],
    area: 'blocks',
    label: 'editor.shortcuts.insertMenu',
  },
  blockMenu: {
    keys: ['Shift-F10', 'ContextMenu'],
    area: 'blocks',
    label: 'editor.shortcuts.blockMenu',
  },
  moveUp: {
    keys: ['Alt-ArrowUp'],
    area: 'blocks',
    label: 'editor.shortcuts.moveUp',
  },
  moveDown: {
    keys: ['Alt-ArrowDown'],
    area: 'blocks',
    label: 'editor.shortcuts.moveDown',
  },
  indent: { keys: ['Tab'], area: 'blocks', label: 'editor.shortcuts.indent' },
  outdent: {
    keys: ['Shift-Tab'],
    area: 'blocks',
    label: 'editor.shortcuts.outdent',
  },
  manualMove: {
    keys: ['Alt-ArrowUp', 'Alt-ArrowDown'],
    area: 'manuals',
    label: 'editor.shortcuts.manualMove',
  },
  manualIndent: {
    keys: ['Tab'],
    area: 'manuals',
    label: 'editor.shortcuts.manualIndent',
  },
  manualOutdent: {
    keys: ['Shift-Tab'],
    area: 'manuals',
    label: 'editor.shortcuts.manualOutdent',
  },
  manualSelect: {
    keys: ['ArrowUp', 'ArrowDown'],
    area: 'manuals',
    label: 'editor.shortcuts.manualSelect',
  },
  manualOpen: {
    keys: ['Enter'],
    area: 'manuals',
    label: 'editor.shortcuts.manualOpen',
  },
  manualRename: {
    keys: ['F2'],
    area: 'manuals',
    label: 'editor.shortcuts.manualRename',
  },
  manualRemove: {
    keys: ['Delete'],
    area: 'manuals',
    label: 'editor.shortcuts.manualRemove',
  },
  manualRowActions: {
    keys: ['Shift-F10'],
    area: 'manuals',
    label: 'editor.shortcuts.manualRowActions',
  },
  nextChange: {
    keys: ['j', 'n'],
    area: 'review',
    label: 'editor.shortcuts.nextChange',
  },
  previousChange: {
    keys: ['k', 'p'],
    area: 'review',
    label: 'editor.shortcuts.previousChange',
  },
  commentChange: {
    keys: ['c'],
    area: 'review',
    label: 'editor.shortcuts.commentChange',
  },
} as const satisfies Record<string, Shortcut>;

export type ShortcutId = keyof typeof SHORTCUTS;
