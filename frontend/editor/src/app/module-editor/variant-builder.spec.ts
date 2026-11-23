import { parseCondition, type Condition } from '@openfolia/content-model/core';

import {
  addComparison,
  emptyBuilder,
  fromCondition,
  parseText,
  removeComparison,
  setComparison,
  setNegate,
  toCondition,
  toggleValue,
  toText,
  unknownNames,
  type Builder,
  type VariantAttributeInfo,
} from './variant-builder';

const ATTRIBUTES: VariantAttributeInfo[] = [
  {
    id: 'model',
    label: 'Model',
    kind: 'enum',
    values: [
      { id: 'small', label: 'Small' },
      { id: 'large', label: 'Large' },
      { id: 'xl', label: 'Extra large' },
    ],
  },
  {
    id: 'market',
    label: 'Market',
    kind: 'enum',
    values: [
      { id: 'eu', label: 'Europe' },
      { id: 'us', label: 'United States' },
    ],
  },
  { id: 'software', label: 'Software', kind: 'version', values: [] },
];

const fromText = (text: string, combine: 'all' | 'any' = 'all') =>
  fromCondition(parseCondition(text), ATTRIBUTES, combine);

describe('variant builder', () => {
  it('turns groups into a condition in the configured order, whatever the clicks', () => {
    let b = emptyBuilder();
    b = toggleValue(b, 'market', 'us', true);
    b = toggleValue(b, 'model', 'large', true);
    b = toggleValue(b, 'model', 'small', true);
    expect(toText(b, ATTRIBUTES)).toBe(
      'model in (small, large) && market in (us)',
    );
    b = { ...b, combine: 'any' };
    expect(toText(b, ATTRIBUTES)).toBe(
      'model in (small, large) || market in (us)',
    );
  });

  it('leaves out groups with nothing chosen, and says nothing for none', () => {
    let b = toggleValue(emptyBuilder(), 'model', 'small', true);
    b = toggleValue(b, 'model', 'small', false);
    b = setNegate(b, 'market', true);
    b = addComparison(b, 'software');
    expect(toCondition(b, ATTRIBUTES)).toBeNull();
    expect(toText(b, ATTRIBUTES)).toBe('');
  });

  it('negates a group and makes a version range', () => {
    let b = toggleValue(emptyBuilder(), 'market', 'us', true);
    b = setNegate(b, 'market', true);
    b = addComparison(b, 'software');
    b = setComparison(b, 'software', 0, { cmp: '>=', value: '2.3' });
    b = addComparison(b, 'software');
    b = setComparison(b, 'software', 1, { cmp: '<', value: '3' });
    expect(toText(b, ATTRIBUTES)).toBe(
      '!(market in (us)) && (software >= 2.3 && software < 3)',
    );
    b = removeComparison(b, 'software', 1);
    expect(toText(b, ATTRIBUTES)).toBe('!(market in (us)) && software >= 2.3');
    b = setComparison(b, 'software', 0, { cmp: '=', value: '2.3' });
    expect(toText(b, ATTRIBUTES)).toBe(
      '!(market in (us)) && software in (2.3)',
    );
  });

  it('reads back every condition it writes', () => {
    const builders: Builder[] = [
      {
        combine: 'all',
        groups: {
          model: { negate: false, values: ['small', 'xl'], comparisons: [] },
          software: {
            negate: true,
            values: [],
            comparisons: [
              { cmp: '>=', value: '2' },
              { cmp: '<', value: '3.1' },
            ],
          },
        },
      },
      {
        combine: 'any',
        groups: {
          market: { negate: true, values: ['eu'], comparisons: [] },
          software: {
            negate: false,
            values: [],
            comparisons: [{ cmp: '=', value: '1.0' }],
          },
        },
      },
    ];
    for (const b of builders) {
      const text = toText(b, ATTRIBUTES);
      expect(fromText(text)).toEqual(b);
      expect(toText(fromText(text)!, ATTRIBUTES)).toBe(text);
    }
  });

  it('reads typed conditions of the builder’s shape', () => {
    expect(
      fromText('software >= 2 && software < 3 && model in (large)'),
    ).toEqual({
      combine: 'all',
      groups: {
        software: {
          negate: false,
          values: [],
          comparisons: [
            { cmp: '>=', value: '2' },
            { cmp: '<', value: '3' },
          ],
        },
        model: { negate: false, values: ['large'], comparisons: [] },
      },
    });
    // One group keeps the way groups combine that was chosen.
    expect(fromText('model in (large)', 'any')?.combine).toBe('any');
    expect(fromText('software >= 2 && software < 3', 'any')?.combine).toBe(
      'any',
    );
  });

  it('leaves conditions it cannot show to the text', () => {
    for (const text of [
      'model in (huge)',
      'colour in (red)',
      'model > 2',
      'model in (small) && model in (large)',
      'software > 2 || software < 1',
      '(model in (small) || market in (eu)) && software >= 2',
      '!(model in (small) && market in (eu))',
      'software in (1, 2)',
    ]) {
      expect(fromText(text)).toBeNull();
    }
  });

  it('tells empty, unreadable, invalid and good text apart', () => {
    expect(parseText('  ').kind).toBe('empty');
    expect(parseText('model in (').kind).toBe('unreadable');
    expect(parseText('x'.repeat(1001)).kind).toBe('unreadable');
    expect(parseText('software >= abc').kind).toBe('invalid');
    expect(parseText('model in (small)')).toEqual({
      kind: 'condition',
      condition: { op: 'in', attr: 'model', values: ['small'] },
    });
  });

  it('names what the configuration does not hold', () => {
    const c: Condition = parseCondition(
      'colour in (red) || model in (huge, small) || model > 2 || software >= abc',
    );
    expect(unknownNames(c, ATTRIBUTES)).toEqual([
      { issue: 'unknown-variant-attribute', attribute: 'colour', value: '' },
      { issue: 'unknown-variant-value', attribute: 'Model', value: 'huge' },
      { issue: 'version-compare-on-enum', attribute: 'Model', value: '' },
      { issue: 'invalid-version-value', attribute: 'Software', value: 'abc' },
    ]);
  });
});
