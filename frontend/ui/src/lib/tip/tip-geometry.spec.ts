import { arrowFor, centredTop, clearOf } from './tip-geometry';
import { withinWindow } from './tip-overlay';

const box = (left: number, top: number, width: number, height: number) => ({
  left,
  top,
  width,
  height,
});

describe('the arrow toward the anchor (#868)', () => {
  const anchor = box(100, 100, 40, 20);

  it('sits on the edge that faces the anchor, at its centre', () => {
    expect(arrowFor(box(90, 132, 300, 120), anchor)).toEqual({
      side: 'top',
      offset: 30,
    });
    expect(arrowFor(box(90, -40, 300, 128), anchor)).toEqual({
      side: 'bottom',
      offset: 30,
    });
    expect(arrowFor(box(152, 80, 300, 120), anchor)).toEqual({
      side: 'left',
      offset: 30,
    });
    expect(arrowFor(box(-212, 80, 300, 120), anchor)).toEqual({
      side: 'right',
      offset: 30,
    });
  });

  it('keeps off the card’s rounded corners', () => {
    expect(arrowFor(box(130, 132, 300, 120), anchor)?.offset).toBe(18);
    expect(arrowFor(box(-400, 132, 300, 120), anchor)).toEqual({
      side: 'top',
      offset: 282,
    });
  });

  it('is none when the card overlaps its anchor', () => {
    expect(arrowFor(box(90, 90, 300, 120), anchor)).toBeNull();
  });
});

describe('a centred card', () => {
  it('sits in the middle of the window', () => {
    expect(centredTop(200, 900, 0)).toBe(350);
  });

  it('goes below what it keeps clear of', () => {
    expect(centredTop(200, 900, 400)).toBe(416);
  });

  it('never runs past the window’s bottom', () => {
    expect(centredTop(200, 500, 400)).toBe(284);
    expect(centredTop(600, 500, 0)).toBe(16);
  });
});

describe('the spotlight within the window (#869)', () => {
  it('closes a box wider than the window inside it, and leaves one inside alone', () => {
    expect(
      withinWindow({ left: 2, top: 400, width: 900, height: 60 }, 390, 844),
    ).toEqual({ left: 6, top: 400, width: 378, height: 60 });
    const inside = { left: 20, top: 30, width: 100, height: 40 };
    expect(withinWindow(inside, 1440, 900)).toEqual(inside);
  });
});

describe('a card clear of the person’s edit (issue 869)', () => {
  // The sentence just changed, under a card beside the sidebar's Review.
  const sentence = box(520, 190, 540, 30);

  it('moves below the sentence it would cover, or above it with no room below', () => {
    expect(clearOf(box(270, 190, 350, 200), sentence, 900, 16)).toBe(46);
    // Not covering it (beside, or already below): stays.
    expect(clearOf(box(100, 190, 350, 200), sentence, 900, 16)).toBe(0);
    expect(clearOf(box(270, 240, 350, 200), sentence, 900, 16)).toBe(0);
    // No room below in a short window: above the sentence.
    const low = box(520, 600, 540, 30);
    expect(clearOf(box(270, 560, 350, 200), low, 820, 16)).toBe(-176);
    // Room neither way: stays, rather than leave the window.
    expect(clearOf(box(270, 100, 350, 600), sentence, 720, 16)).toBe(0);
  });
});
