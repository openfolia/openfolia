import {
  autoScrollStep,
  chooseTarget,
  flipShifts,
  indexBefore,
  type PlacedTarget,
} from './drag-geometry';

const place = (
  pos: number,
  top: number,
  extra: Partial<PlacedTarget> = {},
): PlacedTarget => ({
  pos,
  boundary: pos,
  level: null,
  refusal: null,
  home: false,
  top,
  ...extra,
});

describe('choosing where a dragged block goes', () => {
  const targets = [
    place(0, 0),
    place(5, 30, { home: true }),
    place(9, 60),
    place(14, 90, { refusal: 'schema' }),
  ];

  it('takes the place whose slot would stand nearest the copy', () => {
    expect(chooseTarget(targets, 8, null)?.pos).toBe(0);
    expect(chooseTarget(targets, 20, null)?.pos).toBe(5);
    expect(chooseTarget(targets, 300, null)?.pos).toBe(14);
  });

  it('hands back a refused place as it is, for the drag to say why', () => {
    expect(chooseTarget(targets, 88, null)?.refusal).toBe('schema');
  });

  it("takes a section to the level the pointer asks for among one boundary's places", () => {
    const boundary = [
      place(20, 100, { boundary: 22, level: 3 }),
      place(21, 102, { boundary: 22, level: 2 }),
      place(22, 104, { boundary: 22, level: 1 }),
    ];
    expect(chooseTarget(boundary, 100, 2)?.level).toBe(2);
    expect(chooseTarget(boundary, 100, 1)?.level).toBe(1);
    expect(chooseTarget(boundary, 100, 9)?.level).toBe(3);
  });

  it('passes over a refused level for an allowed one at the same boundary, else says why', () => {
    const capped = [
      place(20, 100, { boundary: 22, level: 3, refusal: 'cap' }),
      place(22, 104, { boundary: 22, level: 2 }),
    ];
    expect(chooseTarget(capped, 100, 3)?.level).toBe(2);
    const refused = [
      place(20, 100, { boundary: 22, refusal: 'variant' }),
      place(22, 104, { boundary: 22, level: 4, refusal: 'cap' }),
    ];
    expect(chooseTarget(refused, 100, 4)?.refusal).toBe('cap');
  });

  it('has nothing to choose from no places', () => {
    expect(chooseTarget([], 0, null)).toBeNull();
  });
});

describe('scrolling near the edge while dragging', () => {
  it('scrolls up near the top and down near the bottom, faster the closer', () => {
    expect(autoScrollStep(300, 0, 600)).toBe(0);
    expect(autoScrollStep(40, 0, 600)).toBeLessThan(0);
    expect(autoScrollStep(2, 0, 600)).toBeLessThan(autoScrollStep(40, 0, 600));
    expect(autoScrollStep(590, 0, 600)).toBeGreaterThan(0);
    expect(autoScrollStep(-50, 0, 600)).toBe(-16);
    expect(autoScrollStep(900, 0, 600)).toBe(16);
  });

  it('keeps the edge zones within a small scroll area', () => {
    expect(autoScrollStep(50, 0, 90)).toBe(0);
    expect(autoScrollStep(5, 0, 0)).toBe(0);
  });
});

describe('the slide after a keyboard move', () => {
  it('maps a new index back to the old one', () => {
    // 0 to 2: new order is [1, 2, 0, 3].
    expect([0, 1, 2, 3].map((i) => indexBefore(i, 0, 2))).toEqual([1, 2, 0, 3]);
    // 3 to 1: new order is [0, 3, 1, 2].
    expect([0, 1, 2, 3].map((i) => indexBefore(i, 3, 1))).toEqual([0, 3, 1, 2]);
  });

  it('pushes each block back to where it stood, for the first frame of a keyboard move', () => {
    // Block 1 moved up to 0: the new tops are [0, 50] where the old were [0, 30].
    expect(flipShifts([0, 30], [0, 50], 1, 0)).toEqual([30, -50]);
  });
});
