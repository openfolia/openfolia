import { computed, Directive, input } from '@angular/core';

/**
 * Fades an element in as it appears (300 ms), so new content never pops in. Put it on what an
 * `@if` or `@for` adds: the rows that replace a skeleton, a section that opens.
 *
 * `ofFadeIn="delayed"` is for loading placeholders: they stay invisible for 150 ms and only
 * then fade in, so a quick answer never flashes them. `of-skeleton-rows` is delayed already.
 *
 * Reduced motion: no fade. A delayed element still waits its 150 ms, then shows at once, so it
 * never flashes either.
 *
 * Not on an element with another `animate-*` class (`animate-pulse`, `animate-spin`): both set
 * `animation`, and the other one wins. Put it on a wrapper instead.
 *
 * ```html
 * <ul ofFadeIn>…</ul>
 * <div ofFadeIn="delayed" role="status" aria-busy="true">
 *   <span class="bg-muted h-8 animate-pulse rounded-md motion-reduce:animate-none"></span>
 * </div>
 * ```
 */
@Directive({
  selector: '[ofFadeIn]',
  host: { '[class]': 'classes()' },
})
export class FadeInDirective {
  /** `''` (the bare attribute): fade in at once; `'delayed'`: after 150 ms. */
  readonly mode = input<'' | 'delayed'>('', { alias: 'ofFadeIn' });
  protected readonly classes = computed(() =>
    this.mode() === 'delayed' ? FADE_IN_DELAYED : AT_ONCE,
  );
}

/** Merged with the element's own classes (Angular combines every class binding). */
const AT_ONCE = 'animate-in fade-in-0 duration-300 motion-reduce:animate-none';
/** Also the host classes of `of-skeleton-rows` (library-internal, not exported from `@openfolia/ui`). */
export const FADE_IN_DELAYED =
  'animate-in fade-in-0 duration-300 delay-150 fill-mode-both motion-reduce:duration-0';
