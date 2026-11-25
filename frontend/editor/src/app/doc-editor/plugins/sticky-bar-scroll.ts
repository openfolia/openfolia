import { Plugin, PluginKey } from '@tiptap/pm/state';

/** ProseMirror's own margin between the caret and a scroller's edge, in px. */
const MARGIN = 5;

/** A sticky bar stuck over the document: what it covers of its scroller's top, in px. */
export interface StuckBar {
  /** From the scroller's top to the bar's bottom: the band the caret must stay out of. */
  readonly band: number;
  /** From the scroller's top to the bar's top: the strip above the bar (the scroller's padding). */
  readonly gap: number;
}

/**
 * Where a sticky bar is stuck over the document that follows it, or null while it sits in the
 * flow. In the flow the bar ends where the next element (the document's scroller) begins; stuck,
 * it has slid down over it. That holds whatever the scroller's padding or the bar's `top`.
 */
export function stuckBar(bar: HTMLElement | null): StuckBar | null {
  const next = bar?.nextElementSibling;
  if (!bar || !next || getComputedStyle(bar).position !== 'sticky') return null;
  const box = bar.getBoundingClientRect();
  if (box.bottom <= next.getBoundingClientRect().top + 0.5) return null;
  let scroller = bar.parentElement;
  while (
    scroller &&
    !/^(auto|scroll|hidden)$/.test(getComputedStyle(scroller).overflowY)
  )
    scroller = scroller.parentElement;
  if (!scroller) return null;
  const top = scroller.getBoundingClientRect().top;
  return {
    band: Math.max(0, box.bottom - top),
    gap: Math.max(0, box.top - top),
  };
}

const key = new PluginKey('docEditorStickyBarScroll');

/**
 * Keeps the caret clear of a sticky bar over the document (#886): with its columns stacked the module editor's
 * toolbar sticks to the top of the page's scroller, and ProseMirror (as the browser) scrolls a
 * caret coming back into view to 5 px from that top, under the bar. While the bar is stuck, a
 * caret under it counts as out of view and comes back to just below it; otherwise ProseMirror's
 * defaults stand, so a caret in view never scrolls the page. Read on every scroll, so the bar's
 * height (one row or two) and whether it is stuck are always current.
 *
 * While stuck the bar also carries `data-stuck`, and `--doc-editor-stuck-gap` is the strip above
 * it (the scroller's padding), which the styles cover so no text shows above the bar.
 */
export function stickyBarScroll(bar: () => HTMLElement | null): Plugin {
  const band = () => stuckBar(bar())?.band ?? 0;
  return new Plugin({
    key,
    view(view) {
      const doc = view.dom.ownerDocument;
      const win = doc.defaultView;
      let frame = 0;
      const mark = () => {
        frame = 0;
        const el = bar();
        if (!el) return;
        const stuck = stuckBar(el);
        el.toggleAttribute('data-stuck', !!stuck);
        if (stuck)
          el.style.setProperty('--doc-editor-stuck-gap', `${stuck.gap}px`);
        else el.style.removeProperty('--doc-editor-stuck-gap');
      };
      const schedule = () => {
        if (!frame && win) frame = win.requestAnimationFrame(mark);
      };
      // Scroll events don't bubble: listening while capturing hears every scroller's.
      doc.addEventListener('scroll', schedule, {
        capture: true,
        passive: true,
      });
      win?.addEventListener('resize', schedule, { passive: true });
      // Also once now and after every change: the toolbar comes after the view, and a page can
      // open already scrolled.
      schedule();
      return {
        update: schedule,
        destroy() {
          doc.removeEventListener('scroll', schedule, { capture: true });
          win?.removeEventListener('resize', schedule);
          if (frame) win?.cancelAnimationFrame(frame);
        },
      };
    },
    props: {
      scrollThreshold: {
        get top() {
          return band();
        },
        right: 0,
        bottom: 0,
        left: 0,
      },
      scrollMargin: {
        get top() {
          return band() + MARGIN;
        },
        right: MARGIN,
        bottom: MARGIN,
        left: MARGIN,
      },
    },
  });
}
