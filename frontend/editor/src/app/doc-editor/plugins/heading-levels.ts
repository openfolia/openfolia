import { Extension } from '@tiptap/core';
import { closeHistory } from '@tiptap/pm/history';
import {
  Fragment,
  Slice,
  type Node as ProseMirrorNode,
  type ResolvedPos,
} from '@tiptap/pm/model';
import {
  Plugin,
  PluginKey,
  TextSelection,
  type Command,
  type EditorState,
  type Transaction,
} from '@tiptap/pm/state';
import { ReplaceStep } from '@tiptap/pm/transform';
import type { EditorView } from '@tiptap/pm/view';
import {
  DEFAULT_MAX_HEADING_LEVEL,
  MAX_SECTION_DEPTH,
} from '@openfolia/content-model/core';

import { isFlow, isSection, isTitle } from './flow';
import { paragraphToSection } from './structure';

// Heading levels, as a word processor has them, on the content model's nesting: a heading is a
// section's title, and its level is how deep the section stands (Heading 1 at the top of the
// module, Heading 2 in a Heading 1, …). Changing a level moves the section in the tree, never in
// the reading order: demoting puts it into the section before it, as its last subsection;
// promoting takes it out of its parent, right after it, and the sections that followed it there
// become its own last subsections (they keep their level, and their place in the text). A
// section always moves with its blocks and its subsections. No level is skipped, and none goes
// deeper than the configured cap (`ProjectConfig.maxHeadingLevel`). Each change is one
// transaction and its own undo step.

/** Why a heading level can't apply at the caret. */
export type HeadingRefusal =
  /** Not a paragraph or heading directly in a flow (a list, a table, a variant or safety block). */
  | 'notHere'
  /** It would skip a level: no heading one level up encloses the caret. */
  | 'skip'
  /** It, or a subsection of it, would go deeper than the cap. */
  | 'cap'
  /** Demoting needs a section before it, at its level, to go into. */
  | 'noPrevious'
  /** Already a Heading 1: nothing to promote it out of. */
  | 'top';

const REFUSAL_KEYS: Readonly<Record<HeadingRefusal, string>> = {
  notHere: 'editor.docEditor.heading.notHere',
  skip: 'editor.docEditor.heading.skip',
  cap: 'editor.docEditor.heading.cap',
  noPrevious: 'editor.docEditor.heading.noPrevious',
  top: 'editor.docEditor.heading.top',
};

/**
 * A refusal as the person reads it, for Heading `level`: a translation key and its parameters
 * (`parent`, the level it needs around the caret; `max`, the cap).
 */
export function refusalText(
  state: EditorState,
  refusal: HeadingRefusal,
  level: number,
): { key: string; params: { parent: number; max: number } } {
  return {
    key: REFUSAL_KEYS[refusal],
    params: { parent: Math.max(1, level - 1), max: headingCap(state) },
  };
}

export const headingLevelsKey = new PluginKey<number>('headingLevels');

/** A cap as the editor uses it: a whole number from 1 to the model's own section depth. */
export function clampCap(cap: number | null | undefined): number {
  if (cap === null || cap === undefined || !Number.isFinite(cap))
    return DEFAULT_MAX_HEADING_LEVEL;
  return Math.min(MAX_SECTION_DEPTH, Math.max(1, Math.floor(cap)));
}

/** The deepest heading level the editor offers (the configured cap; 3 when none is set). */
export function headingCap(state: EditorState): number {
  return clampCap(headingLevelsKey.getState(state));
}

/** Sets the cap, when the configuration arrives or changes (no undo step, no document change). */
export function setHeadingCap(view: EditorView, cap: number): void {
  if (headingCap(view.state) === clampCap(cap)) return;
  view.dispatch(
    view.state.tr
      .setMeta(headingLevelsKey, clampCap(cap))
      .setMeta('addToHistory', false),
  );
}

/** The level of the flow `depth` levels up from `$pos`: 0 for the document, n in a Heading n. */
function flowLevel($pos: ResolvedPos, depth: number): number {
  let level = 0;
  for (let d = 1; d <= depth; d += 1) if (isSection($pos.node(d))) level += 1;
  return level;
}

/** How many levels a section spans: 1, plus its deepest subsection's. */
export function height(section: ProseMirrorNode): number {
  let below = 0;
  section.forEach((child) => {
    if (isSection(child)) below = Math.max(below, height(child));
  });
  return 1 + below;
}

/**
 * Why `section` can't stand as a Heading `level` (a section `level` deep: in a flow whose level is
 * one less), or null when it can: it and its subsections stay within the cap. A section placed in
 * a flow skips no level by construction; the cap is the one rule left to check. The block drag
 * and Alt+Up/Down ask this for every place they offer a section.
 */
export function sectionLevelRefusal(
  state: EditorState,
  level: number,
  section: ProseMirrorNode,
): 'cap' | null {
  return level + height(section) - 1 > headingCap(state) ? 'cap' : null;
}

/** The heading at the caret: its section, the section's position and level, the caret offset. */
export function headingAt(state: EditorState): {
  pos: number;
  level: number;
  section: ProseMirrorNode;
  offset: number;
} | null {
  const { $from } = state.selection;
  if (!isTitle($from.parent) || $from.depth < 2) return null;
  const section = $from.node(-1);
  if (!isSection(section)) return null;
  return {
    pos: $from.before(-1),
    level: flowLevel($from, $from.depth - 1),
    section,
    offset: $from.parentOffset,
  };
}

/** The level of the text at the caret: 0 for a paragraph in a flow, n for a Heading n, else null. */
export function textLevelAt(state: EditorState): number | null {
  const heading = headingAt(state);
  if (heading) return heading.level;
  const { $from } = state.selection;
  if (
    $from.parent.type.name === 'paragraph' &&
    $from.depth >= 1 &&
    isFlow($from.node(-1))
  )
    return 0;
  return null;
}

/**
 * Why demoting the heading at `pos` by `steps` levels is refused, or null when it can: each step
 * needs a section before it to go into (the first, its previous sibling; the next, that one's
 * last subsection), and its deepest subsection must stay within the cap.
 */
function demoteRefusal(
  doc: ProseMirrorNode,
  pos: number,
  level: number,
  steps: number,
  cap: number,
): HeadingRefusal | null {
  const $pos = doc.resolve(pos);
  const section = $pos.nodeAfter;
  if (!section) return 'notHere';
  const index = $pos.index();
  let into = index > 0 ? $pos.parent.child(index - 1) : null;
  for (let step = 1; step <= steps; step += 1) {
    if (!isSection(into)) return 'noPrevious';
    if (step < steps) into = into?.lastChild ?? null;
  }
  return level + steps + height(section) - 1 > cap ? 'cap' : null;
}

/** Demotes the section at `pos` one level in `tr`; its new position. */
function demoteIn(tr: Transaction, pos: number): number {
  const $pos = tr.doc.resolve(pos);
  const section = $pos.nodeAfter as ProseMirrorNode;
  const into = $pos.parent.child($pos.index() - 1);
  const intoPos = pos - into.nodeSize;
  tr.replaceWith(
    intoPos,
    pos + section.nodeSize,
    into.copy(into.content.addToEnd(section)),
  );
  return intoPos + into.nodeSize - 1;
}

/** Promotes the section at `pos` one level in `tr`, taking the sections after it along; its new position. */
function promoteIn(tr: Transaction, pos: number): number {
  const $pos = tr.doc.resolve(pos);
  const parent = $pos.parent;
  const section = $pos.nodeAfter as ProseMirrorNode;
  const followers: ProseMirrorNode[] = [];
  for (let i = $pos.index() + 1; i < parent.childCount; i += 1)
    followers.push(parent.child(i));
  const kept = parent.copy(parent.content.cut(0, $pos.parentOffset));
  const moved = section.copy(
    section.content.append(Fragment.fromArray(followers)),
  );
  const parentPos = $pos.before();
  tr.replaceWith(parentPos, parentPos + parent.nodeSize, [kept, moved]);
  return parentPos + kept.nodeSize;
}

/** Marks a level change (or a block move), so the history is closed after it (see `HeadingLevels`). */
const LEVEL_CHANGE = 'headingLevelChange';
/** Marks the step `HeadingLevels` appends to close it. */
const LEVEL_CLOSE = 'headingLevelClose';
/** Further back than any grouping delay the history is given (TipTap's default is 500 ms). */
const UNDO_GROUP_GAP = 60_000;

/**
 * Each level change, and each block move (`block-move.ts`), is an undo step of its own: not
 * merged with the edit before or after it. `HeadingLevels` closes the step after what the other
 * plugins append to it.
 */
export function ownUndoStep(tr: Transaction): Transaction {
  // `closeHistory` starts a new step here; `HeadingLevels` ends it after what the other plugins
  // append (a caret gap, a repair), which still join it.
  return closeHistory(tr).setMeta(LEVEL_CHANGE, true);
}

/** Whether `tr` is a level change, or a change a plugin appended to one (not our closing one). */
function partOfLevelChange(tr: Transaction): boolean {
  if (tr.getMeta(LEVEL_CLOSE)) return false;
  if (tr.getMeta(LEVEL_CHANGE)) return true;
  const root: unknown = tr.getMeta('appendedTransaction');
  return (
    tr.docChanged && !!root && !!(root as Transaction).getMeta?.(LEVEL_CHANGE)
  );
}

/**
 * The end of a level change's undo step: a step that changes nothing, dated before the history's
 * grouping delay. As an appended transaction it joins the level change's step; its old time makes
 * the next edit start a step of its own. (Closing the history here instead would split off what
 * another plugin appends after it.)
 */
function closingStep(state: EditorState): Transaction {
  return state.tr
    .step(new ReplaceStep(0, 0, Slice.empty))
    .setTime(Date.now() - UNDO_GROUP_GAP)
    .setMeta(LEVEL_CLOSE, true);
}

/** The caret back in the moved heading's title, at the offset it had. */
function caretInHeading(tr: Transaction, pos: number, offset: number): void {
  const title = tr.doc.nodeAt(pos)?.firstChild;
  const size = title?.content.size ?? 0;
  tr.setSelection(
    TextSelection.create(tr.doc, pos + 2 + Math.min(offset, size)),
  );
}

/**
 * Why the text at the caret can't become a Heading `level`, or null when it can (or already is
 * one). A paragraph becomes a heading only directly in a flow, at most one level deeper than the
 * heading around it; a heading changes level within the cap, demoted only into a section before it.
 */
export function headingRefusal(
  state: EditorState,
  level: number,
): HeadingRefusal | null {
  const cap = headingCap(state);
  const heading = headingAt(state);
  if (heading) {
    if (level >= heading.level) {
      return level === heading.level
        ? null
        : demoteRefusal(
            state.doc,
            heading.pos,
            heading.level,
            level - heading.level,
            cap,
          );
    }
    return level < 1 ? 'top' : null;
  }
  const flow = textLevelAt(state);
  if (flow === null) return 'notHere';
  if (level > cap) return 'cap';
  const { $from } = state.selection;
  if (level > flowLevel($from, $from.depth - 1) + 1) return 'skip';
  return level < 1 ? 'notHere' : null;
}

/**
 * The text at the caret becomes a Heading `level`: a paragraph a new section at that depth (its
 * blocks after it, and the sections that close there, go into it), a heading moves to that
 * depth. False when refused (`headingRefusal`) or when it already is one.
 */
export function setHeadingLevel(level: number): Command {
  return (state, dispatch) => {
    if (headingRefusal(state, level)) return false;
    const heading = headingAt(state);
    if (heading?.level === level) return false;
    if (!dispatch) return true;
    if (heading) {
      const tr = state.tr;
      let pos = heading.pos;
      for (let l = heading.level; l < level; l += 1) pos = demoteIn(tr, pos);
      for (let l = heading.level; l > level; l -= 1) pos = promoteIn(tr, pos);
      caretInHeading(tr, pos, heading.offset);
      dispatch(ownUndoStep(tr).scrollIntoView());
      return true;
    }
    // A paragraph: a section one level below its flow's, then promoted to the level wanted, in
    // the same transaction.
    const { $from } = state.selection;
    const below = flowLevel($from, $from.depth - 1) + 1;
    let made: Transaction | null = null;
    paragraphToSection(state, (tr) => {
      made = tr;
    });
    if (!made) return false;
    const tr = made as Transaction;
    // The caret is in the new section's title.
    let pos = tr.selection.$from.before(-1);
    const offset = tr.selection.$from.parentOffset;
    for (let l = below; l > level; l -= 1) pos = promoteIn(tr, pos);
    caretInHeading(tr, pos, offset);
    dispatch(ownUndoStep(tr).scrollIntoView());
    return true;
  };
}

/** Why the heading at the caret can't go one level down (Tab), or null; `notHere` outside a heading. */
export function demoteRefusalAt(state: EditorState): HeadingRefusal | null {
  const heading = headingAt(state);
  if (!heading) return 'notHere';
  return headingRefusal(state, heading.level + 1);
}

/** Why the heading at the caret can't go one level up (Shift+Tab), or null; `notHere` outside one. */
export function promoteRefusalAt(state: EditorState): HeadingRefusal | null {
  const heading = headingAt(state);
  if (!heading) return 'notHere';
  return heading.level <= 1 ? 'top' : null;
}

/** Tab in a heading: one level down, into the section before it. */
export const demoteHeading: Command = (state, dispatch) => {
  const heading = headingAt(state);
  return !!heading && setHeadingLevel(heading.level + 1)(state, dispatch);
};

/** Shift+Tab in a heading: one level up, out of its parent. */
export const promoteHeading: Command = (state, dispatch) => {
  const heading = headingAt(state);
  return (
    !!heading &&
    heading.level > 1 &&
    setHeadingLevel(heading.level - 1)(state, dispatch)
  );
};

export interface HeadingLevelsOptions {
  /** The deepest heading level offered (`ProjectConfig.maxHeadingLevel`); 3 when not given. */
  cap: number;
}

/**
 * The heading levels: the cap in the editor's state (read by the menus and the commands), and
 * Tab and Shift+Tab in a heading. In a heading those keys stay in the editor even where the
 * level can't change; anywhere else they are left to the lists and tables.
 */
export const HeadingLevels = Extension.create<HeadingLevelsOptions>({
  name: 'headingLevels',
  // Last among the plugins: its closing step comes after what the others append.
  priority: 1,
  addOptions() {
    return { cap: DEFAULT_MAX_HEADING_LEVEL };
  },
  addProseMirrorPlugins() {
    const initial = clampCap(this.options.cap);
    return [
      new Plugin<number>({
        key: headingLevelsKey,
        state: {
          init: () => initial,
          apply: (tr, cap) => {
            const next: unknown = tr.getMeta(headingLevelsKey);
            return typeof next === 'number' ? clampCap(next) : cap;
          },
        },
        // After a level change (and what was appended to it), a closing step ends its undo step.
        appendTransaction: (trs, _old, state) =>
          trs.some(partOfLevelChange) ? closingStep(state) : null,
      }),
    ];
  },
  addKeyboardShortcuts() {
    const { editor } = this;
    const run = (command: Command) => () => {
      if (!headingAt(editor.state)) return false;
      command(editor.state, editor.view.dispatch, editor.view);
      return true;
    };
    return { Tab: run(demoteHeading), 'Shift-Tab': run(promoteHeading) };
  },
});
