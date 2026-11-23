import {
  diffBlocks,
  sectionTitle,
  type Block,
  type BlockDiff,
} from './block-diff';
import { countChanges, foldUnchanged } from './tree-diff';

const text = (t: string) => [{ type: 'text' as const, text: t }];
const p = (id: string, t: string): Block => ({
  type: 'paragraph',
  id,
  content: text(t),
});
const section = (id: string, title: string, blocks: Block[]): Block => ({
  type: 'section',
  id,
  title: text(title),
  blocks,
});

/** The compared nodes in reading order, with what the reviewer is told. */
const flat = (nodes: readonly BlockDiff[], depth = 0): string[] =>
  nodes.flatMap((n) => [
    `${'  '.repeat(depth)}${n.ghost ? 'ghost' : n.change}${n.hunk ? `(${n.hunk})` : ''}${n.wraps ? ' wraps' : ''}${n.unwraps ? ' unwraps' : ''}${n.inherited ? ' inherited' : ''}${n.movedFrom ? ` from:${n.movedFrom.parentId}` : ''}${n.movedTo ? ` to:${n.movedTo.parentId}` : ''} ${n.id}`,
    ...flat(n.children, depth + 1),
  ]);

describe('diffBlocks', () => {
  it('names a new variant block around an existing paragraph as one wrap, not an add and a move', () => {
    const before = [p('intro', 'It charges.'), p('end', 'Done.')];
    const after: Block[] = [
      {
        type: 'variant',
        id: 'small',
        when: { op: 'in', attr: 'model', values: ['small'] },
        blocks: [p('intro', 'It charges.')],
      },
      p('end', 'Done.'),
    ];
    const nodes = diffBlocks(before, after);
    expect(flat(nodes)).toEqual([
      'added(added) wraps small',
      '  same intro',
      'same end',
    ]);
    expect(countChanges(nodes)).toEqual({
      added: 1,
      removed: 0,
      changed: 0,
      moved: 0,
    });
  });

  it('names a frame taken away as one unwrap, its content kept in place', () => {
    const before: Block[] = [
      { type: 'admonition', id: 'note', kind: 'note', blocks: [p('a', 'A.')] },
    ];
    const nodes = diffBlocks(before, [p('a', 'A.')]);
    expect(flat(nodes)).toEqual(['removed(removed) unwraps note', 'same a']);
  });

  it('counts what a new block holds as part of it, never on its own', () => {
    const after: Block[] = [
      {
        type: 'safety',
        id: 'hot',
        severity: 'warning',
        hazard: text('Hot contacts'),
        symbols: [],
        blocks: [p('c', 'Burns.'), p('m', 'Wait.')],
      },
    ];
    const nodes = diffBlocks([], after);
    expect(flat(nodes)).toEqual([
      'added(added) hot',
      '  added inherited c',
      '  added inherited m',
    ]);
    expect(countChanges(nodes).added).toBe(1);
  });

  it('marks a block moved to another section, with a ghost where it stood', () => {
    const before = [
      section('s1', 'Before you start', [p('a', 'A.')]),
      section('s2', 'Charging', [p('b', 'B.'), p('store', 'Store it.')]),
    ];
    const after = [
      section('s1', 'Before you start', [
        p('a', 'A.'),
        p('store', 'Store it.'),
      ]),
      section('s2', 'Charging', [p('b', 'B.')]),
    ];
    const nodes = diffBlocks(before, after);
    expect(flat(nodes)).toEqual([
      'same s1',
      '  same a',
      '  same(moved) from:s2 store',
      'same s2',
      '  same b',
      '  ghost to:s1 store',
    ]);
    expect(sectionTitle(before, 's2')).toBe('Charging');
    expect(countChanges(nodes).moved).toBe(1);
  });

  it('marks a reordered block once, with a ghost at its old place', () => {
    const nodes = diffBlocks(
      [p('a', 'A.'), p('b', 'B.'), p('c', 'C.')],
      [p('b', 'B.'), p('c', 'C.'), p('a', 'A.')],
    );
    expect(flat(nodes)).toEqual([
      'ghost to:null a',
      'same b',
      'same c',
      'same(moved) from:null a',
    ]);
  });

  it('compares a changed text word by word, and a removed one whole', () => {
    const nodes = diffBlocks(
      [p('a', 'Park near the station.'), p('gone', 'Takes two hours.')],
      [p('a', 'Park close to the station.')],
    );
    const [changed, removed] = nodes;
    expect(changed?.change).toBe('changed');
    expect(changed?.texts['text']).toEqual([
      { op: 'same', text: 'Park ' },
      { op: 'del', text: 'near ' },
      { op: 'ins', text: 'close to ' },
      { op: 'same', text: 'the station.' },
    ]);
    expect(removed?.change).toBe('removed');
    // A whole block removed is marked at the block, not word by word.
    expect(removed?.texts['text']).toEqual([
      { op: 'same', text: 'Takes two hours.' },
    ]);
  });

  it('compares list items and steps by their own IDs', () => {
    const steps = (second: string): Block => ({
      type: 'procedure',
      id: 'proc',
      steps: [
        { id: 's1', content: text('Drive on.'), blocks: [] },
        { id: 's2', content: text(second), blocks: [] },
      ],
    });
    const nodes = diffBlocks(
      [steps('Wait for green.')],
      [steps('Wait for steady green.')],
    );
    expect(flat(nodes)).toEqual([
      'same proc',
      '  same s1',
      '  changed(changed) s2',
    ]);
  });

  it('sees an image replaced, and its alt text and caption word by word', () => {
    const img = (asset: string, alt: string): Block => ({
      type: 'image',
      id: 'photo',
      asset,
      alt,
      title: text('Wall charger'),
    });
    const [node] = diffBlocks(
      [img(`sha256:${'a'.repeat(64)}`, 'The charger')],
      [img(`sha256:${'b'.repeat(64)}`, 'The charger with its ring')],
    );
    expect(node?.change).toBe('changed');
    expect(node?.texts['text']).toContainEqual({
      op: 'ins',
      text: ' with its ring',
    });
    expect(node?.texts['caption']).toEqual([
      { op: 'same', text: 'Wall charger' },
    ]);
  });
});

describe('settings a text diff does not show', () => {
  const table = (
    align: 'left' | 'center' | 'right' | undefined,
    colspan?: number,
  ): Block => ({
    type: 'table',
    id: 't',
    header: false,
    columns: [{ width: 1, ...(align ? { align } : {}) }, { width: 1 }],
    rows: [
      {
        cells: colspan
          ? [{ colspan, blocks: [p('a', 'a')] }]
          : [{ blocks: [p('a', 'a')] }, { blocks: [p('b', 'b')] }],
      },
    ],
  });
  const changed = (before: Block, after: Block) =>
    diffBlocks([before], [after])[0]?.change;

  it('mark a table changed when a column is aligned or cells are merged', () => {
    expect(changed(table(undefined), table(undefined))).toBe('same');
    expect(changed(table(undefined), table('center'))).toBe('changed');
    expect(changed(table(undefined), table(undefined, 2))).toBe('changed');
  });

  it('mark a code block changed when its language changes', () => {
    const code = (language?: string): Block => ({
      type: 'literal',
      id: 't',
      text: 'a: 1',
      ...(language ? { language } : {}),
    });
    expect(changed(code('yaml'), code('yaml'))).toBe('same');
    expect(changed(code('yaml'), code('json'))).toBe('changed');
    expect(changed(code(), code('json'))).toBe('changed');
  });

  it('marks a block moved to an earlier cell once, with a ghost in the table', () => {
    const grid = (ids: string[]): Block => ({
      type: 'table',
      id: 't',
      header: false,
      columns: [{ width: 1 }, { width: 1 }, { width: 1 }],
      rows: [{ cells: ids.map((id) => ({ blocks: [p(id, id)] })) }],
    });
    const [table] = diffBlocks(
      [grid(['a', 'b', 'c'])],
      [grid(['c', 'a', 'b'])],
    );
    const moved = table?.children.filter((c) => c.id === 'c');
    expect(moved?.map((c) => (c.ghost ? 'ghost' : c.hunk))).toEqual([
      'moved',
      'ghost',
    ]);
  });

  it('compares an attachment by its facts', () => {
    const attachment = (fileName: string): Block => ({
      type: 'attachment',
      id: 'f1',
      asset: `sha256:${'a'.repeat(64)}`,
      name: 'Settings',
      fileName,
      mediaType: 'application/zip',
      size: 1200,
    });
    const [node] = diffBlocks(
      [attachment('settings.zip')],
      [attachment('settings-v2.zip')],
    );
    expect(node?.change).toBe('changed');
    const inserted = (node?.texts['text'] ?? [])
      .filter((s) => s.op === 'ins')
      .map((s) => s.text)
      .join('');
    expect(inserted).toContain('v2');
  });
});

describe('foldUnchanged', () => {
  const same = (n: number) =>
    diffBlocks(
      Array.from({ length: n }, (_, i) => p(`p${i}`, `${i}`)),
      Array.from({ length: n }, (_, i) => p(`p${i}`, `${i}`)),
    );

  it('folds runs of unchanged blocks, keeping one block of context beside a change', () => {
    const before = Array.from({ length: 8 }, (_, i) => p(`p${i}`, `${i}`));
    const after = before.map((b, i) => (i === 4 ? p('p4', 'four') : b));
    const shown = foldUnchanged(diffBlocks(before, after));
    expect(
      shown.map((s) =>
        s.kind === 'run' ? `run ${s.key} ${s.nodes.length}` : s.node.id,
      ),
    ).toEqual(['run p0 3', 'p3', 'p4', 'p5', 'run p6 2']);
  });

  it('shows a few unchanged blocks as they are, and folds more', () => {
    expect(foldUnchanged(same(3)).every((s) => s.kind === 'node')).toBe(true);
    expect(foldUnchanged(same(5))).toHaveLength(1);
  });
});
