import { afterNextRender, Directive, ElementRef, inject } from '@angular/core';

/**
 * Takes the focus when it appears (#611): a step of the two-factor dialog or page replaces the
 * control that led to it, and the keyboard and a screen reader go on from here.
 */
@Directive({ selector: '[ofFocusOnShow]' })
export class FocusOnShowDirective {
  constructor() {
    const el = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
    afterNextRender(() => el.focus({ preventScroll: true }));
  }
}
