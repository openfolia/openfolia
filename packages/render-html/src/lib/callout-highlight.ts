/**
 * Hover highlighting for image callouts (#549), for a host page that runs
 * script (a portal; the editor's preview frame does the same from outside
 * its sandbox). The rendered HTML ties each callout's marker, leader line,
 * legend entry and references together by one key (`data-callout`); while
 * the pointer is over one of them, or the keyboard focus is in one (a
 * reference is a link), every part with the same key carries
 * `of-callout--highlighted`, which the stylesheet draws.
 *
 * Keys are compared as strings, never put into a selector. Structural types
 * only, so the package needs no DOM library to build.
 */

/** The class every part of the highlighted callout carries (`render-html.css`). */
export const CALLOUT_HIGHLIGHTED = 'of-callout--highlighted';

/** The attribute that holds a callout's key: `<image output ID>:<callout ID>`. */
export const CALLOUT_KEY_ATTRIBUTE = 'data-callout';

interface CalloutElement {
  readonly classList: {
    add(name: string): void;
    remove(name: string): void;
  };
  getAttribute(name: string): string | null;
  closest(selectors: string): CalloutElement | null;
}

interface CalloutEvent {
  readonly target: unknown;
  /** On `mouseout`, where the pointer went: null when it left the page. */
  readonly relatedTarget?: unknown;
}

/** What `highlightCallouts` needs of a document. */
export interface CalloutDocument {
  querySelectorAll(selectors: string): Iterable<CalloutElement>;
  addEventListener(type: string, listener: (event: CalloutEvent) => void): void;
  removeEventListener(
    type: string,
    listener: (event: CalloutEvent) => void,
  ): void;
}

/** The callout key of the part `target` is in, or null. */
function keyAt(target: unknown): string | null {
  const element = target as Partial<CalloutElement> | null;
  if (!element || typeof element.closest !== 'function') return null;
  const part = element.closest(`[${CALLOUT_KEY_ATTRIBUTE}]`);
  return part?.getAttribute(CALLOUT_KEY_ATTRIBUTE) || null;
}

/**
 * Highlights a callout's parts while one of them is hovered or holds the
 * focus (`of-callout--highlighted`). Returns the function that stops
 * listening and takes the highlight away.
 */
export function highlightCallouts(doc: CalloutDocument): () => void {
  let hovered: string | null = null;
  let focused: string | null = null;
  let shown: string | null = null;
  const draw = () => {
    // The pointer wins over the focus: it is where the reader looks now.
    const key = hovered ?? focused;
    if (key === shown) return;
    shown = key;
    for (const part of doc.querySelectorAll(`[${CALLOUT_KEY_ATTRIBUTE}]`)) {
      if (key !== null && part.getAttribute(CALLOUT_KEY_ATTRIBUTE) === key)
        part.classList.add(CALLOUT_HIGHLIGHTED);
      else part.classList.remove(CALLOUT_HIGHLIGHTED);
    }
  };
  const onOver = (event: CalloutEvent) => {
    hovered = keyAt(event.target);
    draw();
  };
  // Off the page (the pointer left the window or frame): nothing is hovered.
  const onOut = (event: CalloutEvent) => {
    if (event.relatedTarget) return;
    hovered = null;
    draw();
  };
  const onFocus = (event: CalloutEvent) => {
    focused = keyAt(event.target);
    draw();
  };
  const onBlur = () => {
    focused = null;
    draw();
  };
  const listened: [string, (event: CalloutEvent) => void][] = [
    ['mouseover', onOver],
    ['mouseout', onOut],
    ['focusin', onFocus],
    ['focusout', onBlur],
  ];
  for (const [type, listener] of listened) doc.addEventListener(type, listener);
  return () => {
    for (const [type, listener] of listened)
      doc.removeEventListener(type, listener);
    hovered = null;
    focused = null;
    draw();
  };
}
