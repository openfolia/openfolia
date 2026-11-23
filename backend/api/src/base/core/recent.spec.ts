import { Recent } from './recent.js';

describe('Recent', () => {
  it('keeps the last results asked for, dropping the least recently used', async () => {
    const recent = new Recent<string>(2);
    let made = 0;
    const make = (value: string) => () => {
      made++;
      return Promise.resolve(value);
    };
    expect(await recent.get('a', make('A'))).toBe('A');
    expect(await recent.get('b', make('B'))).toBe('B');
    expect(await recent.get('a', make('other'))).toBe('A');
    expect(await recent.get('c', make('C'))).toBe('C');
    expect(recent.size).toBe(2);
    // `b` was the least recently used.
    expect(await recent.get('b', make('B again'))).toBe('B again');
    expect(await recent.get('c', make('other'))).toBe('C');
    expect(made).toBe(4);
  });

  it('shares a result still being made and forgets one that failed', async () => {
    const recent = new Recent<number>(4);
    let calls = 0;
    const failing = () => {
      calls++;
      return Promise.reject(new Error('no'));
    };
    const [x, y] = [recent.get('k', failing), recent.get('k', failing)];
    await expect(x).rejects.toThrow('no');
    await expect(y).rejects.toThrow('no');
    expect(calls).toBe(1);
    expect(await recent.get('k', () => Promise.resolve(7))).toBe(7);
  });

  it('forgets everything on clear', async () => {
    const recent = new Recent<number>(2);
    recent.set('a', 1);
    recent.clear();
    expect(recent.size).toBe(0);
    expect(await recent.get('a', () => Promise.resolve(2))).toBe(2);
  });

  describe('with a weight (#684)', () => {
    const weighed = () =>
      new Recent<string>(8, { maxWeight: 10, weigh: (v) => v.length });

    it('drops the least recently used until what it keeps weighs at most `maxWeight`', async () => {
      const recent = weighed();
      await recent.get('a', () => Promise.resolve('aaaa'));
      await recent.get('b', () => Promise.resolve('bbbb'));
      expect(recent.weight).toBe(8);
      await recent.get('c', () => Promise.resolve('cccc'));
      // `a` went: 12 is past 10.
      expect(recent.size).toBe(2);
      expect(recent.weight).toBe(8);
      expect(recent.peek('a')).toBeUndefined();
      expect(await recent.peek('b')).toBe('bbbb');
    });

    it('drops by use, not by when a result was made', async () => {
      const recent = weighed();
      await recent.get('a', () => Promise.resolve('aaaa'));
      await recent.get('b', () => Promise.resolve('bbbb'));
      // `a` is used again: `b` is now the least recently used.
      await recent.get('a', () => Promise.resolve('other'));
      await recent.get('c', () => Promise.resolve('cccc'));
      expect(recent.peek('b')).toBeUndefined();
      expect(await recent.peek('a')).toBe('aaaa');
      expect(recent.weight).toBe(8);
    });

    it('keeps the newest result alone when it weighs more than `maxWeight`', async () => {
      const recent = weighed();
      await recent.get('a', () => Promise.resolve('aa'));
      await recent.get('big', () => Promise.resolve('x'.repeat(40)));
      expect(recent.size).toBe(1);
      expect(recent.weight).toBe(40);
      let made = 0;
      await recent.get('big', () => {
        made++;
        return Promise.resolve('');
      });
      expect(made).toBe(0);
      // The next one asked for takes its place.
      await recent.get('b', () => Promise.resolve('bb'));
      expect(recent.size).toBe(1);
      expect(recent.weight).toBe(2);
    });

    it('weighs a kept value, forgets the weight of one dropped or failed', async () => {
      const recent = weighed();
      recent.set('a', 'aaaaaa');
      recent.set('b', 'bbbbbb');
      expect(recent.size).toBe(1);
      expect(recent.weight).toBe(6);
      await expect(
        recent.get('c', () => Promise.reject(new Error('no'))),
      ).rejects.toThrow('no');
      expect(recent.weight).toBe(6);
      recent.clear();
      expect(recent.weight).toBe(0);
    });

    it('drops by count as before', async () => {
      const recent = new Recent<string>(1, {
        maxWeight: 100,
        weigh: (v) => v.length,
      });
      await recent.get('a', () => Promise.resolve('a'));
      await recent.get('b', () => Promise.resolve('b'));
      expect(recent.size).toBe(1);
      expect(recent.weight).toBe(1);
    });
  });
});
