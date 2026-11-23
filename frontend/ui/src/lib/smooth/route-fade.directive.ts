import { Directive } from '@angular/core';

/**
 * On a `router-outlet`: the page it shows fades in (200 ms ease-out, opacity only: no slide, no
 * layout shift) each time the route changes, instead of popping in. Off under reduced motion.
 *
 * The page is the element Angular puts right after the outlet, so the rule lives in `ui.css`
 * (`.of-route-fade + *`). It animates opacity alone, not tw-animate-css's `animate-in`, whose
 * transform would make the page the containing block of its fixed children (the sidebar) while
 * it runs.
 *
 * ```html
 * <router-outlet ofRouteFade />
 * ```
 */
@Directive({
  selector: 'router-outlet[ofRouteFade]',
  host: { class: 'of-route-fade' },
})
export class RouteFadeDirective {}
