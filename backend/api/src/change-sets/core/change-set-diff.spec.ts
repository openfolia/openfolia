import type { Block, Manifest, Module } from '@openfolia/content-model';
import { manifest, module } from '../../../tests/fakes/fake-content.js';
import { diffBlocks, subjectChange } from './change-set-diff.js';

const text = (t: string) => [{ type: 'text' as const, text: t }];
const p = (id: string, t = id): Block => ({
  type: 'paragraph',
  id,
  content: text(t),
});
const section = (id: string, blocks: Block[], title = id): Block => ({
  type: 'section',
  id,
  title: text(title),
  blocks,
});

describe('diffBlocks', () => {
  it('lists nothing for the same blocks', () => {
    const blocks = [p('a'), section('s', [p('b'), p('c')])];
    expect(diffBlocks(blocks, structuredClone(blocks))).toEqual([]);
  });

  it('names added, changed and removed blocks by ID, the unchanged not at all', () => {
    expect(
      diffBlocks(
        [p('a'), p('b'), p('c')],
        [p('new'), p('a'), p('b', 'edited')],
      ),
    ).toEqual([
      { blockId: 'new', change: 'added' },
      { blockId: 'b', change: 'changed' },
      { blockId: 'c', change: 'removed' },
    ]);
  });

  it('keeps unchanged blocks out wherever their siblings moved', () => {
    expect(
      diffBlocks(
        [p('a'), p('b'), p('c')],
        [p('c'), p('inserted'), p('a'), p('b')],
      ),
    ).toEqual([{ blockId: 'inserted', change: 'added' }]);
  });

  it('gives an edit inside a container to the inner block alone', () => {
    expect(
      diffBlocks(
        [section('s', [p('a'), p('b')])],
        [section('s', [p('a', 'edited'), p('b')])],
      ),
    ).toEqual([{ blockId: 'a', change: 'changed' }]);
    expect(
      diffBlocks([section('s', [p('a')])], [section('s', [p('a')], 'Renamed')]),
    ).toEqual([{ blockId: 's', change: 'changed' }]);
  });

  it('gives an edit in an FAQ entry’s answer to the answer’s block alone', () => {
    const faq = (question: string, blocks: Block[]): Block => ({
      type: 'faq',
      id: 'q',
      question: text(question),
      blocks,
    });
    expect(
      diffBlocks(
        [faq('Why?', [p('a'), p('b')])],
        [faq('Why?', [p('a', 'edited'), p('b')])],
      ),
    ).toEqual([{ blockId: 'a', change: 'changed' }]);
    expect(
      diffBlocks([faq('Why?', [p('a')])], [faq('Why not?', [p('a')])]),
    ).toEqual([{ blockId: 'q', change: 'changed' }]);
  });

  it('changes a container whose children are added, removed or reordered', () => {
    expect(
      diffBlocks(
        [section('s', [p('a'), p('b')])],
        [section('s', [p('b'), p('a'), p('c')])],
      ),
    ).toEqual([
      { blockId: 's', change: 'changed' },
      { blockId: 'c', change: 'added' },
    ]);
  });

  it('counts a block moved to another parent as changed, with both parents', () => {
    expect(
      diffBlocks(
        [section('s', [p('a')]), section('t', [])],
        [section('s', []), section('t', [p('a')])],
      ),
    ).toEqual([
      { blockId: 's', change: 'changed' },
      { blockId: 't', change: 'changed' },
      { blockId: 'a', change: 'changed' },
    ]);
  });

  it('diffs list items and steps', () => {
    const list = (items: [string, string][]): Block => ({
      type: 'list',
      id: 'l',
      ordered: false,
      items: items.map(([id, t]) => ({ id, content: text(t), blocks: [] })),
    });
    expect(
      diffBlocks(
        [
          list([
            ['i1', 'one'],
            ['i2', 'two'],
          ]),
        ],
        [list([['i1', 'uno']])],
      ),
    ).toEqual([
      { blockId: 'l', change: 'changed' },
      { blockId: 'i1', change: 'changed' },
      { blockId: 'i2', change: 'removed' },
    ]);
  });

  it('keeps the blocks of a table unchanged when a row is added above them', () => {
    const table = (rows: Block[][][]): Block => ({
      type: 'table',
      id: 't',
      columns: [{ width: 1 }, { width: 1 }],
      header: false,
      rows: rows.map((cells) => ({
        cells: cells.map((blocks) => ({ blocks })),
      })),
    });
    const below = [[p('x')], [p('y')]];
    expect(
      diffBlocks([table([below])], [table([[[p('new')], []], below])]),
    ).toEqual([
      { blockId: 't', change: 'changed' },
      { blockId: 'new', change: 'added' },
    ]);
    // An edit in a cell is the block's; a move between cells the table's.
    expect(
      diffBlocks([table([below])], [table([[[p('x', 'edited')], [p('y')]]])]),
    ).toEqual([{ blockId: 'x', change: 'changed' }]);
    expect(
      diffBlocks([table([below])], [table([[[p('y')], [p('x')]]])]),
    ).toEqual([{ blockId: 't', change: 'changed' }]);
  });
});

describe('subjectChange', () => {
  const subject = { type: 'module', lang: 'en', moduleId: 'm' } as const;
  const before = module('m');
  const edited: Module = {
    ...before,
    meta: { ...before.meta, title: 'New title' },
    blocks: [p('p', 'Edited.'), p('q')],
  };

  it('names the fields and blocks of a changed module', () => {
    expect(subjectChange(subject, before, edited)).toEqual({
      subject,
      change: 'changed',
      fields: ['title'],
      blocks: [
        { blockId: 'p', change: 'changed' },
        { blockId: 'q', change: 'added' },
      ],
      unreadable: false,
    });
  });

  it('shows nothing when neither side is there or both are the same', () => {
    expect(subjectChange(subject, undefined, undefined)).toBeUndefined();
    expect(
      subjectChange(subject, before, structuredClone(before)),
    ).toBeUndefined();
  });

  it('tells added and removed apart, without fields or blocks', () => {
    expect(subjectChange(subject, undefined, before)).toMatchObject({
      change: 'added',
      fields: [],
      blocks: [],
    });
    expect(subjectChange(subject, before, undefined)).toMatchObject({
      change: 'removed',
    });
  });

  it('marks a side that cannot be read', () => {
    expect(subjectChange(subject, 'unreadable', before)).toEqual({
      subject,
      change: 'changed',
      fields: [],
      blocks: [],
      unreadable: true,
    });
    expect(subjectChange(subject, undefined, 'unreadable')).toMatchObject({
      change: 'added',
      unreadable: true,
    });
  });

  it('names the members of a changed manifest', () => {
    const manual = { type: 'manual', manualId: 'x' } as const;
    const was = manifest('x', ['a']);
    const now: Manifest = { ...manifest('x', ['a', 'b']), title: 'Other' };
    expect(subjectChange(manual, was, now)).toMatchObject({
      change: 'changed',
      fields: ['entries', 'title'],
      blocks: [],
    });
  });
});
