import { signal } from '@angular/core';
import type { Editor } from '@tiptap/core';
import type { Block } from '@openfolia/content-model/core';

import {
  setDocBlocksContext,
  type DocBlockSettings,
} from '../blocks/doc-blocks-context';
import type { SnippetSuggestion } from '../snippets/snippet-match';
import {
  blocks,
  doc,
  insideText,
  p,
  sec,
  testEditor,
} from '../testing/test-editor';
import { ModelRepair } from './model-repair';
import {
  setSnippets,
  shownSuggestion,
  SnippetSuggestions,
} from './snippet-suggestions';

const gloves: SnippetSuggestion = {
  id: 'wear-gloves',
  title: 'Wear gloves',
  text: 'Wear protective gloves when you touch the battery terminals.',
};

/** The snippet's own blocks, as the page reads them. */
const GLOVES_BLOCKS: Block[] = [
  {
    type: 'paragraph',
    id: 'text',
    content: [
      {
        type: 'text',
        text: 'Wear protective gloves when you touch the battery terminals.',
      },
    ],
  },
  {
    type: 'list',
    id: 'kinds',
    ordered: false,
    items: [
      {
        id: 'nitrile',
        content: [{ type: 'text', text: 'Nitrile' }],
        blocks: [],
      },
    ],
  },
];

const press = (editor: Editor, key: string, init: KeyboardEventInit = {}) =>
  editor.view.dom.dispatchEvent(
    new KeyboardEvent('keydown', {
      key,
      bubbles: true,
      cancelable: true,
      ...init,
    }),
  );

function setUp(
  content = doc(p('Before', 'before'), p('', 'line')),
  settings: DocBlockSettings = {},
) {
  const failed: string[] = [];
  const announced: string[] = [];
  const editor = testEditor(content, [
    ModelRepair,
    SnippetSuggestions.configure({
      announce: (text) => announced.push(text),
      failed: (title) => failed.push(title),
    }),
  ]);
  const read = vi.fn(async (id: string) =>
    id === gloves.id
      ? { title: gloves.title, type: 'snippet', blocks: GLOVES_BLOCKS }
      : null,
  );
  setDocBlocksContext(editor, {
    settings: signal<DocBlockSettings>({ moduleContent: read, ...settings }),
    editable: signal(true),
  });
  setSnippets(editor.view, [gloves]);
  return { editor, read, failed, announced };
}

/** Types `text` into the blank line (the second block), caret at its end. */
function typeInLine(editor: Editor, text: string): void {
  let at = -1;
  editor.state.doc.forEach((node, offset, index) => {
    if (index === 1) at = offset + 1;
  });
  editor.commands.setTextSelection(at);
  editor.commands.insertContent(text);
}

const ids = (editor: Editor): string[] => {
  const out: string[] = [];
  editor.state.doc.descendants((node) => {
    const id = node.attrs['id'];
    if (typeof id === 'string') out.push(id);
  });
  return out;
};

describe('snippet suggestions', () => {
  it('shows the rest of a snippet after the caret once the first words match', () => {
    const { editor, announced } = setUp();
    typeInLine(editor, 'Wear');
    expect(shownSuggestion(editor.state)).toBeNull();
    editor.commands.insertContent(' protective g');
    expect(shownSuggestion(editor.state)?.rest).toBe(
      'loves when you touch the battery terminals.',
    );
    const ghost = editor.view.dom.querySelector('.doc-editor-snippet-ghost');
    expect(ghost?.textContent).toContain('loves when you touch');
    expect(ghost?.getAttribute('aria-hidden')).toBe('true');
    expect(announced).toEqual(['editor.docEditor.snippet.suggested']);
    // The ghost is no text of the document.
    expect(blocks(editor)).toContain('p:Wear protective g');
  });

  it('shows nothing with the caret inside the line, a non-matching text, or no snippets', () => {
    const { editor } = setUp();
    typeInLine(editor, 'Wear protective');
    editor.commands.setTextSelection(insideText(editor, 'Wear protective') + 2);
    expect(shownSuggestion(editor.state)).toBeNull();
    typeInLine(editor, 'Do not wear');
    expect(shownSuggestion(editor.state)).toBeNull();
    const other = setUp();
    setSnippets(other.editor.view, []);
    typeInLine(other.editor, 'Wear protective');
    expect(shownSuggestion(other.editor.state)).toBeNull();
  });

  it('puts a reference in the paragraph’s place with Tab, the caret on a line after it', async () => {
    const { editor, announced } = setUp();
    typeInLine(editor, 'Wear protective');
    press(editor, 'Tab');
    await vi.waitFor(() => expect(blocks(editor)).toContain('ref'));
    expect(blocks(editor).slice(0, 3)).toEqual(['p:Before', 'ref', 'p:']);
    let module = '';
    editor.state.doc.descendants((node) => {
      if (node.type.name === 'moduleRef') module = String(node.attrs['module']);
    });
    expect(module).toBe('wear-gloves');
    expect(editor.state.selection.$from.parent.type.name).toBe('paragraph');
    expect(editor.state.selection.$from.parent.textContent).toBe('');
    expect(announced.at(-1)).toBe('editor.docEditor.snippet.referenced');
    // One undo step brings the typed words back.
    editor.commands.undo();
    expect(blocks(editor)).toContain('p:Wear protective');
  });

  it('puts a copy with fresh IDs in the paragraph’s place with Shift+Tab', async () => {
    const { editor, read } = setUp();
    typeInLine(editor, 'wear PROTECTIVE gl');
    press(editor, 'Tab', { shiftKey: true });
    await vi.waitFor(() =>
      expect(blocks(editor)).toContain(
        'p:Wear protective gloves when you touch the battery terminals.',
      ),
    );
    expect(read).toHaveBeenCalledWith('wear-gloves');
    expect(blocks(editor)).not.toContain('ref');
    const all = ids(editor);
    // Every block and item has an ID, none repeats, and none is the snippet's own.
    expect(all.length).toBeGreaterThanOrEqual(4);
    expect(new Set(all).size).toBe(all.length);
    for (const own of ['text', 'kinds', 'nitrile'])
      expect(all).not.toContain(own);
    // The caret is at the end of the copy, to write on.
    expect(editor.state.selection.$from.parent.textContent).toBe('Nitrile');
  });

  it('dismisses the suggestion with Escape for that paragraph only', () => {
    const { editor } = setUp(doc(p('', 'one'), p('', 'two')));
    typeInLine(editor, 'Wear protective');
    press(editor, 'Escape');
    expect(shownSuggestion(editor.state)).toBeNull();
    editor.commands.insertContent(' g');
    expect(shownSuggestion(editor.state)).toBeNull();
    // Tab is the editor's own again.
    expect(
      editor.view.dom.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Tab', cancelable: true }),
      ),
    ).toBe(true);
    editor.commands.setTextSelection(1);
    editor.commands.insertContent('Wear protective');
    expect(shownSuggestion(editor.state)?.snippet.id).toBe('wear-gloves');
  });

  it('suggests nothing while read-only, and nothing in a heading', () => {
    const { editor } = setUp(doc(sec('Wear protective'), p('', 'line')));
    editor.commands.setTextSelection(
      insideText(editor, 'Wear protective') + 15,
    );
    expect(shownSuggestion(editor.state)).toBeNull();
    typeInLine(editor, 'Wear protective');
    editor.setEditable(false);
    expect(editor.view.dom.querySelector('.doc-editor-snippet-ghost')).toBe(
      null,
    );
    press(editor, 'Tab');
    expect(blocks(editor).join()).not.toContain('ref');
  });

  it('tells the page when a snippet could not be read for a copy', async () => {
    const { editor, failed } = setUp(undefined, {
      moduleContent: async () => null,
    });
    typeInLine(editor, 'Wear protective');
    press(editor, 'Tab', { shiftKey: true });
    await vi.waitFor(() => expect(failed).toEqual(['Wear gloves']));
    expect(blocks(editor)).toContain('p:Wear protective');
  });
});
