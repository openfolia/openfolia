import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';

import { prefersReducedMotion } from '../smooth/reduced-motion';

/**
 * Well past the transition (200 ms): by then an opening has ended, seen or not.
 * Clipping a little too long is harmless; unclipping mid-grow would spill.
 * Not `transitioncancel`: reopening while closing cancels the closing
 * transition while the row is still growing.
 */
const SETTLE_FALLBACK_MS = 500;

/**
 * Content that opens and closes smoothly: its height grows from nothing to
 * its natural size (and back), with a short fade, instead of popping in.
 * Animates the grid row (`0fr` → `1fr`), so it needs no measuring and copes
 * with content that changes size while open. With reduced motion it switches
 * at once.
 *
 * While closed the content stays in the page but is `inert` and hidden from
 * assistive technology, so it can't be focused or read. The content clips only
 * while closed or moving, so focus rings show once it's open.
 *
 * ```html
 * <of-collapse [open]="expanded()"><ul>…</ul></of-collapse>
 * ```
 */
@Component({
  selector: 'of-collapse',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    'data-slot': 'collapse',
    '[attr.data-state]': "open() ? 'open' : 'closed'",
    class:
      'grid transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none',
    '[style.grid-template-rows]': "open() ? '1fr' : '0fr'",
    '[style.opacity]': 'open() ? 1 : 0',
    '[attr.inert]': "open() ? null : ''",
    '[attr.aria-hidden]': "open() ? null : 'true'",
    '(transitionend)': 'settle($event)',
  },
  template: `<div
    class="min-h-0"
    [style.overflow]="settled() ? 'visible' : 'hidden'"
  >
    <ng-content />
  </div>`,
})
export class CollapseComponent {
  readonly open = input(false);

  /** Open and done moving: the content may overflow (focus rings, shadows). */
  protected readonly settled = signal(false);

  private fallback: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    let first = true;
    inject(DestroyRef).onDestroy(() => clearTimeout(this.fallback));
    effect(() => {
      const open = this.open();
      untracked(() => {
        clearTimeout(this.fallback);
        // Created open: nothing moves, so it is settled at once. Closing clips
        // at once. Opening clips until the row has grown, unless nothing will
        // move (reduced motion).
        const instant = first || prefersReducedMotion();
        first = false;
        this.settled.set(open && instant);
        // An opening whose transition never ends here (hidden while it ran,
        // e.g. under display:none) still settles.
        if (open && !instant) {
          this.fallback = setTimeout(
            () => this.settled.set(this.open()),
            SETTLE_FALLBACK_MS,
          );
        }
      });
    });
  }

  protected settle(event: TransitionEvent): void {
    if (event.target !== event.currentTarget) return;
    if (event.propertyName !== 'grid-template-rows') return;
    clearTimeout(this.fallback);
    this.settled.set(this.open());
  }
}
