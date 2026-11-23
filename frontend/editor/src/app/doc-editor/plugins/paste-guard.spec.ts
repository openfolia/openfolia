import type { Editor, JSONContent } from '@tiptap/core';
import { NodeSelection, TextSelection } from '@tiptap/pm/state';

import { doc, inside, p, ref, testEditor } from '../testing/test-editor';
import { ModelRepair } from './model-repair';
import { PasteGuard } from './paste-guard';

let next = 0;
const editorWith = (...content: Parameters<typeof doc>) =>
  testEditor(doc(...content), [
    PasteGuard,
    ModelRepair.configure({ newId: () => `new-${(next += 1)}` }),
  ]);

const types = (editor: Editor) => {
  const out: string[] = [];
  editor.state.doc.forEach((node) => out.push(node.type.name));
  return out;
};

const caretAtEnd = (editor: Editor) =>
  editor.view.dispatch(
    editor.state.tr.setSelection(TextSelection.atEnd(editor.state.doc)),
  );

/** What a copy of the node at `pos` puts on the clipboard, through the editor's own copy path. */
function copyNode(editor: Editor, pos: number): string {
  editor.view.dispatch(
    editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, pos)),
  );
  return editor.view.serializeForClipboard(editor.state.selection.content()).dom
    .innerHTML;
}

/** A paste as the view takes it (jsdom has no ClipboardEvent: a plain event stands in). */
const paste = (editor: Editor, html: string) =>
  editor.view.pasteHTML(html, new Event('paste') as ClipboardEvent);

const foreign = (body: string) =>
  `<meta charset="utf-8"><div data-pm-slice="0 0 []">${body}</div>`;

describe('pasting guarded blocks', () => {
  it('drops a module reference from outside the editor, even with a forged data-pm-slice', () => {
    const editor = editorWith(p('a', 'a'), p('b', 'b'));
    caretAtEnd(editor);
    paste(
      editor,
      foreign(
        `<div data-node="moduleRef" data-module="&quot;secret&quot;">secret</div><p>text</p>`,
      ),
    );
    expect(types(editor)).not.toContain('moduleRef');
    expect(editor.getText()).toContain('text');
  });

  it('keeps the blocks of a foreign variant and drops the condition', () => {
    const editor = editorWith(p('a', 'a'));
    caretAtEnd(editor);
    paste(
      editor,
      foreign(
        `<div data-node="variant" data-when='{"op":"in","attr":"x","values":["y"]}'><p>inside</p></div>`,
      ),
    );
    expect(types(editor)).not.toContain('variant');
    expect(editor.getText()).toContain('inside');
  });

  it('keeps a module reference copied in the editor itself, with a new ID', () => {
    const editor = editorWith(
      p('a', 'a'),
      { ...ref('shared'), attrs: { id: 'r', module: 'shared' } },
      p('b', 'b'),
    );
    const html = copyNode(editor, inside(editor, 1) - 1);
    caretAtEnd(editor);
    paste(editor, html);
    const refs: { id: unknown; module: unknown }[] = [];
    editor.state.doc.forEach((node) => {
      if (node.type.name === 'moduleRef')
        refs.push({ id: node.attrs['id'], module: node.attrs['module'] });
    });
    expect(refs).toHaveLength(2);
    expect(refs[0]).toEqual({ id: 'r', module: 'shared' });
    expect(refs[1]?.module).toBe('shared');
    expect(refs[1]?.id).toMatch(/^new-/);
  });

  it('drops a pasted reference that differs from the one copied', () => {
    const editor = editorWith(
      { ...ref('shared'), attrs: { id: 'r', module: 'shared' } },
      p('b', 'b'),
    );
    const html = copyNode(editor, 0).replace(
      '&quot;shared&quot;',
      '&quot;other&quot;',
    );
    caretAtEnd(editor);
    paste(editor, html);
    const modules: unknown[] = [];
    editor.state.doc.forEach((node) => {
      if (node.type.name === 'moduleRef') modules.push(node.attrs['module']);
    });
    expect(modules).toEqual(['shared']);
  });

  it('gives a pasted paragraph a new ID', () => {
    const editor = editorWith(p('a', 'a'), p('b', 'b'));
    caretAtEnd(editor);
    paste(editor, foreign(`<p data-id='"a"'>one</p><p data-id='"a"'>two</p>`));
    const ids: unknown[] = [];
    editor.state.doc.forEach((node) => ids.push(node.attrs['id']));
    expect(ids[0]).toBe('a');
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('guards a paste while a drag flag lingers: only the dragged slice itself passes', () => {
    const editor = editorWith(p('a', 'a'), p('b', 'b'));
    caretAtEnd(editor);
    const view = editor.view as unknown as { dragging: unknown };
    view.dragging = { slice: editor.state.doc.slice(0, 3), move: true };
    paste(
      editor,
      foreign(
        `<div data-node="moduleRef" data-module="&quot;secret&quot;">secret</div><p>text</p>`,
      ),
    );
    view.dragging = null;
    expect(types(editor)).not.toContain('moduleRef');
  });

  it('makes every drag within the editor a move, never a copy that would share the IDs', () => {
    const editor = editorWith(p('a', 'a'));
    // jsdom has no DragEvent: a mouse event with the copy modifiers held stands in.
    const event = new MouseEvent('dragstart', { altKey: true, ctrlKey: true });
    const props = editor.state.plugins
      .map((plugin) => plugin.props.dragCopies)
      .filter((f) => f !== undefined);
    expect(props).toHaveLength(1);
    expect(props[0]?.(event as DragEvent)).toBe(false);
  });
});

describe('pasting an image with callouts (#547)', () => {
  const ASSET = `sha256:${'a'.repeat(64)}`;
  const image = (id: string, ...callouts: string[]): JSONContent => ({
    type: 'image',
    attrs: { id, asset: ASSET, alt: 'A pump' },
    content: callouts.map((c) => ({
      type: 'callout',
      attrs: { id: c, anchor: { x: 0.5, y: 0.5 } },
      content: [{ type: 'text', text: c }],
    })),
  });
  const refTo = (block: string, callout: string, id: string): JSONContent => ({
    type: 'paragraph',
    attrs: { id },
    content: [
      { type: 'text', text: 'See ' },
      { type: 'calloutRef', attrs: { block, callout } },
    ],
  });
  const ids = (editor: Editor) => {
    const out: string[] = [];
    editor.state.doc.descendants((node) => {
      if (typeof node.attrs['id'] === 'string') out.push(node.attrs['id']);
      return !node.isTextblock;
    });
    return out;
  };
  const refs = (editor: Editor) => {
    const out: string[] = [];
    editor.state.doc.descendants((node) => {
      if (node.type.name === 'calloutRef')
        out.push(`${node.attrs['block']}#${node.attrs['callout']}`);
      return true;
    });
    return out;
  };
  /** Copies the blocks `from`..`to` (top-level indexes) through the editor's own copy path. */
  function copyBlocks(editor: Editor, from: number, to: number): string {
    const { doc: d } = editor.state;
    let start = 0;
    for (let i = 0; i < from; i++) start += d.child(i).nodeSize;
    let end = start;
    for (let i = from; i <= to; i++) end += d.child(i).nodeSize;
    const slice = d.slice(start, end);
    editor.view.someProp('transformCopied', (f) => f(slice, editor.view));
    return editor.view.serializeForClipboard(slice).dom.innerHTML;
  }

  it('copied within the module: the copy gets new IDs, and a reference inside it follows the copy', () => {
    const editor = editorWith(
      image('pump', 'inlet', 'outlet'),
      refTo('pump', 'outlet', 'see'),
      p('end', 'end'),
    );
    const html = copyBlocks(editor, 0, 1);
    caretAtEnd(editor);
    paste(editor, html);
    const all = ids(editor);
    expect(new Set(all).size).toBe(all.length);
    const copy = editor.state.doc.child(3);
    expect(copy.type.name).toBe('image');
    const copyId = String(copy.attrs['id']);
    expect(copyId).not.toBe('pump');
    const calloutIds: string[] = [];
    copy.forEach((c) => calloutIds.push(String(c.attrs['id'])));
    expect(calloutIds).toEqual([`${copyId}-1`, `${copyId}-2`]);
    // The original's reference still names the original; the copy's names the copy.
    expect(refs(editor)).toEqual(['pump#outlet', `${copyId}#${copyId}-2`]);
  });

  it('cut and pasted: the image and its callouts keep their IDs, so references elsewhere still hold', () => {
    const editor = editorWith(
      p('start', 'start'),
      image('pump', 'inlet', 'outlet'),
      refTo('pump', 'inlet', 'see'),
    );
    const html = copyBlocks(editor, 1, 1);
    // The cut: the image goes, then it is pasted at the end.
    const at = editor.state.doc.child(0).nodeSize;
    editor.view.dispatch(
      editor.state.tr.delete(at, at + editor.state.doc.child(1).nodeSize),
    );
    caretAtEnd(editor);
    paste(editor, html);
    expect(ids(editor)).toEqual(
      expect.arrayContaining(['pump', 'inlet', 'outlet']),
    );
    expect(refs(editor)).toEqual(['pump#inlet']);
  });

  it('a reference pasted without its image keeps naming the original', () => {
    const editor = editorWith(
      image('pump', 'inlet'),
      refTo('pump', 'inlet', 'see'),
    );
    const html = copyBlocks(editor, 1, 1);
    caretAtEnd(editor);
    paste(editor, html);
    expect(refs(editor)).toEqual(['pump#inlet', 'pump#inlet']);
  });
});
