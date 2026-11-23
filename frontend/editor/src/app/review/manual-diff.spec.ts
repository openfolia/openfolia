import type { ShownConfig as ProjectConfig } from '../i18n';

import { chapterTitle, diffEntries, type EntryDiff } from './manual-diff';
import { manualFields, moduleFields } from './meta-diff';

const flat = (nodes: readonly EntryDiff[], depth = 0): string[] =>
  nodes.flatMap((n) => [
    `${'  '.repeat(depth)}${n.ghost ? 'ghost' : n.change}${n.hunk ? `(${n.hunk})` : ''} ${n.id}`,
    ...flat(n.children, depth + 1),
  ]);

describe('diffEntries', () => {
  it('shows an entry added to a chapter', () => {
    const nodes = diffEntries(
      [{ title: 'Daily use', entries: [{ module: 'charging' }] }],
      [
        {
          title: 'Daily use',
          entries: [{ module: 'charging' }, { module: 'safety-note' }],
        },
      ],
    );
    expect(flat(nodes)).toEqual([
      'same chapter:0',
      '  same module:charging',
      '  added(added) module:safety-note',
    ]);
  });

  it('matches a renamed chapter by the modules it holds, and names the move between chapters', () => {
    const before = [
      { title: 'Daily use', entries: [{ module: 'a' }, { module: 'b' }] },
      { title: 'Care', entries: [{ module: 'c' }] },
    ];
    const after = [
      { title: 'Everyday use', entries: [{ module: 'a' }] },
      { title: 'Care', entries: [{ module: 'c' }, { module: 'b' }] },
    ];
    const nodes = diffEntries(before, after);
    expect(flat(nodes)).toEqual([
      'changed(changed) chapter:1',
      '  same module:a',
      '  ghost module:b',
      'same chapter:0',
      '  same module:c',
      '  same(moved) module:b',
    ]);
    const renamed = nodes[0];
    expect(renamed?.texts['text']).toEqual([
      { op: 'del', text: 'Daily' },
      { op: 'ins', text: 'Everyday' },
      { op: 'same', text: ' use' },
    ]);
    const moved = nodes[1]?.children[1];
    expect(
      chapterTitle(nodes, moved?.movedFrom?.parentId ?? null, 'before'),
    ).toBe('Daily use');
  });

  it('keeps a module used twice apart', () => {
    const nodes = diffEntries(
      [{ module: 'a' }],
      [{ module: 'a' }, { module: 'a' }],
    );
    expect(flat(nodes)).toEqual(['same module:a', 'added(added) module:a:2']);
  });
});

const config = {
  moduleTypes: [
    { id: 'procedure', label: 'Procedure', restricted: false, snippet: false },
  ],
  audiences: [
    { id: 'public', label: 'Public' },
    { id: 'internal', label: 'Internal' },
  ],
  facets: [
    {
      id: 'region',
      label: 'Region',
      values: [
        { id: 'north', label: 'North' },
        { id: 'south', label: 'South' },
      ],
    },
  ],
  variantAttributes: [
    {
      id: 'model',
      label: 'Model',
      kind: 'enum',
      values: [
        { id: 'small', label: 'Small' },
        { id: 'large', label: 'Large' },
      ],
    },
  ],
  textAttributes: [],
} as unknown as ProjectConfig;

describe('moduleFields', () => {
  const module = (over: Record<string, unknown>) =>
    ({
      moduleId: 'charging',
      lang: 'en',
      schemaVersion: 1,
      title: 'Charging',
      moduleType: 'procedure',
      audience: 'public',
      facets: { region: ['north'] },
      keywords: ['battery'],
      blocks: [],
      ...over,
    }) as never;

  it('lists only what changed, by the configured labels, each side marked', () => {
    const fields = moduleFields(
      module({}),
      module({
        audience: 'internal',
        facets: { region: ['north', 'south'] },
        keywords: ['battery', 'charging station'],
      }),
      config,
    );
    expect(fields.map((f) => f.field)).toEqual([
      'editor.review.meta.field.audience',
      'editor.review.meta.field.facets',
      'editor.review.meta.field.keywords',
    ]);
    expect(fields[0]?.before).toEqual([{ op: 'del', text: 'Public' }]);
    expect(fields[0]?.after).toEqual([{ op: 'ins', text: 'Internal' }]);
    expect(fields[1]?.after).toEqual([
      { op: 'same', text: 'Region: North' },
      { op: 'same', text: ', ' },
      { op: 'ins', text: 'Region: South' },
    ]);
  });

  it('compares the deprecation, marked as such (#266)', () => {
    const [field] = moduleFields(
      module({}),
      module({
        deprecated: { reason: 'Superseded.', replacedBy: 'safety-note' },
      }),
      config,
    );
    expect(field).toMatchObject({
      field: 'editor.review.meta.field.deprecated',
      deprecation: true,
      before: [],
    });
    expect(field?.after.map((s) => s.text).join('')).toBe(
      'Superseded. → safety-note',
    );
  });

  it('has nothing to compare for a module added or removed', () => {
    expect(moduleFields(null, module({}), config)).toEqual([]);
  });
});

describe('manualFields', () => {
  it('names variants by their labels', () => {
    const manual = (variants: Record<string, string>[]) =>
      ({
        schemaVersion: 1,
        title: 'Operating manual',
        variants,
        textAttributes: {},
        entries: [],
      }) as never;
    const [field] = manualFields(
      manual([{ model: 'small' }]),
      manual([{ model: 'small' }, { model: 'large' }]),
      config,
    );
    expect(field?.field).toBe('editor.review.meta.field.variants');
    expect(field?.after.at(-1)).toEqual({ op: 'ins', text: 'Model: Large' });
  });
});
