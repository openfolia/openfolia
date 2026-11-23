/**
 * How a shortcut's keys are written (#221, #447): the in-app overlay and the user guide's shortcut
 * reference both name them with this one function, so they never disagree. The guide's build
 * imports this file as it is (`frontend/docs/scripts/lib/guide-references.mjs`, Node's type
 * stripping), so it imports nothing and uses only erasable TypeScript.
 *
 * A cap is a translation key (`editor.shortcuts.keys.*`, the word for a key in the person's
 * language) or a symbol written as it is (`⌘`, `↑`, a character key upper-cased).
 */

/** Windows and Linux (`pc`), or an Apple platform (`mac`). */
export type KeyPlatform = 'pc' | 'mac';

/** Each named key, per platform: a translation key, or a symbol. */
const NAMED_KEYS: Readonly<
  Record<string, Readonly<Record<KeyPlatform, string>>>
> = {
  Mod: { pc: 'editor.shortcuts.keys.ctrl', mac: '⌘' },
  Ctrl: { pc: 'editor.shortcuts.keys.ctrl', mac: '⌃' },
  Shift: { pc: 'editor.shortcuts.keys.shift', mac: '⇧' },
  Alt: { pc: 'editor.shortcuts.keys.alt', mac: '⌥' },
  Enter: {
    pc: 'editor.shortcuts.keys.enter',
    mac: 'editor.shortcuts.keys.enter',
  },
  Tab: { pc: 'editor.shortcuts.keys.tab', mac: 'editor.shortcuts.keys.tab' },
  ArrowUp: { pc: '↑', mac: '↑' },
  ArrowDown: { pc: '↓', mac: '↓' },
  ContextMenu: {
    pc: 'editor.shortcuts.keys.contextMenu',
    mac: 'editor.shortcuts.keys.contextMenu',
  },
  Escape: {
    pc: 'editor.shortcuts.keys.escape',
    mac: 'editor.shortcuts.keys.escape',
  },
  Delete: {
    pc: 'editor.shortcuts.keys.delete',
    mac: 'editor.shortcuts.keys.delete',
  },
  F2: { pc: 'editor.shortcuts.keys.f2', mac: 'editor.shortcuts.keys.f2' },
  F10: { pc: 'editor.shortcuts.keys.f10', mac: 'editor.shortcuts.keys.f10' },
};

/** A single printable character is a key of its own (`b`, `/`, `,`, `?`). */
const CHARACTER = /^[a-z0-9/,.?]$/;

/** The modifiers' order: Ctrl, Alt, Shift on Windows and Linux; ⌃ ⌥ ⇧ ⌘ as a Mac writes them. */
const MODIFIER_ORDER: Readonly<Record<KeyPlatform, readonly string[]>> = {
  pc: ['Mod', 'Ctrl', 'Alt', 'Shift'],
  mac: ['Ctrl', 'Alt', 'Shift', 'Mod'],
};

/** Whether a cap is a translation key (else it is shown as it is). */
export function isKeyName(cap: string): boolean {
  return cap.startsWith('editor.shortcuts.keys.');
}

/**
 * The caps of one alternative of a shortcut (`Mod-Shift-u`, written as ProseMirror writes keys)
 * on `platform`, each translated by `translate` when it is a key's name; `undefined` for a key or
 * a modifier it cannot name, or a name `translate` has no text for.
 */
export function keyCaps(
  keys: string,
  platform: KeyPlatform,
  translate: (key: string) => string | undefined,
): string[] | undefined {
  // `Mod-Shift-u` → `Mod`, `Shift`, `u`; `Mod--` would end in `-`.
  const parts = keys.split(/-(?!$)/);
  const key = parts.pop();
  if (key === undefined) return undefined;
  const order = MODIFIER_ORDER[platform];
  if (parts.some((part) => !order.includes(part))) return undefined;
  parts.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  const caps: string[] = [];
  for (const part of [...parts, key]) {
    const named = NAMED_KEYS[part];
    if (named !== undefined) {
      const cap = named[platform];
      const text = isKeyName(cap) ? translate(cap) : cap;
      if (text === undefined) return undefined;
      caps.push(text);
    } else if (CHARACTER.test(part)) caps.push(part.toUpperCase());
    else return undefined;
  }
  return caps;
}
