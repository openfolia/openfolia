import { Extension } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import {
  Plugin,
  PluginKey,
  Selection,
  type Command,
  type EditorState,
  type Transaction,
} from '@tiptap/pm/state';
import { isHistoryTransaction, redoDepth } from '@tiptap/pm/history';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

import { gapIndexes, hasCaret } from './caret-gaps';
import { isBlank, isSection } from './flow';
import { motionAllowed, SLIDE_MS } from './drag-state';

// Blank lines are not spacing: the content model stores no empty paragraph and the outputs space
// blocks by their design, so a stack of blank lines would show a gap the saved module does not
// have. At most one blank paragraph stays, the one holding the caret, besides the caret gaps a
// flow needs (`caret-gaps.ts`); the others go once the caret leaves them, collapsing smoothly
// (at once under reduced motion). Enter on a blank line moves on instead of stacking another.
// The tidying is never an undo step of its own: it joins the last one, so one undo brings back
// the blank line together with what made it (an Enter, the text deleted from it), exactly as
// typed. Nothing is tidied while there is something to redo (until the next edit), nor in a
// read-only editor.

const key = new PluginKey<readonly number[]>('docEditorBlankLines');

/** Set on the transaction that takes the blank lines away. */
const TIDY = 'docEditorBlankLinesTidy';

/** Whether the blank paragraph at `pos` holds the selection (or lies within it). */
function holds(state: EditorState, pos: number): boolean {
  const { from, to } = state.selection;
  return pos + 1 >= from && pos + 1 <= to;
}

/** Whether a container's child is a block with something in it (not a blank line). */
const filled = (node: ProseMirrorNode) =>
  node.type.isInGroup('block') && !isBlank(node);

/**
 * The blank paragraphs that go now, last first: neither holding the selection nor needed as a
 * caret gap. In a container other than a flow (a variant block, a table cell, a safety notice's
 * body), a blank line it can't do without (its only block) stays too.
 */
export function strayBlanks(state: EditorState): number[] {
  const out: number[] = [];
  const visit = (node: ProseMirrorNode, start: number, isDoc: boolean) => {
    if (node.isTextblock || node.isAtom) return;
    const children: ProseMirrorNode[] = [];
    const starts: number[] = [];
    node.forEach((child, offset) => {
      children.push(child);
      starts.push(start + offset);
    });
    const stray = (index: number) => {
      const child = children[index];
      const pos = starts[index];
      return (
        child !== undefined &&
        pos !== undefined &&
        isBlank(child) &&
        !holds(state, pos)
      );
    };
    const isFlow = isDoc || isSection(node);
    if (isFlow) {
      // The gaps the flow needs once the stray lines are gone: one of them stays in each.
      const kept = children.filter((_child, index) => !stray(index));
      const needed = new Set(gapIndexes(kept, hasCaret, isSection, isDoc));
      let seen = 0;
      const saved = new Set<number>();
      children.forEach((_child, index) => {
        if (!stray(index)) {
          seen += 1;
          return;
        }
        if (needed.has(seen) && !saved.has(seen)) saved.add(seen);
        else out.push(starts[index] as number);
      });
    } else if (
      children.some(
        (child, index) => filled(child) || (isBlank(child) && !stray(index)),
      )
    ) {
      children.forEach((_child, index) => {
        if (stray(index)) out.push(starts[index] as number);
      });
    } else {
      // Nothing but blank lines: the first stays, the container needs a place to type.
      let first = true;
      children.forEach((child, index) => {
        if (!isBlank(child)) return;
        if (first) first = false;
        else if (stray(index)) out.push(starts[index] as number);
      });
    }
    node.forEach((child, offset) => visit(child, start + offset + 1, false));
  };
  visit(state.doc, 0, true);
  return out.sort((a, b) => b - a);
}

/**
 * Takes the blank paragraphs at `positions` (last first) away. `join`: dispatched on its own (the
 * collapse's timer), it still joins the last undo step, as an appended transaction does. In the
 * history, not outside it: an undo of text deleted from a blank line would map through a
 * deletion it does not know of and lose that text.
 */
function tidy(
  state: EditorState,
  positions: readonly number[],
  join: boolean,
): Transaction | null {
  const tr = state.tr;
  for (const pos of positions) {
    const node = tr.doc.nodeAt(pos);
    if (node && isBlank(node)) tr.delete(pos, pos + node.nodeSize);
  }
  if (!tr.docChanged) return null;
  tr.setMeta(TIDY, true).setMeta(key, []);
  // prosemirror-history adds an appended transaction to the event before it.
  if (join) tr.setMeta('appendedTransaction', tr);
  return tr;
}

/** Whether `tr` only took blank lines away (what a delete's Undo may look past). */
export function isTidy(tr: Transaction): boolean {
  return tr.getMeta(TIDY) === true;
}

const same = (a: readonly number[], b: readonly number[]) =>
  a.length === b.length && a.every((value, index) => value === b[index]);

/**
 * Enter on a blank line moves on, to the next place to type, rather than stacking another blank
 * line; with nothing after it, nothing happens.
 */
export const enterOnBlank: Command = (state, dispatch) => {
  const { $from, empty } = state.selection;
  if (!empty || !isBlank($from.parent)) return false;
  const next = Selection.findFrom(state.doc.resolve($from.after()), 1, true);
  if (next && dispatch) dispatch(state.tr.setSelection(next).scrollIntoView());
  return true;
};

export interface BlankLinesOptions {
  /** Whether to let a blank line collapse before it goes; by default, unless less motion is asked for. */
  animate: () => boolean;
}

export const BlankLines = Extension.create<BlankLinesOptions>({
  name: 'blankLines',
  addOptions() {
    return { animate: () => motionAllowed(globalThis.window) };
  },
  addProseMirrorPlugins() {
    const { animate } = this.options;
    // Read-only, the document stays as it is: the view says so after each update.
    let editable = true;
    return [
      new Plugin<readonly number[]>({
        key,
        // The blank lines collapsing now, before they go.
        state: {
          init: () => [],
          apply(tr, value) {
            const meta = tr.getMeta(key) as readonly number[] | undefined;
            if (meta) return meta;
            if (!tr.docChanged) return value;
            return value.flatMap((pos) => {
              const mapped = tr.mapping.mapResult(pos, 1);
              return mapped.deleted ? [] : [mapped.pos];
            });
          },
        },
        appendTransaction(transactions, _old, state) {
          if (
            !editable ||
            // Something to redo: a tidy would clear it (or, outside the history, make the redo
            // lose what it brings back). The blank lines wait for the next edit.
            redoDepth(state) > 0 ||
            !transactions.some((tr) => tr.docChanged || tr.selectionSet) ||
            transactions.some((tr) => isTidy(tr) || isHistoryTransaction(tr))
          )
            return null;
          const stray = strayBlanks(state);
          if (!animate())
            return stray.length ? tidy(state, stray, false) : null;
          // Those collapsing and still astray keep collapsing; a caret back in one keeps it.
          const leaving = key.getState(state) ?? [];
          return same(leaving, stray) ? null : state.tr.setMeta(key, stray);
        },
        view(view) {
          editable = view.editable;
          let timer: ReturnType<typeof setTimeout> | undefined;
          let scheduled: readonly number[] = [];
          return {
            update() {
              editable = view.editable;
              const leaving = key.getState(view.state) ?? [];
              if (same(leaving, scheduled)) return;
              scheduled = leaving;
              clearTimeout(timer);
              if (!leaving.length) return;
              timer = setTimeout(() => {
                if (view.isDestroyed) return;
                if (!view.editable || redoDepth(view.state) > 0) {
                  view.dispatch(view.state.tr.setMeta(key, []));
                  return;
                }
                // Gone only if still astray: the caret may have come back meanwhile.
                const stray = new Set(strayBlanks(view.state));
                const now = (key.getState(view.state) ?? []).filter((pos) =>
                  stray.has(pos),
                );
                const tr = tidy(view.state, now, true);
                view.dispatch(tr ?? view.state.tr.setMeta(key, []));
              }, SLIDE_MS);
            },
            destroy() {
              clearTimeout(timer);
            },
          };
        },
        props: {
          decorations(state) {
            const leaving = key.getState(state) ?? [];
            const decorations = leaving.flatMap((pos) => {
              const node = state.doc.nodeAt(pos);
              return node && isBlank(node)
                ? [
                    Decoration.node(pos, pos + node.nodeSize, {
                      class: 'doc-editor-blank-leaving',
                    }),
                  ]
                : [];
            });
            return decorations.length
              ? DecorationSet.create(state.doc, decorations)
              : DecorationSet.empty;
          },
        },
      }),
    ];
  },
});
