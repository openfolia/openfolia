import { isTextRange, plainTextOf } from './plain-text.js';

describe('plainTextOf', () => {
  it('joins text runs and marks every other inline node as an atom', () => {
    const plain = plainTextOf([
      { type: 'text', text: 'Press ', marks: [{ type: 'strong' }] },
      { type: 'kbd', keys: ['Ctrl', 'S'] },
      { type: 'text', text: ' on ' },
      { type: 'attribute', name: 'product' },
      { type: 'hardBreak' },
      { type: 'xref', module: 'other' },
      { type: 'text', text: ' and ' },
      { type: 'xref', module: 'other', text: [{ type: 'text', text: 'this' }] },
    ]);
    expect(plain.text).toBe('Press Ctrl+S on {product}\n[xref] and this');
    expect(plain.atoms.map((a) => plain.text.slice(a.start, a.end))).toEqual([
      'Ctrl+S',
      '{product}',
      '\n',
      '[xref]',
      'this',
    ]);
  });
});

describe('isTextRange', () => {
  const plain = plainTextOf([
    { type: 'text', text: 'Use ' },
    { type: 'attribute', name: 'x' },
    { type: 'text', text: ' now 🚗.' },
  ]);

  it('takes a non-empty range of typed text', () => {
    expect(isTextRange(plain, 0, 3)).toBe(true);
    expect(isTextRange(plain, 7, 11)).toBe(true);
    expect(isTextRange(plain, 0, plain.text.length)).toBe(false);
  });

  it('refuses ranges out of bounds, empty, reversed or not whole numbers', () => {
    expect(isTextRange(plain, -1, 2)).toBe(false);
    expect(isTextRange(plain, 2, 2)).toBe(false);
    expect(isTextRange(plain, 3, 2)).toBe(false);
    expect(isTextRange(plain, 0, plain.text.length + 1)).toBe(false);
    expect(isTextRange(plain, 0.5, 2)).toBe(false);
  });

  it('refuses a range touching an atom or splitting a surrogate pair', () => {
    expect(isTextRange(plain, 2, 5)).toBe(false);
    expect(isTextRange(plain, 4, 7)).toBe(false);
    const car = plain.text.indexOf('🚗');
    expect(isTextRange(plain, car, car + 1)).toBe(false);
    expect(isTextRange(plain, car, car + 2)).toBe(true);
  });
});
