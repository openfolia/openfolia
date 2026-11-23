import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it } from 'vitest';

import { provideZard } from '@openfolia/ui/core';

import { keyCaps } from './key-caps';
import { SHORTCUT_AREAS, SHORTCUTS } from './shortcuts';
import {
  isShortcutsOverlayKey,
  ShortcutsOverlay,
  ShortcutsOverlayComponent,
} from './shortcuts-overlay.component';

const press = (
  init: KeyboardEventInit,
  target: EventTarget = document.body,
) => {
  const event = new KeyboardEvent('keydown', {
    bubbles: true,
    cancelable: true,
    ...init,
  });
  target.dispatchEvent(event);
  return event;
};

describe('the shortcut overlay', () => {
  afterEach(() => {
    TestBed.inject(ShortcutsOverlay).close();
    document.querySelector('.cdk-overlay-container')?.replaceChildren();
    document.body.replaceChildren();
  });

  const render = async () => {
    TestBed.configureTestingModule({ providers: [provideZard()] });
    const fixture = TestBed.createComponent(ShortcutsOverlayComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    const stable = async () => {
      fixture.detectChanges();
      await fixture.whenStable();
      fixture.detectChanges();
    };
    return { fixture, stable, overlay: TestBed.inject(ShortcutsOverlay) };
  };
  const dialog = () => document.querySelector<HTMLElement>('[role=dialog]');

  it('opens on ? and lists every shortcut of the catalogue by area, with its keys', async () => {
    const t = await render();
    const event = press({ key: '?', shiftKey: true });
    await t.stable();
    expect(event.defaultPrevented).toBe(true);
    expect(t.overlay.isOpen()).toBe(true);
    const shown = [
      ...(dialog()?.querySelectorAll<HTMLElement>('[data-shortcut]') ?? []),
    ].map((row) => row.dataset['shortcut']);
    expect(shown).toEqual(
      Object.keys(SHORTCUTS).sort(
        (a, b) =>
          Object.keys(SHORTCUT_AREAS).indexOf(
            SHORTCUTS[a as keyof typeof SHORTCUTS].area,
          ) -
          Object.keys(SHORTCUT_AREAS).indexOf(
            SHORTCUTS[b as keyof typeof SHORTCUTS].area,
          ),
      ),
    );
    const text = dialog()?.textContent ?? '';
    expect(text).toContain('Keyboard shortcuts');
    expect(text).toContain('Writing text');
    const redo = dialog()?.querySelector('[data-shortcut="redo"]');
    expect(redo?.textContent).toContain('Redo');
    expect(
      [...(redo?.querySelectorAll('kbd') ?? [])].map((k) => k.textContent),
    ).toEqual(['Ctrl', 'Shift', 'Z', 'Ctrl', 'Y']);
    expect(redo?.textContent).toContain('or');
  });

  it('leaves ? to a field, to a modifier and to an open dialog', async () => {
    const t = await render();
    const field = document.createElement('input');
    document.body.append(field);
    field.focus();
    press({ key: '?', shiftKey: true }, field);
    press({ key: '?', ctrlKey: true });
    press({ key: '/' });
    await t.stable();
    expect(t.overlay.isOpen()).toBe(false);

    const modal = document.createElement('div');
    modal.setAttribute('aria-modal', 'true');
    document.body.append(modal);
    field.blur();
    press({ key: '?', shiftKey: true });
    await t.stable();
    expect(t.overlay.isOpen()).toBe(false);
  });

  it('opens from the menu entry and closes on Escape', async () => {
    const t = await render();
    t.overlay.open();
    await t.stable();
    expect(dialog()).not.toBeNull();
    press({ key: 'Escape' }, dialog() ?? document);
    await t.stable();
    expect(t.overlay.isOpen()).toBe(false);
  });

  it('takes ? with AltGr, as some layouts type it', () => {
    expect(
      isShortcutsOverlayKey({
        key: '?',
        metaKey: false,
        ctrlKey: true,
        altKey: true,
        getModifierState: (k: string) => k === 'AltGraph',
      }),
    ).toBe(true);
    expect(
      isShortcutsOverlayKey({
        key: '?',
        metaKey: true,
        ctrlKey: false,
        altKey: false,
      }),
    ).toBe(false);
  });
});

describe('the keys’ caps', () => {
  const words: Record<string, string> = {
    'editor.shortcuts.keys.ctrl': 'Strg',
    'editor.shortcuts.keys.shift': 'Umschalt',
    'editor.shortcuts.keys.enter': 'Eingabe',
  };
  const translate = (key: string) => words[key];

  it('names each key on each platform, the modifiers in their order', () => {
    expect(keyCaps('Shift-Mod-z', 'pc', translate)).toEqual([
      'Strg',
      'Umschalt',
      'Z',
    ]);
    expect(keyCaps('Shift-Mod-z', 'mac', translate)).toEqual(['⇧', '⌘', 'Z']);
    expect(keyCaps('Alt-ArrowUp', 'mac', translate)).toEqual(['⌥', '↑']);
    expect(keyCaps('?', 'pc', translate)).toEqual(['?']);
    expect(keyCaps('Mod-Shift-Enter', 'pc', translate)).toEqual([
      'Strg',
      'Umschalt',
      'Eingabe',
    ]);
  });

  it('names nothing it cannot name', () => {
    expect(keyCaps('Hyper-k', 'pc', translate)).toBeUndefined();
    expect(keyCaps('PageDown', 'pc', translate)).toBeUndefined();
    // A name without its text.
    expect(keyCaps('Tab', 'pc', translate)).toBeUndefined();
  });

  it('names every key of the catalogue in English, on both platforms', async () => {
    const en = (await import('../../i18n/en.json')).default as Record<
      string,
      unknown
    >;
    const text = (key: string) => {
      const value = key
        .replace(/^editor\./, '')
        .split('.')
        .reduce<unknown>(
          (node, part) =>
            node && typeof node === 'object'
              ? (node as Record<string, unknown>)[part]
              : undefined,
          en,
        );
      return typeof value === 'string' ? value : undefined;
    };
    for (const shortcut of Object.values(SHORTCUTS))
      for (const keys of shortcut.keys)
        for (const platform of ['pc', 'mac'] as const)
          expect(
            keyCaps(keys, platform, text),
            `${keys} ${platform}`,
          ).toBeDefined();
  });
});
