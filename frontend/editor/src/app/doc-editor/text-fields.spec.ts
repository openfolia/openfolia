import {
  fromEditor,
  normalizeEditorDoc,
  toEditor,
} from '@openfolia/content-editor-model';
import {
  plainTextOf,
  translatableUnits,
  type Block,
  type Image,
  type Module,
} from '@openfolia/content-model';

import { SAMPLE_MODULE } from './sample-module';
import { testEditor } from './testing/test-editor';
import {
  findTextField,
  imageOfCallout,
  textChange,
  type TextChange,
} from './text-fields';

const IMAGE: Image = {
  type: 'image',
  id: 'pump',
  asset: `sha256:${'a'.repeat(64)}`,
  alt: 'A pump',
  title: [{ type: 'text', text: 'The pump' }],
  callouts: [
    {
      id: 'pump-1',
      anchor: { x: 0.2, y: 0.5 },
      legend: [{ type: 'text', text: 'Utilize the outlet' }],
    },
    {
      id: 'pump-2',
      anchor: { x: 0.8, y: 0.5 },
      legend: [
        { type: 'text', text: 'Inlet ' },
        { type: 'attribute', name: 'product' },
        { type: 'text', text: ' valve', marks: [{ type: 'strong' }] },
      ],
    },
  ],
};

const BLOCKS: Block[] = [
  {
    type: 'section',
    id: 's',
    title: [{ type: 'text', text: 'Charging the battery' }],
    blocks: [
      {
        type: 'paragraph',
        id: 'p1',
        content: [
          { type: 'text', text: 'Switch off ' },
          { type: 'attribute', name: 'product' },
          { type: 'text', text: ' in order to charge.' },
        ],
      },
      IMAGE,
      {
        type: 'list',
        id: 'l',
        ordered: false,
        items: [
          {
            id: 'i1',
            content: [{ type: 'text', text: 'First item' }],
            blocks: [],
          },
        ],
      },
    ],
  },
];

const MODULE: Module = { ...SAMPLE_MODULE, blocks: BLOCKS };

function setup() {
  const editor = testEditor(toEditor(MODULE));
  const saved = () => fromEditor(normalizeEditorDoc(editor.getJSON()));
  const apply = (change: TextChange) => {
    const result = textChange(editor.state, change);
    if ('tr' in result) editor.view.dispatch(result.tr);
    return result;
  };
  return { editor, saved, apply };
}

const change = (
  blockId: string,
  field: string,
  expected: string,
  original: string,
  replacement: string,
  at = expected.indexOf(original),
): TextChange => ({
  blockId,
  field,
  expected,
  original,
  replacement,
  range: { start: at, end: at + original.length },
});

const legendOf = (module: Module, id: string) =>
  ((module.blocks[0] as { blocks: Block[] }).blocks[1] as Image).callouts!.find(
    (c) => c.id === id,
  )!.legend;

describe('text fields by unit and field (#573)', () => {
  it('reads every unit’s part as the content model’s plain text does', () => {
    const { editor } = setup();
    for (const unit of translatableUnits(MODULE)) {
      for (const part of unit.parts) {
        expect(
          findTextField(editor.state.doc, unit.blockId, part.field)?.plain,
        ).toEqual(plainTextOf(part.content));
      }
    }
    expect(findTextField(editor.state.doc, 'pump-1', 'content')).toBeNull();
    expect(findTextField(editor.state.doc, 'gone', 'legend')).toBeNull();
  });

  it('changes only the callout’s legend, in one undoable step', () => {
    const { editor, saved, apply } = setup();
    const before = saved();
    expect(
      apply(change('pump-1', 'legend', 'Utilize the outlet', 'Utilize', 'Use')),
    ).toHaveProperty('tr');
    const after = saved();
    expect(legendOf(after, 'pump-1')).toEqual([
      { type: 'text', text: 'Use the outlet' },
    ]);
    // Nothing else moved: the other callout, the image, the other blocks.
    const withOld = structuredClone(after);
    legendOf(withOld, 'pump-1').splice(0, 1, {
      type: 'text',
      text: 'Utilize the outlet',
    });
    expect(withOld).toEqual(before);
    editor.commands.undo();
    expect(saved()).toEqual(before);
  });

  it('keeps the marks and the inline nodes around the range', () => {
    const { saved, apply } = setup();
    const text = 'Inlet {product} valve';
    expect(
      apply(change('pump-2', 'legend', text, 'valve', 'tap')),
    ).toHaveProperty('tr');
    expect(legendOf(saved(), 'pump-2')).toEqual([
      { type: 'text', text: 'Inlet ' },
      { type: 'attribute', name: 'product' },
      { type: 'text', text: ' tap', marks: [{ type: 'strong' }] },
    ]);
  });

  it('changes a paragraph after an attribute, a title, a list item and the alt text', () => {
    const { saved, apply } = setup();
    const p = 'Switch off {product} in order to charge.';
    expect(
      apply(change('p1', 'content', p, 'in order to', 'to')),
    ).toHaveProperty('tr');
    expect(
      apply(change('s', 'title', 'Charging the battery', 'the battery', 'it')),
    ).toHaveProperty('tr');
    expect(
      apply(change('i1', 'content', 'First item', 'First', 'One')),
    ).toHaveProperty('tr');
    expect(apply(change('pump', 'alt', 'A pump', 'A', 'The'))).toHaveProperty(
      'tr',
    );
    const units = translatableUnits(saved()).flatMap((u) =>
      u.parts.map((part) => [u.blockId, plainTextOf(part.content).text]),
    );
    expect(units).toEqual([
      ['s', 'Charging it'],
      ['p1', 'Switch off {product} to charge.'],
      ['pump', 'The pump'],
      ['pump', 'The pump'],
      ['pump-1', 'Utilize the outlet'],
      ['pump-2', 'Inlet {product} valve'],
      ['i1', 'One item'],
    ]);
  });

  it('refuses a change once the field’s text is no longer what was reviewed', () => {
    const { editor, saved, apply } = setup();
    const before = saved();
    // The range still holds the original, but the rest of the legend changed.
    expect(
      apply(change('pump-1', 'legend', 'Utilize the inlet', 'Utilize', 'Use')),
    ).toEqual({ refused: 'changed' });
    // The range no longer holds the original.
    expect(
      apply({
        ...change('pump-1', 'legend', 'Utilize the outlet', 'Utilize', 'Use'),
        original: 'Utilise',
      }),
    ).toEqual({ refused: 'changed' });
    // A range over an inline node.
    expect(
      apply(change('pump-2', 'legend', 'Inlet {product} valve', 't {p', 'x')),
    ).toEqual({ refused: 'changed' });
    // A callout that is gone, or a field it does not have.
    expect(
      apply(change('pump-9', 'legend', 'Utilize the outlet', 'Utilize', 'Use')),
    ).toEqual({ refused: 'missing' });
    expect(
      apply(change('pump-1', 'title', 'Utilize the outlet', 'Utilize', 'Use')),
    ).toEqual({ refused: 'missing' });
    expect(saved()).toEqual(before);
    expect(editor.can().undo()).toBe(false);
  });

  it('never takes the marks toggled at the caret', () => {
    const { editor, saved, apply } = setup();
    editor.commands.setTextSelection(3);
    editor.commands.setMark('strong');
    expect(editor.state.storedMarks?.length).toBe(1);
    expect(
      apply(change('pump-1', 'legend', 'Utilize the outlet', 'Utilize', 'Use')),
    ).toHaveProperty('tr');
    expect(legendOf(saved(), 'pump-1')).toEqual([
      { type: 'text', text: 'Use the outlet' },
    ]);
  });

  it('removes a range when the replacement is empty', () => {
    const { saved, apply } = setup();
    expect(
      apply(change('pump-1', 'legend', 'Utilize the outlet', ' the', '')),
    ).toHaveProperty('tr');
    expect(legendOf(saved(), 'pump-1')).toEqual([
      { type: 'text', text: 'Utilize outlet' },
    ]);
  });

  it('finds the image of a callout', () => {
    const { editor } = setup();
    expect(imageOfCallout(editor.state.doc, 'pump-2')).toBe('pump');
    expect(imageOfCallout(editor.state.doc, 'pump')).toBeNull();
    expect(imageOfCallout(editor.state.doc, 'gone')).toBeNull();
  });
});
