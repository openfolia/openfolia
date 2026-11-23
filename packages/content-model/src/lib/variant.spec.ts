import {
  compareVersions,
  evaluateCondition,
  parseVariantSlug,
  variantSlug,
} from './variant.js';

describe('compareVersions', () => {
  it('compares numerically, part by part', () => {
    expect(compareVersions('2.10', '2.9')).toBe(1);
    expect(compareVersions('2.3', '2.3.0')).toBe(0);
    expect(compareVersions('1.9.9', '2')).toBe(-1);
  });
});

describe('evaluateCondition', () => {
  const variant = { model: 'l-400', software: '2.10', market: 'eu' };
  const versions = { versionAttributes: new Set(['software']) };

  it('evaluates enum and version tests', () => {
    expect(
      evaluateCondition(
        { op: 'in', attr: 'model', values: ['l-200', 'l-400'] },
        variant,
      ),
    ).toBe(true);
    expect(
      evaluateCondition(
        { op: 'cmp', attr: 'software', cmp: '>', value: '2.9' },
        variant,
      ),
    ).toBe(true);
    expect(
      evaluateCondition(
        { op: 'in', attr: 'software', values: ['2.10.0'] },
        variant,
        versions,
      ),
    ).toBe(true);
    expect(
      evaluateCondition(
        { op: 'in', attr: 'software', values: ['2.10.0'] },
        variant,
      ),
    ).toBe(false);
  });

  it('combines with all, any and not', () => {
    const condition = {
      op: 'all' as const,
      of: [
        { op: 'in' as const, attr: 'model', values: ['l-400'] },
        {
          op: 'not' as const,
          of: { op: 'in' as const, attr: 'market', values: ['us'] },
        },
      ],
    };
    expect(evaluateCondition(condition, variant)).toBe(true);
    expect(
      evaluateCondition(
        {
          op: 'any',
          of: [condition, { op: 'in', attr: 'model', values: ['x'] }],
        },
        { ...variant, market: 'us' },
      ),
    ).toBe(false);
  });

  it('treats tests on unset attributes as false and reports each one', () => {
    const missing: string[] = [];
    const result = evaluateCondition(
      {
        op: 'any',
        of: [
          { op: 'in', attr: 'option', values: ['lift'] },
          { op: 'cmp', attr: 'firmware', cmp: '>=', value: '1' },
        ],
      },
      variant,
      { onMissing: (attr) => missing.push(attr) },
    );
    expect(result).toBe(false);
    expect(missing).toEqual(['option', 'firmware']);
  });
});

describe('missing attributes', () => {
  const condition = { op: 'in' as const, attr: 'market', values: ['us'] };
  it('never include content, not even through not', () => {
    expect(evaluateCondition({ op: 'not', of: condition }, {})).toBe(false);
    expect(evaluateCondition(condition, {})).toBe(false);
    expect(
      evaluateCondition(
        {
          op: 'all',
          of: [
            { op: 'not', of: condition },
            { op: 'in', attr: 'model', values: ['x'] },
          ],
        },
        { model: 'x' },
      ),
    ).toBe(false);
  });
  it('do not matter when the rest decides', () => {
    expect(
      evaluateCondition(
        {
          op: 'any',
          of: [condition, { op: 'in', attr: 'model', values: ['x'] }],
        },
        { model: 'x' },
      ),
    ).toBe(true);
    expect(
      evaluateCondition(
        {
          op: 'not',
          of: {
            op: 'all',
            of: [condition, { op: 'in', attr: 'model', values: ['y'] }],
          },
        },
        { model: 'x' },
      ),
    ).toBe(true);
  });
});

describe('variantSlug', () => {
  it('is stable regardless of key order', () => {
    expect(variantSlug({ model: 'l-400', market: 'eu', software: '2.3' })).toBe(
      'market=eu,model=l-400,software=2.3',
    );
    expect(variantSlug({ software: '2.3', market: 'eu', model: 'l-400' })).toBe(
      'market=eu,model=l-400,software=2.3',
    );
  });
  it('never gives two variants the same slug, and stays ASCII', () => {
    const variants: Record<string, string>[] = [
      { model: 'line-x' },
      { 'model-line': 'x' },
      { a: 'b,c=d' },
      { a: 'b', c: 'd' },
      { a: 'größe ü' },
      { a: '~41;' },
      { a: 'A' },
    ];
    const slugs = variants.map(variantSlug);
    expect(new Set(slugs).size).toBe(variants.length);
    for (const slug of slugs) expect(slug).toMatch(/^[A-Za-z0-9.=,~;-]+$/);
  });
});

describe('parseVariantSlug', () => {
  it('is the inverse of variantSlug', () => {
    const variants: Record<string, string>[] = [
      { model: 'l-400', market: 'eu', software: '2.3' },
      { model: 'a b', market: '~7e;' },
      { x: 'é€😀' },
    ];
    for (const variant of variants) {
      expect(parseVariantSlug(variantSlug(variant))).toEqual(variant);
    }
  });

  it('refuses anything that is not a slug, or not its canonical spelling', () => {
    for (const bad of [
      '',
      'model',
      '=x',
      'model=',
      'model=a,model=b',
      'b=1,a=2',
      'model=~zz;',
      'model=~41;',
      'model=~d800;',
      'model=~110000;',
      'model=~41',
      'model=a b',
      'Bad Key=1',
    ]) {
      expect(parseVariantSlug(bad)).toBeUndefined();
    }
  });
});
