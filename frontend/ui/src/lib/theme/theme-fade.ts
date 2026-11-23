/**
 * Applies a theme change the person asked for as one crossfade of the whole page (300 ms,
 * ease-out: the `::view-transition-*` rules in `styles/ui.css`), rather than a snap. One fade
 * over a snapshot, so nothing changes colour at its own pace. The element marked
 * `themeIconMotion` (the sun or moon) turns out and in on its own during that fade.
 *
 * Where the browser has no view transitions, or the person asked for less motion, the change
 * simply happens. `change` must apply the new look synchronously (toggle the `.dark` class):
 * the DOM when it returns is the "after" picture. It is told whether it runs inside the fade
 * (then later, in the browser's update callback) or right away.
 */
export function withThemeFade(
  change: (inFade: boolean) => void,
  doc: Document = document,
): void {
  const view = doc.defaultView;
  const reduced = view?.matchMedia?.(
    '(prefers-reduced-motion: reduce)',
  ).matches;
  if (reduced || typeof doc.startViewTransition !== 'function') {
    change(false);
    return;
  }
  doc.startViewTransition(() => change(true));
}

/** The class that gives the theme toggle's icon its own part in the crossfade. */
export const themeIconMotion = '[view-transition-name:theme-icon]';
