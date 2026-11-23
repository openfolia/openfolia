import {
  Editor,
  getExtensionField,
  getSchemaTypeByName,
  type AnyExtension,
} from '@tiptap/core';
import { ZARD_SIDEBAR_KEYBOARD_SHORTCUT } from '@openfolia/ui/sidebar';
import { isSearchShortcut } from '@openfolia/ui/search-shortcut';

import { createEditorExtensions } from '../doc-editor/extensions';
import { isBlockMenuKey } from '../doc-editor/plugins/block-menu';
import { snippetKeyAction } from '../doc-editor/plugins/snippet-suggestions';
import { SLASH_CHAR } from '../doc-editor/slash/slash-command';
import { termKeyAction } from '../doc-editor/writing/term-suggestions';
import { isPopoverKey } from '../doc-editor/writing/writing-checks';
import { OUTLINE_KEYS } from '../manuals/manual-builder.page';
import { NOTIFICATIONS_SHORTCUT } from '../notifications/notification-bell.component';
import { REVIEW_KEYS } from '../review/review.page';
import { isPaletteShortcut } from '../search/search-palette.service';
import { isShortcutsOverlayKey } from './shortcuts-overlay.component';
import en from '../../i18n/en.json';
import {
  SHORTCUT_AREAS,
  SHORTCUTS,
  type Shortcut,
  type ShortcutId,
} from './shortcuts';

/**
 * Keys the module editor binds that are plain editing, not shortcuts a person looks up: Enter
 * and the deletions (with their platform variants, which TipTap's core keymap joins with),
 * selecting everything, the line's start and end, and undo's and redo's keys on a Cyrillic
 * layout (TipTap's undo binds them beside `Mod-z`).
 */
const PLAIN_EDITING_KEYS = new Set([
  'Enter',
  'Mod-Enter',
  'Backspace',
  'Mod-Backspace',
  'Shift-Backspace',
  'Alt-Backspace',
  'Delete',
  'Mod-Delete',
  'Alt-Delete',
  'Ctrl-h',
  'Ctrl-d',
  'Alt-d',
  'Ctrl-Alt-Backspace',
  'Mod-a',
  'Home',
  'End',
  'Ctrl-a',
  'Ctrl-e',
  'Mod-я',
  'Shift-Mod-я',
]);

/** The entries the module editor's own keymaps carry out (the rest are checked one by one). */
const IN_EDITOR_KEYMAP: readonly ShortcutId[] = [
  'undo',
  'redo',
  'bold',
  'italic',
  'code',
  'uiLabel',
  'subscript',
  'superscript',
  'inlineEdit',
  'lineBreak',
  'insertMenu',
  'moveUp',
  'moveDown',
  'indent',
  'outdent',
];

/** Every key the module editor's extensions bind (`addKeyboardShortcuts`). */
function editorKeys(): Set<string> {
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: createEditorExtensions({ slashMenu: null, bubble: null }),
  });
  try {
    const keys = new Set<string>();
    for (const extension of editor.extensionManager
      .extensions as AnyExtension[]) {
      const add = getExtensionField<
        (() => Record<string, unknown>) | undefined
      >(extension, 'addKeyboardShortcuts', {
        name: extension.name,
        options: extension.options,
        storage:
          editor.extensionStorage[
            extension.name as keyof typeof editor.extensionStorage
          ],
        editor,
        type: getSchemaTypeByName(extension.name, editor.schema),
      });
      for (const key of Object.keys(add?.() ?? {})) keys.add(key);
    }
    return keys;
  } finally {
    editor.destroy();
  }
}

/** A keydown for one of the catalogue's keys (`Mod` as Ctrl, or Cmd on an Apple platform). */
function keydown(keys: string, apple = false): KeyboardEvent {
  const parts = keys === '-' ? ['-'] : keys.split(/-(?!$)/);
  const key = parts.pop() ?? '';
  const has = (name: string) => parts.includes(name);
  return new KeyboardEvent('keydown', {
    key,
    code: /^[a-z]$/i.test(key) ? `Key${key.toUpperCase()}` : key,
    shiftKey: has('Shift'),
    altKey: has('Alt'),
    ctrlKey: has('Ctrl') || (has('Mod') && !apple),
    metaKey: has('Mod') && apple,
  });
}

const entries = Object.entries(SHORTCUTS) as [ShortcutId, Shortcut][];

const lookup = (key: string): unknown =>
  key
    .replace(/^editor\./, '')
    .split('.')
    .reduce<unknown>(
      (node, part) =>
        node && typeof node === 'object'
          ? (node as Record<string, unknown>)[part]
          : undefined,
      en,
    );

describe('the shortcut catalogue', () => {
  it('names every shortcut and area in a key of its own', () => {
    for (const [id, shortcut] of entries) {
      expect(shortcut.label).toBe(`editor.shortcuts.${id}`);
      expect(typeof lookup(shortcut.label)).toBe('string');
      expect(shortcut.keys.length).toBeGreaterThan(0);
    }
    for (const [area, label] of Object.entries(SHORTCUT_AREAS)) {
      expect(label).toBe(`editor.shortcuts.areas.${area}`);
      expect(typeof lookup(label)).toBe('string');
    }
  });

  it('lists the keys the module editor binds, and every key it binds', () => {
    const bound = editorKeys();
    for (const id of IN_EDITOR_KEYMAP) {
      for (const key of SHORTCUTS[id].keys) {
        expect({ id, key, bound: bound.has(key) }).toEqual({
          id,
          key,
          bound: true,
        });
      }
    }
    const listed = new Set(entries.flatMap(([, s]) => s.keys));
    const unlisted = [...bound].filter(
      (key) => !listed.has(key) && !PLAIN_EDITING_KEYS.has(key),
    );
    expect(unlisted).toEqual([]);
  });

  it('has the keys the app listens to outside the editor’s keymaps', () => {
    for (const keys of SHORTCUTS.palette.keys) {
      expect(isPaletteShortcut(keydown(keys), false)).toBe(true);
      expect(isPaletteShortcut(keydown(keys, true), true)).toBe(true);
    }
    expect(SHORTCUTS.pageSearch.keys).toEqual(['/']);
    expect(SHORTCUTS.overlay.keys).toEqual(['?']);
    expect(isShortcutsOverlayKey(keydown('Shift-?'))).toBe(true);
    expect(isSearchShortcut(keydown('/'))).toBe(true);
    expect(SHORTCUTS.sidebar.keys).toEqual([
      `Mod-${ZARD_SIDEBAR_KEYBOARD_SHORTCUT}`,
    ]);
    expect(SHORTCUTS.notifications.keys).toEqual([
      NOTIFICATIONS_SHORTCUT.replace(/\+/g, '-').replace(
        /-([A-Z])$/,
        (_, c: string) => `-${c.toLowerCase()}`,
      ),
    ]);
    expect(SHORTCUTS.slashMenu.keys).toEqual([SLASH_CHAR]);
    for (const keys of SHORTCUTS.blockMenu.keys)
      expect(isBlockMenuKey(keydown(keys))).toBe(true);
    for (const [id, action] of [
      ['snippetReference', 'reference'],
      ['snippetCopy', 'copy'],
      ['snippetDismiss', 'dismiss'],
    ] as const)
      for (const keys of SHORTCUTS[id].keys)
        expect(snippetKeyAction(keydown(keys))).toBe(action);
    for (const [id, action] of [
      ['termAccept', 'accept'],
      ['termDismiss', 'dismiss'],
    ] as const)
      for (const keys of SHORTCUTS[id].keys)
        expect(termKeyAction(keydown(keys))).toBe(action);
    for (const keys of SHORTCUTS.writingPopover.keys)
      expect(isPopoverKey(keydown(keys))).toBe(true);
    expect(SHORTCUTS.nextChange.keys).toEqual(REVIEW_KEYS.next);
    expect(SHORTCUTS.previousChange.keys).toEqual(REVIEW_KEYS.previous);
    expect(SHORTCUTS.commentChange.keys).toEqual(REVIEW_KEYS.comment);
  });

  it('has the manual outline’s keys, as its keyboard popover lists them', () => {
    // The popover's key caps, as the catalogue writes the keys; dragging is no key.
    const CAPS: Record<string, string> = {
      alt: 'Alt',
      shift: 'Shift',
      up: 'ArrowUp',
      down: 'ArrowDown',
      tab: 'Tab',
      enter: 'Enter',
      f2: 'F2',
      delete: 'Delete',
      f10: 'F10',
    };
    const MODIFIERS = new Set(['Alt', 'Shift']);
    const popover = OUTLINE_KEYS.filter(
      (entry) => !entry.keys.includes('editor.manuals.keys.cap.drag'),
    ).map((entry) => {
      const caps = entry.keys.map((key) => {
        const cap = CAPS[key.replace('editor.manuals.keys.cap.', '')];
        expect(cap, key).toBeDefined();
        return cap ?? key;
      });
      const modifiers = caps.filter((cap) => MODIFIERS.has(cap));
      return caps
        .filter((cap) => !MODIFIERS.has(cap))
        .map((cap) => [...modifiers, cap].join('-'))
        .join(' ');
    });
    const catalogue = Object.values(SHORTCUTS as Record<string, Shortcut>)
      .filter((shortcut) => shortcut.area === 'manuals')
      .map((shortcut) => shortcut.keys.join(' '));
    // Delete both removes a row and, in a derived manual, leaves a gathered module out: one entry.
    expect([...new Set(catalogue)].sort()).toEqual(
      [...new Set(popover)].sort(),
    );
  });
});
