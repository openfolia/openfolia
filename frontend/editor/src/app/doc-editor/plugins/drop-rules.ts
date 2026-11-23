import { Fragment, type Node as ProseMirrorNode } from '@tiptap/pm/model';
import type { EditorState } from '@tiptap/pm/state';

import {
  blockAround,
  CONTAINERS,
  isBlank,
  isSection,
  isStep,
  isStepText,
  isTitle,
} from './flow';
import { refusalText, sectionLevelRefusal } from './heading-levels';

// Where a block of a flow (`flow.ts`) may go when it is dragged or moved with Alt+Up/Down: the
// rules, as plain positions, so they are tested without a browser.
//
// - A block (anything but a section) goes into any flow's text (the document's or a section's,
//   between its heading and its subsections) and into a variant block's or safety notice's
//   content (after the hazard) or an FAQ entry's answer (after the question), wherever the
//   schema takes it.
// - A section goes among the sections of any flow, its blocks and subsections with it. Its level
//   is the depth it lands at, so it skips no level; it and its subsections stay within the cap
//   (`heading-levels.ts`, the same rule as Tab and Shift+Tab).
// - A procedure's step goes only among the steps of its own procedure; a block goes into any
//   step, under its text.
// - Where a section can't go (between a flow's blocks, in a list, a table, a variant, safety
//   or FAQ block, past the cap) is a refused place, with the reason: the drag shows why instead of
//   snapping back.
// - A block inside a container stays there when the container can't be without it (a variant
//   block's or an FAQ answer's last block; a safety notice may keep its hazard only), refused
//   everywhere else with the reason.

/** Why a block can't go to a place. */
export type DropRefusal =
  /** A heading between blocks of text: sections come after a flow's blocks. */
  | 'text'
  | 'list'
  | 'table'
  | 'variant'
  | 'safety'
  | 'faq'
  /** The section, or a subsection of it, would go deeper than the cap. */
  | 'cap'
  /** The schema takes no such block there. */
  | 'schema'
  /** The block is the last its container can't be without (a variant block's, an FAQ answer's). */
  | 'last';

const REFUSAL_KEYS: Readonly<Record<Exclude<DropRefusal, 'cap'>, string>> = {
  text: 'editor.docEditor.drop.text',
  list: 'editor.docEditor.drop.list',
  table: 'editor.docEditor.drop.table',
  variant: 'editor.docEditor.drop.variant',
  safety: 'editor.docEditor.drop.safety',
  faq: 'editor.docEditor.drop.faq',
  schema: 'editor.docEditor.drop.schema',
  last: 'editor.docEditor.drop.last',
};

/** A refusal as the person reads it: a translation key and its parameters. */
export function dropRefusalText(
  state: EditorState,
  refusal: DropRefusal,
  level: number,
): { key: string; params: Record<string, number> } {
  if (refusal === 'cap') return refusalText(state, 'cap', level);
  return { key: REFUSAL_KEYS[refusal], params: {} };
}

/** A place a dragged block may go, or is refused at. */
export interface DropTarget {
  /** The position it goes to, in the document as it is (with the block still in its place). */
  pos: number;
  /** The type of the node that would hold it. */
  holder: string;
  /** Its own place: dropping there changes nothing. */
  home: boolean;
  /** For a section: the heading level it has there. */
  level: number | null;
  refusal: DropRefusal | null;
  /**
   * What stands right there on screen: the node starting at `pos` (`edge: 'top'`), or at a
   * holder's end the last node before it (`edge: 'bottom'`).
   */
  anchor: number;
  edge: 'top' | 'bottom';
}

/** Where a section is refused inside a node, by the node's type. */
const SECTION_REFUSALS: Readonly<Record<string, DropRefusal>> = {
  list: 'list',
  table: 'table',
  variant: 'variant',
  safety: 'safety',
  faq: 'faq',
};

/** The child index content starts at in a holder: past a section's title, a safety's hazard or an FAQ entry's question. */
function firstIndex(holder: ProseMirrorNode): number {
  const first = holder.firstChild;
  return first &&
    (isTitle(first) ||
      isStepText(first) ||
      first.type.name === 'hazard' ||
      first.type.name === 'question')
    ? 1
    : 0;
}

/** The index of the first section in a flow, or its child count. */
function firstSectionIndex(flow: ProseMirrorNode): number {
  for (let i = 0; i < flow.childCount; i += 1)
    if (isSection(flow.child(i))) return i;
  return flow.childCount;
}

/**
 * Every place the block at `from` may go, or is refused at, in document order. Its own place is
 * there once (`home`); the place right after it, the same place, is not; nothing inside it is.
 */
export function dropTargets(state: EditorState, from: number): DropTarget[] {
  const node = state.doc.nodeAt(from);
  if (!node) return [];
  const to = from + node.nodeSize;
  const dragsSection = isSection(node);
  const out: DropTarget[] = [];
  // A block its holder can't be without goes nowhere but among its holder's own children.
  const $from = state.doc.resolve(from);
  const home = $from.start();
  const kept = !$from.parent.canReplace($from.index(), $from.index() + 1);

  /**
   * The place before child `index` of `holder`, whose content starts at `start`; `starts` holds
   * its children's positions and its end.
   */
  const add = (
    holder: ProseMirrorNode,
    start: number,
    starts: readonly number[],
    index: number,
    level: number | null,
    refusal: DropRefusal | null,
  ) => {
    const pos = starts[index] as number;
    if (pos === to) return;
    const own = pos === from;
    const atEnd = index === holder.childCount && index > 0;
    out.push({
      pos,
      holder: holder.type.name,
      home: own,
      level,
      refusal: own
        ? null
        : kept && start !== home
          ? 'last'
          : (refusal ??
            (holder.canReplace(index, index, Fragment.from(node))
              ? null
              : 'schema')),
      anchor: atEnd ? (starts[index - 1] as number) : pos,
      edge: atEnd ? 'bottom' : 'top',
    });
  };

  /** The places inside `holder` (content from `start`), `level` deep in sections. */
  const visit = (holder: ProseMirrorNode, start: number, level: number) => {
    const type = holder.type.name;
    const first = firstIndex(holder);
    const starts: number[] = [];
    holder.forEach((_child, offset) => starts.push(start + offset));
    starts.push(start + holder.content.size);
    const range = (
      from: number,
      last: number,
      lvl: number | null,
      refusal: DropRefusal | null,
    ) => {
      for (let i = from; i <= last; i += 1)
        add(holder, start, starts, i, lvl, refusal);
    };
    if (type === 'doc' || type === 'section') {
      const sections = firstSectionIndex(holder);
      if (dragsSection) {
        // Before the blank lines that end a flow's text (caret gaps) is the end of it to see:
        // no refused place there, right above the allowed one.
        let text = sections;
        while (text > first && isBlank(holder.child(text - 1))) text -= 1;
        range(first, text - 1, null, 'text');
        range(
          sections,
          holder.childCount,
          level + 1,
          sectionLevelRefusal(state, level + 1, node),
        );
      } else {
        range(first, sections, null, null);
      }
    } else if (type === 'listItem' && !dragsSection) {
      // A procedure's step (only visited as one): its blocks, under its text, and under its
      // result (the paragraph right after the text) unless that is what is dragged.
      const result =
        holder.maybeChild(first)?.type.name === 'paragraph' &&
        starts[first] !== from;
      range(result ? first + 1 : first, holder.childCount, null, null);
    } else if (CONTAINERS.has(type) || dragsSection) {
      range(
        first,
        holder.childCount,
        null,
        dragsSection ? (SECTION_REFUSALS[type] ?? null) : null,
      );
    }
    holder.forEach((child, _offset, index) => {
      const pos = starts[index] as number;
      if (pos === from) return;
      const name = child.type.name;
      if (isSection(child)) visit(child, pos + 1, level + 1);
      else if (CONTAINERS.has(name)) visit(child, pos + 1, level);
      // A procedure's steps hold blocks under their text: a block (never a section) goes there.
      else if (name === 'procedure' && !dragsSection)
        child.forEach((step, stepOffset) => {
          const at = pos + 1 + stepOffset;
          if (at !== from && step.type.name === 'listItem')
            visit(step, at + 1, level);
        });
      // A heading over a list or a table: refused at its items or rows, so the reason shows.
      else if (dragsSection && (name === 'list' || name === 'table'))
        visit(child, pos + 1, level);
    });
  };

  // A procedure's step goes only among its procedure's steps (after the title).
  if ($from.parent.type.name === 'procedure') {
    const holder = $from.parent;
    const starts: number[] = [];
    holder.forEach((_child, offset) => starts.push(home + offset));
    starts.push(home + holder.content.size);
    for (let i = firstIndex(holder); i <= holder.childCount; i += 1)
      add(holder, home, starts, i, null, null);
    return out;
  }

  visit(state.doc, 0, 0);
  return out.sort((a, b) => a.pos - b.pos);
}

/**
 * Where a place stands among the document's boundaries: places that only closing tags separate
 * (the end of a section, of the section around it, the place after both) share one.
 */
export function boundaryOf(doc: ProseMirrorNode, pos: number): number {
  let $pos = doc.resolve(pos);
  while ($pos.depth > 0 && $pos.pos === $pos.end())
    $pos = doc.resolve($pos.after());
  return $pos.pos;
}

/** Whether only blank lines (caret gaps) stand between `from` and `to`: a move there shows nothing. */
export function onlyBlanksBetween(
  doc: ProseMirrorNode,
  from: number,
  to: number,
): boolean {
  let visible = false;
  doc.nodesBetween(from, to, (node, pos) => {
    if (visible) return false;
    // Partly in the range: a flow the range enters or leaves, looked into.
    if (pos < from || pos + node.nodeSize > to) return true;
    if (!isBlank(node)) visible = true;
    return false;
  });
  return !visible;
}

/** The heading level of the section at `pos`: how many sections hold it, itself included. */
export function sectionLevel(doc: ProseMirrorNode, pos: number): number {
  const $pos = doc.resolve(pos);
  let level = 1;
  for (let depth = 1; depth <= $pos.depth; depth += 1)
    if (isSection($pos.node(depth))) level += 1;
  return level;
}

/**
 * Where Alt+Up (`up`) or Alt+Down takes the selection's block: to the next place of the flows
 * that shows a change, past one block of its flow, or past its flow's edge into the neighbouring
 * one (a block into the text before or after it, across a heading; a section among the sections
 * of the neighbouring flow, at its own level). A block of a variant block, a safety notice or an
 * FAQ entry steps among its container's blocks and, at their edge, out of the container; where it
 * can't leave (a variant block's or FAQ answer's last block), with `frame`, its container
 * steps. Null where there is none.
 */
export function keyboardTarget(
  state: EditorState,
  up: boolean,
  frame = true,
): { from: number; to: number } | null {
  const block = blockAround(state.selection.$from);
  return block ? stepOf(state, block.pos, up, frame) : null;
}

/** One step for the block at `from` (`keyboardTarget`); `frame`: at a container's edge, the container's. */
function stepOf(
  state: EditorState,
  from: number,
  up: boolean,
  frame: boolean,
): { from: number; to: number } | null {
  const { doc } = state;
  const node = doc.nodeAt(from);
  if (!node) return null;
  const end = from + node.nodeSize;
  const level = isSection(node) ? sectionLevel(doc, from) : null;
  const targets = dropTargets(state, from);
  // A block with no place of its own here is not one the rules move.
  if (!targets.some((target) => target.home)) return null;
  // A block of a step moves only among the steps of its procedure (never out of it, so never out
  // of a variant or safety block around it either: a drag takes it further); a block of a
  // container among its container's blocks, and out of it (below). Any other block steps over a
  // procedure whole, as over a variant or safety block.
  const $block = doc.resolve(from);
  const procedure = isStep($block.parent, $block.node(-1))
    ? $block.start(-1)
    : null;
  const container = CONTAINERS.has($block.parent.type.name)
    ? $block.start()
    : null;
  const ownStep = (pos: number) => {
    const $at = doc.resolve(pos);
    return procedure !== null && $at.depth >= 2 && $at.start(-1) === procedure;
  };
  const inOwn = (target: DropTarget) =>
    procedure !== null
      ? target.holder === 'listItem' && ownStep(target.pos)
      : container !== null
        ? doc.resolve(target.pos).start() === container
        : target.holder === 'doc' ||
          target.holder === 'section' ||
          target.holder === 'procedure';
  const places = targets.filter(
    (target) =>
      !target.home &&
      !target.refusal &&
      inOwn(target) &&
      target.level === level,
  );
  const ahead = up
    ? places.filter((target) => target.pos < from).reverse()
    : places.filter((target) => target.pos > end);
  const next = ahead.find(
    (target) =>
      !onlyBlanksBetween(doc, up ? target.pos : end, up ? from : target.pos),
  );
  if (next) return { from, to: next.pos };
  if (container === null) return null;
  // At its container's edge, it steps out, right before or after the container (unless the
  // container can't be without it). Else the container itself steps on (as it did with the caret
  // in it before its blocks had a flow of their own); from the block's own grip menu, never.
  const outside = up ? $block.before() : $block.after();
  const out = targets.find(
    (target) => target.pos === outside && !target.home && !target.refusal,
  );
  if (out) return { from, to: out.pos };
  return frame ? stepOf(state, $block.before(), up, frame) : null;
}
