/**
 * Marks the changes on a rendered page in the preview frame (`of-preview-frame`): each changed
 * block gets a bar at its edge, a tint for a whole block added, and a line above it naming the
 * change in words (never the colour alone). The page is untrusted and has no scripts; everything
 * here is done from outside, through the prototypes' own members (an element in the page could
 * shadow a member of its document by name), and only as text and inline styles, which the
 * frame's policy allows (`style-src-attr`); nothing of it reaches the page as markup.
 */

export type FrameTone = 'added' | 'changed' | 'moved';

export interface FrameMark {
  /** The block's element ID in the page (`of-<module>--<block>`). */
  readonly elementId: string;
  readonly tone: FrameTone;
  /** What happened, in words (with its symbol). */
  readonly text: string;
}

/** The attribute a mark's line carries, so marks are found (and taken away) again. */
export const MARK_ATTR = 'data-of-review-mark';

/**
 * The colours of the marks: the app's own tokens as resolved now (`--success`, `--info` and their
 * muted tints), so the page shows the app's theme. An empty tint: none.
 */
export type FramePalette = Record<
  FrameTone,
  { readonly bar: string; readonly tint: string; readonly text: string }
>;

/** The palette from the app's tokens, as the element's styles resolve them. */
export function paletteOf(style: CSSStyleDeclaration): FramePalette {
  const token = (name: string) => style.getPropertyValue(name).trim();
  const info = {
    bar: token('--info'),
    tint: '',
    text: token('--info'),
  };
  return {
    added: {
      bar: token('--success'),
      tint: token('--success-muted'),
      text: token('--success'),
    },
    changed: info,
    moved: info,
  };
}

const getElementByIdOf = Document.prototype.getElementById;
const createElementOf = Document.prototype.createElement;
const setAttributeOf = Element.prototype.setAttribute;
const getAttributeOf = Element.prototype.getAttribute;
const removeAttributeOf = Element.prototype.removeAttribute;
const removeOf = Element.prototype.remove;
const beforeOf = Element.prototype.before;
const prependOf = Element.prototype.prepend;
const localNameOf = Object.getOwnPropertyDescriptor(
  Element.prototype,
  'localName',
)?.get as (this: Element) => string;
const textContentOf = Object.getOwnPropertyDescriptor(
  Node.prototype,
  'textContent',
)?.set as (this: Node, value: string) => void;

/**
 * What the last marking did on a page: the lines it added and the blocks it styled, with their
 * own style. Kept here, not in the page, so the page's own attributes can never pass for them.
 */
const drawn = new WeakMap<
  Document,
  { lines: Element[]; styled: [Element, string | null][] }
>();

/** Takes the marks away again (another variant shown, the marks drawn anew). */
export function clearMarks(doc: Document): void {
  const last = drawn.get(doc);
  if (!last) return;
  drawn.delete(doc);
  for (const line of last.lines) removeOf.call(line);
  // Last first: a block marked twice gets its own style back.
  for (const [el, style] of [...last.styled].reverse()) {
    if (style === null) removeAttributeOf.call(el, 'style');
    else setAttributeOf.call(el, 'style', style);
  }
}

/**
 * Marks the blocks the page shows; answers the marks whose block is not on the page (a variant
 * that leaves it out).
 */
export function markChanges(
  doc: Document,
  marks: readonly FrameMark[],
  palette: FramePalette,
): FrameMark[] {
  clearMarks(doc);
  const missing: FrameMark[] = [];
  const done = {
    lines: [] as Element[],
    styled: [] as [Element, string | null][],
  };
  drawn.set(doc, done);
  for (const mark of marks) {
    const block = getElementByIdOf.call(doc, mark.elementId) as Element | null;
    if (!block) {
      missing.push(mark);
      continue;
    }
    const colours = palette[mark.tone];
    const saved = getAttributeOf.call(block, 'style');
    const own = saved ?? '';
    done.styled.push([block, saved]);
    setAttributeOf.call(
      block,
      'style',
      `${own};box-shadow:inset 3px 0 0 ${colours.bar};${colours.tint ? `background-color:${colours.tint};` : ''}padding-inline-start:0.75rem;border-radius:0 0.375rem 0.375rem 0;${mark.tone === 'moved' ? 'outline:1px dashed ' + colours.bar + ';outline-offset:2px;' : ''}`,
    );
    const name = localNameOf.call(block);
    // Inside a list item or a cell (a line before it would break the list or the table); above
    // anything else.
    const inside = ['li', 'td', 'th', 'tr', 'dt', 'dd'].includes(name);
    const line = createElementOf.call(doc, inside ? 'span' : 'div') as Element;
    setAttributeOf.call(line, MARK_ATTR, mark.tone);
    setAttributeOf.call(
      line,
      'style',
      `display:block;margin:0 0 0.25rem;padding-inline-start:0.75rem;font:500 0.75rem/1.25rem system-ui,sans-serif;color:${colours.text};box-shadow:inset 3px 0 0 ${colours.bar}`,
    );
    textContentOf.call(line, mark.text);
    done.lines.push(line);
    if (inside) prependOf.call(block, line);
    else beforeOf.call(block, line);
  }
  return missing;
}
