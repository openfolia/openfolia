import type { ProjectConfig } from '../content/browser-model';
import { toRows } from './manual-outline';
import {
  attributeRows,
  cleanVariant,
  duplicateOf,
  fromOptions,
  issuesFor,
  restoreVariant,
  rowIssues,
  sameVariant,
  setRowCondition,
  toOptions,
  withAttribute,
  withCondition,
  type Condition,
  type Issue,
} from './manual-settings';

const EU: Condition = { op: 'in', attr: 'market', values: ['eu'] };
const US: Condition = { op: 'in', attr: 'market', values: ['us'] };

const issue = (code: string, at?: string): Issue => ({
  severity: 'error',
  code,
  message: code,
  ...(at === undefined ? {} : { at }),
});

describe('manual settings', () => {
  it('compares combinations whatever their order, and finds a duplicate', () => {
    expect(
      sameVariant({ model: 'l', market: 'eu' }, { market: 'eu', model: 'l' }),
    ).toBe(true);
    expect(sameVariant({ model: 'l' }, { model: 'l', market: 'eu' })).toBe(
      false,
    );
    const list = [{ model: 'l' }, { model: 'xl' }];
    expect(duplicateOf(list, { model: 'xl' })).toBe(1);
    // The one being edited is not its own duplicate.
    expect(duplicateOf(list, { model: 'xl' }, 1)).toBe(-1);
  });

  it('leaves empty values out of a combination', () => {
    expect(cleanVariant({ model: 'l', software: ' ', market: '' })).toEqual({
      model: 'l',
    });
    expect(cleanVariant({ software: ' 2.3 ' })).toEqual({ software: '2.3' });
  });

  it('puts a removed combination back where it was, unless it is there again', () => {
    expect(restoreVariant([{ m: 'a' }, { m: 'c' }], { m: 'b' }, 1)).toEqual([
      { m: 'a' },
      { m: 'b' },
      { m: 'c' },
    ]);
    expect(restoreVariant([{ m: 'a' }], { m: 'b' }, 5)).toEqual([
      { m: 'a' },
      { m: 'b' },
    ]);
    expect(restoreVariant([{ m: 'b' }], { m: 'b' }, 0)).toEqual([{ m: 'b' }]);
  });

  it('turns a text attribute into values and back: none, one, several', () => {
    expect(toOptions(undefined)).toEqual([]);
    expect(toOptions('Lifter')).toEqual([{ value: 'Lifter' }]);
    expect(fromOptions([])).toBeUndefined();
    expect(fromOptions([{ value: 'Lifter' }])).toBe('Lifter');
    expect(fromOptions([{ value: 'EU', when: EU }])).toEqual([
      { value: 'EU', when: EU },
    ]);
    const several = [{ value: 'EU', when: EU }, { value: 'Other' }];
    expect(fromOptions(toOptions(fromOptions(several)))).toEqual(several);
    expect(withAttribute({ a: 'x', b: 'y' }, 'a', undefined)).toEqual({
      b: 'y',
    });
  });

  it('moves a value given variants before a value for every variant', () => {
    const options = [{ value: 'Other' }, { value: 'EU' }];
    expect(withCondition(options, 1, EU)).toEqual([
      { value: 'EU', when: EU },
      { value: 'Other' },
    ]);
    // A value whose variants are taken away stays where it is.
    expect(
      withCondition(
        [
          { value: 'US', when: US },
          { value: 'EU', when: EU },
        ],
        0,
        null,
      ),
    ).toEqual([{ value: 'US' }, { value: 'EU', when: EU }]);
  });

  it('lists every configured text attribute, then unknown ones set', () => {
    const config = {
      textAttributes: [{ id: 'product', label: 'Product' }],
    } as ProjectConfig;
    expect(attributeRows(config, { old: 'x' })).toEqual([
      { id: 'product', label: 'Product', configured: true },
      { id: 'old', label: 'old', configured: false },
    ]);
  });

  it('sets and removes a row condition', () => {
    const rows = toRows([{ module: 'a' }, { module: 'b', when: EU }]);
    const set = setRowCondition(rows, 'a', US);
    expect(set[0]?.when).toEqual(US);
    const cleared = setRowCondition(set, 'b', null);
    expect('when' in (cleared[1] ?? {})).toBe(false);
  });

  it('finds the issues each field is about', () => {
    const issues = [
      issue('unknown-audience'),
      issue('unknown-variant-value', 'variant 2'),
      issue('inconsistent-variants'),
      issue('unknown-text-attribute', 'old'),
      issue('unknown-variant-value', 'b'),
    ];
    expect(issuesFor(issues, { kind: 'audience' })).toHaveLength(1);
    expect(issuesFor(issues, { kind: 'variant', index: 1 })).toEqual([
      issues[1],
    ]);
    expect(issuesFor(issues, { kind: 'variant', index: 0 })).toEqual([]);
    expect(issuesFor(issues, { kind: 'variants' })).toEqual([issues[2]]);
    expect(issuesFor(issues, { kind: 'attribute', id: 'old' })).toEqual([
      issues[3],
    ]);
    const rows = toRows([{ module: 'a' }, { module: 'b', when: EU }]);
    expect(rowIssues(issues, rows[1]!)).toEqual([issues[4]]);
    expect(rowIssues(issues, rows[0]!)).toEqual([]);
  });
});
