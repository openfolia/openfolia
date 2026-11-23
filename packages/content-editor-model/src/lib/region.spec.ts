import type { Block } from '@openfolia/content-model';
import { ConversionError } from './errors.js';
import { getEditorSchema } from './extensions.js';
import { regionFromEditor } from './from-editor.js';
import { normalizeEditorDoc } from './normalize.js';
import { regionToEditor } from './to-editor.js';

const text = (t: string) => ({ type: 'text' as const, text: t });

/** A region as a design holds it (#393): a heading one level deep, placeholders, a note, a list. */
const region: Block[] = [
  {
    type: 'section',
    id: 'contact',
    title: [text('Contact')],
    blocks: [
      {
        type: 'paragraph',
        id: 'version',
        content: [
          text('Version '),
          { type: 'placeholder', key: 'product-version' },
          text(' of '),
          { type: 'placeholder', key: 'date' },
        ],
      },
      {
        type: 'admonition',
        id: 'keep',
        kind: 'note',
        blocks: [
          { type: 'paragraph', id: 'keep-text', content: [text('Keep it.')] },
        ],
      },
      {
        type: 'list',
        id: 'points',
        ordered: false,
        items: [{ id: 'p1', content: [text('One')], blocks: [] }],
      },
    ],
  },
];

describe('a page design region in the editor (#393)', () => {
  it('goes there and back unchanged, placeholders included, through ProseMirror too', () => {
    const doc = regionToEditor(region);
    expect(doc.attrs).toEqual({
      moduleId: '',
      schemaVersion: expect.any(Number),
      meta: null,
    });
    expect(regionFromEditor(doc)).toStrictEqual(region);
    const node = getEditorSchema().nodeFromJSON(doc);
    node.check();
    const back = JSON.parse(JSON.stringify(node.toJSON())) as unknown;
    expect(regionFromEditor(normalizeEditorDoc(back))).toStrictEqual(region);
  });

  it('keeps a placeholder as a node with its key, never as text', () => {
    const doc = JSON.stringify(regionToEditor(region));
    expect(doc).toContain(
      '{"type":"placeholder","attrs":{"key":"product-version"}}',
    );
  });

  it('reads an empty document, or one of empty paragraphs, as no text', () => {
    expect(regionFromEditor(regionToEditor([]))).toEqual([]);
    expect(
      regionFromEditor({
        type: 'doc',
        content: [{ type: 'paragraph', attrs: { id: 'a' } }],
      }),
    ).toEqual([]);
  });

  it('refuses what a region cannot hold, naming the block', () => {
    const nested: Block[] = [
      {
        type: 'section',
        id: 'outer',
        title: [text('Outer')],
        blocks: [
          { type: 'section', id: 'inner', title: [text('Inner')], blocks: [] },
        ],
      },
    ];
    const pageBreak: Block[] = [{ type: 'pageBreak', id: 'brk' }];
    const xref: Block[] = [
      {
        type: 'paragraph',
        id: 'see',
        content: [{ type: 'xref', module: 'other', text: [] }],
      },
    ];
    for (const [blocks, id] of [
      [nested, 'inner'],
      [pageBreak, 'brk'],
      [xref, 'see'],
    ] as const) {
      const attempt = () => regionFromEditor(regionToEditor(blocks));
      expect(attempt).toThrow(ConversionError);
      try {
        attempt();
      } catch (error) {
        expect((error as ConversionError).blockId).toBe(id);
      }
    }
  });
});
