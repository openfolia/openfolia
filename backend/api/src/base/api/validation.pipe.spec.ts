import { MAX_BODY_DEPTH, nestsDeeperThan } from './validation.pipe.js';

const nested = (levels: number): unknown => {
  let value: unknown = 'leaf';
  for (let i = 0; i < levels; i++) value = { blocks: [value] };
  return value;
};

describe('nestsDeeperThan', () => {
  it('counts objects and arrays, iteratively', () => {
    expect(nestsDeeperThan('text', 0)).toBe(false);
    expect(nestsDeeperThan({}, 1)).toBe(false);
    expect(nestsDeeperThan({ a: [] }, 1)).toBe(true);
    // Each level here is an object and an array.
    expect(nestsDeeperThan(nested(MAX_BODY_DEPTH / 2), MAX_BODY_DEPTH)).toBe(
      false,
    );
    expect(
      nestsDeeperThan(nested(MAX_BODY_DEPTH / 2 + 1), MAX_BODY_DEPTH),
    ).toBe(true);
    // Far deeper than the stack would allow recursively.
    expect(nestsDeeperThan(nested(100_000), MAX_BODY_DEPTH)).toBe(true);
  });
});
