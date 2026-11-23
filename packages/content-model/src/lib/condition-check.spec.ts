import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { Condition } from './condition.js';
import { isCondition } from './condition-check.js';

/** The schema's answer, which `isCondition` must give without the schema. */
const schemaSays = (value: unknown) => Condition.safeParse(value).success;

/**
 * Values near a condition: every field drawn from valid and invalid choices, nested, with keys
 * of their own and the odd non-object, so both answers come up often.
 */
const nearCondition: fc.Arbitrary<unknown> = fc.letrec<{ c: unknown }>(
  (tie) => ({
    c: fc.oneof(
      { depthSize: 'small', withCrossShrink: true },
      fc.record(
        {
          op: fc.constantFrom('in', 'cmp', 'all', 'any', 'not', 'IN', ''),
          attr: fc.constantFrom(
            'model',
            'product-line',
            'Model',
            '1model',
            '',
            'a'.repeat(64),
            'a'.repeat(65),
            7,
          ),
          values: fc.oneof(
            fc.array(fc.constantFrom('l-200', '', 3, null), { maxLength: 3 }),
            fc.constant('l-200'),
          ),
          cmp: fc.constantFrom('<', '<=', '>', '>=', '=', '=>'),
          value: fc.constantFrom('2', '2.3', '10.0.1', 'v2', '2.', '.2', '', 2),
          of: fc.oneof(
            tie('c'),
            fc.array(tie('c'), { maxLength: 3 }),
            fc.constant(null),
          ),
          extra: fc.anything(),
        },
        { requiredKeys: ['op'] },
      ),
      fc.anything(),
    ),
  }),
).c;

describe('isCondition', () => {
  it('accepts what the schema accepts and refuses what it refuses', () => {
    fc.assert(
      fc.property(nearCondition, (value) => {
        expect(isCondition(value)).toBe(schemaSays(value));
      }),
      { numRuns: 2000 },
    );
  });

  it('gives the schema’s answer on the edge cases', () => {
    const inTest = { op: 'in', attr: 'model', values: ['l-200'] };
    const cases: unknown[] = [
      inTest,
      { ...inTest, note: 'a key of its own' },
      { op: 'in', attr: 'model', values: [] },
      { op: 'in', attr: 'model', values: [''] },
      // eslint-disable-next-line no-sparse-arrays
      { op: 'in', attr: 'model', values: ['a', , 'b'] },
      { op: 'in', attr: 'a'.repeat(64), values: ['x'] },
      { op: 'in', attr: 'a'.repeat(65), values: ['x'] },
      { op: 'cmp', attr: 'software', cmp: '>=', value: '2.3' },
      { op: 'cmp', attr: 'software', cmp: '>=', value: '2.3.' },
      { op: 'cmp', attr: 'software', cmp: '==', value: '2.3' },
      { op: 'not', of: inTest },
      { op: 'not', of: [inTest] },
      { op: 'all', of: [inTest] },
      { op: 'all', of: [inTest, inTest] },
      { op: 'any', of: [inTest, { op: 'in' }] },
      [inTest],
      null,
      'model in (l-200)',
      Object.assign(Object.create(null), inTest),
    ];
    for (const value of cases) {
      expect(isCondition(value), JSON.stringify(value)).toBe(schemaSays(value));
    }
  });
});
