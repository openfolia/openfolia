import { TestBed } from '@angular/core/testing';
import { injectTranslate } from '@openfolia/ui/i18n';

import {
  blocks,
  doc,
  insideText,
  list,
  p,
  sec,
  testEditor,
} from '../testing/test-editor';
import { CaretGaps } from '../plugins/caret-gaps';
import {
  SlashCommand,
  type SlashMenuState,
  type SlashMenuView,
} from './slash-command';
import {
  FOCUSED_SLASH_ITEMS,
  filterSlashItems,
  INLINE_SLASH_ITEMS,
  SLASH_ITEMS,
} from './slash-items';

class FakeMenu implements SlashMenuView {
  state: SlashMenuState | null = null;
  opened = 0;
  open(state: SlashMenuState) {
    this.opened += 1;
    this.state = state;
  }
  update(state: SlashMenuState) {
    this.state = state;
  }
  keyDown() {
    return false;
  }
  close() {
    this.state = null;
  }
}

/** The suggestion plugin resolves its items asynchronously. */
const settle = () => new Promise((resolve) => setTimeout(resolve));

/** The labels as an English reader sees them (the test providers load the English texts). */
const labels = (query: string) => {
  const t = TestBed.runInInjectionContext(() => injectTranslate());
  return filterSlashItems(SLASH_ITEMS, query, (key, params) =>
    t(key, params),
  ).map((item) => t(item.label, item.labelParams));
};

describe('filtering the slash menu', () => {
  it('keeps every item in order for an empty query', () => {
    expect(labels('')).toHaveLength(SLASH_ITEMS.length);
  });

  it('ranks a label that starts with the query first', () => {
    expect(labels('hea')).toEqual([
      'Heading 1',
      'Heading 2',
      'Heading 3',
      'Heading 4',
      'Heading 5',
    ]);
    expect(labels('lis')[0]).toBe('Bulleted list');
  });

  it('finds an item by a search term', () => {
    expect(labels('sec')).toEqual(['Heading 1', 'Heading 2', 'Heading 3']);
    expect(labels('h2')).toEqual(['Heading 2']);
    expect(labels('ol')).toEqual(['Numbered list']);
  });

  it('finds nothing for nonsense', () => {
    expect(labels('zzz')).toEqual([]);
  });
});

describe('the slash command', () => {
  function setup() {
    const menu = new FakeMenu();
    const editor = testEditor(doc(p('intro'), p()), [
      CaretGaps,
      SlashCommand.configure({ view: menu }),
    ]);
    editor.commands.setTextSelection(editor.state.doc.content.size - 1);
    return { menu, editor };
  }

  it('opens the menu on a slash and filters as the query is typed', async () => {
    const { menu, editor } = setup();
    editor.commands.insertContent('/');
    await settle();
    expect(menu.opened).toBe(1);
    // Heading 4 and 5 are past the default cap of 3; an image, an attachment and a snippet need
    // the page's dialogs, which this editor has not (`image-node.spec.ts`,
    // `attachment-node.spec.ts`, `doc-blocks.spec.ts`); a
    // step's result only in a procedure; the inline types need the block editor's popover,
    // which a bare editor has not.
    const ids = menu.state?.items.map((item) => item.id);
    expect(ids).not.toContain('heading4');
    expect(ids).not.toContain('image');
    expect(ids).not.toContain('attachment');
    expect(ids).not.toContain('snippet');
    expect(ids).not.toContain('stepResult');
    expect(ids).not.toContain('xref');
    expect(menu.state?.items.length).toBe(
      SLASH_ITEMS.length - 6 - INLINE_SLASH_ITEMS.length,
    );
    editor.commands.insertContent('num');
    await settle();
    expect(menu.state?.query).toBe('num');
    expect(menu.state?.items.map((item) => item.id)).toEqual(['orderedList']);
  });

  it('replaces the typed query with the chosen block', async () => {
    const { menu, editor } = setup();
    editor.commands.insertContent('/head');
    await settle();
    const item = menu.state!.items.find((i) => i.id === 'heading1')!;
    menu.state!.choose(item);
    expect(blocks(editor)).toEqual(['p:intro', 's:[]']);
    expect(editor.state.selection.$from.parent.type.name).toBe('title');
    expect(menu.state).toBeNull();
  });

  it('inserts every block it offers', async () => {
    const expected: Record<string, string> = {
      paragraph: 'p:',
      heading1: 's:[]',
      bulletList: 'list:',
      orderedList: 'list:',
      table: 'table:',
      safety: 'safety:',
      variant: 'variant:',
      moduleRef: 'ref',
    };
    const offered = SLASH_ITEMS.filter((item) => item.id in expected);
    expect(offered).toHaveLength(Object.keys(expected).length);
    for (const item of offered) {
      const { menu, editor } = setup();
      editor.commands.insertContent('/');
      await settle();
      expect(menu.state!.reasons.has(item.id)).toBe(false);
      menu.state!.choose(item);
      expect(editor.getText()).not.toContain('/');
      expect(blocks(editor)[1]).toBe(expected[item.id]);
    }
  });

  it('stays a plain character outside a paragraph', async () => {
    const menu = new FakeMenu();
    const editor = testEditor(doc(list(false, 'item')), [
      SlashCommand.configure({ view: menu }),
    ]);
    editor.commands.setTextSelection(insideText(editor, 'item') + 4);
    editor.commands.insertContent('/');
    await settle();
    expect(menu.opened).toBe(0);
  });

  it("offers only a step's result in a procedure step's text, and adds it there", async () => {
    const menu = new FakeMenu();
    const editor = testEditor(
      doc({
        type: 'procedure',
        content: [
          { type: 'title', content: [{ type: 'text', text: 'T' }] },
          {
            type: 'listItem',
            content: [
              { type: 'itemText', content: [{ type: 'text', text: 'step' }] },
            ],
          },
        ],
      }),
      [SlashCommand.configure({ view: menu })],
    );
    // At the start of the step's text (a slash after a word is text).
    editor.commands.setTextSelection(insideText(editor, 'step'));
    editor.commands.insertContent('/');
    await settle();
    expect(menu.state?.items.map((item) => item.id)).toEqual(['stepResult']);
    menu.state!.choose(menu.state!.items[0]!);
    await settle();
    const step = editor.state.doc.child(0).child(1);
    expect(step.child(0).textContent).toBe('step');
    expect(step.child(1).type.name).toBe('paragraph');
    expect(editor.state.selection.$from.parent).toBe(step.child(1));
  });

  it('shows the headings disabled, with the reason, where no section may stand', async () => {
    const menu = new FakeMenu();
    const editor = testEditor(
      doc({
        type: 'list',
        content: [
          {
            type: 'listItem',
            content: [{ type: 'itemText' }, p('inside ')],
          },
        ],
      }),
      [SlashCommand.configure({ view: menu })],
    );
    editor.commands.setTextSelection(insideText(editor, 'inside ') + 7);
    editor.commands.insertContent('/');
    await settle();
    expect(menu.opened).toBe(1);
    expect(menu.state?.reasons.get('heading1')?.key).toBe(
      'editor.docEditor.heading.notHere',
    );
    // Choosing it does nothing.
    const before = editor.getJSON();
    menu.state!.choose(menu.state!.items.find((i) => i.id === 'heading1')!);
    expect(editor.getJSON()).toEqual(before);
  });

  it('offers the next level in a section, and shows a skipped one disabled', async () => {
    const menu = new FakeMenu();
    const editor = testEditor(doc(sec('Top', p('body'), p())), [
      SlashCommand.configure({ view: menu }),
    ]);
    editor.commands.setTextSelection(editor.state.doc.content.size - 2);
    editor.commands.insertContent('/');
    await settle();
    const reasons = menu.state!.reasons;
    expect(reasons.has('heading1')).toBe(false);
    expect(reasons.has('heading2')).toBe(false);
    expect(reasons.get('heading3')).toEqual({
      key: 'editor.docEditor.heading.skip',
      params: { parent: 2, max: 3 },
    });
    menu.state!.choose(menu.state!.items.find((i) => i.id === 'heading2')!);
    expect(blocks(editor)).toEqual(['s:Top[p:body, s:[]]']);
  });

  it('does nothing without a menu', () => {
    const editor = testEditor(doc(p()), [SlashCommand]);
    editor.commands.insertContent('/head');
    expect(editor.getText()).toBe('/head');
  });
});

describe('the focused editor’s items (#137)', () => {
  it('are text, the two lists, links, images and attachments: no variants, references or tables', () => {
    expect(FOCUSED_SLASH_ITEMS.map((item) => item.id).sort()).toEqual([
      'attachment',
      'bulletList',
      'image',
      'link',
      'orderedList',
      'paragraph',
    ]);
  });
});
