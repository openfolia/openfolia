import { canIndent, canOutdent, moveSubtree } from '@openfolia/ui/module-tree';

import { BUILDER_VIEW } from './builder-view';
import {
  addModule,
  moduleCount,
  removeRow,
  renameChapter,
  restoreRows,
  toEntries,
  toRows,
  wrapInChapter,
  type ManifestEntry,
  type OutlineRow,
} from './manual-outline';

const ENTRIES: ManifestEntry[] = [
  { module: 'intro' },
  {
    title: 'Operation',
    when: { in: { attribute: 'market', values: ['eu'] } } as never,
    entries: [{ module: 'charging' }, { module: 'service' }],
  },
  { module: 'intro' },
];

const shape = (rows: readonly OutlineRow[]) =>
  rows.map((r) => `${r.id}@${r.level}`).join(' ');

describe('manual outline', () => {
  it('turns entries into rows and back, keeping conditions and repeats', () => {
    const rows = toRows(ENTRIES, (id) => id.toUpperCase());
    expect(shape(rows)).toBe(
      'intro@0 chapter-1@0 charging@1 service@1 intro~2@0',
    );
    expect(rows[0]).toMatchObject({ title: 'INTRO', nesting: 'none' });
    expect(rows[1]).toMatchObject({ kind: 'chapter', nesting: 'required' });
    expect(toEntries(rows)).toEqual(ENTRIES);
    expect(moduleCount(rows)).toBe(4);
  });

  it('keeps chapters non-empty and modules leaves under the tree rules', () => {
    const rows = toRows(ENTRIES);
    expect(canIndent(rows, 1)).toBe(false); // a chapter cannot go under a module
    expect(canOutdent(rows, 3)).toBe(true); // the last module leaves the chapter
    const one = toRows([{ title: 'Only', entries: [{ module: 'a' }] }]);
    expect(canOutdent(one, 1)).toBe(false);
    expect(moveSubtree(one, 1, 0)).toBe(one);
  });

  it('adds a module after the selected row and its subtree, at its level', () => {
    const rows = toRows(ENTRIES);
    const { rows: next, id } = addModule(
      rows,
      { id: 'charging', title: 'Charging' },
      'chapter-1',
    );
    expect(id).toBe('charging~2');
    expect(shape(next)).toBe(
      'intro@0 chapter-1@0 charging@1 service@1 charging~2@0 intro~2@0',
    );
    expect(
      shape(addModule(rows, { id: 'x', title: 'X' }, 'service').rows),
    ).toBe('intro@0 chapter-1@0 charging@1 service@1 x@1 intro~2@0');
    expect(addModule([], { id: 'x', title: 'X' }, null).rows).toHaveLength(1);
  });

  it('puts a row into a new chapter and renames chapters', () => {
    const rows = toRows(ENTRIES);
    const wrapped = wrapInChapter(rows, 'chapter-1', 'Part one');
    expect(wrapped?.id).toBe('chapter-2');
    expect(shape(wrapped!.rows)).toBe(
      'intro@0 chapter-2@0 chapter-1@1 charging@2 service@2 intro~2@0',
    );
    expect(
      toEntries(renameChapter(wrapped!.rows, 'chapter-2', 'Part 1'))[1],
    ).toMatchObject({
      title: 'Part 1',
    });
  });

  it('removes a row with the chapters it leaves empty, and undoes it in place', () => {
    const rows = toRows([
      { module: 'a' },
      {
        title: 'Outer',
        entries: [{ title: 'Inner', entries: [{ module: 'b' }] }],
      },
      { module: 'c' },
    ]);
    const result = removeRow(rows, 'b');
    expect(shape(result!.rows)).toBe('a@0 c@0');
    expect(result!.removed.rows).toHaveLength(3);
    expect(shape(restoreRows(result!.rows, result!.removed))).toBe(shape(rows));
  });

  it('puts removed rows back at the end when their place is gone', () => {
    const rows = toRows([
      { title: 'Part', entries: [{ module: 'a' }, { module: 'b' }] },
    ]);
    const result = removeRow(rows, 'a')!;
    expect(shape(result.rows)).toBe('chapter-1@0 b@1');
    // Meanwhile b left too: the chapter went with it.
    const emptied = removeRow(result.rows, 'b')!;
    expect(shape(restoreRows(emptied.rows, result.removed))).toBe('a@0');
  });
});

describe('group titles per language (#731)', () => {
  const titled: ManifestEntry[] = [
    {
      title: { en: 'Operation', de: 'Bedienung' },
      entries: [{ module: 'charging' }],
    },
  ];

  it('names a chapter row by its source-language title and keeps every language', () => {
    const rows = toRows(titled, () => undefined, 'en');
    expect(rows[0]).toMatchObject({
      kind: 'chapter',
      ref: 'Operation',
      title: 'Operation',
      heading: { en: 'Operation', de: 'Bedienung' },
    });
    expect(toEntries(rows)).toEqual(titled);
  });

  it('renames and wraps with a title per language', () => {
    const rows = toRows(titled, () => undefined, 'en');
    const renamed = renameChapter(
      rows,
      'chapter-1',
      { en: 'Use', de: 'Gebrauch' },
      'en',
    );
    expect(renamed[0]).toMatchObject({ ref: 'Use', title: 'Use' });
    expect(toEntries(renamed)[0]).toMatchObject({
      title: { en: 'Use', de: 'Gebrauch' },
    });
    const wrapped = wrapInChapter(
      toRows([{ module: 'intro' }]),
      'intro',
      { en: 'Start', fr: 'Début' },
      'en',
    );
    expect(wrapped && toEntries(wrapped.rows)).toEqual([
      { title: { en: 'Start', fr: 'Début' }, entries: [{ module: 'intro' }] },
    ]);
  });
});

describe('builder view in the address', () => {
  const parse = (key: keyof typeof BUILDER_VIEW, value: string) =>
    BUILDER_VIEW[key].parse([value]);

  it('keeps values of their form', () => {
    expect(parse('manual', 'operating-manual')).toBe('operating-manual');
    expect(parse('node', 'charging~2')).toBe('charging~2');
    expect(parse('lang', 'de')).toBe('de');
    expect(parse('variant', 'model=l-400,software=2.3')).toBe(
      'model=l-400,software=2.3',
    );
  });

  it('drops the others: paths, spaces, anything else', () => {
    expect(parse('manual', '../x')).toBeUndefined();
    expect(parse('lang', 'de/../')).toBeUndefined();
    expect(parse('node', 'Foo Bar')).toBeUndefined();
    expect(parse('variant', '!!')).toBeUndefined();
    expect(BUILDER_VIEW.manual.parse(['a', 'b'])).toBeUndefined();
  });
});
