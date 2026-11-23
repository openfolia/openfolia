import { Module } from '@openfolia/content-model';
import { must } from '../testing/must.js';
import { ConversionError } from './errors.js';
import { getEditorSchema } from './extensions.js';
import { fromEditor } from './from-editor.js';
import type { EditorDoc, EditorNode } from './json.js';
import { normalizeEditorDoc } from './normalize.js';
import { toEditor } from './to-editor.js';

// Image callouts (#498) in the editor's document: a `callout` node per
// callout inside its image, holding the legend, and the inline `calloutRef`.

const module = Module.parse({
  schemaVersion: 1,
  id: 'front-panel',
  meta: { title: 'Front panel', type: 'concept', lang: 'en' },
  blocks: [
    {
      type: 'image',
      id: 'front-view',
      asset: `sha256:${'ab'.repeat(32)}`,
      alt: 'Front of the unit',
      title: [{ type: 'text', text: 'Front view' }],
      calloutOrder: 'manual',
      callouts: [
        {
          id: 'power-switch',
          anchor: { x: 0.25, y: 0.4 },
          label: { x: 0.1, y: 0.05 },
          legend: [
            { type: 'text', text: 'Power', marks: [{ type: 'strong' }] },
            { type: 'text', text: ' switch' },
          ],
          style: 'square',
        },
        {
          id: 'filter',
          anchor: { x: 0.6, y: 0.55 },
          legend: [{ type: 'text', text: 'Filter' }],
          when: { op: 'in', attr: 'model', values: ['l-400'] },
        },
      ],
    },
    {
      type: 'paragraph',
      id: 'press',
      content: [
        { type: 'text', text: 'Press ' },
        { type: 'calloutRef', block: 'front-view', callout: 'power-switch' },
      ],
    },
  ],
});

const imageOf = (doc: EditorDoc) => must(doc.content?.[0]);
const failure = (run: () => unknown): ConversionError => {
  try {
    run();
  } catch (error) {
    if (error instanceof ConversionError) return error;
    throw error;
  }
  throw new Error('expected a ConversionError');
};

describe('callouts in the editor document', () => {
  it('puts each callout after the title of its image, with its legend as content', () => {
    const doc = toEditor(module);
    const image = imageOf(doc);
    expect(image.attrs?.['calloutOrder']).toBe('manual');
    expect(image.content?.map((n) => n.type)).toEqual([
      'title',
      'callout',
      'callout',
    ]);
    expect(image.content?.[1]).toEqual({
      type: 'callout',
      attrs: {
        id: 'power-switch',
        anchor: { x: 0.25, y: 0.4 },
        label: { x: 0.1, y: 0.05 },
        when: null,
        style: 'square',
      },
      content: [
        { type: 'text', text: 'Power', marks: [{ type: 'strong' }] },
        { type: 'text', text: ' switch' },
      ],
    });
    expect(doc.content?.[1]?.content?.[1]).toEqual({
      type: 'calloutRef',
      attrs: { block: 'front-view', callout: 'power-switch' },
    });
    expect(fromEditor(doc)).toEqual(module);
  });

  it('is a document ProseMirror takes as it is, and the repair leaves alone', () => {
    const doc = toEditor(module);
    const node = getEditorSchema().nodeFromJSON(doc);
    node.check();
    expect(node.toJSON()).toEqual(doc);
    expect(normalizeEditorDoc(doc)).toEqual(doc);
  });

  it('names the image when a callout cannot be read', () => {
    const stray = toEditor(module);
    imageOf(stray).content?.push({
      type: 'paragraph',
      attrs: { id: 'x' },
    });
    expect(failure(() => fromEditor(stray))).toMatchObject({
      blockId: 'front-view',
      message: expect.stringMatching(/its title and its callouts/),
    });

    const noAnchor = toEditor(module);
    must(imageOf(noAnchor).content?.[2]).attrs = {
      ...imageOf(noAnchor).content?.[2]?.attrs,
      anchor: null,
    };
    expect(failure(() => fromEditor(noAnchor)).blockId).toBe('front-view');

    const outside = toEditor(module);
    must(imageOf(outside).content?.[1]).attrs = {
      ...imageOf(outside).content?.[1]?.attrs,
      anchor: { x: 2, y: 0 },
    };
    expect(failure(() => fromEditor(outside)).blockId).toBe('front-view');
  });

  it('repairs: callouts stay in their image, anything else moves out after it, a stray callout becomes text', () => {
    const given = {
      type: 'doc',
      attrs: { moduleId: 'front-panel', schemaVersion: 1, meta: null },
      content: [
        {
          type: 'image',
          attrs: { id: 'img', asset: `sha256:${'ab'.repeat(32)}`, alt: 'A' },
          content: [
            { type: 'paragraph', attrs: { id: 'moved' }, content: [] },
            {
              type: 'callout',
              attrs: { id: 'c', anchor: { x: 0.5, y: 0.5 }, colour: 'red' },
              content: [
                { type: 'text', text: 'two\nlines' },
                { type: 'calloutRef', attrs: { block: 'img', callout: 'c' } },
              ],
            },
          ],
        },
        {
          type: 'callout',
          attrs: { id: 'lost', anchor: { x: 0, y: 0 } },
          content: [{ type: 'text', text: 'Lost legend' }],
        },
      ],
    };
    const out = normalizeEditorDoc(given);
    const types = (nodes: EditorNode[] | undefined) =>
      nodes?.map((n) => n.type);
    expect(types(out.content)).toEqual(['image', 'paragraph', 'paragraph']);
    const [image, moved, lost] = out.content ?? [];
    expect(must(image).content).toEqual([
      {
        type: 'callout',
        attrs: {
          id: 'c',
          anchor: { x: 0.5, y: 0.5 },
          label: null,
          when: null,
          style: null,
        },
        content: [
          { type: 'text', text: 'two lines' },
          { type: 'calloutRef', attrs: { block: 'img', callout: 'c' } },
        ],
      },
    ]);
    expect(moved?.attrs?.['id']).toBe('moved');
    expect(lost?.content).toEqual([{ type: 'text', text: 'Lost legend' }]);
    expect(normalizeEditorDoc(out)).toEqual(out);
    getEditorSchema().nodeFromJSON(out).check();
  });

  it('gives callouts and blocks IDs unique among them all (the later one gets a new one)', () => {
    const doc = toEditor(module);
    must(imageOf(doc).content?.[1]).attrs = {
      ...imageOf(doc).content?.[1]?.attrs,
      id: 'press',
    };
    const out = normalizeEditorDoc(doc, { newId: () => 'fresh' });
    expect(imageOf(out).content?.[1]?.attrs?.['id']).toBe('press');
    expect(out.content?.[1]?.attrs?.['id']).toBe('fresh');
    expect(failure(() => fromEditor(doc)).message).toMatch(
      /duplicate (block|callout) id/,
    );
  });
});
