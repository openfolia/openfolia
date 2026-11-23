/**
 * Escape for term tooltips (#245), for a host page that runs script (the
 * editor's preview frame, a portal). The rendered HTML shows a term's
 * definition on hover and focus with CSS alone; dismissing it with Escape,
 * without moving the pointer or the focus (WCAG 1.4.13), needs this.
 *
 * Structural types only, so the package needs no DOM library to build.
 */

/** The class that hides a term's tooltip (`render-html.css`). */
export const TERM_DISMISSED = 'of-term--dismissed';

interface TermElement {
  readonly classList: {
    add(name: string): void;
    remove(name: string): void;
  };
  contains(other: unknown): boolean;
}

interface TermEvent {
  readonly key?: string;
  readonly target: unknown;
}

/** What `dismissTermOnEscape` needs of a document. */
export interface TermDocument {
  querySelectorAll(selectors: string): Iterable<TermElement>;
  addEventListener(type: string, listener: (event: TermEvent) => void): void;
  removeEventListener(type: string, listener: (event: TermEvent) => void): void;
}

/**
 * On Escape, hides the tooltip of every term under the pointer or holding
 * the focus (`of-term--dismissed`), until the pointer or the focus moves
 * to something outside it. Returns the function that stops listening.
 */
export function dismissTermOnEscape(doc: TermDocument): () => void {
  const onKey = (event: TermEvent) => {
    if (event.key !== 'Escape') return;
    for (const term of doc.querySelectorAll(
      '.of-term:hover, .of-term:focus-within',
    )) {
      term.classList.add(TERM_DISMISSED);
    }
  };
  const onMove = (event: TermEvent) => {
    for (const term of doc.querySelectorAll(`.${TERM_DISMISSED}`)) {
      if (!term.contains(event.target)) term.classList.remove(TERM_DISMISSED);
    }
  };
  doc.addEventListener('keydown', onKey);
  doc.addEventListener('mouseover', onMove);
  doc.addEventListener('focusin', onMove);
  return () => {
    doc.removeEventListener('keydown', onKey);
    doc.removeEventListener('mouseover', onMove);
    doc.removeEventListener('focusin', onMove);
  };
}
