import { Extension } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { Plugin, type EditorState } from '@tiptap/pm/state';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';

import { blockMenuPos, openBlockMenu, pressGrip } from './block-menu';
import { moveBlockTo, selectedBlock } from './block-move';
import { readDomSelection } from './caret-sync';
import {
  autoScrollStep,
  chooseTarget,
  type PlacedTarget,
} from './drag-geometry';
import {
  blockDragKey,
  IDLE,
  motionAllowed,
  SLIDE_MS,
  type ActiveDrag,
  type DragState,
} from './drag-state';
import {
  boundaryOf,
  dropRefusalText,
  dropTargets,
  sectionLevel,
  type DropRefusal,
  type DropTarget,
} from './drop-rules';
import { blockAround, flowNode, isSection } from './flow';

export { blockDragKey, type DragState } from './drag-state';

// Dragging a block by its grip, the way the module tree does it: the block lifts as a floating
// copy locked to the vertical axis (a long one capped, fading out), and a dashed slot of its
// height stands where it will land, anywhere `drop-rules.ts` lets it go: across sections, into
// and out of a variant block, a safety notice or an FAQ entry, a section among the sections of any flow at the level it
// lands at (a sideways pull picks the level where several meet). The blocks it passes slide
// aside. Over a place where it can't go, the slot stays at the last allowed one, the copy shows
// it is refused with a short reason, and releasing there changes nothing. Near the scroll area's
// edges the editor scrolls. On release the copy settles into the slot and one transaction moves
// the block, so one undo puts it back. A pointer way only (the grip is hidden from assistive
// technology): Alt+Up/Down and the toolbar's buttons make the same moves. A click on the grip
// (a press let go without moving) opens the block's menu (`block-menu.ts`).

export interface BlockDragOptions {
  /** Finds a text as the person reads it: the refusal's reason, the slot's heading level. */
  translate: (key: string, params?: Record<string, unknown>) => string;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** The tallest the lifted copy and the slot get (px): a long block shows its start, fading out. */
export const LIFT_MAX = 160;
/** How far sideways (px) the pointer moves for a section to ask for one level more or less. */
const LEVEL_STEP = 24;
/** Room left of the block for the copy's grip and padding (px): the copy's own CSS matches. */
const COPY_INSET = 36;

const SLIDE_CLASS = 'doc-editor-sliding';
const SOURCE_CLASS = 'doc-editor-drag-source';
const SLOT_CLASS =
  'doc-editor-drag-slot rounded-md outline-1 outline-dashed -outline-offset-1 outline-ring/70 bg-accent/60';
/** On the root element while a block is dragged, and while the place under it is refused. */
const DRAGGING_CLASS = 'doc-editor-dragging';
const REFUSED_CLASS = 'doc-editor-drag-refused';

/**
 * The drags under way in each editor, from the lift until the block has settled: their clean-ups,
 * which the editor runs when it is destroyed. The drag listens on the window (the pointer, and
 * Escape in the capture phase, so nothing else hears it), and an editor destroyed mid-drag (the
 * page left, the module closed) would otherwise leave those listeners behind, taking the next
 * Escape anywhere on the page.
 */
const activeDrags = new WeakMap<EditorView, Set<() => void>>();

/** Six dots, built node by node: no markup string reaches the DOM. */
function gripIcon(doc: Document): SVGSVGElement {
  const svg = doc.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '12');
  svg.setAttribute('height', '12');
  svg.setAttribute('fill', 'currentColor');
  for (const cx of [9, 15]) {
    for (const cy of [6, 12, 18]) {
      const dot = doc.createElementNS(SVG_NS, 'circle');
      dot.setAttribute('cx', String(cx));
      dot.setAttribute('cy', String(cy));
      dot.setAttribute('r', '1.5');
      svg.appendChild(dot);
    }
  }
  return svg;
}

/** The start of the block at these coordinates: anything inside one counts as all of it. */
function blockAt(
  view: EditorView,
  clientX: number,
  clientY: number,
): number | null {
  const coords = view.posAtCoords({ left: clientX, top: clientY });
  if (!coords) return null;
  // Over a leaf such as a placeholder, `pos` is before or after it by the pointer's half;
  // `inside` is the node itself.
  const at = coords.inside >= 0 ? coords.inside : coords.pos;
  return blockAround(view.state.doc.resolve(at))?.pos ?? null;
}

const elementAt = (view: EditorView, pos: number): HTMLElement | null => {
  const dom = view.nodeDOM(pos);
  return dom instanceof HTMLElement ? dom : null;
};

/**
 * The holders whose children slide: the flows (a procedure is the flow of its steps) and the
 * containers a block can go into.
 */
const HOLDERS = new Set([
  'doc',
  'section',
  'variant',
  'safety',
  'faq',
  'procedure',
  'listItem',
]);

/**
 * Calls `visit` for each child of every holder, outermost first, but the dragged block's own
 * content; `visit` returns what its children are handed.
 */
function eachChild<T>(
  doc: ProseMirrorNode,
  source: number,
  visit: (pos: number, node: ProseMirrorNode, parent: T) => T,
  root: T,
): void {
  const walk = (holder: ProseMirrorNode, start: number, parent: T) => {
    holder.forEach((child, offset) => {
      const pos = start + offset;
      const value = visit(pos, child, parent);
      if (pos !== source && HOLDERS.has(child.type.name))
        walk(child, pos + 1, value);
    });
  };
  walk(doc, 0, root);
}

/** The nodes that slide aside while the block at `source` is dragged: every holder's children. */
export function slidingNodes(doc: ProseMirrorNode, source: number): number[] {
  const out: number[] = [];
  eachChild<null>(
    doc,
    source,
    (pos) => {
      out.push(pos);
      return null;
    },
    null,
  );
  return out;
}

/** Where every child of a holder stands on screen now (its top), by position. */
function nodeTops(view: EditorView, source: number): Map<number, number> {
  const tops = new Map<number, number>();
  for (const pos of slidingNodes(view.state.doc, source)) {
    const el = elementAt(view, pos);
    if (el) tops.set(pos, el.getBoundingClientRect().top);
  }
  return tops;
}

/**
 * How far each node must be pushed back to stand where it stood (`before`) now that it stands
 * at `after`: relative to the holder around it, whose own push already carries it.
 */
function pushBacks(
  doc: ProseMirrorNode,
  source: number,
  before: Map<number, number>,
  after: Map<number, number>,
): [number, number][] {
  const out: [number, number][] = [];
  eachChild<number>(
    doc,
    source,
    (pos, _node, parent) => {
      const was = before.get(pos);
      const is = after.get(pos);
      if (was === undefined || is === undefined) return parent;
      const delta = was - is;
      if (Math.abs(delta - parent) > 0.5) out.push([pos, delta - parent]);
      return delta;
    },
    0,
  );
  return out;
}

/** The scroll area the editor is in: the nearest ancestor that scrolls, else the page (null). */
export function scrollArea(dom: HTMLElement): HTMLElement | null {
  const win = dom.ownerDocument.defaultView;
  for (let el = dom.parentElement; el; el = el.parentElement) {
    const overflow = win?.getComputedStyle(el).overflowY ?? '';
    if (
      /auto|scroll|overlay/.test(overflow) &&
      el.scrollHeight > el.clientHeight
    )
      return el;
  }
  return null;
}

/** The floating copy of the block: the grip, its content cloned (capped) and the refusal's hint. */
function liftedCopy(
  view: EditorView,
  block: HTMLElement,
  capped: boolean,
): { copy: HTMLElement; hint: HTMLElement } {
  const doc = view.dom.ownerDocument;
  const copy = doc.createElement('div');
  copy.className =
    'doc-editor-lifted bg-background text-foreground border-border rounded-md border shadow-lg ring-1 ring-ring/20';
  copy.setAttribute('aria-hidden', 'true');
  copy.setAttribute('data-testid', 'block-lifted');
  const grip = doc.createElement('div');
  grip.className = 'doc-editor-lifted-grip';
  grip.appendChild(gripIcon(doc));
  const clip = doc.createElement('div');
  clip.className = capped
    ? 'doc-editor-lifted-body doc-editor-lifted-capped'
    : 'doc-editor-lifted-body';
  clip.style.maxHeight = `${LIFT_MAX}px`;
  const body = block.cloneNode(true) as HTMLElement;
  body.classList.remove('ProseMirror-selectednode', SOURCE_CLASS);
  // Only the drag's own styles go: the block's own (a table's columns) stay.
  for (const property of ['transform', 'transition', 'translate'])
    body.style.removeProperty(property);
  clip.appendChild(body);
  const hint = doc.createElement('div');
  hint.className =
    'doc-editor-drop-hint bg-destructive-muted text-destructive border-destructive/40 rounded-md border px-2 py-1 text-xs font-medium shadow-md';
  hint.setAttribute('data-testid', 'block-drop-hint');
  hint.hidden = true;
  copy.append(grip, clip, hint);
  return { copy, hint };
}

/**
 * Puts the copy's block exactly over the block (left, top, width): what the copy adds around
 * it (the grip, the padding, the border) is measured, not assumed.
 */
function alignCopy(copy: HTMLElement, rect: DOMRect): void {
  const body = copy.querySelector('.doc-editor-lifted-body > *');
  if (!body) return;
  const at = body.getBoundingClientRect();
  if (at.width === 0 && at.height === 0) return; // not laid out (a test without layout)
  copy.style.left = `${parseFloat(copy.style.left) + rect.left - at.left}px`;
  copy.style.top = `${parseFloat(copy.style.top) + rect.top - at.top}px`;
  copy.style.width = `${parseFloat(copy.style.width) + rect.width - at.width}px`;
}

/** The slot: a dashed box of the block's height, saying the level a section lands at. */
function slotElement(
  view: EditorView,
  height: number,
  label: string | null,
): HTMLElement {
  const doc = view.dom.ownerDocument;
  const slot = doc.createElement('div');
  slot.className = SLOT_CLASS;
  slot.setAttribute('contenteditable', 'false');
  slot.setAttribute('aria-hidden', 'true');
  slot.setAttribute('data-testid', 'block-slot');
  slot.style.height = `${height}px`;
  if (label) {
    const text = doc.createElement('span');
    text.className =
      'doc-editor-drag-slot-label text-muted-foreground text-xs font-medium';
    text.textContent = label;
    slot.appendChild(text);
  }
  return slot;
}

interface Placed extends PlacedTarget {
  target: DropTarget;
}

function beginDrag(
  view: EditorView,
  from: number,
  start: { x: number; y: number },
  translate: BlockDragOptions['translate'],
) {
  const startDoc = view.state.doc;
  const node = startDoc.nodeAt(from);
  const block = elementAt(view, from);
  if (!node || !block) return;
  const doc = view.dom.ownerDocument;
  const win = doc.defaultView ?? window;
  const animate = motionAllowed(win);
  const rect = block.getBoundingClientRect();
  const ownLevel = isSection(node) ? sectionLevel(startDoc, from) : null;
  const levelLabel = (level: number | null) =>
    level === null
      ? null
      : translate('editor.docEditor.style.heading', { level });

  // The room the block takes in its flow: its height and the space after it.
  const $from = startDoc.resolve(from);
  const next = $from.parent.maybeChild($from.index() + 1);
  const nextEl = next ? elementAt(view, from + node.nodeSize) : null;
  const gap = Math.max(
    0,
    nextEl
      ? nextEl.getBoundingClientRect().top - rect.top - rect.height
      : parseFloat(win.getComputedStyle(block).marginBottom) || 0,
  );
  const height = Math.min(rect.height, LIFT_MAX);
  const room = height + gap;

  const { copy, hint } = liftedCopy(view, block, rect.height > LIFT_MAX);
  Object.assign(copy.style, {
    position: 'fixed',
    left: `${rect.left - COPY_INSET}px`,
    top: `${rect.top - 4}px`,
    width: `${rect.width + COPY_INSET + 8}px`,
    zIndex: '50',
    pointerEvents: 'none',
  });
  (view.dom.parentElement ?? doc.body).appendChild(copy);
  alignCopy(copy, rect);
  doc.documentElement.classList.add(DRAGGING_CLASS);

  const area = scrollArea(view.dom);
  const scrollTop = () => (area ? area.scrollTop : win.scrollY);
  // Set once the block has folded away: a shorter document may have scrolled the area.
  let scrollStart = scrollTop();

  let drag: ActiveDrag = {
    source: from,
    slot: from,
    height,
    label: levelLabel(ownLevel),
    offsets: [],
    sliding: false,
  };
  const set = (value: ActiveDrag | null) =>
    view.dispatch(
      view.state.tr.setMeta(blockDragKey, { drag: value, hoverPos: null }),
    );

  // Each change of the slot lays the document out anew; the nodes it moves slide there from
  // where they stood (for someone who has not asked for less motion).
  let slideRun = 0;
  let slideFrame: number | undefined;
  let slideTimer: ReturnType<typeof setTimeout> | undefined;
  function moveSlot(change: Partial<ActiveDrag>, laidOut?: () => void) {
    slideRun += 1;
    if (slideFrame !== undefined) win.cancelAnimationFrame?.(slideFrame);
    win.clearTimeout(slideTimer);
    const before = animate ? nodeTops(view, from) : null;
    drag = { ...drag, ...change, offsets: [], sliding: false };
    set(drag);
    laidOut?.();
    if (!before) return;
    const offsets = pushBacks(
      view.state.doc,
      from,
      before,
      nodeTops(view, from),
    );
    if (!offsets.length) return;
    const settled = drag;
    set({ ...settled, offsets });
    // Lay the pushed-back frame out before letting go, or the browser skips the transition.
    void view.dom.offsetHeight;
    const run = slideRun;
    slideFrame = win.requestAnimationFrame(() => {
      if (run !== slideRun || view.isDestroyed) return;
      set({
        ...settled,
        offsets: offsets.map(([pos]) => [pos, 0]),
        sliding: true,
      });
      slideTimer = win.setTimeout(() => {
        if (run === slideRun && !view.isDestroyed) set(settled);
      }, SLIDE_MS);
    });
  }

  // Where each place would put the slot's top with the block folded away and no slot standing,
  // measured once at the start of the drag (scrolled as it was then). On screen, the places past
  // the slot stand one room lower.
  let places: Placed[] = [];
  moveSlot({}, () => {
    scrollStart = scrollTop();
    const slotBox = view.dom
      .querySelector('[data-testid="block-slot"]')
      ?.getBoundingClientRect();
    const homeTop = slotBox?.height ? slotBox.top : rect.top;
    places = dropTargets(view.state, from).flatMap((target) => {
      let top: number;
      if (target.home) top = homeTop;
      else {
        const el = elementAt(view, target.anchor);
        if (!el) return [];
        const box = el.getBoundingClientRect();
        top = target.edge === 'top' ? box.top : box.top + box.height + gap;
        // The block's own place folds away first: below it, everything stands its room higher.
        if (target.pos > from) top -= room;
      }
      return [
        {
          pos: target.pos,
          boundary: boundaryOf(startDoc, target.pos),
          level: target.level,
          refusal: target.refusal,
          home: target.home,
          top,
          target,
        },
      ];
    });
  });

  let pointer = { ...start };
  let refused: DropRefusal | null = null;

  function showRefusal(refusal: DropRefusal | null, level: number | null) {
    refused = refusal;
    copy.classList.toggle('doc-editor-lifted-refused', refusal !== null);
    doc.documentElement.classList.toggle(REFUSED_CLASS, refusal !== null);
    if (refusal === null) {
      hint.hidden = true;
      return;
    }
    const text = dropRefusalText(view.state, refusal, level ?? ownLevel ?? 1);
    hint.textContent = translate(text.key, text.params);
    hint.hidden = false;
  }

  function follow() {
    if (view.isDestroyed || view.state.doc !== startDoc) return cancel();
    const dy = pointer.y - start.y;
    copy.style.transform = `translateY(${dy}px)`;
    const copyTop = rect.top + dy + (scrollTop() - scrollStart);
    const preferred =
      ownLevel === null
        ? null
        : ownLevel + Math.round((pointer.x - start.x) / LEVEL_STEP);
    // Compared where each place stands on screen now: past the slot, one room lower.
    const shown = places.map((place) =>
      place.pos > drag.slot ? { ...place, top: place.top + room } : place,
    );
    const chosen = chooseTarget(shown, copyTop, preferred);
    if (!chosen) return;
    if (chosen.refusal) {
      showRefusal(chosen.refusal as DropRefusal, chosen.level);
      return;
    }
    showRefusal(null, null);
    const label = levelLabel(chosen.level);
    if (chosen.pos !== drag.slot || label !== drag.label)
      moveSlot({ slot: chosen.pos, label });
  }

  // Near the scroll area's edges, the editor scrolls, a little more each frame.
  let scrollFrame: number | undefined;
  function edges(): { top: number; bottom: number } {
    const viewport = { top: 0, bottom: win.innerHeight };
    if (!area) return viewport;
    const box = area.getBoundingClientRect();
    return {
      top: Math.max(box.top, viewport.top),
      bottom: Math.min(box.top + box.height, viewport.bottom),
    };
  }
  function autoScroll() {
    scrollFrame = undefined;
    const { top, bottom } = edges();
    const step = autoScrollStep(pointer.y, top, bottom);
    if (!step) return;
    if (area) area.scrollTop += step;
    else win.scrollBy(0, step);
    follow();
    scrollFrame = win.requestAnimationFrame?.(autoScroll);
  }

  let settling: ReturnType<typeof setTimeout> | undefined;

  function cleanUp() {
    activeDrags.get(view)?.delete(cleanUp);
    slideRun += 1;
    win.clearTimeout(settling);
    win.clearTimeout(slideTimer);
    if (slideFrame !== undefined) win.cancelAnimationFrame?.(slideFrame);
    if (scrollFrame !== undefined) win.cancelAnimationFrame?.(scrollFrame);
    win.removeEventListener('pointermove', onMove);
    win.removeEventListener('pointerup', onUp);
    win.removeEventListener('pointercancel', cancel);
    win.removeEventListener('keydown', onKey, true);
    win.removeEventListener('scroll', onScroll, true);
    doc.documentElement.classList.remove(DRAGGING_CLASS, REFUSED_CLASS);
    copy.remove();
  }

  function cancel() {
    cleanUp();
    if (!view.isDestroyed && blockDragKey.getState(view.state)?.drag) set(null);
  }

  function onKey(event: KeyboardEvent) {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    cancel();
  }

  function onScroll() {
    follow();
  }

  function onMove(event: PointerEvent) {
    pointer = { x: event.clientX, y: event.clientY };
    follow();
    if (scrollFrame === undefined && win.requestAnimationFrame) {
      const { top, bottom } = edges();
      if (autoScrollStep(pointer.y, top, bottom))
        scrollFrame = win.requestAnimationFrame(autoScroll);
    }
  }

  function onUp() {
    win.removeEventListener('pointermove', onMove);
    win.removeEventListener('pointerup', onUp);
    win.removeEventListener('pointercancel', cancel);
    win.removeEventListener('scroll', onScroll, true);
    if (scrollFrame !== undefined) win.cancelAnimationFrame?.(scrollFrame);
    scrollFrame = undefined;
    if (view.isDestroyed || view.state.doc !== startDoc) return cancel();
    // Released over a refused place: nothing changes, the block goes back to its own place.
    if (refused !== null && drag.slot !== from) {
      showRefusal(null, null);
      moveSlot({ slot: from, label: levelLabel(ownLevel) });
    }
    const to = refused === null ? drag.slot : from;
    const drop = () => {
      cleanUp();
      if (view.isDestroyed) return;
      set(null);
      if (to !== from && view.editable && view.state.doc === startDoc)
        moveBlockTo(view, from, to);
    };
    if (!animate) return drop();
    // The copy settles into the slot, then the block takes its place.
    const slot = view.dom.querySelector('[data-testid="block-slot"]');
    const settleTop = slot?.getBoundingClientRect().top ?? rect.top;
    copy.style.transition = `transform ${SLIDE_MS}ms cubic-bezier(0.2, 0, 0, 1)`;
    copy.style.transform = `translateY(${settleTop - rect.top}px)`;
    settling = win.setTimeout(drop, SLIDE_MS);
  }

  const active = activeDrags.get(view) ?? new Set<() => void>();
  activeDrags.set(view, active.add(cleanUp));
  win.addEventListener('pointermove', onMove);
  win.addEventListener('pointerup', onUp);
  win.addEventListener('pointercancel', cancel);
  win.addEventListener('keydown', onKey, true);
  win.addEventListener('scroll', onScroll, true);
}

// Two elements: a zero-size anchor at the block's own position, so the grip lines up with its
// row without layout math, and the grip placed against that anchor.
function gripElement(
  view: EditorView,
  pos: number,
  translate: BlockDragOptions['translate'],
): HTMLElement {
  const doc = view.dom.ownerDocument;
  const anchor = doc.createElement('div');
  anchor.className = 'doc-editor-grip-anchor';
  anchor.setAttribute('contenteditable', 'false');
  const grip = doc.createElement('div');
  grip.className = 'doc-editor-grip';
  grip.setAttribute('aria-hidden', 'true');
  grip.setAttribute('data-testid', 'block-grip');
  grip.appendChild(gripIcon(doc));
  // The press is the drag's alone: no text selection, no native drag and no ProseMirror
  // mouse handling, which would hold the text cursor for the whole drag.
  const keep = (event: Event) => {
    event.preventDefault();
    event.stopPropagation();
  };
  grip.addEventListener('mousedown', keep);
  grip.addEventListener('dragstart', keep);
  grip.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    if (!view.editable || pos >= view.state.doc.content.size) return;
    if (blockAround(view.state.doc.resolve(pos))?.pos !== pos) return;
    // Pressed and moved: a drag; let go where it was pressed: the block's menu.
    pressGrip(
      event,
      (press) => {
        if (view.isDestroyed || !view.editable) return;
        if (pos >= view.state.doc.content.size) return;
        if (blockAround(view.state.doc.resolve(pos))?.pos !== pos) return;
        beginDrag(view, pos, { x: press.clientX, y: press.clientY }, translate);
      },
      () => openBlockMenu(view, pos, false),
    );
  });
  anchor.appendChild(grip);
  return anchor;
}

/** The start of the block the selection starts in, or null at the document's edge. */
function caretBlock(state: EditorState): number | null {
  return selectedBlock(state)?.pos ?? null;
}

/**
 * The plugin state after a transaction: a meta replaces fields; a change to the document maps
 * the hover and drops a slide or a drag measured on the old one.
 */
export function nextDragState(
  value: DragState,
  meta: Partial<DragState> | undefined,
  map: ((pos: number) => number) | null,
): DragState {
  if (meta) return { ...value, ...meta };
  if (!map) return value;
  return {
    ...value,
    hoverPos: value.hoverPos === null ? null : map(value.hoverPos),
    drag: null,
    flip: null,
  };
}

/** The node decorations of a keyboard move's slide: per child of its flow. */
function flipDecorations(
  state: EditorState,
  flip: NonNullable<DragState['flip']>,
): Decoration[] {
  if (flip.flow > state.doc.content.size) return [];
  const decorations: Decoration[] = [];
  flowNode(state.doc, flip.flow).forEach((node, childOffset, index) => {
    const offset = flip.flow + childOffset;
    const dy = flip.shifts[index] ?? 0;
    if (!dy && !flip.animate) return;
    decorations.push(
      Decoration.node(offset, offset + node.nodeSize, {
        ...(flip.animate ? { class: SLIDE_CLASS } : {}),
        style: `transform: translateY(${dy}px)`,
      }),
    );
  });
  return decorations;
}

/** The decorations of a drag: the folded block, its slot and the nodes sliding aside. */
function dragDecorations(state: EditorState, drag: ActiveDrag): Decoration[] {
  const size = state.doc.content.size;
  const node = drag.source < size ? state.doc.nodeAt(drag.source) : null;
  if (!node || drag.slot > size) return [];
  const decorations = [
    Decoration.node(drag.source, drag.source + node.nodeSize, {
      class: SOURCE_CLASS,
    }),
    Decoration.widget(
      drag.slot,
      (view) => slotElement(view, drag.height, drag.label),
      {
        side: -1,
        key: `drag-slot:${drag.height}:${drag.label ?? ''}`,
        ignoreSelection: true,
      },
    ),
  ];
  for (const [pos, dy] of drag.offsets) {
    const moved = pos < size ? state.doc.nodeAt(pos) : null;
    if (!moved) continue;
    decorations.push(
      Decoration.node(pos, pos + moved.nodeSize, {
        ...(drag.sliding ? { class: SLIDE_CLASS } : {}),
        style: `transform: translateY(${dy}px)`,
      }),
    );
  }
  return decorations;
}

export const BlockDrag = Extension.create<BlockDragOptions>({
  name: 'blockDrag',
  addOptions() {
    return { translate: (key) => key };
  },
  addProseMirrorPlugins() {
    const { translate } = this.options;
    return [
      new Plugin<DragState>({
        key: blockDragKey,
        // Destroyed mid-drag: the window listeners, timers, copy and root classes go with it. (A
        // plugin reconfigure runs this too; nothing here reconfigures the editor's plugins.)
        view: (view) => ({
          destroy: () => activeDrags.get(view)?.forEach((cleanUp) => cleanUp()),
        }),
        state: {
          init: () => IDLE,
          apply: (tr, value) =>
            nextDragState(
              value,
              tr.getMeta(blockDragKey) as Partial<DragState> | undefined,
              tr.docChanged ? (pos) => tr.mapping.map(pos) : null,
            ),
        },
        props: {
          handleDOMEvents: {
            mousemove(view, event) {
              const state = blockDragKey.getState(view.state);
              // A read-only document has no grip: nothing is moved there.
              if (!state || state.drag || !view.editable) return false;
              // On the grip, or over the gutter on the way to it, the block keeps its grip.
              const target = event.target as HTMLElement | null;
              if (target?.closest?.('.doc-editor-grip-anchor')) return false;
              // The grip moves with a redraw, which puts the state's selection into the page: a
              // click's caret the state has not read yet would be undone (#490). Read first.
              readDomSelection(view);
              const hoverPos = blockAt(view, event.clientX, event.clientY);
              if (hoverPos !== null && hoverPos !== state.hoverPos) {
                view.dispatch(
                  view.state.tr.setMeta(blockDragKey, { hoverPos }),
                );
              }
              return false;
            },
            focus(view) {
              if (!view.editable) return false;
              view.dispatch(
                view.state.tr.setMeta(blockDragKey, { focused: true }),
              );
              return false;
            },
            blur(view) {
              view.dispatch(
                view.state.tr.setMeta(blockDragKey, { focused: false }),
              );
              return false;
            },
            mouseleave(view) {
              const state = blockDragKey.getState(view.state);
              if (state && !state.drag && state.hoverPos !== null) {
                view.dispatch(
                  view.state.tr.setMeta(blockDragKey, { hoverPos: null }),
                );
              }
              return false;
            },
          },
          decorations(editorState) {
            const state = blockDragKey.getState(editorState);
            if (!state) return DecorationSet.empty;
            const decorations = state.drag
              ? dragDecorations(editorState, state.drag)
              : state.flip
                ? flipDecorations(editorState, state.flip)
                : [];
            // While a block is lifted or sliding, its grip would stand in the wrong place.
            // While the block's menu is open, its block keeps the grip: the menu stands by it.
            const at =
              state.drag || state.flip
                ? null
                : (blockMenuPos(editorState) ??
                  state.hoverPos ??
                  (state.focused ? caretBlock(editorState) : null));
            if (at !== null && editorState.doc.nodeAt(at)) {
              decorations.push(
                Decoration.widget(
                  at,
                  (view) => gripElement(view, at, translate),
                  { side: -1, key: `grip-${at}` },
                ),
              );
            }
            return decorations.length
              ? DecorationSet.create(editorState.doc, decorations)
              : DecorationSet.empty;
          },
        },
      }),
    ];
  },
});
