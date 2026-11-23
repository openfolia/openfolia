import {
  afterRenderEffect,
  DestroyRef,
  inject,
  signal,
  type ElementRef,
  type Signal,
} from '@angular/core';

/**
 * The space above a list frame and below it (`belowPx`), for its `offset`: the frame is then
 * capped to the rest of the viewport (half of it at least), its rows scroll inside it and its
 * pagination stays in view.
 * Measured after each render (`track` names what may move it) and on resize.
 */
export function frameOffset(
  frame: Signal<ElementRef<HTMLElement> | undefined>,
  belowPx: number,
  track: () => unknown = () => undefined,
): Signal<string> {
  const offset = signal('20rem');
  const measure = () => {
    const el = frame()?.nativeElement;
    if (!el) return;
    // A frame further down the page (stacked under another section) still gets half the
    // viewport at least, once scrolled to.
    const top = Math.min(
      Math.round(el.getBoundingClientRect().top),
      Math.round(window.innerHeight / 2),
    );
    offset.set(`${Math.max(0, top) + belowPx}px`);
  };
  afterRenderEffect(() => {
    frame();
    track();
    measure();
  });
  window.addEventListener('resize', measure);
  inject(DestroyRef).onDestroy(() =>
    window.removeEventListener('resize', measure),
  );
  return offset.asReadonly();
}
