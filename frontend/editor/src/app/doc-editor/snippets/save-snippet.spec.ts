import { signal } from '@angular/core';
import type { Editor, JSONContent } from '@tiptap/core';
import { undo } from '@tiptap/pm/history';
import { NodeSelection, TextSelection } from '@tiptap/pm/state';

import {
  setDocBlocksContext,
  type DocBlockSettings,
} from '../blocks/doc-blocks-context';
import {
  blocks,
  doc,
  insideText,
  list,
  p,
  ref,
  sec,
  testEditor,
} from '../testing/test-editor';
import {
  saveAsSnippet,
  saveSnippetBlocked,
  snippetSource,
  SNIPPET_REFUSALS,
  type SnippetSaveRequest,
} from './save-snippet';

// jsdom lays nothing out: ProseMirror asks for rectangles when it scrolls the caret into view.
beforeAll(() => {
  const proto = Range.prototype as Partial<Range>;
  proto.getClientRects ??= () => [] as unknown as DOMRectList;
  proto.getBoundingClientRect ??= () => new DOMRect();
});

const variant = (...content: JSONContent[]): JSONContent => ({
  type: 'variant',
  attrs: { id: 'v1' },
  content,
});

/** Selects from the start of the text `from` to the end of the text `to`. */
function select(editor: Editor, from: string, to: string): void {
  const start = insideText(editor, from);
  const end = insideText(editor, to) + to.length;
  editor.view.dispatch(
    editor.state.tr.setSelection(
      TextSelection.create(editor.state.doc, start, end),
    ),
  );
}

/** An editor whose page offers "Save as snippet", recording what it was handed. */
function withSaver(content: JSONContent, blocked: string | null = null) {
  const editor = testEditor(content);
  const requests: SnippetSaveRequest[] = [];
  const settings = signal<DocBlockSettings>({
    saveSnippet: { blocked, save: (request) => requests.push(request) },
  });
  setDocBlocksContext(editor, { settings, editable: signal(true) });
  return { editor, requests, settings };
}

describe('the blocks a selection saves as a snippet', () => {
  it('are the paragraphs it covers, with new block IDs and their text', () => {
    const editor = testEditor(
      doc(p('Before', 'b0'), p('First', 'b1'), p('Second', 'b2'), p('After')),
    );
    select(editor, 'First', 'Second');
    const source = snippetSource(editor.state);
    expect(source.ok).toBe(true);
    if (!source.ok) return;
    expect(source.blocks.map((b) => b.type)).toEqual([
      'paragraph',
      'paragraph',
    ]);
    expect(
      source.blocks.map((b) => (b.type === 'paragraph' ? b.content : null)),
    ).toEqual([
      [{ type: 'text', text: 'First' }],
      [{ type: 'text', text: 'Second' }],
    ]);
    const ids = source.blocks.map((b) => b.id);
    expect(ids.every((id) => typeof id === 'string' && id.length > 0)).toBe(
      true,
    );
    expect(new Set(ids).size).toBe(2);
    expect(ids).not.toContain('b1');
    expect(ids).not.toContain('b2');
  });

  it('are the whole block when the selection is inside one paragraph', () => {
    const editor = testEditor(doc(p('One two three', 'b1'), p('Next', 'b2')));
    const start = insideText(editor, 'One two three');
    editor.view.dispatch(
      editor.state.tr.setSelection(
        TextSelection.create(editor.state.doc, start + 4, start + 7),
      ),
    );
    const source = snippetSource(editor.state);
    expect(source.ok && source.blocks.length).toBe(1);
  });

  it('refuses a section or a module reference, inside a frame too', () => {
    const editor = testEditor(
      doc(p('Intro', 'b1'), sec('Heading', p('Inside', 'b2'))),
    );
    select(editor, 'Intro', 'Inside');
    expect(snippetSource(editor.state)).toEqual({
      ok: false,
      reason: SNIPPET_REFUSALS.tooLarge,
    });

    const withRef = testEditor(doc(p('A', 'b1'), ref(), p('B', 'b2')));
    select(withRef, 'A', 'B');
    expect(snippetSource(withRef.state)).toEqual({
      ok: false,
      reason: SNIPPET_REFUSALS.tooLarge,
    });

    const framed = testEditor(
      doc(variant(p('V', 'b3'), ref()), p('After', 'b4')),
    );
    expect(snippetSource(framed.state, 0)).toEqual({
      ok: false,
      reason: SNIPPET_REFUSALS.tooLarge,
    });
  });

  it('refuses a block the model can’t hold yet', () => {
    const editor = testEditor(doc(list(false, 'one', ''), p('After', 'b9')));
    expect(snippetSource(editor.state, 0)).toEqual({
      ok: false,
      reason: SNIPPET_REFUSALS.incomplete,
    });
  });

  it('for a block’s menu: the block, or the selection’s run when it holds the block', () => {
    const editor = testEditor(
      doc(p('First', 'b1'), p('Second', 'b2'), p('Third', 'b3')),
    );
    const second = editor.state.doc.child(0).nodeSize;
    const alone = snippetSource(editor.state, second);
    expect(alone.ok && alone.range.nodes.map((n) => n.attrs['id'])).toEqual([
      'b2',
    ]);
    select(editor, 'First', 'Second');
    const run = snippetSource(editor.state, second);
    expect(run.ok && run.range.nodes.map((n) => n.attrs['id'])).toEqual([
      'b1',
      'b2',
    ]);
    // A block outside the selection: that block alone.
    const third = second + editor.state.doc.child(1).nodeSize;
    const other = snippetSource(editor.state, third);
    expect(other.ok && other.range.nodes.map((n) => n.attrs['id'])).toEqual([
      'b3',
    ]);
  });
});

describe('saving the selection as a snippet', () => {
  it('is not offered without the page’s saver, and says the page’s reason first', () => {
    const plain = testEditor(doc(p('Text', 'b1')));
    setDocBlocksContext(plain, {
      settings: signal<DocBlockSettings>({}),
      editable: signal(true),
    });
    expect(saveSnippetBlocked(plain)).toBeUndefined();

    const { editor } = withSaver(
      doc(p('Intro', 'b1'), sec('S', p('In', 'b2'))),
      'editor.moduleEditor.saveSnippet.needsDraft',
    );
    select(editor, 'Intro', 'In');
    expect(saveSnippetBlocked(editor)).toBe(
      'editor.moduleEditor.saveSnippet.needsDraft',
    );
    expect(saveAsSnippet(editor)).toBe(false);
  });

  it('puts one reference in place of the blocks once the snippet exists; one undo brings them back', () => {
    const { editor, requests } = withSaver(
      doc(
        p('Before', 'b0'),
        p('First', 'b1'),
        p('Second', 'b2'),
        p('After', 'b3'),
      ),
    );
    select(editor, 'First', 'Second');
    expect(saveSnippetBlocked(editor)).toBeNull();
    expect(saveAsSnippet(editor)).toBe(true);
    expect(requests).toHaveLength(1);
    // Nothing changes until the snippet is there.
    expect(blocks(editor)).toEqual([
      'p:Before',
      'p:First',
      'p:Second',
      'p:After',
    ]);
    expect(requests[0]!.place('battery-warning')).toBe('placed');
    expect(blocks(editor)).toEqual(['p:Before', 'ref', 'p:After']);
    const reference = editor.state.doc.child(1);
    expect(reference.attrs['module']).toBe('battery-warning');
    expect(editor.state.selection).toBeInstanceOf(NodeSelection);

    undo(editor.state, editor.view.dispatch);
    expect(blocks(editor)).toEqual([
      'p:Before',
      'p:First',
      'p:Second',
      'p:After',
    ]);
  });

  it('finds the blocks again after edits elsewhere', () => {
    const { editor, requests } = withSaver(
      doc(p('Before', 'b0'), p('First', 'b1'), p('Second', 'b2')),
    );
    select(editor, 'First', 'Second');
    saveAsSnippet(editor);
    editor.view.dispatch(
      editor.state.tr.insertText('More ', insideText(editor, 'Before')),
    );
    expect(requests[0]!.place('greeting')).toBe('placed');
    expect(blocks(editor)).toEqual(['p:More Before', 'ref']);
  });

  it('leaves the blocks alone when one of them changed meanwhile', () => {
    const { editor, requests } = withSaver(
      doc(p('First', 'b1'), p('Second', 'b2'), p('After', 'b3')),
    );
    select(editor, 'First', 'Second');
    saveAsSnippet(editor);
    editor.view.dispatch(
      editor.state.tr.insertText('!', insideText(editor, 'Second') + 6),
    );
    expect(requests[0]!.place('greeting')).toBe('changed');
    expect(blocks(editor)).toEqual(['p:First', 'p:Second!', 'p:After']);
  });

  it('puts nothing in once the editor is read-only or gone', () => {
    const { editor, requests } = withSaver(
      doc(p('First', 'b1'), p('After', 'b3')),
    );
    select(editor, 'First', 'First');
    saveAsSnippet(editor);
    editor.setEditable(false);
    expect(requests[0]!.place('greeting')).toBe('gone');
    expect(blocks(editor)).toEqual(['p:First', 'p:After']);
  });
});
