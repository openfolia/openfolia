import type { WritableSignal } from '@angular/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { NodeSelection, Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';

import {
  hoverCallout,
  sameCallout,
  type CalloutKey,
} from '../blocks/doc-blocks-context';

// Callout highlighting in the text (#549): a reference chip under the pointer, or selected with
// the keyboard while the editor has the focus, names its callout in the editor's shared hover
// state (`DocBlocksContext.calloutHover`), so its marker and panel row light up; and every chip
// of the callout hovered anywhere (a marker, a row, another chip) is highlighted, through a node
// decoration. Only the decorations change: no step in the document, nothing for Undo.

/** The classes a highlighted reference chip gets: a ring, never colour alone; no change of weight, so the line does not move. */
export const CALLOUT_REF_HIGHLIGHTED =
  'doc-editor-callout-ref--highlighted ring-2 ring-ring ring-offset-1 ring-offset-background';

interface HoverState {
  readonly key: CalloutKey | null;
  readonly decorations: DecorationSet;
}

const calloutHoverKey = new PluginKey<HoverState>('calloutHover');

/** The callout a reference chip names. */
function refKey(node: ProseMirrorNode): CalloutKey | null {
  const block = node.attrs['block'];
  const callout = node.attrs['callout'];
  return typeof block === 'string' && block && typeof callout === 'string'
    ? { block, callout }
    : null;
}

/** A decoration on every reference to `key`. */
function decorate(doc: ProseMirrorNode, key: CalloutKey | null): DecorationSet {
  if (!key) return DecorationSet.empty;
  const found: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name === 'calloutRef' && sameCallout(refKey(node), key)) {
      found.push(
        Decoration.node(pos, pos + node.nodeSize, {
          class: CALLOUT_REF_HIGHLIGHTED,
          'data-highlighted': '',
        }),
      );
    }
    return true;
  });
  return DecorationSet.create(doc, found);
}

/** The callout of the reference chip `target` is in, from the chip's own data. */
function chipKeyAt(target: EventTarget | null): CalloutKey | null {
  const element =
    target instanceof Element
      ? target
      : target instanceof Node
        ? target.parentElement
        : null;
  const chip = element?.closest<HTMLElement>('[data-node="calloutRef"]');
  const block = chip?.dataset['calloutBlock'];
  const callout = chip?.dataset['callout'];
  return block && callout !== undefined ? { block, callout } : null;
}

/** The reference selected as a whole while the editor has the focus, else null. */
function selectedKey(view: EditorView): CalloutKey | null {
  const { selection } = view.state;
  return view.hasFocus() &&
    selection instanceof NodeSelection &&
    selection.node.type.name === 'calloutRef'
    ? refKey(selection.node)
    : null;
}

/** Highlights the references to `key` (null: none), as the shared hover state says. */
export function setCalloutHover(
  view: EditorView,
  key: CalloutKey | null,
): void {
  const state = calloutHoverKey.getState(view.state);
  if (!state || state.key === key || sameCallout(state.key, key)) return;
  view.dispatch(
    view.state.tr.setMeta(calloutHoverKey, key).setMeta('addToHistory', false),
  );
}

/** The plugin, writing the chips' hover and selection into `hover`. */
export function calloutHoverPlugin(
  hover: WritableSignal<CalloutKey | null>,
): Plugin<HoverState> {
  // What this plugin itself put into `hover`: so it clears only its own.
  let pointed: CalloutKey | null = null;
  let selected: CalloutKey | null = null;
  const point = (key: CalloutKey | null) => {
    if (sameCallout(key, pointed) || (!key && !pointed)) return;
    hoverCallout(hover, key, pointed);
    pointed = key;
  };
  const select = (view: EditorView) => {
    const key = selectedKey(view);
    if (sameCallout(key, selected) || (!key && !selected)) return;
    hoverCallout(hover, key, selected);
    selected = key;
  };
  return new Plugin<HoverState>({
    key: calloutHoverKey,
    state: {
      init: () => ({ key: null, decorations: DecorationSet.empty }),
      apply(tr, value) {
        const meta = tr.getMeta(calloutHoverKey) as
          CalloutKey | null | undefined;
        if (meta !== undefined)
          return { key: meta, decorations: decorate(tr.doc, meta) };
        // A reference added, removed or changed: found again.
        return tr.docChanged && value.key
          ? { key: value.key, decorations: decorate(tr.doc, value.key) }
          : value;
      },
    },
    props: {
      decorations: (state) => calloutHoverKey.getState(state)?.decorations,
      handleDOMEvents: {
        mouseover: (_view, event) => {
          point(chipKeyAt(event.target));
          return false;
        },
        mouseleave: () => {
          point(null);
          return false;
        },
        focus: (view) => {
          select(view);
          return false;
        },
        blur: () => {
          // The focus is leaving: `hasFocus` may still say otherwise for this event.
          hoverCallout(hover, null, selected);
          selected = null;
          return false;
        },
      },
    },
    view: () => ({
      update: (view) => select(view),
      destroy: () => {
        hoverCallout(hover, null, pointed);
        hoverCallout(hover, null, selected);
        pointed = null;
        selected = null;
      },
    }),
  });
}
