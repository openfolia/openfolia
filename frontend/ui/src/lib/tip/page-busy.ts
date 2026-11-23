import {
  isEditable,
  openModal,
} from '../search-shortcut/search-shortcut.directive';

/**
 * Whether the page is busy with something a tip must not cover (#222):
 *
 * - a modal dialog is open (a dialog, a sheet, the search palette);
 * - a menu, select, popover or other panel is open in the overlay container (one playing its exit
 *   animation does not count, nor the tip itself);
 * - the focus is in a text field or editor: the person is typing, and a tip would cover the caret
 *   or take the keys.
 */
export function pageBusy(doc: Document = document): boolean {
  if (isEditable(doc.activeElement)) return true;
  if (openModal()) return true;
  const container = doc.querySelector('.cdk-overlay-container');
  if (!container) return false;
  for (const pane of Array.from(
    container.querySelectorAll<HTMLElement>('.cdk-overlay-pane'),
  )) {
    const content = pane.firstElementChild;
    if (!(content instanceof HTMLElement)) continue;
    if (
      content.closest('[data-slot="tip"]') ||
      content.dataset['slot'] === 'tip'
    )
      continue;
    if (
      content.dataset['state'] === 'closed' ||
      content.hasAttribute('data-closed')
    )
      continue;
    // A tooltip is no panel: it goes with the pointer and holds no keys.
    if (
      content.getAttribute('role') === 'tooltip' ||
      pane.querySelector('[role="tooltip"]')
    )
      continue;
    if (
      typeof content.checkVisibility === 'function' &&
      !content.checkVisibility()
    )
      continue;
    return true;
  }
  return false;
}
