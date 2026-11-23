import {
  afterApplied,
  afterUndone,
  changeOf,
  styleItems,
  type StyleSuggestion,
  textAfter,
  undoOf,
} from './suggestion-items';

const suggestion = (
  id: string,
  blockId: string,
  field: StyleSuggestion['field'],
  start: number,
  original: string,
  replacement: string | null,
): StyleSuggestion => ({
  id,
  blockId,
  field,
  range: { start, end: start + original.length },
  original,
  message: `About ${original}`,
  replacement,
  rule: 'model',
});

const TEXTS: Record<string, string> = {
  'pump-1/legend': 'Utilize the outlet in order to drain',
  'p1/content': 'Switch it off.',
};
const textOf = (blockId: string, field: string) =>
  TEXTS[`${blockId}/${field}`] ?? null;

describe('suggestion items (#573)', () => {
  const items = styleItems(
    [
      suggestion('a', 'pump-1', 'legend', 0, 'Utilize', 'Use'),
      suggestion('b', 'pump-1', 'legend', 19, 'in order to', 'to'),
      suggestion('c', 'pump-1', 'legend', 4, 'ize the', 'x'),
      suggestion('d', 'p1', 'content', 7, 'it', null),
      suggestion('e', 'gone', 'legend', 0, 'x', 'y'),
      suggestion('f', 'p1', 'content', 0, 'Turn', 'Switch'),
    ],
    textOf,
  );

  it('holds each suggestion against the text it was made for', () => {
    expect(items.map((i) => [i.id, i.expected])).toEqual([
      ['a', TEXTS['pump-1/legend']],
      ['b', TEXTS['pump-1/legend']],
      ['c', TEXTS['pump-1/legend']],
      ['d', TEXTS['p1/content']],
      // No such field, or a range that does not hold its original: nothing to apply.
      ['e', null],
      ['f', null],
    ]);
    expect(changeOf(items[3]!)).toBeNull(); // a remark without a fix
    expect(changeOf(items[4]!)).toBeNull();
    expect(changeOf(items[0]!)).toEqual({
      blockId: 'pump-1',
      field: 'legend',
      range: { start: 0, end: 7 },
      original: 'Utilize',
      replacement: 'Use',
      expected: TEXTS['pump-1/legend'],
    });
  });

  it('moves the others on the field along once one is applied, and drops the overlapping', () => {
    const a = items[0]!;
    expect(textAfter(a)).toBe('Use the outlet in order to drain');
    const next = afterApplied(items, a);
    expect(next.map((i) => i.id)).toEqual(['b', 'c', 'd', 'e', 'f']);
    const b = next[0]!;
    expect(b.range).toEqual({ start: 15, end: 26 });
    expect(b.expected).toBe('Use the outlet in order to drain');
    expect(b.expected!.slice(b.range.start, b.range.end)).toBe('in order to');
    // Overlapped the applied range: it no longer fits.
    expect(next[1]!.expected).toBeNull();
    // Another field: unchanged.
    expect(next[2]).toBe(items[3]);
  });

  it('takes an applied one back out, with its field’s items as they were', () => {
    const a = items[0]!;
    const undo = undoOf(a);
    expect(undo).toEqual({
      blockId: 'pump-1',
      field: 'legend',
      range: { start: 0, end: 3 },
      original: 'Use',
      replacement: 'Utilize',
      expected: 'Use the outlet in order to drain',
    });
    // Meanwhile another field's item was dismissed: it stays gone.
    const now = afterApplied(items, a).filter((i) => i.id !== 'd');
    expect(afterUndone(now, items, a).map((i) => i.id)).toEqual([
      'a',
      'b',
      'c',
      'e',
      'f',
    ]);
  });
});
