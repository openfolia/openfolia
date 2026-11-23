import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import type { EditorView } from '@tiptap/pm/view';

/** Gives an element the box jsdom does not lay out. */
export function box(el: Element, top: number, height: number): void {
  el.getBoundingClientRect = () =>
    ({ top, height, left: 0, width: 300, bottom: top + height }) as DOMRect;
}

/** The nodes that hold rows of their own here: they span them (a frame adds 10 px at the top). */
const SPANS: Readonly<Record<string, number>> = {
  section: 0,
  list: 0,
  variant: 10,
  safety: 10,
};

/**
 * Lays the document out as jsdom does not, from `top` down: every block a row of 20 px (or the
 * height `rows` gives its text) with 10 px after it, in reading order; a section, list, variant or
 * safety notice spans its rows. The drag measures what this sets.
 */
export function layOutRows(
  view: EditorView,
  top = 200,
  rows: Readonly<Record<string, number>> = {},
): void {
  let y = top;
  const walk = (node: ProseMirrorNode, start: number) =>
    node.forEach((child, offset) => {
      const pos = start + offset;
      const el = view.nodeDOM(pos);
      const at = y;
      const frame = SPANS[child.type.name];
      if (frame !== undefined) {
        y += frame;
        walk(child, pos + 1);
        if (el instanceof Element) box(el, at, y - at - 10);
      } else {
        const height = rows[child.textContent] ?? 20;
        if (el instanceof Element) box(el, at, height);
        y += height + 10;
      }
    });
  walk(view.state.doc, 0);
}
