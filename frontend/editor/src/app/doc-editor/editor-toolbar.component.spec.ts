import { TestBed } from '@angular/core/testing';
import type { JSONContent } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';
import type { ProjectConfig } from '@openfolia/content-model/core';
import { provideZard } from '@openfolia/ui/core';

import { BlockEditorComponent } from './block-editor.component';
import { doc, p, sec } from './testing/test-editor';
import { advance } from '../testing/fake-time';

// jsdom lays nothing out and its ranges have no rectangles; ProseMirror asks for them when a
// command focuses the editor and scrolls the caret into view.
beforeAll(() => {
  const proto = Range.prototype as Partial<Range>;
  proto.getClientRects ??= () => [] as unknown as DOMRectList;
  proto.getBoundingClientRect ??= () => new DOMRect();
});

async function render(value: JSONContent, maxHeadingLevel?: number) {
  // Fake time: the editor, its menus and change detection run on timers; a fixed real wait
  // ends before they have run on a busy machine (#562).
  vi.useFakeTimers();
  TestBed.configureTestingModule({ providers: [provideZard()] });
  const fixture = TestBed.createComponent(BlockEditorComponent);
  fixture.componentRef.setInput('value', value);
  if (maxHeadingLevel !== undefined)
    fixture.componentRef.setInput('blocks', {
      config: { maxHeadingLevel } as ProjectConfig,
    });
  await advance();
  const editor = fixture.componentInstance.editor!;
  const el = fixture.nativeElement as HTMLElement;
  /** Runs what is due within 30 ms of the fake clock (the menus' and the editor's own
   * timers), then renders. */
  const settle = () => advance(30);
  /** The caret into the text block with this text. */
  const caret = async (text: string) => {
    let at = -1;
    editor.state.doc.descendants((node, pos) => {
      if (at >= 0) return false;
      if (node.isTextblock && node.textContent === text) at = pos + 1;
      return at < 0;
    });
    editor.view.dispatch(
      editor.state.tr.setSelection(TextSelection.create(editor.state.doc, at)),
    );
    await settle();
  };
  const picker = () =>
    el.querySelector<HTMLButtonElement>(
      '[role="toolbar"] button[aria-label="Text style"]',
    )!;
  /** The picker's items: their text, whether disabled, as a reader sees them. */
  const open = async () => {
    picker().focus();
    picker().click();
    await settle();
    return [
      ...document.querySelectorAll<HTMLElement>(
        '[role="menu"] [data-slot="dropdown-menu-item"]',
      ),
    ];
  };
  /** Closes it again: the trigger toggles it. */
  const close = async () => {
    picker().click();
    await settle();
  };
  return { editor, el, caret, picker, open, close, settle };
}

/** An item's texts (label, key, reason), each on its own, joined by a space. */
const text = (item: HTMLElement) =>
  [...item.querySelectorAll('span, kbd')]
    .filter((el) => el.children.length === 0)
    .map((el) => el.textContent?.trim())
    .filter(Boolean)
    .join(' ');

describe('the toolbar’s text style picker', () => {
  it('shows the level at the caret and offers Text and Heading 1 to the cap', async () => {
    const view = await render(doc(p('intro'), sec('Alpha', p('body'))), 2);
    await view.caret('Alpha');
    expect(view.picker().textContent?.trim()).toBe('Heading 1');
    await view.caret('intro');
    expect(view.picker().textContent?.trim()).toBe('Text');

    const items = await view.open();
    expect(items.map(text)).toEqual([
      'Text',
      'Heading 1',
      'Heading 2 Needs a Heading 1 around the caret first.',
    ]);
    expect(items.map((i) => i.getAttribute('aria-disabled'))).toEqual([
      'false',
      'false',
      'true',
    ]);
    await view.close();
  });

  it('changes the text at the caret into the level chosen', async () => {
    const view = await render(doc(sec('Alpha', p('body'))));
    await view.caret('body');
    const items = await view.open();
    // In a Heading 1, a Heading 2 is the next level; the default cap is 3.
    expect(items.map(text)).toEqual([
      'Text',
      'Heading 1',
      'Heading 2',
      'Heading 3 Needs a Heading 2 around the caret first.',
    ]);
    items[2]!.click();
    await view.settle();
    expect(view.picker().textContent?.trim()).toBe('Heading 2');
    const section = view.editor.state.doc.child(0);
    expect(section.child(1).type.name).toBe('section');
    expect(section.child(1).firstChild?.textContent).toBe('body');
  });

  it('in a heading, offers a level down and up, disabled with the reason', async () => {
    const view = await render(doc(sec('Alpha'), sec('Beta')));
    await view.caret('Alpha');
    let items = await view.open();
    expect(items.slice(-2).map(text)).toEqual([
      'Level down Tab Needs a heading at its level before it to go under.',
      'Level up Shift+Tab Already a Heading 1.',
    ]);
    await view.close();

    await view.caret('Beta');
    items = await view.open();
    expect(items.at(-2)?.getAttribute('aria-disabled')).toBe('false');
    items.at(-2)!.click();
    await view.settle();
    expect(view.picker().textContent?.trim()).toBe('Heading 2');
    expect(view.editor.state.doc.childCount).toBe(1);
  });
});

describe('the toolbar’s Insert menu', () => {
  /** Opens the menu by its button; its groups and entries as a reader sees them. */
  const openInsert = async (view: Awaited<ReturnType<typeof render>>) => {
    const button = view.el.querySelector<HTMLButtonElement>(
      '[data-testid="insert-menu"]',
    )!;
    button.click();
    await view.settle();
    const panel = document.querySelector<HTMLElement>(
      '[data-slot="popover-content"]',
    )!;
    return {
      panel,
      groups: () =>
        [...panel.querySelectorAll('[data-slot="command-group-heading"]')].map(
          (h) => h.textContent?.trim(),
        ),
      entry: (id: string) =>
        panel.querySelector<HTMLElement>(
          `[data-insert="${id}"] [role="option"]`,
        )!,
    };
  };

  it('holds every block in groups, the same list as the slash menu, one line of toolbar', async () => {
    const view = await render(doc(p('intro')));
    await view.caret('intro');
    const menu = await openInsert(view);
    expect(menu.groups()).toEqual(['Content', 'Notices', 'Structure']);
    for (const id of [
      'table',
      'image',
      'literal',
      'attachment',
      'safety',
      'admonition',
      'procedure',
      'variant',
      'moduleRef',
      'pageBreak',
    ])
      expect(menu.entry(id), id).not.toBeNull();
    // No pills left in the toolbar: Insert is the one way in.
    expect(
      view.el.querySelector('[role="toolbar"] .bg-warning-muted'),
    ).toBeNull();
    // Without the page's image picker, Image is there, disabled, with the reason.
    expect(menu.entry('image').getAttribute('aria-disabled')).toBe('true');
    expect(menu.entry('image').textContent).toContain(
      'Inserting an image is not available here',
    );
  });

  it('inserts what is chosen at the caret', async () => {
    const view = await render(doc(p('intro')));
    await view.caret('intro');
    const menu = await openInsert(view);
    menu.entry('admonition').click();
    await view.settle();
    expect(
      view.editor.state.doc.content.content.some(
        (n) => n.type.name === 'admonition',
      ),
    ).toBe(true);
  });

  it('shows a table disabled inside a table, with the reason', async () => {
    const inTable = await render({
      type: 'doc',
      content: [
        {
          type: 'table',
          attrs: { header: false, columns: [{ width: 1 }] },
          content: [
            {
              type: 'tableRow',
              content: [{ type: 'tableCell', content: [p('cell')] }],
            },
          ],
        },
      ],
    });
    await inTable.caret('cell');
    const menu = await openInsert(inTable);
    expect(menu.entry('table').getAttribute('aria-disabled')).toBe('true');
    expect(menu.entry('table').textContent).toContain(
      "A table can't hold a table",
    );
  });

  it('opens from the text with Ctrl+Shift+Enter, its search focused', async () => {
    const view = await render(doc(p('intro')));
    await view.caret('intro');
    view.editor.commands.keyboardShortcut('Mod-Shift-Enter');
    await view.settle();
    const input = document.querySelector<HTMLInputElement>(
      '[data-slot="popover-content"] input',
    );
    expect(input).not.toBeNull();
    expect(document.activeElement).toBe(input);
  });
});

describe('the toolbar’s table menu at the caps (#686)', () => {
  /** A table of `columns` columns and one row, each cell holding its column's number. */
  const tableOf = (columns: number): JSONContent => ({
    type: 'doc',
    content: [
      {
        type: 'table',
        attrs: {
          header: false,
          columns: Array.from({ length: columns }, () => ({ width: 1 })),
        },
        content: [
          {
            type: 'tableRow',
            content: Array.from({ length: columns }, (_c, c) => ({
              type: 'tableCell',
              content: [p(`cell ${c + 1}`)],
            })),
          },
        ],
      },
    ],
  });

  /** Opens the table menu: its items by label, whether disabled, and the reason it gives. */
  const openTableMenu = async (view: Awaited<ReturnType<typeof render>>) => {
    const trigger = view.el.querySelector<HTMLButtonElement>(
      '[role="toolbar"] button[aria-label="Table actions"]',
    )!;
    trigger.focus();
    trigger.click();
    await view.settle();
    const items = [
      ...document.querySelectorAll<HTMLElement>(
        '[role="menu"] [data-slot="dropdown-menu-item"]',
      ),
    ];
    return {
      disabled: (label: string) =>
        items
          .find((i) => i.textContent?.trim() === label)
          ?.getAttribute('aria-disabled'),
      reason: () =>
        document
          .querySelector('[role="menu"] [data-testid="table-cap-reason"]')
          ?.textContent?.trim(),
    };
  };

  it('disables adding a column at 1,000 columns, and says why', async () => {
    const view = await render(tableOf(1_000));
    await view.caret('cell 1000');
    const menu = await openTableMenu(view);
    expect(menu.disabled('Insert column before')).toBe('true');
    expect(menu.disabled('Insert column after')).toBe('true');
    // A row still fits: 2,000 cells.
    expect(menu.disabled('Insert row below')).toBe('false');
    expect(menu.reason()).toBe(
      'A table has at most 1,000 columns: no more can be added.',
    );
  });

  it('offers every action below the caps, with no reason', async () => {
    const view = await render(tableOf(999));
    await view.caret('cell 999');
    const menu = await openTableMenu(view);
    expect(menu.disabled('Insert column after')).toBe('false');
    expect(menu.disabled('Insert row below')).toBe('false');
    expect(menu.reason()).toBeUndefined();
  });
});
