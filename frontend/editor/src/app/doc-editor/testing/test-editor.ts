import { Editor, type Extensions, type JSONContent } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { UndoRedo } from '@tiptap/extensions';
import { createEditorExtensions } from '@openfolia/content-editor-model';

// Every test editor goes when the test that made it finishes: a live one's DOM observer flushes
// on a timer, and once the test environment is gone that reads a `document` that no longer
// exists. The cleanup is tied to the test, not to a module-level `afterEach`: the unit tests run
// with `isolate: false`, so this module is evaluated once per worker and such a hook would only
// reach the first spec file of each worker, leaving every later file's editors running. The hook
// is the test runner's global, looked up so the app's own typecheck (which compiles this file
// without test types) passes too.
const { onTestFinished } = globalThis as {
  onTestFinished?: (hook: () => void) => void;
};

/** A detached editor on the content model's schema, with undo and the given extra extensions. */
export function testEditor(
  content: JSONContent,
  extensions: Extensions = [],
): Editor {
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: [...createEditorExtensions(), UndoRedo, ...extensions],
    content,
  });
  onTestFinished?.(() => editor.destroy());
  return editor;
}

const text = (value?: string): JSONContent[] =>
  value ? [{ type: 'text', text: value }] : [];

/** A paragraph; without text, a blank line (a caret gap). IDs only when given. */
export const p = (value?: string, id?: string): JSONContent => {
  const content = text(value);
  return {
    type: 'paragraph',
    ...(id ? { attrs: { id } } : {}),
    ...(content.length ? { content } : {}),
  };
};

/** A section with its title and blocks (and subsections, after the blocks). */
export const sec = (title: string, ...blocks: JSONContent[]): JSONContent => ({
  type: 'section',
  content: [
    { type: 'title', ...(title ? { content: text(title) } : {}) },
    ...blocks,
  ],
});

/** A list with one item per text. */
export const list = (ordered: boolean, ...items: string[]): JSONContent => ({
  type: 'list',
  attrs: { ordered },
  content: items.map((item) => ({
    type: 'listItem',
    content: [{ type: 'itemText', ...(item ? { content: text(item) } : {}) }],
  })),
});

/** A block without text of its own: a module reference (an atom, like a divider was). */
export const ref = (module = 'other'): JSONContent => ({
  type: 'moduleRef',
  attrs: { module },
});

export const doc = (...content: JSONContent[]): JSONContent => ({
  type: 'doc',
  content,
});

/** A node as a short name: `p:text`, `s:title[...]`, `list:text`, `ref`, `p:` for a blank. */
function describe(node: ProseMirrorNode): string {
  switch (node.type.name) {
    case 'paragraph':
      return `p:${node.textContent}`;
    case 'moduleRef':
      return 'ref';
    case 'section': {
      const inner: string[] = [];
      node.forEach((child, _offset, index) => {
        if (index > 0) inner.push(describe(child));
      });
      return `s:${node.firstChild?.textContent ?? ''}[${inner.join(', ')}]`;
    }
    default:
      return `${node.type.name}:${node.textContent}`;
  }
}

/** The root blocks as short names (see `describe`). */
export function blocks(editor: Editor): string[] {
  const out: string[] = [];
  editor.state.doc.forEach((node) => out.push(describe(node)));
  return out;
}

/** The position just inside the root block at `index`. */
export function inside(editor: Editor, index: number): number {
  let pos = 0;
  for (let i = 0; i < index; i += 1) pos += editor.state.doc.child(i).nodeSize;
  return pos + 1;
}

/** The position just inside the first text block whose text is `textContent`. */
export function insideText(editor: Editor, textContent: string): number {
  let found = -1;
  editor.state.doc.descendants((node, pos) => {
    if (found >= 0) return false;
    if (node.isTextblock && node.textContent === textContent) {
      found = pos + 1;
      return false;
    }
    return true;
  });
  if (found < 0) throw new Error(`no text block "${textContent}"`);
  return found;
}
