import {
  booleanAttribute,
  Directive,
  effect,
  ElementRef,
  inject,
  input,
  untracked,
} from '@angular/core';

/** What can take focus, in document order. */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Something that comes and goes (a filter bar's Reset filters) without moving what is around it:
 * the element always keeps its space, and `[ofReservedSlot]="false"` only hides it, faded out
 * (200 ms, at once under reduced motion), `invisible`, `inert` and `aria-hidden`, so it is out of
 * the tab order and not read. Showing it fades it back in. Nothing wraps or moves either way.
 *
 * Hidden while it has focus (Reset filters, clicked, has nothing left to reset), focus moves to
 * the focusable element before it in its parent (else the one after), never to the page.
 *
 * ```html
 * <button z-button [ofReservedSlot]="hasFilters()" (click)="reset()">Reset filters</button>
 * ```
 */
@Directive({
  selector: '[ofReservedSlot]',
  host: {
    class:
      'transition-[opacity,visibility] duration-200 ease-out motion-reduce:transition-none',
    '[class.opacity-0]': '!shown()',
    '[class.invisible]': '!shown()',
    '[attr.inert]': "shown() ? null : ''",
    '[attr.aria-hidden]': "shown() ? null : 'true'",
  },
})
export class ReservedSlotDirective {
  readonly shown = input(false, {
    alias: 'ofReservedSlot',
    transform: booleanAttribute,
  });

  private readonly host =
    inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;

  constructor() {
    effect(() => {
      if (!this.shown()) untracked(() => this.moveFocusOut());
    });
  }

  private moveFocusOut(): void {
    const active = this.host.ownerDocument.activeElement;
    if (!(active instanceof HTMLElement) || !this.host.contains(active)) return;
    const parent = this.host.parentElement;
    if (!parent) return;
    const candidates = [
      ...parent.querySelectorAll<HTMLElement>(FOCUSABLE),
    ].filter((el) => !this.host.contains(el) && !el.closest('[inert]'));
    const before = candidates.filter(
      (el) =>
        el.compareDocumentPosition(this.host) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    );
    (before.at(-1) ?? candidates[0])?.focus();
  }
}
