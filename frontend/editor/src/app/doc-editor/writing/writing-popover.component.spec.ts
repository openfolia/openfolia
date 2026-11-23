import { TestBed } from '@angular/core/testing';
import type { JSONContent } from '@tiptap/core';
import { compileWritingRules, type Term } from '@openfolia/content-model/core';
import { provideZard } from '@openfolia/ui/core';

import { advance } from '../../testing/fake-time';
import { BlockEditorComponent } from '../block-editor.component';
import type { DocBlockSettings } from '../blocks/doc-blocks-context';
import { doc, p } from '../testing/test-editor';
import { TermHints } from './term-hints';
import { DEBOUNCE_MS, writingFindings } from './writing-checks';
import { PEEK_MS } from './writing-popover.component';

// The writing aids' popover (#247), in the block editor: Alt+Enter at a finding opens it with the
// focus on "Replace"; Replace and Ignore here act and give the focus back to the text; a linked
// term shows its definition; a page suggestion offers Apply and Dismiss. Its texts are text only.

// jsdom lays nothing out and its ranges have no rectangles; ProseMirror asks for them when a
// command scrolls the caret into view.
beforeAll(() => {
  const proto = Range.prototype as Partial<Range>;
  proto.getClientRects ??= () => [] as unknown as DOMRectList;
  proto.getBoundingClientRect ??= () => new DOMRect();
});

const TERMS: Term[] = [
  {
    schemaVersion: 1,
    id: 'charger',
    status: 'approved',
    languages: {
      en: {
        preferred: 'charger',
        allowed: [],
        forbidden: [{ term: 'loader' }],
        definition: [
          { type: 'text', text: 'The unit that charges <b>the</b> battery.' },
        ],
      },
    },
  } as Term,
];

const writing = () => ({
  rules: compileWritingRules({
    terms: TERMS,
    styleRules: {
      en: {
        rules: [
          {
            id: 'markup',
            words: 'dry place',
            message: '<img src=x onerror=alert(1)> Say where.',
          },
        ],
      },
    },
    lang: 'en',
  }),
  terms: new TermHints(TERMS, 'en'),
});

async function render(
  value: JSONContent,
  blocks: DocBlockSettings = { lang: 'en', writing: writing() },
) {
  TestBed.configureTestingModule({ providers: [provideZard()] });
  vi.useFakeTimers();
  const fixture = TestBed.createComponent(BlockEditorComponent);
  fixture.componentRef.setInput('value', value);
  fixture.componentRef.setInput('blocks', blocks);
  await advance();
  await advance(DEBOUNCE_MS + 10);
  const component = fixture.componentInstance;
  const editor = component.editor!;
  const popover = () =>
    document.querySelector<HTMLElement>('[data-slot="writing-popover"]');
  const button = (action: string) =>
    popover()?.querySelector<HTMLButtonElement>(`[data-action="${action}"]`);
  const altEnter = async () => {
    editor.view.dom.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        altKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    await advance();
    await advance();
  };
  return { fixture, component, editor, popover, button, altEnter };
}

describe('the writing popover', () => {
  afterEach(() => {
    document
      .querySelectorAll('[data-slot="writing-popover"]')
      .forEach((e) => e.closest('.cdk-overlay-pane')?.remove());
  });

  it('opens at a finding with Alt+Enter, focused on Replace, and Replace puts the fix in', async () => {
    const { editor, popover, button, altEnter } = await render(
      doc(p('Plug in the loader.', 'a')),
    );
    const [f] = writingFindings(editor.state);
    editor.commands.focus();
    editor.commands.setTextSelection(f!.from + 2);
    await altEnter();
    expect(popover()?.getAttribute('role')).toBe('dialog');
    expect(popover()?.textContent).toContain('Warning');
    expect(popover()?.textContent).toContain('“loader” is a forbidden term.');
    expect(popover()?.textContent).toContain('charger');
    expect(document.activeElement).toBe(button('replace'));
    button('replace')!.click();
    await advance();
    expect(editor.state.doc.textContent).toBe('Plug in the charger.');
    expect(document.activeElement).toBe(editor.view.dom);
    editor.commands.undo();
    expect(editor.state.doc.textContent).toBe('Plug in the loader.');
  });

  it('ignores a finding here, and Escape closes it with the focus back in the text', async () => {
    const { editor, popover, button, altEnter } = await render(
      doc(p('Plug in the loader.', 'a')),
    );
    const [f] = writingFindings(editor.state);
    editor.commands.focus();
    editor.commands.setTextSelection(f!.from + 1);
    await altEnter();
    popover()!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
    await advance(200);
    expect(document.activeElement).toBe(editor.view.dom);
    await altEnter();
    button('ignore')!.click();
    await advance();
    expect(writingFindings(editor.state)).toEqual([]);
    expect(editor.state.doc.textContent).toBe('Plug in the loader.');
  });

  it('stays the keyboard’s once opened: the caret’s pending peek does not take it over, and Escape still gives the focus back', async () => {
    const { editor, popover, button, altEnter } = await render(
      doc(p('Plug in the loader.', 'a')),
    );
    const [f] = writingFindings(editor.state);
    editor.view.focus();
    // The caret moved into the finding starts a peek; Alt+Enter comes before it is due.
    editor.commands.setTextSelection(f!.from + 2);
    await altEnter();
    expect(document.activeElement).toBe(button('replace'));
    await advance(PEEK_MS + 50);
    expect(document.activeElement).toBe(button('replace'));
    popover()!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
    await advance(200);
    expect(popover()).toBeNull();
    expect(document.activeElement).toBe(editor.view.dom);
  });

  it('shows a style rule’s message as text, never as markup', async () => {
    const { editor, popover, altEnter } = await render(
      doc(p('Keep it in a dry place.', 'a')),
    );
    const [f] = writingFindings(editor.state);
    editor.commands.focus();
    editor.commands.setTextSelection(f!.from + 1);
    await altEnter();
    expect(popover()?.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(popover()?.querySelector('img')).toBeNull();
  });

  it('peeks at a linked term’s definition when the caret rests in it, without taking the focus', async () => {
    const { editor, popover } = await render(
      doc({
        type: 'paragraph',
        attrs: { id: 'a' },
        content: [
          { type: 'text', text: 'Use the ' },
          {
            type: 'text',
            text: 'charger',
            marks: [{ type: 'term', attrs: { termId: 'charger' } }],
          },
          { type: 'text', text: '.' },
        ],
      }),
    );
    editor.view.focus();
    editor.commands.setTextSelection(12);
    await advance(PEEK_MS + 10);
    expect(popover()?.textContent).toContain('Term link');
    expect(popover()?.textContent).toContain(
      'The unit that charges <b>the</b> battery.',
    );
    expect(popover()?.querySelector('b')).toBeNull();
    expect(document.activeElement).toBe(editor.view.dom);
  });

  it('offers Apply and Dismiss for a page suggestion marked in the text', async () => {
    const { fixture, component, editor, button, altEnter } = await render(
      doc(p('Open the valve in order to drain.', 'a')),
    );
    const actions: unknown[] = [];
    component.suggestionAction.subscribe((a) => actions.push(a));
    fixture.componentRef.setInput('suggestionMarks', [
      {
        id: 's1',
        blockId: 'a',
        field: 'content',
        start: 15,
        end: 26,
        expected: 'Open the valve in order to drain.',
        message: 'Shorter.',
        original: 'in order to',
        replacement: 'to',
      },
    ]);
    await advance(DEBOUNCE_MS + 10);
    expect(
      editor.view.dom.querySelector('.doc-editor-suggestion-mark')?.textContent,
    ).toBe('in order to');
    editor.commands.focus();
    editor.commands.setTextSelection(18);
    await altEnter();
    button('apply')!.click();
    await advance();
    expect(actions).toEqual([{ id: 's1', action: 'apply' }]);
  });
});
