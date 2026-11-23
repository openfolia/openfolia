import { booleanAttribute, Directive, input } from '@angular/core';

/**
 * A region that loads again while its last answer is on screen: `[ofRefreshing]="true"`
 * keeps the content where it is, dimmed (60 %, a 300 ms ease-out fade), `inert` and
 * `aria-busy`, until the new answer replaces it. No skeleton, no jump. Instant under reduced
 * motion.
 *
 * Only for a reload: the first load shows placeholders (`of-skeleton-rows`) instead.
 *
 * ```html
 * <ul [ofRefreshing]="loading() && items().length > 0">…</ul>
 * ```
 */
@Directive({
  selector: '[ofRefreshing]',
  host: {
    class:
      'transition-opacity duration-300 ease-out motion-reduce:transition-none',
    '[class.opacity-60]': 'refreshing()',
    '[class.pointer-events-none]': 'refreshing()',
    '[attr.inert]': "refreshing() ? '' : null",
    '[attr.aria-busy]': 'refreshing() || null',
  },
})
export class RefreshingDirective {
  readonly refreshing = input(false, {
    alias: 'ofRefreshing',
    transform: booleanAttribute,
  });
}
