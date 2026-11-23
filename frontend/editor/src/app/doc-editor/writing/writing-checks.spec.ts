import type { Editor, JSONContent } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import {
  compileWritingRules,
  type Term,
  type TextFinding,
} from '@openfolia/content-model/core';

import { doc, p, sec, testEditor } from '../testing/test-editor';
import {
  DEBOUNCE_MS,
  findingAt,
  ignoreFinding,
  MAX_WAIT_MS,
  type PlacedFinding,
  replaceFinding,
  runChecks,
  setSuggestionMarks,
  setWritingRules,
  suggestionMarks,
  WritingChecks,
  writingFindings,
} from './writing-checks';

const charger: Term = {
  schemaVersion: 1,
  id: 'charger',
  status: 'approved',
  languages: {
    en: {
      preferred: 'charger',
      allowed: [{ term: 'charging unit' }],
      forbidden: [{ term: 'loader', note: 'Reads as a machine.' }],
    },
  },
} as Term;

const rules = () =>
  compileWritingRules({
    terms: [charger],
    styleRules: {
      en: {
        rules: [
          {
            id: 'dry-place',
            words: 'in a dry place',
            message: 'Say where: "in a room below 30 °C".',
          },
        ],
      },
    },
    lang: 'en',
  });

function setUp(content: JSONContent = doc(p('Plug in the loader.', 'a'))) {
  const found: (readonly PlacedFinding[])[] = [];
  const caret: unknown[] = [];
  const editor = testEditor(content, [
    WritingChecks.configure({
      onFindings: (f) => found.push(f),
      onCaret: (at) => caret.push(at),
    }),
  ]);
  return { editor, found, caret };
}

/** Lets the debounced check run. */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 10);
}

const texts = (editor: Editor) =>
  writingFindings(editor.state).map((f) =>
    editor.state.doc.textBetween(f.from, f.to),
  );

describe('the writing checks while typing', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('finds a forbidden term once typing pauses, and underlines it with its field marked', async () => {
    const { editor, found } = setUp();
    setWritingRules(editor.view, rules());
    expect(writingFindings(editor.state)).toEqual([]);
    await settle();
    const [f] = writingFindings(editor.state);
    expect(f).toMatchObject({
      code: 'forbidden-term',
      severity: 'warning',
      blockId: 'a',
      field: 'content',
      text: 'loader',
      replacement: 'charger',
    });
    expect(texts(editor)).toEqual(['loader']);
    expect(found.at(-1)).toHaveLength(1);
    const mark = editor.view.dom.querySelector('.doc-editor-finding');
    expect(mark?.textContent).toBe('loader');
    expect(mark?.getAttribute('data-severity')).toBe('warning');
    expect(
      editor.view.dom.querySelector('p.doc-editor-has-finding'),
    ).not.toBeNull();
  });

  it('marks a field with a finding by an icon of its own, never by the field’s ::after (a safety notice’s labels use it)', async () => {
    const { editor } = setUp(
      doc({
        type: 'safety',
        attrs: { id: 's', severity: 'warning' },
        content: [
          { type: 'hazard', content: [{ type: 'text', text: 'A loader' }] },
          {
            type: 'paragraph',
            attrs: { id: 'm' },
            content: [{ type: 'text', text: 'Unplug it.' }],
          },
        ],
      }),
    );
    setWritingRules(editor.view, rules());
    await settle();
    expect(writingFindings(editor.state).map((f) => f.field)).toEqual([
      'hazard',
    ]);
    const icons = editor.view.dom.querySelectorAll('.doc-editor-finding-icon');
    expect(icons).toHaveLength(1);
    expect(icons[0]!.getAttribute('aria-hidden')).toBe('true');
    expect(icons[0]!.closest('.doc-editor-has-finding')?.textContent).toBe(
      'A loader',
    );
    // Not text of the document.
    expect(editor.state.doc.textContent).toBe('A loaderUnplug it.');
  });

  it('waits for a pause in typing, at most MAX_WAIT_MS', async () => {
    const { editor } = setUp(doc(p('Plug in the ', 'a')));
    setWritingRules(editor.view, rules());
    await settle();
    editor.commands.setTextSelection(editor.state.doc.content.size - 1);
    editor.commands.insertContent('loader');
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS - 50);
    expect(writingFindings(editor.state)).toEqual([]);
    // Typing on keeps it waiting, but not past MAX_WAIT_MS since the first change.
    for (let t = 0; t < MAX_WAIT_MS; t += 100) {
      editor.commands.insertContent(' ');
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(texts(editor)).toEqual(['loader']);
  });

  it('checks only the fields that changed since the last check', () => {
    const editor = testEditor(
      doc(p('The loader.', 'a'), p('Keep it in a dry place.', 'b')),
    );
    const cache = new WeakMap<ProseMirrorNode, readonly TextFinding[]>();
    const compiled = rules();
    const first = runChecks(editor.state.doc, compiled, cache, new Set(), []);
    expect(first.checked).toBe(2);
    expect(first.findings.map((f) => f.text)).toEqual([
      'loader',
      'in a dry place',
    ]);
    editor.commands.setTextSelection(3);
    editor.commands.insertContent('x');
    const second = runChecks(editor.state.doc, compiled, cache, new Set(), []);
    expect(second.checked).toBe(1);
    expect(second.findings).toHaveLength(2);
  });

  it('reads titles and paragraphs, but never code blocks or text marked as code', async () => {
    const { editor } = setUp(
      doc(
        { ...sec('The loader', p('A `loader`', 'p')), attrs: { id: 's' } },
        {
          type: 'literal',
          attrs: { id: 'code' },
          content: [{ type: 'text', text: 'loader' }],
        },
        {
          type: 'paragraph',
          attrs: { id: 'c' },
          content: [
            { type: 'text', text: 'loader', marks: [{ type: 'code' }] },
          ],
        },
      ),
    );
    setWritingRules(editor.view, rules());
    await settle();
    expect(writingFindings(editor.state).map((f) => [f.field, f.text])).toEqual(
      [
        ['title', 'loader'],
        ['content', 'loader'],
      ],
    );
  });

  it('puts the replacement in with one undo step, and Undo brings the text back', async () => {
    const { editor } = setUp();
    setWritingRules(editor.view, rules());
    await settle();
    const [f] = writingFindings(editor.state);
    expect(replaceFinding(editor.view, f!.id)).toBe(true);
    expect(editor.state.doc.textContent).toBe('Plug in the charger.');
    editor.commands.undo();
    expect(editor.state.doc.textContent).toBe('Plug in the loader.');
  });

  it('refuses a replacement once the text found changed, and one without a fix', async () => {
    const { editor } = setUp();
    setWritingRules(editor.view, rules());
    await settle();
    const [f] = writingFindings(editor.state);
    // The word typed over before the next check: mapped, but no longer the text found.
    editor.commands.insertContentAt(f!.from + 1, 'x');
    expect(replaceFinding(editor.view, f!.id)).toBe(false);
    expect(replaceFinding(editor.view, 'nothing')).toBe(false);
  });

  it('ignores a finding here: the same rule on the same text in that field, until the editor goes', async () => {
    const { editor } = setUp(
      doc(p('The loader and the loader.', 'a'), p('A loader.', 'b')),
    );
    setWritingRules(editor.view, rules());
    await settle();
    expect(writingFindings(editor.state)).toHaveLength(3);
    const [first] = writingFindings(editor.state);
    expect(ignoreFinding(editor.view, first!.id)).toBe(true);
    expect(writingFindings(editor.state).map((f) => f.blockId)).toEqual(['b']);
    // Typing in the field does not bring it back.
    editor.commands.setTextSelection(2);
    editor.commands.insertContent('Now ');
    await settle();
    expect(writingFindings(editor.state).map((f) => f.blockId)).toEqual(['b']);
  });

  it('says what is at the caret, once per finding', async () => {
    const { editor, caret } = setUp();
    setWritingRules(editor.view, rules());
    await settle();
    const [f] = writingFindings(editor.state);
    editor.commands.setTextSelection(f!.from + 2);
    editor.commands.setTextSelection(f!.from + 3);
    expect(findingAt(editor.state, f!.from + 3)?.id).toBe(f!.id);
    const hits = caret.filter(Boolean);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ kind: 'finding' });
  });

  it('checks nothing without rules, and drops what it found when they go', async () => {
    const { editor } = setUp();
    await settle();
    expect(writingFindings(editor.state)).toEqual([]);
    setWritingRules(editor.view, rules());
    await settle();
    expect(writingFindings(editor.state)).toHaveLength(1);
    setWritingRules(editor.view, null);
    expect(writingFindings(editor.state)).toEqual([]);
    expect(editor.view.dom.querySelector('.doc-editor-finding')).toBeNull();
  });

  it('marks a page suggestion where its field still reads as it was made for', async () => {
    const { editor } = setUp(doc(p('Open the valve in order to drain.', 'a')));
    setSuggestionMarks(editor.view, [
      {
        id: 's1',
        blockId: 'a',
        field: 'content',
        start: 15,
        end: 26,
        expected: 'Open the valve in order to drain.',
      },
      {
        id: 'stale',
        blockId: 'a',
        field: 'content',
        start: 0,
        end: 4,
        expected: 'Something else.',
      },
    ]);
    await settle();
    const marks = suggestionMarks(editor.state);
    expect(marks.map((m) => m.id)).toEqual(['s1']);
    expect(editor.state.doc.textBetween(marks[0]!.from, marks[0]!.to)).toBe(
      'in order to',
    );
    expect(
      editor.view.dom.querySelector('.doc-editor-suggestion-mark')?.textContent,
    ).toBe('in order to');
  });
});
