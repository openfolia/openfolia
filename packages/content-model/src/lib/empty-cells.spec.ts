import { sampleConfig } from '../fixtures/config.js';
import { batteryDisposal } from '../fixtures/modules.js';
import type { Block, Table } from './blocks.js';
import { ProjectConfig } from './config.js';
import { Module } from './module.js';
import { parseModule } from './asciidoc/parse.js';
import { printModule } from './asciidoc/print.js';
import { validateModule } from './validate.js';

const config = ProjectConfig.parse(sampleConfig);
const p = (id: string, text: string): Block => ({
  type: 'paragraph',
  id,
  content: [{ type: 'text', text }],
});

const table = (header: boolean, rows: Block[][][]): Table => ({
  type: 'table',
  id: 'grid',
  header,
  columns: (rows[0] ?? []).map(() => ({ width: 1 })),
  rows: rows.map((cells) => ({ cells: cells.map((blocks) => ({ blocks })) })),
});

const moduleWith = (block: Table) =>
  Module.parse({ ...batteryDisposal, blocks: [block] });

const CASES: [string, Table][] = [
  [
    'an empty cell',
    table(false, [
      [[p('a', 'a')], []],
      [[p('c', 'c')], [p('d', 'd')]],
    ]),
  ],
  [
    'an empty column under a header row',
    table(true, [
      [[p('h1', 'Item')], [p('h2', 'Note')]],
      [[p('a', 'Cable')], []],
      [[p('b', 'Plug')], []],
    ]),
  ],
  [
    'an empty header cell',
    table(true, [
      [[p('h1', 'Item')], []],
      [[], []],
    ]),
  ],
  [
    'an all-empty table',
    table(false, [
      [[], []],
      [[], []],
    ]),
  ],
];

describe('empty table cells', () => {
  it.each(CASES)('are a valid module: %s', (_, t) => {
    expect(() => moduleWith(t)).not.toThrow();
  });

  it.each(CASES)('round-trip through AsciiDoc: %s', (_, t) => {
    const module = moduleWith(t);
    const text = printModule(module);
    expect(parseModule(text, { id: module.id })).toEqual(module);
  });

  it('print as a bare "|"', () => {
    const text = printModule(moduleWith(CASES[0]![1]));
    expect(text).toContain('|[[a]]a |\n');
  });

  it('only warn, and only when the whole table is empty', () => {
    for (const [name, t] of CASES) {
      const issues = validateModule(moduleWith(t), config);
      const all = name === 'an all-empty table';
      expect(issues.map((i) => i.code)).toEqual(all ? ['empty-table'] : []);
      expect(issues.every((i) => i.severity === 'warning')).toBe(true);
    }
  });
});
