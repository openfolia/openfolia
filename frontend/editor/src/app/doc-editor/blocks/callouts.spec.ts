import type { Editor } from '@tiptap/core';
import type { Transaction } from '@tiptap/pm/state';
import {
  fromEditor,
  normalizeEditorDoc,
  toEditor,
} from '@openfolia/content-editor-model';
import {
  parseModule,
  printModule,
  type Condition,
  type Image,
  type Module,
} from '@openfolia/content-model';

import { SAMPLE_MODULE } from '../sample-module';
import { testEditor } from '../testing/test-editor';
import {
  addCallout,
  documentCallouts,
  editorCallouts,
  legendContent,
  moveCalloutPoint,
  newCalloutId,
  nudged,
  refState,
  removeCallout,
  reorderCallouts,
  setCalloutLabel,
  setCalloutLegend,
  setCalloutWhen,
  toPoint,
  useReadingOrder,
} from './callouts';

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
      when: { op: 'in', attr: 'model', values: ['large'] },
    },
    {
      id: 'switch',
      anchor: { x: 0.5, y: 0.1 },
      label: { x: 0.6, y: 0.05 },
      legend: [{ type: 'text', text: 'Switch' }],
    },
  ],
};

const MODULE: Module = { ...SAMPLE_MODULE, blocks: [IMAGE] };

const SMALL = { values: { model: 'small' }, label: 'Small' };
const LARGE = { values: { model: 'large' }, label: 'Large' };

function setup(module: Module = MODULE) {
  const editor: Editor = testEditor(toEditor(module));
  const image = () => editor.state.doc.firstChild!;
  const run = (change: (tr: Transaction, pos: number) => unknown) => {
    const tr = editor.state.tr;
    const result = change(tr, 0);
    editor.view.dispatch(tr);
    return result;
  };
  const saved = () =>
    fromEditor(normalizeEditorDoc(editor.getJSON())).blocks[0] as Image;
  return { editor, image, run, saved };
}

describe('the callout editor’s model (#547)', () => {
  it('lists the callouts in reading order, numbered in the chosen variant', () => {
    const { image } = setup();
    const all = editorCallouts(image(), null);
    expect(all.map((c) => [c.id, c.number, c.text])).toEqual([
      ['switch', 1, 'Switch'],
      ['inlet', 2, 'Inlet'],
      ['outlet', 3, 'Outlet'],
    ]);
    // A variant that hides one: the numbers close up, the hidden one has none.
    expect(editorCallouts(image(), SMALL).map((c) => c.number)).toEqual([
      1,
      null,
      2,
    ]);
    expect(editorCallouts(image(), LARGE).map((c) => c.number)).toEqual([
      1, 2, 3,
    ]);
  });

  it('says what a reference reads as: its number, hidden, or missing', () => {
    const { editor } = setup();
    const small = documentCallouts(editor.state.doc, SMALL);
    expect(refState(small, 'pump', 'outlet')).toEqual({
      status: 'numbered',
      number: 2,
    });
    expect(refState(small, 'pump', 'inlet')).toEqual({ status: 'hidden' });
    expect(refState(small, 'pump', 'gone')).toEqual({ status: 'missing' });
    expect(refState(small, 'nope', 'outlet')).toEqual({ status: 'missing' });
  });

  it('adds a callout at a point, with an ID of its own and an empty legend to fill in', () => {
    const { image, run, saved } = setup();
    const id = run((tr, pos) => addCallout(tr, pos, { x: 0.33333, y: 1.4 }));
    expect(id).toBe('pump-1');
    const added = image().lastChild!;
    expect(added.attrs).toEqual({
      id: 'pump-1',
      anchor: { x: 0.3333, y: 1 },
      label: null,
      when: null,
      style: null,
    });
    // The model wants a legend: the draft is incomplete until one is typed.
    expect(() => saved()).toThrow(/legend/);
    expect(run((tr, pos) => addCallout(tr, pos, { x: 0.1, y: 0.1 }))).toBe(
      'pump-2',
    );
  });

  it('moves and nudges an anchor and a label, clamped and rounded', () => {
    const { run, saved } = setup();
    run((tr, pos) =>
      moveCalloutPoint(tr, pos, 'outlet', 'anchor', { x: 0.123456, y: -2 }),
    );
    expect(saved().callouts?.[0]?.anchor).toEqual({ x: 0.1235, y: 0 });
    // No label: there is nothing to move.
    expect(
      run((tr, pos) =>
        moveCalloutPoint(tr, pos, 'outlet', 'label', { x: 0.5, y: 0.5 }),
      ),
    ).toBe(false);
    run((tr, pos) =>
      moveCalloutPoint(
        tr,
        pos,
        'switch',
        'label',
        nudged({ x: 0.6, y: 0.05 }, 0.05, -0.1),
      ),
    );
    expect(saved().callouts?.[2]?.label).toEqual({ x: 0.65, y: 0 });
    expect(toPoint(Number.NaN, 0.5)).toEqual({ x: 0, y: 0.5 });
  });

  it('adds and removes a leader line, its label inside the image', () => {
    const { run, saved } = setup();
    run((tr, pos) => setCalloutLabel(tr, pos, 'outlet', true));
    expect(saved().callouts?.[0]?.label).toEqual({ x: 0.9, y: 0.4 });
    run((tr, pos) => setCalloutLabel(tr, pos, 'switch', false));
    expect(saved().callouts?.[2]?.label).toBeUndefined();
  });

  it('sets a condition and a legend with marks, a break as a space', () => {
    const { editor, run, saved } = setup();
    const when: Condition = { op: 'in', attr: 'model', values: ['small'] };
    run((tr, pos) => setCalloutWhen(tr, pos, 'outlet', when));
    expect(saved().callouts?.[0]?.when).toEqual(when);
    const schema = editor.schema;
    const legend = schema.nodes['paragraph']!.create(null, [
      schema.text('Out', [schema.marks['strong']!.create()]),
      schema.nodes['hardBreak']!.create(),
      schema.text('let'),
    ]).content;
    // The break and the text after it become one run.
    expect(legendContent(schema, legend).childCount).toBe(2);
    run((tr, pos) => setCalloutLegend(tr, pos, 'outlet', legend));
    expect(saved().callouts?.[0]?.legend).toEqual([
      { type: 'text', text: 'Out', marks: [{ type: 'strong' }] },
      { type: 'text', text: ' let' },
    ]);
  });

  it('reorders into the author’s order, and back to reading order', () => {
    const { image, run, saved } = setup();
    run((tr, pos) => reorderCallouts(tr, pos, ['inlet', 'switch', 'outlet']));
    expect(saved().calloutOrder).toBe('manual');
    expect(editorCallouts(image(), null).map((c) => c.id)).toEqual([
      'inlet',
      'switch',
      'outlet',
    ]);
    // An incomplete order is refused.
    expect(run((tr, pos) => reorderCallouts(tr, pos, ['inlet']))).toBe(false);
    run((tr, pos) => useReadingOrder(tr, pos));
    expect(saved().calloutOrder).toBeUndefined();
    expect(editorCallouts(image(), null).map((c) => c.id)).toEqual([
      'switch',
      'inlet',
      'outlet',
    ]);
  });

  it('removes a callout, and Undo brings it back', () => {
    const { editor, run, saved } = setup();
    run((tr, pos) => removeCallout(tr, pos, 'inlet'));
    expect(saved().callouts?.map((c) => c.id)).toEqual(['outlet', 'switch']);
    editor.commands.undo();
    expect(saved()).toEqual(IMAGE);
  });

  it('makes IDs within the model’s length, the first free number', () => {
    expect(newCalloutId('pump', new Set(['pump-1']))).toBe('pump-2');
    const long = 'a'.repeat(64);
    expect(newCalloutId(long, new Set())).toHaveLength(64);
    expect(newCalloutId('', new Set())).toBe('callout-1');
  });

  it('saves a module the callout editor changed that round-trips through AsciiDoc unchanged', () => {
    const { editor, run } = setup();
    const schema = editor.schema;
    run((tr, pos) => addCallout(tr, pos, { x: 0.4, y: 0.7 }));
    run((tr, pos) =>
      setCalloutLegend(
        tr,
        pos,
        'pump-1',
        schema.nodes['paragraph']!.create(null, [
          schema.text('Drain', [schema.marks['emphasis']!.create()]),
          schema.text(' valve'),
        ]).content,
      ),
    );
    run((tr, pos) => setCalloutLabel(tr, pos, 'pump-1', true));
    run((tr, pos) =>
      setCalloutWhen(tr, pos, 'pump-1', {
        op: 'in',
        attr: 'model',
        values: ['small'],
      }),
    );
    run((tr, pos) =>
      reorderCallouts(tr, pos, ['pump-1', 'switch', 'inlet', 'outlet']),
    );
    const module = fromEditor(normalizeEditorDoc(editor.getJSON()));
    expect(parseModule(printModule(module), { id: module.id })).toEqual(module);
  });
});
