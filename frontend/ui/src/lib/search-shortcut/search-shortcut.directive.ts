import { Directive, ElementRef, inject } from '@angular/core';

/**
 * Whether a key press is the page-search shortcut: `/` with no Ctrl, Cmd or Alt. Shift is fine
 * (`/` is Shift+7 on German and Nordic layouts), and so is AltGr, which some layouts need for `/`
 * and which Windows reports as Ctrl+Alt.
 */
export function isSearchShortcut(
  event: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey'> &
    Partial<Pick<KeyboardEvent, 'getModifierState'>>,
): boolean {
  if (event.key !== '/' || event.metaKey) return false;
  if (event.getModifierState?.('AltGraph')) return true;
  return !event.ctrlKey && !event.altKey;
}

/** Whether focus is somewhere a `/` should be typed, not taken as a shortcut: a text field or editor. */
export function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (
    target.isContentEditable ||
    target.closest('[contenteditable]:not([contenteditable="false"])')
  ) {
    return true;
  }
  if (target instanceof HTMLTextAreaElement) return true;
  if (target instanceof HTMLSelectElement) return true;
  if (target instanceof HTMLInputElement) {
    // Buttons, checkboxes and the like take no text.
    return ![
      'button',
      'checkbox',
      'radio',
      'range',
      'reset',
      'submit',
      'color',
      'file',
      'image',
    ].includes(target.type);
  }
  return false;
}

/**
 * Whether a key press may be taken as a page-wide shortcut (`/`, `?`): focus is in no field, no
 * menu, select or popover is open around it (they keep their keys) and no modal dialog is open.
 */
export function isPageShortcut(event: KeyboardEvent): boolean {
  // The real target, also inside shadow DOM.
  const target = event.composedPath?.()[0] ?? event.target;
  if (isEditable(target) || isEditable(document.activeElement)) return false;
  if (target instanceof Element && target.closest('.cdk-overlay-container')) {
    return false;
  }
  return !openModal();
}

/**
 * A page's search box that `/` focuses, like the palette's Cmd/Ctrl+K: only when no field has
 * focus, no modal dialog is open and the box is visible and enabled. With several on a page the
 * first one created that can take it wins. `Esc` in the empty box gives focus back to the
 * page. Pair it with a `/` keycap (`of-kbd`) for the mouse user.
 */
@Directive({
  selector: 'input[ofSearchShortcut]',
  host: {
    'aria-keyshortcuts': '/',
    '(document:keydown)': 'onKeydown($event)',
    '(keydown.escape)': 'onEscape()',
  },
})
export class SearchShortcutDirective {
  private readonly input =
    inject<ElementRef<HTMLInputElement>>(ElementRef).nativeElement;

  protected onKeydown(event: KeyboardEvent): void {
    if (event.defaultPrevented || !isSearchShortcut(event)) return;
    // Holding the key: the first press focused the box, the rest must not type "///".
    if (event.repeat && document.activeElement === this.input) {
      event.preventDefault();
      return;
    }
    if (!isPageShortcut(event)) return;
    if (this.input.disabled || !isShown(this.input)) return;
    event.preventDefault();
    this.input.focus();
    this.input.select();
  }

  protected onEscape(): void {
    if (this.input.value === '') this.input.blur();
  }
}

/**
 * A modal dialog that is open: one kept mounted while closed (the sidebar's drawer, for its exit
 * animation) is inert or not shown, and one closing (`data-state="closed"`, a dialog's exit
 * animation) doesn't count either.
 */
export function openModal(): boolean {
  try {
    if (document.querySelector('dialog[open]:modal')) return true;
  } catch {
    // No :modal support: an open <dialog> counts.
    if (document.querySelector('dialog[open]')) return true;
  }
  for (const el of Array.from(
    document.querySelectorAll<HTMLElement>('[aria-modal="true"]'),
  )) {
    if (el.dataset['state'] !== 'closed' && isShown(el)) return true;
  }
  return false;
}

function isShown(el: HTMLElement): boolean {
  if (el.closest('[inert], [hidden]')) return false;
  return typeof el.checkVisibility === 'function' ? el.checkVisibility() : true;
}
