import { alignPairs, type AlignRow } from './align-sides.directive';

/** Rows stacked one after another, each this tall; a push moves it and every row below it. */
function column(rows: [key: string, height: number][]) {
  const pushes = new Map<string, number>();
  const list: AlignRow[] = rows.map(([key], i) => ({
    key,
    top: () =>
      rows
        .slice(0, i)
        .reduce((sum, [k, h]) => sum + h + (pushes.get(k) ?? 0), 0) +
      (pushes.get(key) ?? 0),
    push: (by) => void pushes.set(key, by),
  }));
  return { list, pushes };
}

describe('alignPairs', () => {
  it('pushes the higher row of each pair down to the other’s top', () => {
    // Left: a tall changed paragraph first; right: an added one between.
    const left = column([
      ['a', 40],
      ['b', 20],
      ['c', 20],
    ]);
    const right = column([
      ['a', 60],
      ['new', 30],
      ['b', 20],
      ['c', 20],
    ]);
    expect(alignPairs(left.list, right.list)).toBe(3);
    for (const key of ['a', 'b', 'c']) {
      const l = left.list.find((r) => r.key === key)!;
      const r = right.list.find((x) => x.key === key)!;
      expect(l.top()).toBe(r.top());
    }
    // `b` on the left waits for the added row and the taller `a`.
    expect(left.pushes.get('b')).toBe(50);
  });

  it('leaves a row moved between the pairs where it is', () => {
    const left = column([
      ['x', 20],
      ['a', 20],
      ['b', 20],
    ]);
    const right = column([
      ['a', 20],
      ['b', 20],
      ['x', 20],
    ]);
    // `x` pairs first; `a` and `b` then come before it on the right and are skipped.
    expect(alignPairs(left.list, right.list)).toBe(1);
  });

  it('starts again from no pushes', () => {
    const left = column([['a', 20]]);
    const right = column([
      ['gap', 30],
      ['a', 20],
    ]);
    alignPairs(left.list, right.list);
    expect(left.pushes.get('a')).toBe(30);
    alignPairs(left.list, column([['a', 20]]).list);
    expect(left.pushes.get('a')).toBe(0);
  });
});
