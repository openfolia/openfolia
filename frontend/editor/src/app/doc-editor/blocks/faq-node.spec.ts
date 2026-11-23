import { TestBed } from '@angular/core/testing';
import type { JSONContent } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';
import {
  fromEditor,
  normalizeEditorDoc,
  toEditor,
} from '@openfolia/content-editor-model';
import type { Module } from '@openfolia/content-model/core';
import { provideZard } from '@openfolia/ui/core';

import { BlockEditorComponent } from '../block-editor.component';
import { SAMPLE_MODULE } from '../sample-module';
import { withoutCaretGaps } from '../plugins/caret-gaps';
import { SLASH_ITEMS } from '../slash/slash-items';
import { insertFaq } from './doc-blocks';

beforeAll(() => {
  const proto = Range.prototype as Partial<Range>;
  proto.getClientRects ??= () => [] as unknown as DOMRectList;
  proto.getBoundingClientRect ??= () => new DOMRect();
});

const t = (text: string) => ({ type: 'text' as const, text });

const MODULE: Module = {
  ...SAMPLE_MODULE,
  blocks: [
    {
      type: 'paragraph',
      id: 'intro',
      content: [t('Questions people ask.')],
    },
    {
      type: 'faq',
      id: 'overnight',
      question: [
        t('Can I charge '),
        { ...t('overnight'), marks: [{ type: 'emphasis' }] },
        t('?'),
      ],
      blocks: [
        { type: 'paragraph', id: 'overnight-a', content: [t('Yes.')] },
        {
          type: 'list',
          id: 'overnight-list',
          ordered: false,
          items: [
            {
              id: 'overnight-i',
              content: [t('It stops when full.')],
              blocks: [],
            },
          ],
        },
      ],
    },
  ],
};

async function mount(module: Module = MODULE) {
  const fixture = TestBed.createComponent(BlockEditorComponent);
  fixture.componentRef.setInput('value', toEditor(module));
  fixture.componentRef.setInput('blocks', {});
  let last: JSONContent | null = null;
  fixture.componentInstance.changed.subscribe((d) => (last = d));
  await fixture.whenStable();
  const editor = fixture.componentInstance.editor!;
  return {
    fixture,
    editor,
    el: fixture.nativeElement as HTMLElement,
    model: () =>
      fromEditor(
        normalizeEditorDoc(last ?? withoutCaretGaps(editor.getJSON())),
      ),
  };
}

describe('the FAQ entry in the editor', () => {
  beforeEach(() =>
    TestBed.configureTestingModule({ providers: [provideZard()] }),
  );

  it('round-trips unchanged through its node view', async () => {
    const { editor } = await mount();
    expect(
      fromEditor(normalizeEditorDoc(withoutCaretGaps(editor.getJSON()))),
    ).toEqual(MODULE);
  });

  it('draws the question as the first line of the frame, the answer below it, only the content editable', async () => {
    const { el } = await mount();
    const dom = el.querySelector<HTMLElement>('[data-node="faq"]')!;
    expect(dom.querySelector('of-faq-entry')).not.toBeNull();
    const content = dom.querySelector<HTMLElement>('.doc-block-content')!;
    expect(content.dataset['content']).toBe('faq');
    expect(content.firstElementChild?.getAttribute('data-node')).toBe(
      'question',
    );
    expect(content.firstElementChild?.textContent).toBe(
      'Can I charge overnight?',
    );
    expect(dom.hasAttribute('contenteditable')).toBe(false);
    const label = dom.querySelector('of-faq-entry > div')!;
    expect(label.closest('[contenteditable="false"]')).not.toBeNull();
  });

  it('is in the "/" menu as "FAQ entry", in the content group', () => {
    const item = SLASH_ITEMS.find((i) => i.id === 'faq');
    expect(item).toMatchObject({
      label: 'editor.docEditor.slash.faq',
      hint: 'editor.docEditor.slash.faqHint',
      group: 'content',
    });
    expect(item?.terms).toContain('question');
  });

  it('inserts an entry after the block at the caret, the caret in its question, and saves what is typed', async () => {
    const { editor, model } = await mount();
    editor.commands.setTextSelection(3);
    expect(insertFaq(editor.state)).toBe(true);
    insertFaq(editor.state, editor.view.dispatch, editor.view);
    expect(editor.state.selection.$from.parent.type.name).toBe('question');
    editor.commands.insertContent('Does the cold slow it down?');
    // The answer: the paragraph right after the question.
    const $q = editor.state.selection.$from;
    editor.commands.setTextSelection($q.after() + 1);
    expect(editor.state.selection.$from.parent.type.name).toBe('paragraph');
    editor.commands.insertContent('It takes longer.');
    const blocks = model().blocks;
    expect(blocks[1]).toMatchObject({
      type: 'faq',
      question: [t('Does the cold slow it down?')],
      blocks: [{ type: 'paragraph', content: [t('It takes longer.')] }],
    });
    expect(blocks[2]).toMatchObject({ type: 'faq', id: 'overnight' });
  });

  it('takes a new block into its answer, after the question', async () => {
    const { editor } = await mount();
    let question = -1;
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name === 'question') question = pos;
      return question < 0;
    });
    editor.view.dispatch(
      editor.state.tr.setSelection(
        TextSelection.create(editor.state.doc, question + 2),
      ),
    );
    insertFaq(editor.state, editor.view.dispatch, editor.view);
    const outer = editor.state.doc.child(1);
    expect(outer.type.name).toBe('faq');
    const kids: string[] = [];
    outer.forEach((child) => kids.push(child.type.name));
    expect(kids).toEqual(['question', 'faq', 'paragraph', 'list']);
    expect(editor.state.selection.$from.parent.type.name).toBe('question');
    expect(editor.state.selection.$from.node(-1)).toBe(outer.child(1));
  });
});
