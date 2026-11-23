import { Directive, input } from '@angular/core';

/**
 * A column that gives way sideways: collapsed, its width shrinks to nothing (250 ms, the
 * easing of `of-side-panel`) while it fades out, and grows back the same way. The content
 * stays rendered all along, so it keeps its state (a tab, a scroll position); once collapsed
 * it is `visibility: hidden` and `inert`, so it can't be focused or read.
 *
 * Its open width comes from the element's own class (`lg:w-80`: a length, so the width has
 * something to move between); give the content inside the same fixed width, so it never
 * reflows while the column moves. `--of-collapse-gap` (default `0px`) is the parent's `gap`
 * before the column, closed along with the width.
 *
 * Paired with a `of-side-panel` that opens in its place, both columns move in the same
 * frames: bind `[ofCollapseWidth]` to the panel's `opened()` and
 * `[ofCollapseWidthInstant]` to `!panel.animates()`, so an opening the panel makes at once
 * (reduced motion, not the person's) collapses the column at once too.
 *
 * ```html
 * <div
 *   class="shrink-0 lg:w-80 [--of-collapse-gap:1rem]"
 *   [ofCollapseWidth]="preview.opened()"
 *   [ofCollapseWidthInstant]="!preview.animates()"
 * >
 *   <aside class="lg:w-80 lg:overflow-y-auto">…</aside>
 * </div>
 * ```
 */
@Directive({
  selector: '[ofCollapseWidth]',
  host: {
    'data-slot': 'collapse-width',
    '[attr.data-state]': "collapsed() ? 'collapsed' : 'open'",
    class:
      'overflow-clip transition-[width,margin-inline-start,opacity,visibility] duration-250 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none',
    '[class.invisible]': 'collapsed()',
    '[class.opacity-0]': 'collapsed()',
    '[style.width]': "collapsed() ? '0px' : null",
    '[style.margin-inline-start]':
      "collapsed() ? 'calc(-1 * var(--of-collapse-gap, 0px))' : null",
    // Inline, so it wins over the transition class whatever order the styles come in.
    '[style.transition]': "instant() ? 'none' : null",
    '[attr.inert]': "collapsed() ? '' : null",
  },
})
export class CollapseWidthDirective {
  /** Collapsed: no width, faded out, hidden. */
  readonly collapsed = input(false, { alias: 'ofCollapseWidth' });
  /** Changes at once, without a transition (as the panel replacing it does). */
  readonly instant = input(false, { alias: 'ofCollapseWidthInstant' });
}
