import { TestBed } from '@angular/core/testing';
import { undoDepth } from '@tiptap/pm/history';
import { NodeSelection, TextSelection } from '@tiptap/pm/state';
import { toEditor } from '@openfolia/content-editor-model';
import type { Image, Module } from '@openfolia/content-model/core';
import { provideZard } from '@openfolia/ui/core';

import { BlockEditorComponent } from '../block-editor.component';
import { SAMPLE_MODULE } from '../sample-module';
import type { DocBlockSettings } from './doc-blocks-context';

// Callout highlighting in the editor (#549), both ways: a marker or a panel row hovered or
// focused lights up the references to its callout in the text; a reference hovered, or selected
// with the keyboard, lights up its marker and its row. Nothing of it is a step for Undo.

beforeAll(() => {
  const proto = Range.prototype as Partial<Range>;
  proto.getClientRects ??= () => [] as unknown as DOMRectList;
  proto.getBoundingClientRect ??= () => new DOMRect();
});

const IMAGE: Image = {
  type: 'image',
  id: 'pump',
  asset: `sha256:${'a'.repeat(64)}`,
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
        { type: 'text', text: ' and the inlet ' },
        { type: 'calloutRef', block: 'pump', callout: 'inlet' },
        { type: 'text', text: ', then the outlet again ' },
        { type: 'calloutRef', block: 'pump', callout: 'outlet' },
        { type: 'text', text: '.' },
      ],
    },
  ],
};

const flush = () => new Promise((resolve) => setTimeout(resolve));

const SHOWN: DocBlockSettings = { imageSource: async () => 'blob:pump' };

async function mount() {
  const fixture = TestBed.createComponent(BlockEditorComponent);
  fixture.componentRef.setInput('value', toEditor(MODULE));
  fixture.componentRef.setInput('blocks', SHOWN);
  fixture.componentRef.setInput('editable', true);
  let changes = 0;
  fixture.componentInstance.changed.subscribe(() => changes++);
  await fixture.whenStable();
  const editor = fixture.componentInstance.editor!;
  const el = fixture.nativeElement as HTMLElement;
  const stable = async () => {
    await flush();
    fixture.detectChanges();
    await fixture.whenStable();
  };
  await stable();
  const all = (selector: string) => [
    ...el.querySelectorAll<HTMLElement>(selector),
  ];
  const marker = (id: string) =>
    el.querySelector<HTMLElement>(
      `[data-slot="callout-marker"][data-callout="${id}"]`,
    )!;
  const chips = () => all('[data-node="calloutRef"]');
  /** Which chips are highlighted, by their callout. */
  const lit = () =>
    chips()
      .filter((c) => c.hasAttribute('data-highlighted'))
      .map((c) => c.dataset['callout']);
  const litMarkers = () =>
    all('[data-slot="callout-marker"][data-highlighted]').map(
      (m) => m.dataset['callout'],
    );
  const litRows = () =>
    all('[data-callout-row][data-highlighted]').map((r) =>
      r.getAttribute('data-callout-row'),
    );
  return {
    fixture,
    editor,
    el,
    stable,
    marker,
    chips,
    lit,
    litMarkers,
    litRows,
    changes: () => changes,
  };
}

const pointer = (target: Element, type: string) =>
  target.dispatchEvent(new PointerEvent(type, { bubbles: false }));

describe('callout highlighting in the editor (#549)', () => {
  beforeEach(() =>
    TestBed.configureTestingModule({ providers: [provideZard()] }),
  );

  it('a marker under the pointer lights up every reference to its callout, and only those', async () => {
    const { marker, lit, stable, editor, changes } = await mount();
    const depth = undoDepth(editor.state);
    const before = changes();
    pointer(marker('outlet'), 'pointerenter');
    await stable();
    expect(lit()).toEqual(['outlet', 'outlet']);
    pointer(marker('outlet'), 'pointerleave');
    await stable();
    expect(lit()).toEqual([]);
    // Not a change of the document, not a step for Undo.
    expect(undoDepth(editor.state)).toBe(depth);
    expect(changes()).toBe(before);
  });

  it('a reference under the pointer lights up its marker and its panel row', async () => {
    const { el, chips, litMarkers, litRows, stable, editor } = await mount();
    el.querySelector<HTMLElement>('[data-action="edit-callouts"]')!.click();
    await stable();
    const [, inlet] = chips();
    inlet!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    await stable();
    expect(litMarkers()).toEqual(['inlet']);
    expect(litRows()).toEqual(['inlet']);
    // Off the text: nothing.
    editor.view.dom.dispatchEvent(new MouseEvent('mouseleave'));
    await stable();
    expect(litMarkers()).toEqual([]);
    expect(litRows()).toEqual([]);
  });

  it('a panel row under the pointer or holding the focus lights up the references', async () => {
    const { el, lit, stable } = await mount();
    el.querySelector<HTMLElement>('[data-action="edit-callouts"]')!.click();
    await stable();
    const row = el.querySelector<HTMLElement>('[data-callout-row="inlet"]')!;
    pointer(row, 'pointerenter');
    await stable();
    expect(lit()).toEqual(['inlet']);
    pointer(row, 'pointerleave');
    await stable();
    expect(lit()).toEqual([]);
    row.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    await stable();
    expect(lit()).toEqual(['inlet']);
    row.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    await stable();
    expect(lit()).toEqual([]);
  });

  it('a reference selected with the keyboard lights up its marker, until the selection moves on', async () => {
    const { editor, litMarkers, stable } = await mount();
    const view = editor.view;
    vi.spyOn(view, 'hasFocus').mockReturnValue(true);
    let at = -1;
    view.state.doc.descendants((node, pos) => {
      if (at < 0 && node.type.name === 'calloutRef') at = pos;
      return at < 0;
    });
    view.dispatch(
      view.state.tr.setSelection(NodeSelection.create(view.state.doc, at)),
    );
    await stable();
    expect(litMarkers()).toEqual(['outlet']);
    view.dispatch(
      view.state.tr.setSelection(TextSelection.create(view.state.doc, at)),
    );
    await stable();
    expect(litMarkers()).toEqual([]);
  });

  it('leaving a marker does not take away the highlight a reference put on', async () => {
    const { chips, marker, litMarkers, stable } = await mount();
    chips()[1]!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    await stable();
    // A leave from a marker that did not set the highlight changes nothing.
    pointer(marker('outlet'), 'pointerleave');
    await stable();
    expect(litMarkers()).toEqual(['inlet']);
  });

  it('a highlighted callout that is deleted leaves no highlight behind', async () => {
    const { el, marker, lit, stable } = await mount();
    el.querySelector<HTMLElement>('[data-action="edit-callouts"]')!.click();
    await stable();
    const remove = async (id: string) => {
      el.querySelector<HTMLElement>(
        `[data-callout-row="${id}"] [data-action="delete-callout"]`,
      )!.click();
      await stable();
    };
    await remove('outlet');
    // The last one, hovered, then deleted: the focus goes to "Add callout", not to a marker.
    const row = el.querySelector<HTMLElement>('[data-callout-row="inlet"]')!;
    pointer(row, 'pointerenter');
    await stable();
    expect(lit()).toEqual(['inlet']);
    await remove('inlet');
    expect(marker('inlet')).toBeNull();
    expect(lit()).toEqual([]);
  });
});
