import type { VariantAttribute } from '../settings/config-model';
import {
  addAttribute,
  addValue,
  findValue,
  orderAttributes,
  orderValues,
  removeAttribute,
  removeValue,
  renameAttribute,
  renameValue,
  setArchived,
  valueCondition,
} from './variant-edits';

const ATTRIBUTES: readonly VariantAttribute[] = [
  {
    id: 'model',
    label: 'Model',
    kind: 'enum',
    values: [
      { id: 'small', label: 'Small' },
      { id: 'large', label: 'Large' },
    ],
  },
  { id: 'firmware', label: 'Firmware', kind: 'version' },
];

const valueIds = (attributes: readonly VariantAttribute[]) => {
  const a = attributes[0];
  return a?.kind === 'enum' ? a.values.map((v) => v.id) : [];
};

describe('variant edits', () => {
  it('renames an attribute or a value, leaving the rest', () => {
    expect(renameAttribute(ATTRIBUTES, 'firmware', 'Software')[1]).toEqual({
      id: 'firmware',
      label: 'Software',
      kind: 'version',
    });
    const renamed = renameValue(ATTRIBUTES, 'model', 'large', 'Big');
    expect(findValue(renamed, 'model', 'large')?.label).toBe('Big');
    expect(findValue(renamed, 'model', 'small')?.label).toBe('Small');
  });

  it('archives and restores a value without other members', () => {
    const archived = setArchived(ATTRIBUTES, 'model', 'small', true);
    expect(findValue(archived, 'model', 'small')).toEqual({
      id: 'small',
      label: 'Small',
      archived: true,
    });
    expect(
      findValue(
        setArchived(archived, 'model', 'small', false),
        'model',
        'small',
      ),
    ).toEqual({ id: 'small', label: 'Small' });
  });

  it('adds and removes values and attributes', () => {
    expect(
      valueIds(addValue(ATTRIBUTES, 'model', { id: 'tiny', label: 'Tiny' })),
    ).toEqual(['small', 'large', 'tiny']);
    expect(valueIds(removeValue(ATTRIBUTES, 'model', 'small'))).toEqual([
      'large',
    ]);
    // A version attribute has no values to add to.
    expect(addValue(ATTRIBUTES, 'firmware', { id: 'x', label: 'X' })).toEqual(
      ATTRIBUTES,
    );
    const more = addAttribute(ATTRIBUTES, {
      id: 'market',
      label: 'Market',
      kind: 'enum',
      values: [{ id: 'eu', label: 'EU' }],
    });
    expect(more.map((a) => a.id)).toEqual(['model', 'firmware', 'market']);
    expect(removeAttribute(more, 'model').map((a) => a.id)).toEqual([
      'firmware',
      'market',
    ]);
  });

  it('puts attributes and values in a new order', () => {
    expect(
      orderAttributes(ATTRIBUTES, ['firmware', 'model']).map((a) => a.id),
    ).toEqual(['firmware', 'model']);
    expect(
      valueIds(orderValues(ATTRIBUTES, 'model', ['large', 'small'])),
    ).toEqual(['large', 'small']);
  });

  it('writes the condition naming one value', () => {
    expect(valueCondition('model', 'small')).toBe('model in (small)');
  });
});
