import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';

import { MeService, NOBODY } from '../permissions/me';
import {
  isPaletteShortcut,
  paletteShortcutLabel,
  SearchPalette,
} from './search-palette.service';

const key = (
  init: Partial<
    Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>
  >,
) => ({
  key: 'k',
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...init,
});

function palette(permissions: string[]) {
  TestBed.configureTestingModule({
    providers: [provideHttpClient(), provideHttpClientTesting()],
  });
  TestBed.inject(MeService).set({
    ...NOBODY,
    id: 'a',
    permissions: new Set(permissions),
  });
  return TestBed.inject(SearchPalette);
}

describe('palette shortcut', () => {
  it('is Cmd+K on Apple platforms and Ctrl+K elsewhere', () => {
    expect(isPaletteShortcut(key({ metaKey: true }), true)).toBe(true);
    expect(isPaletteShortcut(key({ key: 'K', metaKey: true }), true)).toBe(
      true,
    );
    expect(isPaletteShortcut(key({ ctrlKey: true }), true)).toBe(false);
    expect(isPaletteShortcut(key({ ctrlKey: true }), false)).toBe(true);
    expect(isPaletteShortcut(key({ metaKey: true }), false)).toBe(false);
    expect(
      isPaletteShortcut(key({ ctrlKey: true, shiftKey: true }), false),
    ).toBe(false);
    expect(isPaletteShortcut(key({ key: 'j', ctrlKey: true }), false)).toBe(
      false,
    );
    expect(paletteShortcutLabel(true)).toBe('⌘K');
    expect(paletteShortcutLabel(false)).toBe('Ctrl+K');
  });
});

describe('SearchPalette', () => {
  it('offers search, New module, the review and the change-set switch to an author', () => {
    const p = palette([
      'content.read',
      'content.read.draft',
      'content.edit',
      'content.review',
    ]);
    expect(p.canSearch()).toBe(true);
    expect(p.actions().map((a) => a.id)).toEqual([
      'newModule',
      'newManual',
      'openReview',
      'switchChangeSet',
    ]);
    p.open();
    expect(p.isOpen()).toBe(true);
    p.toggle();
    expect(p.isOpen()).toBe(false);
  });

  it('offers a contributor search and New module only: no manuals, no change-set switch (#137)', () => {
    const p = palette(['content.read', 'content.edit']);
    expect(p.actions().map((a) => a.id)).toEqual(['newModule']);
  });

  it('offers only what a role can ever use', () => {
    const reader = palette(['content.read']);
    expect(reader.canSearch()).toBe(true);
    expect(reader.actions()).toEqual([]);
  });

  it('does not open for a role with nothing to offer', () => {
    const nobody = palette([]);
    expect(nobody.available()).toBe(false);
    nobody.open();
    expect(nobody.isOpen()).toBe(false);
  });
});
