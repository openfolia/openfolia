import { mergeClasses } from './merge-classes';

describe('mergeClasses', () => {
  it('lets the last conflicting Tailwind utility win', () => {
    expect(mergeClasses('px-2 py-1', 'px-4')).toBe('py-1 px-4');
  });

  it('drops falsy values', () => {
    expect(mergeClasses('a', false, undefined, 'b')).toBe('a b');
  });
});
