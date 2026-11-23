import { parseCondition, type Manifest } from '@openfolia/content-model';
import { manifest, module } from '../../../tests/fakes/fake-content.js';
import {
  manifestEntryVariants,
  manifestVariantNames,
  mergeVariantNames,
  moduleVariantNames,
  namesVariant,
} from './variant-names.js';

const variantBlock = (id: string, when: string) => ({
  type: 'variant' as const,
  id,
  when: parseCondition(when),
  blocks: [
    {
      type: 'paragraph' as const,
      id: `${id}-p`,
      content: [{ type: 'text' as const, text: 'Only some.' }],
    },
  ],
});

describe('moduleVariantNames', () => {
  it('names what the variant blocks test, nested ones too, sorted and each once', () => {
    const m = module('a');
    const names = moduleVariantNames({
      ...m,
      blocks: [
        ...m.blocks,
        variantBlock('v1', 'model in (small, large) && software >= 2.3'),
        {
          type: 'section',
          id: 's',
          title: [{ type: 'text', text: 'More' }],
          blocks: [
            variantBlock('v2', '!(model in (large) || colour in (red))'),
          ],
        },
      ],
    });
    expect(names).toEqual({
      colour: ['red'],
      model: ['large', 'small'],
      software: [],
    });
  });

  it('names nothing for a module without variant blocks', () => {
    expect(moduleVariantNames(module('a'))).toEqual({});
  });
});

describe('manifestVariantNames', () => {
  const base = manifest('m', ['a', 'b']);
  const m = {
    ...base,
    variants: [{ model: 'small' }],
    attributes: {
      name: [
        { value: 'Big', when: parseCondition('model in (large)') },
        { value: 'Other' },
      ],
      plain: 'Plain',
    },
    entries: [
      {
        title: 'Chapter',
        when: parseCondition('colour in (red)'),
        entries: [
          { module: 'a', when: parseCondition('market in (eu)') },
          { module: 'b' },
        ],
      },
      { module: 'a', when: parseCondition('market in (us)') },
    ],
  } as Manifest;

  it('names the combinations and the conditions of text attributes, not of entries', () => {
    expect(manifestVariantNames(m)).toEqual({ model: ['large', 'small'] });
  });

  it('keeps each entry condition with the modules the entry covers (#91)', () => {
    expect(manifestEntryVariants(m)).toEqual([
      { modules: ['a', 'b'], names: { colour: ['red'] } },
      { modules: ['a'], names: { market: ['eu'] } },
      { modules: ['a'], names: { market: ['us'] } },
    ]);
  });
});

describe('mergeVariantNames', () => {
  it('joins names, sorted and each once', () => {
    expect(
      mergeVariantNames({ model: ['small'] }, [
        { model: ['large', 'small'] },
        { colour: [] },
      ]),
    ).toEqual({ colour: [], model: ['large', 'small'] });
  });
});

describe('namesVariant', () => {
  const names = { model: ['large'], software: [] };
  it('finds an attribute by any test, a value only where listed', () => {
    expect(namesVariant(names, 'model')).toBe(true);
    expect(namesVariant(names, 'software')).toBe(true);
    expect(namesVariant(names, 'model', 'large')).toBe(true);
    expect(namesVariant(names, 'model', 'small')).toBe(false);
    expect(namesVariant(names, 'software', '2.3')).toBe(false);
    expect(namesVariant(names, 'colour')).toBe(false);
    expect(namesVariant(undefined, 'model')).toBe(false);
    expect(namesVariant(names, 'constructor')).toBe(false);
  });
});
