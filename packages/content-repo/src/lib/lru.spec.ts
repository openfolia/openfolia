import { Lru, PINNED_KEPT } from './lru.js';

describe('Lru', () => {
  it('evicts least recently used entries by weight', () => {
    const lru = new Lru<string>(5, (v) => v.length);
    lru.set('a', 'xx');
    lru.set('b', 'yy');
    lru.get('a');
    lru.set('c', 'zz');
    expect([lru.has('a'), lru.has('b'), lru.has('c')]).toEqual([
      true,
      false,
      true,
    ]);
  });

  it('keeps the newest too-heavy value of each group beside the others when asked to (#552)', () => {
    const group = (key: string) => key.split(':')[1] as string;
    const lru = new Lru<string>(5, (v) => v.length, { pinOversized: group });
    lru.set('1:a', 'xx');
    lru.set('1:b', 'toolong');
    lru.set('1:c', 'yy');
    lru.set('1:d', 'z');
    // The others come and go; the heavy one stays.
    expect(lru.get('1:b')).toBe('toolong');
    expect([lru.has('1:a'), lru.has('1:c'), lru.has('1:d')]).toEqual([
      true,
      true,
      true,
    ]);
    expect([lru.weight, lru.pinnedWeight]).toEqual([5, 7]);
    // A newer heavy value of the same group takes its place; another group's stays beside it.
    lru.set('2:b', 'heavier');
    lru.set('1:e', 'alsolong');
    expect([lru.has('1:b'), lru.get('2:b'), lru.get('1:e')]).toEqual([
      false,
      'heavier',
      'alsolong',
    ]);
    // A light value under a pinned key replaces it.
    lru.set('2:b', 'q');
    expect([lru.get('2:b'), lru.pinnedWeight]).toEqual(['q', 8]);
  });

  it('keeps at most PINNED_KEPT oversized values', () => {
    const lru = new Lru<string>(1, (v) => v.length, {
      pinOversized: (key) => key,
    });
    for (let i = 0; i < PINNED_KEPT + 3; i++) lru.set(`g${i}`, 'heavy');
    expect(lru.size).toBe(PINNED_KEPT);
    expect(lru.has('g0')).toBe(false);
    expect(lru.has(`g${PINNED_KEPT + 2}`)).toBe(true);
  });

  it('drops the old value when a too-heavy value replaces it', () => {
    const lru = new Lru<string>(3, (v) => v.length);
    lru.set('a', 'x');
    lru.set('a', 'toolong');
    expect(lru.get('a')).toBeUndefined();
  });
});
