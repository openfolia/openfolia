import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { Editor } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';
import { normalizeEditorDoc } from '@openfolia/content-editor-model';
import type { Block, Module } from '@openfolia/content-model/core';

import { routes } from '../app.routes';
import { BlockEditorComponent } from './block-editor.component';
import { DocEditorPage } from './doc-editor.page';
import { blockDragKey } from './plugins/block-drag';
import { SAMPLE_MODULE } from './sample-module';
import { layOutRows } from './testing/lay-out';

// jsdom lays nothing out and its ranges have no rectangles; ProseMirror asks for them when a
// command focuses the editor and scrolls the caret into view (after the step that ran it).
beforeAll(() => {
  const proto = Range.prototype as Partial<Range>;
  proto.getClientRects ??= () => [] as unknown as DOMRectList;
  proto.getBoundingClientRect ??= () => new DOMRect();
});

async function render() {
  TestBed.configureTestingModule({ providers: [provideRouter([])] });
  const fixture = TestBed.createComponent(DocEditorPage);
  await fixture.whenStable();
  const host = fixture.debugElement.query(
    (de) => de.componentInstance instanceof BlockEditorComponent,
  ).componentInstance as BlockEditorComponent;
  const el = fixture.nativeElement as HTMLElement;
  return { fixture, el, editor: host.editor! };
}

const panel = (el: HTMLElement, id: string) =>
  el.querySelector(`[data-testid="${id}"]`)?.textContent ?? '';

const shownModel = (el: HTMLElement) =>
  JSON.parse(panel(el, 'doc-model')) as Module;

/** The suggestion plugin resolves its items asynchronously. */
const settle = () => new Promise((resolve) => setTimeout(resolve));

/** The caret just inside the first text block whose text is `text` (or starts with it). */
function caretInText(editor: Editor, text: string, atEnd = false) {
  let at = -1;
  editor.state.doc.descendants((node, pos) => {
    if (at >= 0) return false;
    if (node.isTextblock && node.textContent.startsWith(text)) {
      at = pos + 1 + (atEnd ? node.content.size : 0);
      return false;
    }
    return true;
  });
  if (at < 0) throw new Error(`no text block "${text}"`);
  editor.view.dispatch(
    editor.state.tr.setSelection(TextSelection.create(editor.state.doc, at)),
  );
}

/** Typed text, the way the view hands it on: through the text input handlers, then inserted. */
function type(editor: Editor, text: string) {
  const { view } = editor;
  for (const char of text) {
    const { from, to } = view.state.selection;
    const handled = view.someProp('handleTextInput', (f) =>
      f(view, from, to, char, () => view.state.tr.insertText(char, from, to)),
    );
    if (!handled) view.dispatch(view.state.tr.insertText(char, from, to));
  }
}

function press(editor: Editor, key: string, init: KeyboardEventInit = {}) {
  editor.view.dom.dispatchEvent(
    new KeyboardEvent('keydown', {
      key,
      bubbles: true,
      cancelable: true,
      ...init,
    }),
  );
}

const t = (text: string) => ({ type: 'text' as const, text });
const blockOf = (id: string) =>
  SAMPLE_MODULE.blocks.find((block) => block.id === id)!;

describe('DocEditorPage', () => {
  it('mounts the editor with the sample, a toolbar and a labelled document', async () => {
    const { el, editor } = await render();
    expect(editor).not.toBeNull();
    expect(
      el.querySelector('[role="toolbar"][aria-label="Formatting"]'),
    ).not.toBeNull();
    const area = el.querySelector('.doc-editor-content')!;
    expect(area.getAttribute('role')).toBe('textbox');
    expect(area.getAttribute('aria-label')).toBe('Playground document');
    expect(el.textContent).toContain('Before you begin');
  });

  it('shows every block type of the sample: editable text or a block drawn by its node view', async () => {
    const { el } = await render();
    const area = el.querySelector('.doc-editor-content')!;
    expect(area.querySelectorAll('section').length).toBe(4);
    expect(
      area.querySelector('[data-node="list"] [data-node="listItem"]'),
    ).not.toBeNull();
    expect(area.querySelector('p')?.textContent).toContain(
      'This guide sets up',
    );
    // The admonition, the procedure and the code block: their content edited in place.
    const tip = area.querySelector('[data-node="admonition"]')!;
    expect(tip.querySelector('[role="note"]')?.getAttribute('aria-label')).toBe(
      'Tip',
    );
    expect(tip.querySelector('.doc-block-content p')).not.toBeNull();
    const steps = area.querySelectorAll(
      '[data-node="procedure"] .doc-block-content > [data-node="listItem"]',
    );
    expect(steps.length).toBe(2);
    const code = area.querySelector('[data-node="literal"]')!;
    expect(
      code.querySelector('[data-testid="code-language"]')?.textContent?.trim(),
    ).toBe('YAML');
    expect(code.querySelector('.doc-block-content')?.textContent).toContain(
      ':',
    );
    // The passthrough: read-only, its format shown, its source behind "Show source".
    const raw = area.querySelector('[data-node="passthrough"]')!;
    expect(raw.getAttribute('contenteditable')).toBe('false');
    expect(raw.querySelector('[data-format]')?.textContent).toBe('html');
    // The documentation blocks, drawn by their node views: the signal word, the condition, the
    // referenced module; the safety notice's and the variant's content edited in place.
    const safety = area.querySelector('[data-node="safety"]')!;
    expect(safety.querySelector('[role="note"]')?.textContent).toContain(
      'WARNING',
    );
    expect(
      safety.querySelector('.doc-block-content [data-node="hazard"]')
        ?.textContent,
    ).toBe('Loose cables on the floor');
    const variant = area.querySelector('[data-node="variant"]')!;
    expect(variant.querySelector('[data-chip]')?.textContent).toContain(
      'large',
    );
    expect(variant.querySelector('.doc-block-content p')?.textContent).toBe(
      'Large editions also show a dashboard.',
    );
    const ref = area.querySelector('[data-node="moduleRef"]')!;
    expect(ref.getAttribute('contenteditable')).toBe('false');
    // Its title, read through the page.
    expect(ref.textContent).toContain('Shared footer');
  });

  it('shows the content model, exactly the sample, before anything is edited', async () => {
    const { el } = await render();
    expect(shownModel(el)).toEqual(SAMPLE_MODULE);
    expect(panel(el, 'doc-json')).toContain('"moduleId": "getting-started"');
  });

  it('changes only what was edited: typing, Enter, Alt+Up, the slash menu, a drag and undo', async () => {
    const { fixture, el, editor } = await render();
    const step = async (expected: Block[]) => {
      await fixture.whenStable();
      const model = shownModel(el);
      expect(model).toEqual({ ...SAMPLE_MODULE, blocks: expected });
      // What the editor holds is already what the repair step would make of it.
      const json = editor.getJSON();
      expect(normalizeEditorDoc(json)).toEqual(json);
      return model;
    };
    const [intro, safety, before, setup, next] = SAMPLE_MODULE.blocks as [
      Block & { type: 'paragraph' },
      Block,
      Block,
      Block,
      Block,
    ];

    // Typing at the end of the first paragraph changes its last run, nothing else.
    caretInText(editor, 'This guide', true);
    type(editor, ' Welcome.');
    const typed: Block = {
      ...intro,
      content: [
        ...intro.content.slice(0, -1),
        t(
          ' on an empty line to insert a block, and drag a block by its grip. Welcome.',
        ),
      ],
    };
    await step([typed, safety, before, setup, next]);

    // Enter makes a new paragraph with an ID of its own.
    press(editor, 'Enter');
    type(editor, 'Fresh line');
    let model = await step([
      typed,
      expect.objectContaining({
        type: 'paragraph',
        content: [t('Fresh line')],
      }),
      safety,
      before,
      setup,
      next,
    ]);
    const fresh = model.blocks[1]!;
    expect(new Set(collectIds(model.blocks)).size).toBe(
      collectIds(model.blocks).length,
    );
    expect(collectIds(SAMPLE_MODULE.blocks)).not.toContain(fresh.id);

    // Alt+Up moves it above the first paragraph.
    press(editor, 'ArrowUp', { altKey: true });
    await step([fresh, typed, safety, before, setup, next]);

    // The slash menu on a new line: a bulleted list, typed into.
    press(editor, 'Enter');
    type(editor, '/bul');
    await settle();
    await fixture.whenStable();
    expect(el.querySelector('[role="listbox"]')?.textContent).toContain(
      'Bulleted list',
    );
    press(editor, 'Enter');
    type(editor, 'Point');
    model = await step([
      fresh,
      expect.objectContaining({
        type: 'list',
        ordered: false,
        items: [expect.objectContaining({ content: [t('Point')], blocks: [] })],
      }),
      typed,
      safety,
      before,
      setup,
      next,
    ]);
    const list = model.blocks[1]!;
    expect(new Set(collectIds(model.blocks)).size).toBe(
      collectIds(model.blocks).length,
    );

    // A drag by the grip: the last section goes above the one before it.
    const { view } = editor;
    const nextPos =
      view.state.doc.content.size - view.state.doc.lastChild!.nodeSize;
    const setupPos =
      nextPos - view.state.doc.child(view.state.doc.childCount - 2).nodeSize;
    view.dispatch(view.state.tr.setMeta(blockDragKey, { hoverPos: nextPos }));
    layOutRows(view);
    const topOf = (pos: number) =>
      (view.nodeDOM(pos) as Element).getBoundingClientRect().top;
    const grip = view.dom.querySelector('[data-testid="block-grip"]')!;
    const start = topOf(nextPos) + 10;
    grip.dispatchEvent(
      new MouseEvent('pointerdown', {
        bubbles: true,
        clientY: start,
        button: 0,
      }),
    );
    // Its copy's top at the top of the section before it.
    const y = start - (topOf(nextPos) - topOf(setupPos));
    window.dispatchEvent(new MouseEvent('pointermove', { clientY: y }));
    window.dispatchEvent(new MouseEvent('pointerup', { clientY: y }));
    await step([fresh, list, typed, safety, before, next, setup]);

    // Undo, from the toolbar, takes back the drag and only the drag.
    const undo = el.querySelector<HTMLButtonElement>(
      '[role="toolbar"] button[aria-label="Undo"]',
    )!;
    undo.click();
    await step([fresh, list, typed, safety, before, setup, next]);

    // The blocks no step touched came through every step untouched.
    for (const id of ['unplug-first', 'next-shared', 'next-raw']) {
      expect(JSON.stringify(shownModel(el))).toContain(
        JSON.stringify(blockOfDeep(id)),
      );
    }
  });

  it('says why a heading can’t go where it is dragged, and leaves the module as it was', async () => {
    const { fixture, el, editor } = await render();
    const { view } = editor;
    const nextPos =
      view.state.doc.content.size - view.state.doc.lastChild!.nodeSize;
    let itemPos = -1;
    view.state.doc.descendants((node, pos) => {
      if (node.attrs['id'] === 'before-tools') itemPos = pos;
      return itemPos < 0;
    });
    view.dispatch(view.state.tr.setMeta(blockDragKey, { hoverPos: nextPos }));
    layOutRows(view);
    const topOf = (pos: number) =>
      (view.nodeDOM(pos) as Element).getBoundingClientRect().top;
    const start = topOf(nextPos) + 10;
    view.dom.querySelector('[data-testid="block-grip"]')!.dispatchEvent(
      new MouseEvent('pointerdown', {
        bubbles: true,
        clientY: start,
        button: 0,
      }),
    );
    // The copy's top at the second item of the list in "Before you begin".
    const y = start + topOf(itemPos) - topOf(nextPos);
    window.dispatchEvent(new MouseEvent('pointermove', { clientY: y }));
    const hint = el.querySelector<HTMLElement>(
      '[data-testid="block-drop-hint"]',
    );
    expect(hint?.hidden).toBe(false);
    expect(hint?.textContent).toBe('A heading can’t go inside a list.');
    expect(
      el.querySelector('[data-testid="block-lifted"]')?.classList,
    ).toContain('doc-editor-lifted-refused');
    // The slot stays in the section's own place.
    expect(blockDragKey.getState(view.state)?.drag?.slot).toBe(nextPos);
    window.dispatchEvent(new MouseEvent('pointerup', { clientY: y }));
    await fixture.whenStable();
    expect(el.querySelector('[data-testid="block-lifted"]')).toBeNull();
    expect(shownModel(el)).toEqual(SAMPLE_MODULE);
  });

  it('shows a conversion error with the block it is in, and the model again once fixed', async () => {
    const { fixture, el, editor } = await render();
    caretInText(editor, 'Before you begin');
    const { $from } = editor.state.selection;
    editor.view.dispatch(editor.state.tr.delete($from.start(), $from.end()));
    await fixture.whenStable();
    const error = el.querySelector('[data-testid="doc-model-error"]');
    expect(error?.textContent).toContain('Can’t convert block “before”');
    type(editor, 'Ready');
    await fixture.whenStable();
    expect(el.querySelector('[data-testid="doc-model-error"]')).toBeNull();
    const before = shownModel(el).blocks.find((b) => b.id === 'before');
    expect(before).toEqual({ ...blockOf('before'), title: [t('Ready')] });
  });

  it('hands on the document without the caret gaps', async () => {
    const { fixture, el, editor } = await render();
    // In the editor, a gap stands after the safety notice, before the sections.
    const types: string[] = [];
    editor.state.doc.forEach((n) => types.push(n.type.name));
    expect(types).toEqual([
      'paragraph',
      'safety',
      'paragraph',
      'section',
      'section',
      'section',
    ]);
    caretInText(editor, 'This guide');
    type(editor, 'x');
    await fixture.whenStable();
    const shown = JSON.parse(panel(el, 'doc-json')) as {
      content: { type: string }[];
    };
    expect(shown.content.map((b) => b.type)).toEqual([
      'paragraph',
      'safety',
      'section',
      'section',
      'section',
    ]);
  });
});

describe('the playground route', () => {
  it('is registered in a development build', () => {
    expect(routes.some((r) => r.path === 'doc-editor')).toBe(true);
  });
});

/** Every block and item ID, in document order. */
function collectIds(blocks: readonly Block[]): string[] {
  const out: string[] = [];
  const visit = (block: Block) => {
    out.push(block.id);
    const children: Block[] =
      'blocks' in block
        ? block.blocks
        : block.type === 'table'
          ? block.rows.flatMap((row) =>
              row.cells.flatMap((cell) => cell.blocks),
            )
          : [];
    if (block.type === 'list' || block.type === 'procedure') {
      for (const item of block.type === 'list' ? block.items : block.steps) {
        out.push(item.id);
        item.blocks.forEach(visit);
      }
    }
    children.forEach(visit);
  };
  blocks.forEach(visit);
  return out;
}

/** The sample's block with this ID, at any depth. */
function blockOfDeep(id: string): Block {
  let found: Block | undefined;
  const visit = (block: Block) => {
    if (found) return;
    if (block.id === id) {
      found = block;
      return;
    }
    if ('blocks' in block) block.blocks.forEach(visit);
  };
  SAMPLE_MODULE.blocks.forEach(visit);
  return found!;
}
