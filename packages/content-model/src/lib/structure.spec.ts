import { batteryDisposal } from '../fixtures/modules.js';
import type { Block, TableCell } from './blocks.js';
import { Module } from './module.js';
import { checkStructure } from './structure.js';

const t = (text: string) => ({ type: 'text' as const, text });
let n = 0;
const para = (): Block => ({
  type: 'paragraph',
  id: `p${++n}`,
  content: [t('x')],
});
const section = (blocks: Block[]): Block => ({
  type: 'section',
  id: `s${++n}`,
  title: [t('S')],
  blocks,
});
const list = (blocks: Block[] = []): Block => ({
  type: 'list',
  id: `l${++n}`,
  ordered: false,
  items: [{ id: `i${++n}`, content: [t('x')], blocks }],
});

describe('checkStructure', () => {
  it('allows sections at module level and nested in sections', () => {
    expect(
      checkStructure([
        para(),
        section([para(), section([para()])]),
        section([]),
      ]),
    ).toEqual([]);
  });

  it('rejects sections inside other blocks', () => {
    const variant: Block = {
      type: 'variant',
      id: 'v',
      when: { op: 'in', attr: 'm', values: ['a'] },
      blocks: [section([])],
    };
    expect(checkStructure([variant])[0]).toMatch(/must be at module level/);
  });

  it('allows page breaks only at module level and directly in sections', () => {
    const pageBreak = (): Block => ({ type: 'pageBreak', id: `b${++n}` });
    expect(
      checkStructure([para(), pageBreak(), section([pageBreak(), para()])]),
    ).toEqual([]);
    const variant: Block = {
      type: 'variant',
      id: 'v',
      when: { op: 'in', attr: 'm', values: ['a'] },
      blocks: [pageBreak()],
    };
    const note: Block = {
      type: 'admonition',
      id: 'a',
      kind: 'note',
      blocks: [pageBreak()],
    };
    expect(checkStructure([variant, note, list([pageBreak()])])).toEqual([
      expect.stringMatching(/page break "b\d+" must be at module level/),
      expect.stringMatching(/page break "b\d+" must be at module level/),
      expect.stringMatching(/page break "b\d+" must be at module level/),
    ]);
  });

  it('rejects blocks after a section at the same level', () => {
    expect(checkStructure([section([]), para()])[0]).toMatch(
      /follows a section/,
    );
  });

  it('limits section and list depth', () => {
    const deepSections = [
      section([section([section([section([section([section([])])])])])]),
    ];
    expect(checkStructure(deepSections)).toHaveLength(1);
    const deepLists = [list([list([list([list([list([list()])])])])])];
    expect(checkStructure(deepLists)).toEqual([
      expect.stringMatching(/nested deeper than 5/),
    ]);
  });

  it('restarts list depth inside delimited blocks', () => {
    const note: Block = {
      type: 'admonition',
      id: 'a',
      kind: 'note',
      blocks: [list([list([list([list()])])])],
    };
    expect(checkStructure([list([list([note])])])).toEqual([]);
  });

  describe('tables', () => {
    const cell = (
      span: { colspan?: number; rowspan?: number } = {},
      blocks: Block[] = [para()],
    ): TableCell => ({
      ...span,
      blocks,
    });
    const table = (
      columns: number,
      rows: TableCell[][],
      header = false,
    ): Block => ({
      type: 'table',
      id: 'tbl',
      columns: Array.from({ length: columns }, () => ({ width: 1 })),
      header,
      rows: rows.map((cells) => ({ cells })),
    });

    it('accepts colspans and rowspans that fill the grid', () => {
      expect(
        checkStructure([
          table(3, [
            [cell({ rowspan: 2 }), cell({ colspan: 2 })],
            [cell(), cell()],
            [cell({ colspan: 3 })],
          ]),
        ]),
      ).toEqual([]);
    });

    it('rejects rows that are too short or too long', () => {
      expect(checkStructure([table(2, [[cell()]])])).toEqual([
        'table "tbl": row 1 covers 1 of 2 columns',
      ]);
      expect(checkStructure([table(2, [[cell(), cell(), cell()]])])).toEqual([
        'table "tbl": row 1 has more cells than the table\'s 2 columns',
      ]);
    });

    it('counts rowspans from earlier rows, and one bad row does not affect the rows below', () => {
      expect(
        checkStructure([
          table(2, [
            [cell({ rowspan: 2 }), cell()],
            [cell(), cell()],
          ]),
        ]),
      ).toEqual([
        'table "tbl": row 2 has more cells than the table\'s 2 columns',
      ]);
      expect(
        checkStructure([
          table(2, [
            [cell({ rowspan: 2 }), cell(), cell()],
            [cell()],
            [cell(), cell()],
          ]),
        ]),
      ).toEqual([
        'table "tbl": row 1 has more cells than the table\'s 2 columns',
      ]);
    });

    it('rejects rowspans past the last row', () => {
      expect(checkStructure([table(1, [[cell({ rowspan: 3 })]])])).toEqual([
        'table "tbl": row 1, cell 1 spans 3 rows but only 1 remain',
      ]);
    });

    it('requires simple header cells', () => {
      expect(
        checkStructure([
          table(1, [[cell({}, [para(), para()])], [cell()]], true),
        ])[0],
      ).toMatch(/header cells/);
    });

    it('rejects tables inside table cells', () => {
      expect(
        checkStructure([table(1, [[cell({}, [table(1, [[cell()]])])]])])[0],
      ).toMatch(/inside a table cell/);
    });
  });

  it('is enforced by the Module schema', () => {
    const result = Module.safeParse({
      ...batteryDisposal,
      blocks: [section([]), para()],
    });
    expect(result.error?.issues[0]?.message).toMatch(/follows a section/);
  });
});
