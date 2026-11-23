import { Extension } from '@tiptap/core';
import {
  Fragment,
  Slice,
  type Node as ProseMirrorNode,
} from '@tiptap/pm/model';
import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';

import { newCalloutId } from '../blocks/callouts';

// What a paste may bring in (`@openfolia/content-editor-model`, "Copy and paste"). The schema reads
// its own `data-node` markup from any HTML, and anything on a page can say it came from
// ProseMirror (`data-pm-slice` is only an attribute), so neither proves where a paste came from.
// What does: the editor remembers, in memory, the module references, variants, passthroughs and
// images it put on the clipboard itself (`transformCopied`, for copy, cut and drag). A pasted
// one is kept only when it equals one of those, IDs aside; any other is taken out (a variant
// leaves its blocks, the others go). Pasted blocks get new IDs: the repair step
// (`model-repair.ts`) gives every block whose ID is cleared here one of its own. A drag within the
// editor always moves (never copies: a copy would share the IDs), and the blocks it moves keep
// their IDs: only the very slice being dragged passes untouched.
//
// Images with callouts (#547) are the exception to "new IDs": a pasted image keeps its own ID and
// each callout keeps its ID where no node of the document (outside what the paste replaces) holds
// it, so a cut and paste, or a copy into another module, keeps them. A taken one gets a new ID
// (the image's, else `<image>-<n>`, the first free number), given here rather than by the repair
// step so that the callout references inside the pasted content follow the copy: one that names
// a pasted image and its callout names the copy's. A reference to an image that is not pasted is
// left alone (it names the original).

/** Block types only the editor's own copy may bring in. */
export const OWN_COPY_ONLY: ReadonlySet<string> = new Set([
  'moduleRef',
  'variant',
  'passthrough',
  'image',
]);

/** The fragment with every block ID cleared, at every depth. */
export function withoutIds(fragment: Fragment): Fragment {
  const nodes: ProseMirrorNode[] = [];
  fragment.forEach((node) => {
    if (node.isText) {
      nodes.push(node);
      return;
    }
    const attrs =
      'id' in node.attrs && node.attrs['id'] !== null
        ? { ...node.attrs, id: null }
        : node.attrs;
    nodes.push(node.type.create(attrs, withoutIds(node.content), node.marks));
  });
  return Fragment.fromArray(nodes);
}

/** A random block ID, as the repair step makes them. */
function randomId(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = new Uint8Array(10);
  globalThis.crypto.getRandomValues(bytes);
  return `b${Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('')}`;
}

/** The IDs the document holds outside `from`..`to` (what a paste there replaces). */
function idsOutside(state: EditorState): Set<string> {
  const { from, to } = state.selection;
  const out = new Set<string>();
  state.doc.descendants((node, pos) => {
    const inside = pos >= from && pos + node.nodeSize <= to;
    const id = node.attrs['id'];
    if (!inside && typeof id === 'string' && id) out.add(id);
    return !node.isTextblock;
  });
  return out;
}

/**
 * The pasted fragment's IDs: images and their callouts keep theirs where they are free (else get
 * new ones), the callout references inside it follow, every other ID is cleared for the repair
 * step (see the top of this file).
 */
export function pastedIds(fragment: Fragment, state: EditorState): Fragment {
  const taken = idsOutside(state);
  /** Old image ID → its new ID and its callouts' new IDs. */
  const images = new Map<
    string,
    { id: string; callouts: Map<string, string> }
  >();
  const own = (id: unknown): id is string =>
    typeof id === 'string' && id !== '';
  const claim = (wanted: unknown, make: () => string): string => {
    const id = own(wanted) && !taken.has(wanted) ? wanted : make();
    taken.add(id);
    return id;
  };
  fragment.descendants((node) => {
    if (node.type.name !== 'image') return true;
    const old = node.attrs['id'];
    const id = claim(old, () => {
      let next = randomId();
      while (taken.has(next)) next = randomId();
      return next;
    });
    const callouts = new Map<string, string>();
    node.forEach((child) => {
      if (child.type.name !== 'callout') return;
      const was = child.attrs['id'];
      const next = claim(was, () => newCalloutId(id, taken));
      if (own(was) && !callouts.has(was)) callouts.set(was, next);
    });
    if (own(old) && !images.has(old)) images.set(old, { id, callouts });
    return false;
  });
  const rebuild = (content: Fragment, image: string | null): Fragment => {
    const nodes: ProseMirrorNode[] = [];
    content.forEach((node) => {
      if (node.isText) {
        nodes.push(node);
        return;
      }
      let attrs = node.attrs;
      let inner: string | null = null;
      if (node.type.name === 'image' && own(node.attrs['id'])) {
        const found = images.get(node.attrs['id']);
        inner = node.attrs['id'];
        attrs = { ...attrs, id: found?.id ?? null };
      } else if (node.type.name === 'callout' && image !== null) {
        const id = images.get(image)?.callouts.get(String(node.attrs['id']));
        attrs = { ...attrs, id: id ?? null };
      } else if (node.type.name === 'calloutRef') {
        const found = images.get(String(node.attrs['block']));
        const callout = found?.callouts.get(String(node.attrs['callout']));
        if (found && callout) attrs = { ...attrs, block: found.id, callout };
      } else if ('id' in attrs && attrs['id'] !== null) {
        attrs = { ...attrs, id: null };
      }
      nodes.push(
        node.type.create(
          attrs,
          rebuild(node.content, inner ?? image),
          node.marks,
        ),
      );
    });
    return Fragment.fromArray(nodes);
  };
  return rebuild(fragment, null);
}

/** The guarded nodes in a fragment, at every depth, with their IDs cleared. */
export function guardedNodes(fragment: Fragment): ProseMirrorNode[] {
  const out: ProseMirrorNode[] = [];
  withoutIds(fragment).descendants((node) => {
    if (OWN_COPY_ONLY.has(node.type.name)) out.push(node);
    return true;
  });
  return out;
}

/**
 * The fragment with every guarded node that isn't one of `known` taken out: a variant leaves its
 * blocks in its place, a module reference, passthrough or image goes. Compared with IDs cleared.
 */
export function keepKnown(
  fragment: Fragment,
  known: readonly ProseMirrorNode[],
): Fragment {
  const nodes: ProseMirrorNode[] = [];
  fragment.forEach((node) => {
    if (OWN_COPY_ONLY.has(node.type.name)) {
      const bare = withoutIds(Fragment.from(node)).firstChild;
      if (bare && known.some((k) => k.eq(bare))) {
        nodes.push(node);
      } else if (node.type.name === 'variant') {
        keepKnown(node.content, known).forEach((child) => nodes.push(child));
      }
      return;
    }
    nodes.push(node.isText ? node : node.copy(keepKnown(node.content, known)));
  });
  return Fragment.fromArray(nodes);
}

/** How many of an editor's recent copies (or drags) are remembered. */
const REMEMBERED_COPIES = 8;

/** What each editor recently put on the clipboard: per copy, its guarded nodes, IDs cleared. */
const copied = new WeakMap<EditorView, ProseMirrorNode[][]>();

/** Remembers a copy, so a drag in between doesn't forget what was copied before it. */
function remember(view: EditorView, nodes: ProseMirrorNode[]): void {
  const recent = copied.get(view) ?? [];
  copied.set(view, [nodes, ...recent].slice(0, REMEMBERED_COPIES));
}

/** The pasted slice as the editor takes it in: unknown guarded nodes out, IDs cleared. */
export function guardPaste(slice: Slice, view: EditorView): Slice {
  // A drag inside the editor moves its own blocks: they stay as they are, IDs too. Only that
  // slice: a paste while a drag flag lingers is a paste.
  if (view.dragging && slice === view.dragging.slice) return slice;
  const content = keepKnown(slice.content, (copied.get(view) ?? []).flat());
  const cleared = pastedIds(content, view.state);
  if (content.eq(slice.content))
    return new Slice(cleared, slice.openStart, slice.openEnd);
  // Something was taken out, so the open depths may no longer hold: open as far as it goes.
  const open = Slice.maxOpen(cleared);
  return new Slice(
    cleared,
    Math.min(slice.openStart, open.openStart),
    Math.min(slice.openEnd, open.openEnd),
  );
}

const key = new PluginKey('docEditorPasteGuard');

export const PasteGuard = Extension.create({
  name: 'pasteGuard',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key,
        props: {
          transformCopied: (slice, view) => {
            remember(view, guardedNodes(slice.content));
            return slice;
          },
          // Every drag within the editor moves: a copy would carry the blocks' IDs twice.
          dragCopies: () => false,
          transformPasted: (slice, view) => guardPaste(slice, view),
        },
      }),
    ];
  },
});
