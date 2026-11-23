import type { Editor, JSONContent } from '@tiptap/core';

import { doc, p, testEditor } from '../testing/test-editor';
import { type HintTerm, TermHints } from './term-hints';
import {
  setTermHints,
  shownTerm,
  TermSuggestions,
  termKeyAction,
} from './term-suggestions';

const TERMS: HintTerm[] = [
  {
    id: 'charger',
    status: 'approved',
    languages: {
      en: {
        preferred: 'charger',
        allowed: [{ term: 'charging unit' }],
        definition: [
          { type: 'text', text: 'The unit that charges the battery.' },
        ],
      },
      de: { preferred: 'Ladegerät' },
    },
  },
  {
    id: 'emergency-stop',
    status: 'approved',
    languages: { en: { preferred: 'emergency stop button' } },
  },
  {
    id: 'housing',
    status: 'proposed',
    languages: { en: { preferred: 'housing' } },
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

function setUp(content: JSONContent = doc(p('Plug in the ', 'a'))) {
  const announced: string[] = [];
  const editor = testEditor(content, [
    TermSuggestions.configure({
      announce: (text) => announced.push(text),
      translate: (key, params) =>
        params ? `${key} ${JSON.stringify(params)}` : key,
    }),
  ]);
  setTermHints(editor.view, new TermHints(TERMS, 'en'));
  editor.commands.setTextSelection(editor.state.doc.content.size - 1);
  return { editor, announced };
}

const termLinks = (editor: Editor) => {
  const out: [string, string][] = [];
  editor.state.doc.descendants((node) => {
    const mark = node.marks.find((m) => m.type.name === 'term');
    if (node.isText && mark)
      out.push([node.text ?? '', String(mark.attrs['termId'])]);
  });
  return out;
};

describe('term hints', () => {
  it('completes an approved term’s preferred variant from its start, without case', () => {
    const hints = new TermHints(TERMS, 'en');
    expect(hints.completion('CHA')).toEqual({
      termId: 'charger',
      preferred: 'charger',
    });
    expect(hints.completion('ch')).toBeNull();
    expect(hints.completion('charger')).toBeNull();
    expect(hints.completion('emergency st')?.termId).toBe('emergency-stop');
    // A proposed term offers nothing.
    expect(hints.completion('hous')).toBeNull();
    expect(hints.linkable('Charging  Unit')?.termId).toBe('charger');
    expect(hints.info('charger')?.definition).toBe(
      'The unit that charges the battery.',
    );
    expect(new TermHints(TERMS, 'de').completion('lade')?.preferred).toBe(
      'Ladegerät',
    );
  });
});

describe('term suggestions while typing', () => {
  it('shows the rest of a preferred variant after the caret; Tab puts it in, linked, in one undo step', () => {
    const { editor, announced } = setUp();
    editor.commands.insertContent('Cha');
    expect(shownTerm(editor.state)).toMatchObject({
      kind: 'complete',
      rest: 'rger',
    });
    const ghost = editor.view.dom.querySelector('.doc-editor-term-ghost');
    expect(ghost?.textContent).toContain('rger');
    expect(ghost?.getAttribute('aria-hidden')).toBe('true');
    expect(announced[0]).toContain('editor.writing.term.completeSuggested');
    press(editor, 'Tab');
    expect(editor.state.doc.textContent).toBe('Plug in the Charger');
    expect(termLinks(editor)).toEqual([['Charger', 'charger']]);
    editor.commands.undo();
    expect(editor.state.doc.textContent).toBe('Plug in the Cha');
    expect(termLinks(editor)).toEqual([]);
    editor.commands.redo();
    // Typing on is not linked.
    editor.commands.insertContent(' now');
    expect(termLinks(editor)).toEqual([['Charger', 'charger']]);
  });

  it('offers to link an allowed variant typed in full, keeping the words', () => {
    const { editor } = setUp();
    editor.commands.insertContent('charging unit');
    expect(shownTerm(editor.state)).toMatchObject({
      kind: 'link',
      typed: 'charging unit',
    });
    press(editor, 'Tab');
    expect(editor.state.doc.textContent).toBe('Plug in the charging unit');
    expect(termLinks(editor)).toEqual([['charging unit', 'charger']]);
    // Linked already: nothing more is offered.
    expect(shownTerm(editor.state)).toBeNull();
  });

  it('Escape dismisses the offer for those words; other words offer again', () => {
    const { editor } = setUp();
    editor.commands.insertContent('char');
    press(editor, 'Escape');
    expect(shownTerm(editor.state)).toBeNull();
    editor.commands.insertContent('g');
    expect(shownTerm(editor.state)).toBeNull();
    editor.commands.insertContent(' and the char');
    expect(shownTerm(editor.state)?.offer.termId).toBe('charger');
  });

  it('offers nothing inside a word, in text marked as code, or without terms', () => {
    const { editor } = setUp(doc(p('Plug in the chargerx', 'a')));
    editor.commands.setTextSelection(15);
    expect(shownTerm(editor.state)).toBeNull();
    const code = setUp(
      doc({
        type: 'paragraph',
        attrs: { id: 'a' },
        content: [{ type: 'text', text: 'cha', marks: [{ type: 'code' }] }],
      }),
    );
    expect(shownTerm(code.editor.state)).toBeNull();
    const none = setUp();
    setTermHints(none.editor.view, null);
    none.editor.commands.insertContent('cha');
    expect(shownTerm(none.editor.state)).toBeNull();
  });

  it('offers nothing in a "/" or "{" menu’s query, whose keys are the menu’s', () => {
    const { editor } = setUp();
    editor.commands.insertContent('/cha');
    expect(shownTerm(editor.state)).toBeNull();
    editor.commands.insertContent(' {char');
    expect(shownTerm(editor.state)).toBeNull();
    editor.commands.insertContent(' the cha');
    expect(shownTerm(editor.state)?.offer.termId).toBe('charger');
    // A slash inside a word opens no menu: "and/cha" is offered.
    editor.commands.insertContent('rger and/cha');
    expect(shownTerm(editor.state)?.offer.termId).toBe('charger');
  });

  it('leaves Tab to the lists when nothing is offered', () => {
    expect(termKeyAction({ key: 'Tab', shiftKey: true } as KeyboardEvent)).toBe(
      null,
    );
    expect(termKeyAction({ key: 'Tab' } as KeyboardEvent)).toBe('accept');
    expect(termKeyAction({ key: 'Escape' } as KeyboardEvent)).toBe('dismiss');
  });
});
