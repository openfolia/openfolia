import { TestBed } from '@angular/core/testing';
import type { JSONContent } from '@tiptap/core';
import { regionFromEditor } from '@openfolia/content-editor-model';
import { provideZard } from '@openfolia/ui/core';

import { BlockEditorComponent } from './block-editor.component';
import { REGION_PLACEHOLDER_KEYS } from './inline/placeholders';
import { REGION_SLASH_ITEMS } from './slash/slash-items';
import { doc } from './testing/test-editor';

// A page design region's editor (#393): placeholders as chips, typed in with `{` from the keys
// a region may hold, and the blocks a region takes.

const withPlaceholders = (...keys: string[]): JSONContent =>
  doc({
    type: 'paragraph',
    attrs: { id: 'note' },
    content: [
      { type: 'text', text: 'Version ' },
      ...keys.map((key) => ({ type: 'placeholder', attrs: { key } })),
    ],
  });

async function render(value: JSONContent, region = true) {
  TestBed.configureTestingModule({ providers: [provideZard()] });
  const fixture = TestBed.createComponent(BlockEditorComponent);
  fixture.componentRef.setInput('value', value);
  fixture.componentRef.setInput('region', region);
  const changes: JSONContent[] = [];
  fixture.componentInstance.changed.subscribe((d) => changes.push(d));
  await fixture.whenStable();
  const el = fixture.nativeElement as HTMLElement;
  const editor = fixture.componentInstance.editor!;
  // The suggestion plugin resolves its items asynchronously.
  const stable = async () => {
    await new Promise((resolve) => setTimeout(resolve));
    fixture.detectChanges();
    await fixture.whenStable();
  };
  return { el, editor, changes, stable };
}

type TestEditor = NonNullable<BlockEditorComponent['editor']>;

/** Typed text, the way the view hands it on: through the text input handlers, then inserted. */
function type(editor: TestEditor, text: string) {
  const { view } = editor;
  for (const char of text) {
    const { from, to } = view.state.selection;
    const handled = view.someProp('handleTextInput', (f) =>
      f(view, from, to, char, () => view.state.tr.insertText(char, from, to)),
    );
    if (!handled) view.dispatch(view.state.tr.insertText(char, from, to));
  }
}

/** Puts the caret at the end of the first paragraph and types `text` there. */
function typeAtEnd(editor: TestEditor, text: string) {
  const first = editor.state.doc.firstChild!;
  editor.commands.setTextSelection(1 + first.content.size);
  type(editor, text);
}

describe('a region’s editor (#393)', () => {
  it('shows a placeholder as a chip with its name, and flags one that is no placeholder', async () => {
    const { el } = await render(withPlaceholders('product-version', 'serial'));
    const chips = el.querySelectorAll<HTMLElement>('[data-node="placeholder"]');
    expect(chips).toHaveLength(2);
    expect(chips[0]!.textContent).toBe('Product version');
    expect(chips[0]!.classList.contains('doc-editor-issue')).toBe(false);
    expect(chips[1]!.textContent).toContain('{serial}');
    expect(chips[1]!.classList.contains('doc-editor-issue')).toBe(true);
    expect(chips[1]!.title).toBe('Not a placeholder: serial');
  });

  it('opens the placeholders on “{”, without the page keys, and puts the chosen one in', async () => {
    const { el, editor, changes, stable } = await render(withPlaceholders());
    typeAtEnd(editor, '{');
    await stable();
    const menu = el.querySelector('of-slash-menu [role="listbox"]');
    expect(menu?.getAttribute('aria-label')).toBe('Insert a placeholder');
    const rows = [...el.querySelectorAll('of-slash-menu [role="option"]')];
    expect(rows).toHaveLength(REGION_PLACEHOLDER_KEYS.length);
    const labels = rows.map((r) => r.textContent ?? '');
    expect(labels.some((l) => l.includes('Product version'))).toBe(true);
    expect(labels.some((l) => l.includes('Page number'))).toBe(false);

    // Filtered by what follows the brace, then chosen with Enter.
    type(editor, 'vers');
    await stable();
    const filtered = [
      ...el.querySelectorAll('of-slash-menu [role="option"]'),
    ].map((r) => r.textContent ?? '');
    expect(filtered[0]).toContain('Product version');
    editor.view.dom.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
    );
    await stable();
    const blocks = regionFromEditor(changes.at(-1));
    expect(blocks).toEqual([
      {
        type: 'paragraph',
        id: 'note',
        content: [
          { type: 'text', text: 'Version ' },
          { type: 'placeholder', key: 'product-version' },
        ],
      },
    ]);
    expect(el.querySelector('of-slash-menu [role="listbox"]')).toBe(null);
  });

  it('leaves “{” a plain character in a module’s editor', async () => {
    const { el, editor, stable } = await render(withPlaceholders(), false);
    typeAtEnd(editor, '{');
    await stable();
    expect(el.querySelector('of-slash-menu [role="listbox"]')).toBe(null);
  });

  it('offers the blocks a region takes, and Heading 1 only', async () => {
    expect(REGION_SLASH_ITEMS.map((i) => i.id)).toEqual([
      'paragraph',
      'heading1',
      'bulletList',
      'orderedList',
      'image',
      'admonition',
      'link',
      'placeholder',
    ]);
    const { el, editor, stable } = await render(withPlaceholders());
    typeAtEnd(editor, ' /');
    await stable();
    const ids = [...el.querySelectorAll('of-slash-menu [role="option"]')].map(
      (r) => r.textContent ?? '',
    );
    expect(ids.some((l) => l.includes('Heading 1'))).toBe(true);
    expect(ids.some((l) => l.includes('Heading 2'))).toBe(false);
    expect(ids.some((l) => l.includes('Table'))).toBe(false);
  });

  it('offers no callout reference, and its images no callout editor (#547)', async () => {
    expect(REGION_SLASH_ITEMS.map((i) => i.id)).not.toContain('calloutRef');
    const image: JSONContent = {
      type: 'image',
      attrs: { id: 'logo', asset: `sha256:${'a'.repeat(64)}`, alt: 'Logo' },
    };
    const inRegion = await render(doc(image));
    expect(inRegion.el.querySelector('[data-slot="callout-panel"]')).toBeNull();
    TestBed.resetTestingModule();
    const inModule = await render(doc(image), false);
    expect(
      inModule.el.querySelector('[data-slot="callout-panel"]'),
    ).not.toBeNull();
  });
});
