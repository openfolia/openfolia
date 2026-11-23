import {
  canIndent,
  canOutdent,
  dropPreview,
  isValidTree,
  changeLevel,
  moveSubtree,
  siblingInfo,
  siblingMoveTarget,
  normalize,
  numbering,
  type ModuleTreeItem,
} from './module-tree.logic';

const tree = (spec: [string, number][]): ModuleTreeItem[] =>
  spec.map(([id, level]) => ({ id, title: id.toUpperCase(), level }));
const shape = (items: readonly ModuleTreeItem[]) =>
  items.map((i) => `${i.id}${i.level}`).join(' ');

describe('module tree logic', () => {
  const items = tree([
    ['a', 0],
    ['b', 1],
    ['c', 1],
    ['d', 0],
    ['e', 1],
  ]);

  it('numbers the outline', () => {
    expect(numbering(items)).toEqual(['1', '1.1', '1.2', '2', '2.1']);
  });

  it('indents a row that has a predecessor at its level or deeper, with its subtree', () => {
    expect(canIndent(items, 0)).toBe(false);
    expect(canIndent(items, 3)).toBe(true);
    expect(shape(changeLevel(items, 3, 1))).toBe('a0 b1 c1 d1 e2');
    expect(changeLevel(items, 1, 1)).toBe(items); // b is already one below a
  });

  it('outdents with its subtree and never above the top', () => {
    expect(shape(changeLevel(items, 1, -1))).toBe('a0 b0 c1 d0 e1');
    expect(changeLevel(items, 0, -1)).toBe(items);
  });

  it('moves a row with its nested rows down and up', () => {
    expect(shape(moveSubtree(items, 0, 4))).toBe('d0 e1 a0 b1 c1');
    expect(shape(moveSubtree(items, 3, 0))).toBe('d0 e1 a0 b1 c1');
  });

  it('pulls a moved row in when its new place cannot hold its level', () => {
    expect(shape(moveSubtree(items, 3, 0))).toBe('d0 e1 a0 b1 c1');
    expect(shape(moveSubtree(items, 2, 0))).toBe('c0 a0 b1 d0 e1');
  });

  it('ignores a drop inside its own subtree', () => {
    expect(moveSubtree(items, 0, 2)).toBe(items);
  });

  it('repairs jumps of more than one level', () => {
    expect(
      shape(
        normalize(
          tree([
            ['a', 2],
            ['b', 0],
            ['c', 3],
          ]),
        ),
      ),
    ).toBe('a0 b0 c1');
  });

  it('moves past a whole sibling subtree with Alt+Down / Alt+Up', () => {
    const t = tree([
      ['a', 0],
      ['b', 0],
      ['c', 1],
      ['d', 0],
    ]);
    expect(shape(moveSubtree(t, 0, siblingMoveTarget(t, 0, 1)!))).toBe(
      'b0 c1 a0 d0',
    );
    expect(shape(moveSubtree(t, 3, siblingMoveTarget(t, 3, -1)!))).toBe(
      'a0 d0 b0 c1',
    );
    expect(siblingMoveTarget(t, 3, 1)).toBeNull();
    expect(siblingMoveTarget(t, 2, -1)).toBeNull();
  });

  it('counts siblings, not rows', () => {
    expect(siblingInfo(items)).toEqual([
      { pos: 1, size: 2 },
      { pos: 1, size: 2 },
      { pos: 2, size: 2 },
      { pos: 2, size: 2 },
      { pos: 1, size: 1 },
    ]);
  });

  it('previews where a dragged row lands: its level and number there', () => {
    expect(dropPreview(items, 3, 0)).toEqual({ level: 0, number: '1' });
    expect(dropPreview(items, 2, 1)).toEqual({ level: 1, number: '1.1' });
    expect(dropPreview(items, 4, 1)).toEqual({ level: 1, number: '1.1' });
  });

  it('has no preview for a drop that changes nothing', () => {
    expect(dropPreview(items, 1, 1)).toBeNull();
    expect(dropPreview(items, 0, 1)).toBeNull(); // inside its own subtree
  });

  describe('with nesting rules (groups and leaves)', () => {
    // g and h are groups (they keep a row), the others leaves (they hold none).
    const ruled = (spec: [string, number][]): ModuleTreeItem[] =>
      spec.map(([id, level]) => ({
        id,
        title: id,
        level,
        nesting: id === 'g' || id === 'h' ? 'required' : 'none',
      }));
    const t = ruled([
      ['a', 0],
      ['g', 0],
      ['b', 1],
      ['c', 1],
      ['d', 0],
    ]);

    it('tells a valid tree', () => {
      expect(isValidTree(t)).toBe(true);
      expect(isValidTree(ruled([['g', 0]]))).toBe(false); // an empty group
      expect(
        isValidTree(
          ruled([
            ['a', 0],
            ['b', 1],
          ]),
        ),
      ).toBe(false); // under a leaf
    });

    it('indents only under a group', () => {
      expect(canIndent(t, 1)).toBe(false); // g after the leaf a
      // d after the group's last row, the leaf c: in, it joins the group.
      expect(shape(changeLevel(t, 4, 1))).toBe('a0 g0 b1 c1 d1');
      expect(canIndent(t, 3)).toBe(false); // c after its sibling b, a leaf
      const u = ruled([
        ['g', 0],
        ['b', 1],
        ['a', 0],
      ]);
      expect(shape(changeLevel(u, 2, 1))).toBe('g0 b1 a1');
    });

    it('never empties a group', () => {
      const one = ruled([
        ['g', 0],
        ['b', 1],
        ['a', 0],
      ]);
      expect(canOutdent(one, 1)).toBe(false);
      expect(moveSubtree(one, 1, 2)).toBe(one);
    });

    it('outdents the last row of a group in place, an earlier one to after the group', () => {
      expect(shape(changeLevel(t, 3, -1))).toBe('a0 g0 b1 c0 d0');
      expect(shape(changeLevel(t, 2, -1))).toBe('a0 g0 c1 b0 d0');
    });

    it('drops between a group and its first row into the group', () => {
      expect(shape(moveSubtree(t, 4, 2))).toBe('a0 g0 d1 b1 c1');
      expect(shape(moveSubtree(t, 0, 1))).toBe('g0 a1 b1 c1 d0');
    });

    it('drops after the last row of a group, keeping its own level where that is valid', () => {
      expect(shape(moveSubtree(t, 0, 3))).toBe('g0 b1 c1 a0 d0');

      expect(shape(moveSubtree(t, 0, 4))).toBe('g0 b1 c1 d0 a0');
    });

    it('moves a group with its rows', () => {
      const u = ruled([
        ['a', 0],
        ['g', 0],
        ['b', 1],
        ['h', 0],
        ['c', 1],
      ]);
      expect(shape(moveSubtree(u, 3, 0))).toBe('h0 c1 a0 g0 b1');
      expect(shape(changeLevel(u, 3, 1))).toBe('a0 g0 b1 h1 c2');
    });

    it('never moves another row into a different group', () => {
      const v = ruled([
        ['g', 0],
        ['a', 1],
        ['b', 1],
        ['h', 0],
        ['c', 1],
      ]);
      // h dropped between a and b: b stays in g, so h goes into g with its row.
      expect(shape(moveSubtree(v, 3, 2))).toBe('g0 a1 h1 c2 b1');
    });
  });
});
