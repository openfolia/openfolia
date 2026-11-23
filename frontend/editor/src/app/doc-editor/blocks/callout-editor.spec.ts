import { TestBed } from '@angular/core/testing';
import type { JSONContent } from '@tiptap/core';
import { closeHistory } from '@tiptap/pm/history';
import { NodeSelection, TextSelection } from '@tiptap/pm/state';
import {
  fromEditor,
  normalizeEditorDoc,
  toEditor,
} from '@openfolia/content-editor-model';
import type { Image, Module } from '@openfolia/content-model/core';
import { provideZard } from '@openfolia/ui/core';
import { ToastService } from '@openfolia/ui/toast';

import { BlockEditorComponent } from '../block-editor.component';
import { withoutCaretGaps } from '../plugins/caret-gaps';
import { SAMPLE_MODULE } from '../sample-module';
import { SLASH_ITEMS } from '../slash/slash-items';
import { insideText } from '../testing/test-editor';
import type { DocBlockSettings, VariantPick } from './doc-blocks-context';

// The callout editor on an image block (#547), and callout references in the text: the panel,
// the markers on the picture (jsdom shows no picture: the block says so, and the markers sit on
// nothing, but they are there), and the reference picker.

beforeAll(() => {
  const proto = Range.prototype as Partial<Range>;
  proto.getClientRects ??= () => [] as unknown as DOMRectList;
  proto.getBoundingClientRect ??= () => new DOMRect();
});

const PUMP = `sha256:${'a'.repeat(64)}`;

const IMAGE: Image = {
  type: 'image',
  id: 'pump',
  asset: PUMP,
  alt: 'A pump',
  callouts: [
    {
      id: 'outlet',
      anchor: { x: 0.8, y: 0.5 },
      legend: [{ type: 'text', text: 'Outlet' }],
    },
    {
      id: 'inlet',
      anchor: { x: 0.2, y: 0.5 },
      legend: [{ type: 'text', text: 'Inlet' }],
      when: { op: 'in', attr: 'model', values: ['large'] },
    },
  ],
};

const MODULE: Module = {
  ...SAMPLE_MODULE,
  blocks: [
    IMAGE,
    {
      type: 'paragraph',
      id: 'see',
      content: [
        { type: 'text', text: 'Open the outlet ' },
        { type: 'calloutRef', block: 'pump', callout: 'outlet' },
        { type: 'text', text: ' and the drain ' },
        { type: 'calloutRef', block: 'pump', callout: 'drain' },
        { type: 'text', text: '.' },
      ],
    },
  ],
};

const flush = () => new Promise((resolve) => setTimeout(resolve));

/** The picture is "there" (jsdom loads nothing), so the markers are drawn over it. */
const SHOWN: DocBlockSettings = { imageSource: async () => 'blob:pump' };

async function mount(settings: DocBlockSettings = {}) {
  const fixture = TestBed.createComponent(BlockEditorComponent);
  fixture.componentRef.setInput('value', toEditor(MODULE));
  fixture.componentRef.setInput('blocks', { ...SHOWN, ...settings });
  fixture.componentRef.setInput('editable', true);
  let last: JSONContent | null = null;
  fixture.componentInstance.changed.subscribe((d) => (last = d));
  await fixture.whenStable();
  const editor = fixture.componentInstance.editor!;
  const el = fixture.nativeElement as HTMLElement;
  const stable = async () => {
    await flush();
    fixture.detectChanges();
    await fixture.whenStable();
  };
  const image = () =>
    fromEditor(normalizeEditorDoc(last ?? withoutCaretGaps(editor.getJSON())))
      .blocks[0] as Image;
  const q = <T extends HTMLElement = HTMLElement>(selector: string) =>
    el.querySelector<T>(selector);
  const all = (selector: string) => [
    ...el.querySelectorAll<HTMLElement>(selector),
  ];
  const click = async (selector: string) => {
    const target = q(selector);
    if (!target) throw new Error(`no ${selector}`);
    target.click();
    await stable();
  };
  /** The image's callout IDs as the document holds them (a new one has no legend: no model yet). */
  const ids = () => {
    const out: string[] = [];
    editor.state.doc.descendants((c) => {
      if (c.type.name === 'callout') out.push(String(c.attrs['id']));
      return true;
    });
    return out;
  };
  return { fixture, editor, el, image, ids, stable, q, all, click };
}

const key = (target: Element, k: string, shiftKey = false) =>
  target.dispatchEvent(
    new KeyboardEvent('keydown', { key: k, shiftKey, bubbles: true }),
  );

describe('the callout editor', () => {
  beforeEach(() =>
    TestBed.configureTestingModule({ providers: [provideZard()] }),
  );

  it('counts the callouts and says what they are numbered in, and the references show their numbers', async () => {
    const { all, q, fixture, stable } = await mount();
    expect(q('[data-slot="callout-count"]')?.textContent?.trim()).toBe(
      '2 callouts',
    );
    expect(q('[data-slot="callout-variant"]')?.textContent?.trim()).toBe(
      'numbered across all variants',
    );
    const chips = () =>
      all('[data-node="calloutRef"]').map((c) => c.textContent?.trim());
    expect(chips()).toEqual([
      'Callout reference 2',
      'Callout reference ?: The callout is gone: its image or the callout was removed',
    ]);
    // In a variant that hides the inlet, the outlet is 1.
    fixture.componentRef.setInput('blocks', {
      variant: { values: { model: 'small' }, label: 'Small' },
    });
    await stable();
    expect(chips()[0]).toBe('Callout reference 1');
    expect(q('[data-slot="callout-variant"]')?.textContent?.trim()).toBe(
      'numbered as in Small',
    );
  });

  it('adds a callout from the keyboard, nudges it with the arrows, and deletes it with Delete and Undo', async () => {
    const { editor, ids, click, q, all, stable } = await mount();
    await click('[data-action="edit-callouts"]');
    expect(
      q('[data-action="edit-callouts"]')?.getAttribute('aria-pressed'),
    ).toBe('true');
    await click('[data-action="add-callout"]');
    expect(ids()).toEqual(['outlet', 'inlet', 'pump-1']);
    // Its legend is being edited.
    expect(q('[data-slot="callout-legend"] [role="textbox"]')).not.toBeNull();

    const marker = () =>
      q('[data-slot="callout-marker"][data-callout="pump-1"]')!;
    key(marker(), 'ArrowRight');
    await stable();
    key(marker(), 'ArrowDown', true);
    await stable();
    let anchor: unknown = null;
    editor.state.doc.descendants((c) => {
      if (c.attrs['id'] === 'pump-1') anchor = c.attrs['anchor'];
      return true;
    });
    expect(anchor).toEqual({
      x: 0.51,
      y: 0.55,
    });
    const numbers = () =>
      Object.fromEntries(
        all('[data-slot="callout-marker"]').map((m) => [
          m.dataset['callout'],
          m.textContent?.trim(),
        ]),
      );
    // Reading order: the new one is a row lower than the others now.
    expect(numbers()).toEqual({ inlet: '1', outlet: '2', 'pump-1': '3' });

    key(marker(), 'Delete');
    await stable();
    expect(ids()).toEqual(['outlet', 'inlet']);
    const toasts = TestBed.inject(ToastService);
    const toast = toasts.toasts().at(-1)!;
    expect(toast.message).toEqual({
      key: 'editor.docEditor.callouts.deleted',
      params: { number: 3 },
    });
    // Seconds later, as a person would (history groups steps made close together).
    editor.view.dispatch(closeHistory(editor.state.tr));
    toast.onAction?.();
    await stable();
    expect(ids()).toEqual(['outlet', 'inlet', 'pump-1']);
    // The editor's own Undo works as well.
    editor.commands.undo();
    await stable();
    expect(ids()).toEqual(['outlet', 'inlet']);
  });

  it('writes a legend in its field, with marks, as one undo step for the document', async () => {
    const { image, click, q, stable } = await mount();
    await click('[data-action="edit-callouts"]');
    await click(
      '[data-callout-row="outlet"] [data-slot="callout-legend-text"]',
    );
    const field = q('[data-slot="callout-legend"] [role="textbox"]')!;
    expect(field.getAttribute('aria-label')).toBe('Legend of callout 2');
    expect(field.textContent).toBe('Outlet');
    // The field's editor is the content model's: its text goes to the document.
    const fieldEditor = (
      field as unknown as { editor?: import('@tiptap/core').Editor }
    ).editor;
    expect(fieldEditor).toBeDefined();
    fieldEditor!.commands.insertContentAt(7, ' valve');
    fieldEditor!.commands.setTextSelection({ from: 1, to: 7 });
    fieldEditor!.commands.toggleMark('strong');
    await stable();
    expect(image().callouts?.[0]?.legend).toEqual([
      { type: 'text', text: 'Outlet', marks: [{ type: 'strong' }] },
      { type: 'text', text: ' valve' },
    ]);
    // Mod+Z in the field is the document's Undo.
    field.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }),
    );
    await stable();
    expect(image().callouts?.[0]?.legend).not.toEqual([
      { type: 'text', text: 'Outlet', marks: [{ type: 'strong' }] },
      { type: 'text', text: ' valve' },
    ]);
  });

  it('sets a callout’s variants with the variant picker, and adds a leader line', async () => {
    const asked: unknown[] = [];
    let answer: VariantPick | null = {
      op: 'in',
      attr: 'model',
      values: ['small'],
    };
    const { image, click } = await mount({
      pickVariant: async (current) => {
        asked.push(current);
        return answer;
      },
    });
    await click('[data-action="edit-callouts"]');
    await click('[data-callout-row="inlet"] [data-slot="callout-legend-text"]');
    await click('[data-callout-row="inlet"] [data-action="callout-variants"]');
    expect(asked).toEqual([{ op: 'in', attr: 'model', values: ['large'] }]);
    expect(image().callouts?.[1]?.when).toEqual(answer);
    answer = 'remove';
    await click('[data-callout-row="inlet"] [data-action="callout-variants"]');
    expect(image().callouts?.[1]?.when).toBeUndefined();
    await click('[data-callout-row="inlet"] [data-action="callout-leader"]');
    expect(image().callouts?.[1]?.label).toEqual({ x: 0.3, y: 0.4 });
  });

  it('reorders by a row’s grip into the author’s order, and back to reading order', async () => {
    const { image, click, q, all, stable } = await mount();
    await click('[data-action="edit-callouts"]');
    const grips = all('[data-slot="sortable-grip"]');
    grips[1]!.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'ArrowUp',
        altKey: true,
        bubbles: true,
      }),
    );
    await stable();
    expect(image().calloutOrder).toBe('manual');
    expect(image().callouts?.map((c) => c.id)).toEqual(['outlet', 'inlet']);
    expect(
      all('[data-slot="callout-marker"]').map((m) => m.textContent?.trim()),
    ).toEqual(['1', '2']);
    expect(q('[data-action="reading-order"]')).not.toBeNull();
    await click('[data-action="reading-order"]');
    expect(image().calloutOrder).toBeUndefined();
  });
  it('opens on a callout shown from outside, and a style suggestion changes only its legend (#573)', async () => {
    const { fixture, q, image, stable } = await mount();
    const component = fixture.componentInstance;
    expect(q('[data-callout-row]')).toBeNull();
    expect(component.textOf('inlet', 'legend')).toBe('Inlet');
    expect(component.showText('inlet', 'legend')).toBe(true);
    await stable();
    expect(
      q('[data-callout-row="inlet"] of-callout-legend-field'),
    ).not.toBeNull();
    expect(q('[data-callout-row="outlet"] of-callout-legend-field')).toBeNull();

    const before = image();
    expect(
      component.changeText({
        blockId: 'inlet',
        field: 'legend',
        range: { start: 0, end: 5 },
        original: 'Inlet',
        replacement: 'Intake',
        expected: 'Inlet',
      }),
    ).toBe('applied');
    await stable();
    const after = image();
    expect(after.callouts?.map((c) => c.legend)).toEqual([
      [{ type: 'text', text: 'Outlet' }],
      [{ type: 'text', text: 'Intake' }],
    ]);
    expect({ ...after, callouts: before.callouts }).toEqual(before);
    // Made for text that is gone: refused, nothing changes.
    expect(
      component.changeText({
        blockId: 'inlet',
        field: 'legend',
        range: { start: 0, end: 5 },
        original: 'Inlet',
        replacement: 'Intake',
        expected: 'Inlet',
      }),
    ).toBe('changed');
    expect(component.showText('gone', 'legend')).toBe(false);
  });
});

describe('the callout reference', () => {
  beforeEach(() =>
    TestBed.configureTestingModule({ providers: [provideZard()] }),
  );

  it('is offered by "/" where text goes, and its picker lists the images’ callouts by number and legend', async () => {
    const { editor, stable, el } = await mount();
    const item = SLASH_ITEMS.find((i) => i.id === 'calloutRef')!;
    editor.view.dispatch(
      editor.state.tr.setSelection(
        TextSelection.create(
          editor.state.doc,
          insideText(editor, 'Open the outlet  and the drain .') + 4,
        ),
      ),
    );
    expect(item.available?.(editor.state, editor)).toBe(true);
    item.run(editor, {
      from: editor.state.selection.from,
      to: editor.state.selection.from,
    });
    await stable();
    await flush();
    await stable();
    const options = [
      ...el.ownerDocument.querySelectorAll<HTMLElement>(
        'z-command-option [role="option"]',
      ),
    ];
    expect(
      options.map((o) => o.textContent?.replace(/\s+/g, ' ').trim()),
    ).toEqual(['1Inlet', '2Outlet']);
    options[0]!.click();
    await stable();
    const refs: string[] = [];
    editor.state.doc.descendants((n) => {
      if (n.type.name === 'calloutRef')
        refs.push(`${n.attrs['block']}#${n.attrs['callout']}`);
      return true;
    });
    expect(refs).toEqual(['pump#inlet', 'pump#outlet', 'pump#drain']);
  });

  it('opens its picker on a click on its chip', async () => {
    const { editor, stable, el } = await mount();
    let at = -1;
    editor.state.doc.descendants((n, pos) => {
      if (at < 0 && n.type.name === 'calloutRef') at = pos;
      return true;
    });
    editor.view.dispatch(
      editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, at)),
    );
    editor.commands.keyboardShortcut('Enter');
    await stable();
    await flush();
    await stable();
    expect(
      el.ownerDocument
        .querySelector('[role="dialog"]')
        ?.getAttribute('aria-label'),
    ).toBe('Callout reference');
  });
});
