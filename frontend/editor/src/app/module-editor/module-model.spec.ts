import type { JSONContent } from '@tiptap/core';

import {
  contentOf,
  includesModule,
  outlineOf,
  patchMeta,
  textOf,
} from './module-model';

const meta = {
  title: 'Charging',
  type: 'procedure',
  lang: 'en',
  facets: { region: ['north'] },
};

describe('module model', () => {
  it('reads a module of the API as content', () => {
    const content = contentOf({
      moduleId: 'charging',
      lang: 'en',
      schemaVersion: 1,
      title: 'Charging',
      moduleType: 'procedure',
      facets: {},
      keywords: ['battery'],
      blocks: [],
    } as never);
    expect(content).toEqual({
      schemaVersion: 1,
      id: 'charging',
      meta: {
        title: 'Charging',
        type: 'procedure',
        lang: 'en',
        facets: {},
        keywords: ['battery'],
      },
      blocks: [],
    });
  });

  it('keeps a deprecation when it reads a module, and takes it away with undefined (#266)', () => {
    const deprecated = { reason: 'Superseded.', replacedBy: 'safety-note' };
    const content = contentOf({
      moduleId: 'charging',
      lang: 'en',
      schemaVersion: 1,
      title: 'Charging',
      moduleType: 'procedure',
      facets: {},
      blocks: [],
      deprecated,
    } as never);
    expect(content.meta.deprecated).toEqual(deprecated);
    expect(
      patchMeta(content.meta, { deprecated: undefined }),
    ).not.toHaveProperty('deprecated');
    expect(patchMeta(meta, { deprecated }).deprecated).toEqual(deprecated);
  });

  it('leaves out an empty audience, keyword list and facet', () => {
    expect(
      patchMeta(
        { ...meta, audience: 'public', keywords: ['a'] },
        { audience: '', keywords: [], facets: { region: [] } },
      ),
    ).toEqual({ title: 'Charging', type: 'procedure', lang: 'en', facets: {} });
  });

  it('outlines blocks with their texts, sections one level in, without blank lines', () => {
    const doc: JSONContent = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          attrs: { id: 'p1' },
          content: [{ type: 'text', text: 'Hello' }],
        },
        { type: 'paragraph', attrs: { id: 'gap' } },
        {
          type: 'section',
          attrs: { id: 's1' },
          content: [
            { type: 'title', content: [{ type: 'text', text: 'Setup' }] },
            {
              type: 'list',
              attrs: { id: 'l1' },
              content: [
                {
                  type: 'listItem',
                  content: [
                    {
                      type: 'itemText',
                      content: [{ type: 'text', text: 'One' }],
                    },
                  ],
                },
                {
                  type: 'listItem',
                  content: [
                    {
                      type: 'itemText',
                      content: [{ type: 'text', text: 'Two' }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    expect(outlineOf(doc)).toEqual([
      { id: 'p1', type: 'paragraph', label: 'Hello', depth: 0 },
      { id: 's1', type: 'section', label: 'Setup', depth: 0 },
      { id: 'l1', type: 'list', label: 'One · Two', depth: 1 },
    ]);
  });

  it('names an attachment by the name readers see', () => {
    expect(
      outlineOf({
        type: 'doc',
        content: [
          {
            type: 'attachment',
            attrs: { id: 'f1', name: 'Sample settings', fileName: 'x.zip' },
          },
        ],
      }),
    ).toEqual([
      { id: 'f1', type: 'attachment', label: 'Sample settings', depth: 0 },
    ]);
  });

  it('names a module reference by the referred module’s title, its ID while that is not known (#793)', () => {
    const doc = {
      type: 'doc',
      content: [
        { type: 'moduleRef', attrs: { id: 'r1', module: 'secure-vehicle' } },
        { type: 'moduleRef', attrs: { id: 'r2', module: 'not-read-yet' } },
      ],
    };
    const titles = new Map([['secure-vehicle', 'Secure the vehicle']]);
    expect(outlineOf(doc, (id) => titles.get(id))).toEqual([
      { id: 'r1', type: 'moduleRef', label: 'Secure the vehicle', depth: 0 },
      { id: 'r2', type: 'moduleRef', label: 'not-read-yet', depth: 0 },
    ]);
  });

  it('keeps the words of one text block together', () => {
    expect(
      textOf({
        type: 'paragraph',
        content: [
          { type: 'text', text: 'The ' },
          { type: 'text', text: 'charger', marks: [{ type: 'bold' }] },
        ],
      }),
    ).toBe('The charger');
  });

  it('finds a module in a manual at any depth', () => {
    const entries = [
      { module: 'intro' },
      { title: 'Use', entries: [{ module: 'charging' }] },
    ];
    expect(includesModule(entries as never, 'charging')).toBe(true);
    expect(includesModule(entries as never, 'other')).toBe(false);
  });
});
