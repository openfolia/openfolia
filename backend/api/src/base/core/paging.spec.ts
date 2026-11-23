import { paginate } from './paging.js';

describe('paginate', () => {
  const all = [1, 2, 3, 4, 5];

  it('returns the requested page and the total', () => {
    expect(paginate(all, { number: 2, size: 2 })).toEqual({
      items: [3, 4],
      total: 5,
    });
    expect(paginate(all, { number: 3, size: 2 }).items).toEqual([5]);
  });

  it('returns an empty page past the end', () => {
    expect(paginate(all, { number: 9, size: 2 })).toEqual({
      items: [],
      total: 5,
    });
  });
});
