import { Condition } from './condition.js';

describe('Condition', () => {
  it('accepts nested conditions', () => {
    const condition = {
      op: 'any',
      of: [
        { op: 'in', attr: 'model', values: ['l-200'] },
        {
          op: 'all',
          of: [
            { op: 'not', of: { op: 'in', attr: 'market', values: ['us'] } },
            { op: 'cmp', attr: 'software', cmp: '<', value: '3.0.1' },
          ],
        },
      ],
    };
    expect(Condition.safeParse(condition).error).toBeUndefined();
  });

  it('rejects malformed versions, empty value lists and single-term groups', () => {
    expect(
      Condition.safeParse({
        op: 'cmp',
        attr: 'software',
        cmp: '>=',
        value: 'v2',
      }).success,
    ).toBe(false);
    expect(
      Condition.safeParse({ op: 'in', attr: 'model', values: [] }).success,
    ).toBe(false);
    expect(
      Condition.safeParse({
        op: 'all',
        of: [{ op: 'in', attr: 'model', values: ['a'] }],
      }).success,
    ).toBe(false);
  });

  it('rejects equality comparisons on versions; use "in" instead', () => {
    expect(
      Condition.safeParse({
        op: 'cmp',
        attr: 'software',
        cmp: '=',
        value: '2.3',
      }).success,
    ).toBe(false);
  });
});
