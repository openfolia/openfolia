import { PluginKey } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';

import type { BlockBox } from './drag-geometry';
import { childStarts } from './flow';

// What the block drag and the keyboard slide share: the plugin's state and the measuring of a
// flow's children on screen (`flow.ts`).

/** A drag in progress, in the document as it was when it began (a change ends it). */
export interface ActiveDrag {
  /** The dragged block's position; it folds away while its slot stands for it. */
  source: number;
  /** Where the slot stands: a drop target's position (`source`: the block's own place). */
  slot: number;
  /** The slot's height (px): the block's, capped for a long one. */
  height: number;
  /** What the slot says: the heading level a dragged section has there; null for a block. */
  label: string | null;
  /** Per position, how far a node is pushed back from where it now stands, to slide into it. */
  offsets: readonly (readonly [number, number])[];
  /** Whether the offsets slide (else they apply at once: the first frame of the slide). */
  sliding: boolean;
}

export interface DragState {
  /** Whether the editor has the focus: then the caret's block shows its grip. */
  focused?: boolean;
  hoverPos: number | null;
  drag: ActiveDrag | null;
  /** A keyboard move sliding into place: per child of the flow, and whether the slide runs. */
  flip: { flow: number; shifts: number[]; animate: boolean } | null;
}

export const blockDragKey = new PluginKey<DragState>('docEditorBlockDrag');
export const IDLE: DragState = { hoverPos: null, drag: null, flip: null };

/** How long blocks slide and the copy settles, as in the module tree. */
export const SLIDE_MS = 200;

/** Whether to animate: only for someone who has not asked for less motion. */
export function motionAllowed(win: Window | null | undefined): boolean {
  return !!win?.matchMedia?.('(prefers-reduced-motion: no-preference)').matches;
}

/** The flow's children's DOM elements, in order (null where one has none). */
export function flowElements(
  view: EditorView,
  flow: number,
): (HTMLElement | null)[] {
  return childStarts(view.state.doc, flow).map((pos) => {
    const dom = view.nodeDOM(pos);
    return dom instanceof HTMLElement ? dom : null;
  });
}

/** Measures the flow's children as they stand, with no slide applied. */
export function measure(view: EditorView, flow: number): BlockBox[] {
  return flowElements(view, flow).map((el) => {
    const rect = el?.getBoundingClientRect();
    return { top: rect?.top ?? 0, height: rect?.height ?? 0 };
  });
}

/** The flow's children's tops as they stand now, for a slide after a move. */
export function flowTops(view: EditorView, flow: number): number[] {
  return measure(view, flow).map((box) => box.top);
}
