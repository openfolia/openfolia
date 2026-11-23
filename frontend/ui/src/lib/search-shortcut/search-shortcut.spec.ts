import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it } from 'vitest';

import {
  isSearchShortcut,
  SearchShortcutDirective,
} from './search-shortcut.directive';

@Component({
  imports: [SearchShortcutDirective],
  template: `
    <input id="other" />
    <textarea id="notes"></textarea>
    <button id="btn" type="button">B</button>
    <input id="search" type="search" ofSearchShortcut [disabled]="disabled()" />
    <div id="editable" contenteditable="true"><p id="para">x</p></div>
    <!-- Kept mounted while closed, like the sidebar's drawer. -->
    <div role="dialog" aria-modal="true" inert></div>
    <!-- Closing: its exit animation still runs (#221). -->
    <div role="dialog" aria-modal="true" data-state="closed"></div>
    @if (dialog()) {
      <div role="dialog" aria-modal="true"></div>
    }
  `,
})
class HostComponent {
  readonly disabled = signal(false);
  readonly dialog = signal(false);
}

function setup() {
  const fixture = TestBed.createComponent(HostComponent);
  fixture.detectChanges();
  const el = fixture.nativeElement as HTMLElement;
  document.body.appendChild(el);
  const search = el.querySelector('#search') as HTMLInputElement;
  const press = (target: Element = document.body, key = '/') => {
    const event = new KeyboardEvent('keydown', {
      key,
      bubbles: true,
      cancelable: true,
    });
    target.dispatchEvent(event);
    return event;
  };
  return { fixture, el, search, press };
}

describe('SearchShortcutDirective', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('focuses and selects the search box on /, and keeps the / from being typed', () => {
    const { search, press } = setup();
    search.value = 'old';
    const event = press();
    expect(document.activeElement).toBe(search);
    expect(search.selectionStart).toBe(0);
    expect(search.selectionEnd).toBe(3);
    expect(event.defaultPrevented).toBe(true);
    expect(search.getAttribute('aria-keyshortcuts')).toBe('/');
  });

  it('also works with focus on a button', () => {
    const { el, search, press } = setup();
    const btn = el.querySelector('#btn') as HTMLButtonElement;
    btn.focus();
    press(btn);
    expect(document.activeElement).toBe(search);
  });

  it('leaves a / typed in another field alone', () => {
    const { el, search, press } = setup();
    for (const id of ['#other', '#notes']) {
      const field = el.querySelector(id) as HTMLElement;
      field.focus();
      const event = press(field);
      expect(event.defaultPrevented).toBe(false);
      expect(document.activeElement).not.toBe(search);
    }
  });

  it('does nothing while a modal dialog is open, or when the box is disabled', () => {
    const { fixture, search, press } = setup();
    fixture.componentInstance.dialog.set(true);
    fixture.detectChanges();
    expect(press().defaultPrevented).toBe(false);
    expect(document.activeElement).not.toBe(search);

    fixture.componentInstance.dialog.set(false);
    fixture.componentInstance.disabled.set(true);
    fixture.detectChanges();
    expect(press().defaultPrevented).toBe(false);
  });

  it('ignores a closed modal kept mounted (inert), and works with Shift', () => {
    const { search } = setup();
    const event = new KeyboardEvent('keydown', {
      key: '/',
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    document.body.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(search);
  });

  it('leaves a / typed in contenteditable content alone', () => {
    const { el, press } = setup();
    const para = el.querySelector('#para') as HTMLElement;
    expect(press(para).defaultPrevented).toBe(false);
  });

  it('keeps a held / from typing into the box', () => {
    const { search } = setup();
    document.body.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: '/',
        bubbles: true,
        cancelable: true,
      }),
    );
    const repeat = new KeyboardEvent('keydown', {
      key: '/',
      repeat: true,
      bubbles: true,
      cancelable: true,
    });
    search.dispatchEvent(repeat);
    expect(repeat.defaultPrevented).toBe(true);
  });

  it('keeps the box focused on Esc when it has text', () => {
    const { search, press } = setup();
    press();
    search.value = 'abc';
    search.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
    expect(document.activeElement).toBe(search);
  });

  it('gives focus back to the page on Esc when the box is empty', () => {
    const { search, press } = setup();
    press();
    expect(document.activeElement).toBe(search);
    search.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
    expect(document.activeElement).not.toBe(search);
  });

  it('takes / with no modifier only', () => {
    const base = { key: '/', metaKey: false, ctrlKey: false, altKey: false };
    expect(isSearchShortcut(base)).toBe(true);
    expect(isSearchShortcut({ ...base, metaKey: true })).toBe(false);
    expect(isSearchShortcut({ ...base, ctrlKey: true })).toBe(false);
    expect(isSearchShortcut({ ...base, altKey: true })).toBe(false);
    expect(isSearchShortcut({ ...base, key: '?' })).toBe(false);
  });
});
