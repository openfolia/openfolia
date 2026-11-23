import {
  ProjectConfig,
  type Manifest,
  type Module,
} from '@openfolia/content-model';
import { actorWith, READER } from '../../../tests/fakes/actors.js';
import {
  manifest,
  module,
  readable,
} from '../../../tests/fakes/fake-content.js';
import { ForbiddenError } from '../../base/core/errors.js';
import { ListConfigUsagesAction } from './actions/list-config-usages.action.js';
import { countConfigUsages } from './config-usage-counts.js';

const config = ProjectConfig.parse({
  languages: { source: 'en', targets: ['de', 'fr'] },
  moduleTypes: [
    { id: 'concept', label: 'Concept' },
    { id: 'task', label: 'Task' },
  ],
  audiences: [
    { id: 'public', label: 'Public' },
    { id: 'service', label: 'Service' },
  ],
  facets: [
    {
      id: 'region',
      label: 'Region',
      values: [
        { id: 'eu', label: 'EU' },
        { id: 'us', label: 'US' },
      ],
    },
  ],
  variantAttributes: [
    {
      id: 'model',
      label: 'Model',
      kind: 'enum',
      values: [
        { id: 'small', label: 'Small' },
        { id: 'large', label: 'Large', archived: true },
      ],
    },
    { id: 'software', label: 'Software', kind: 'version' },
  ],
  textAttributes: [{ id: 'product-name', label: 'Product name' }],
  safetySymbols: [{ id: 'w001', label: 'General warning' }],
  calloutStyles: [
    { id: 'square', label: 'Square' },
    { id: 'ring', label: 'Ring' },
  ],
});

/** A module using a little of everything, in `lang`. */
function rich(id: string, lang: string): Module {
  const base = module(id, lang);
  return {
    ...base,
    meta: { ...base.meta, facets: { region: ['eu'] } },
    blocks: [
      {
        type: 'paragraph',
        id: 'p',
        content: [
          { type: 'text', text: 'The ' },
          { type: 'attribute', name: 'product-name' },
        ],
      },
      {
        type: 'image',
        id: 'img',
        asset: `sha256:${'ab'.repeat(32)}`,
        alt: 'Front',
        callouts: [
          {
            id: 'c1',
            anchor: { x: 0.5, y: 0.5 },
            legend: [{ type: 'text', text: 'Switch' }],
            style: 'square',
          },
        ],
      },
      {
        type: 'variant',
        id: 'v',
        when: {
          op: 'all',
          of: [
            { op: 'in', attr: 'model', values: ['large'] },
            { op: 'cmp', attr: 'software', cmp: '>=', value: '2.0' },
          ],
        },
        blocks: [
          {
            type: 'safety',
            id: 's',
            severity: 'warning',
            symbols: ['w001'],
            hazard: [{ type: 'text', text: 'Hot.' }],
            blocks: [],
          },
        ],
      },
    ],
  } as Module;
}

const count = (
  usages: ReturnType<typeof countConfigUsages>,
  kind: string,
  valueId: string,
) => usages.find((u) => u.kind === kind && u.valueId === valueId);

describe('countConfigUsages', () => {
  it('counts every configured value, in the configuration’s order, zero included', () => {
    const usages = countConfigUsages(config, [], []);
    expect(usages.map((u) => [u.kind, u.parentId, u.valueId])).toEqual([
      ['language', undefined, 'en'],
      ['language', undefined, 'de'],
      ['language', undefined, 'fr'],
      ['moduleType', undefined, 'concept'],
      ['moduleType', undefined, 'task'],
      ['audience', undefined, 'public'],
      ['audience', undefined, 'service'],
      ['facet', undefined, 'region'],
      ['facetValue', 'region', 'eu'],
      ['facetValue', 'region', 'us'],
      ['variantAttribute', undefined, 'model'],
      ['variantValue', 'model', 'small'],
      ['variantValue', 'model', 'large'],
      ['variantAttribute', undefined, 'software'],
      ['textAttribute', undefined, 'product-name'],
      ['safetySymbol', undefined, 'w001'],
      ['calloutStyle', undefined, 'square'],
      ['calloutStyle', undefined, 'ring'],
    ]);
    expect(usages.every((u) => u.modules === 0 && u.manuals === 0)).toBe(true);
  });

  it('counts a module once across its languages, by what its metadata and blocks name', () => {
    const usages = countConfigUsages(
      config,
      [rich('a', 'en'), rich('a', 'de'), module('b', 'en')],
      [],
    );
    expect(count(usages, 'language', 'en')?.modules).toBe(2);
    expect(count(usages, 'language', 'de')?.modules).toBe(1);
    expect(count(usages, 'language', 'fr')?.modules).toBe(0);
    expect(count(usages, 'moduleType', 'concept')?.modules).toBe(2);
    expect(count(usages, 'audience', 'public')?.modules).toBe(2);
    expect(count(usages, 'facet', 'region')?.modules).toBe(1);
    expect(count(usages, 'facetValue', 'eu')?.modules).toBe(1);
    expect(count(usages, 'facetValue', 'us')?.modules).toBe(0);
    expect(count(usages, 'variantAttribute', 'model')?.modules).toBe(1);
    expect(count(usages, 'variantValue', 'large')?.modules).toBe(1);
    expect(count(usages, 'variantValue', 'small')?.modules).toBe(0);
    expect(count(usages, 'variantAttribute', 'software')?.modules).toBe(1);
    expect(count(usages, 'textAttribute', 'product-name')?.modules).toBe(1);
    expect(count(usages, 'safetySymbol', 'w001')?.modules).toBe(1);
    // A callout's style (#546).
    expect(count(usages, 'calloutStyle', 'square')?.modules).toBe(1);
    expect(count(usages, 'calloutStyle', 'ring')?.modules).toBe(0);
  });

  it('counts manuals by their audience, variants, text attributes and conditions', () => {
    const operating = {
      ...manifest('operating', ['a']),
      attributes: {
        'product-name': [
          { value: 'X', when: { op: 'in', attr: 'software', values: ['2.0'] } },
        ],
      },
      entries: [
        {
          title: 'Chapter',
          when: {
            op: 'not',
            of: { op: 'in', attr: 'model', values: ['small'] },
          },
          entries: [{ module: 'a' }],
        },
      ],
    } as Manifest;
    const usages = countConfigUsages(
      config,
      [],
      [
        operating,
        {
          ...manifest('service', ['a']),
          audience: 'service',
          variants: [{ model: 'large' }],
        } as Manifest,
      ],
    );
    expect(count(usages, 'audience', 'public')?.manuals).toBe(1);
    expect(count(usages, 'audience', 'service')?.manuals).toBe(1);
    expect(count(usages, 'variantValue', 'small')?.manuals).toBe(1);
    expect(count(usages, 'variantValue', 'large')?.manuals).toBe(2);
    expect(count(usages, 'variantAttribute', 'software')?.manuals).toBe(1);
    expect(count(usages, 'textAttribute', 'product-name')?.manuals).toBe(1);
  });
});

describe('ListConfigUsagesAction', () => {
  const action = new ListConfigUsagesAction();

  it('pages the counts of what the reader may see', async () => {
    const snapshot = readable({
      config,
      modules: [rich('a', 'en'), module('b', 'de')],
      manifests: [manifest('operating', ['a'])],
    });
    const page = await action.handle({
      actor: READER,
      snapshot,
      page: { number: 1, size: 3 },
    });
    expect(page.total).toBe(18);
    expect(page.items).toEqual([
      { kind: 'language', valueId: 'en', modules: 1, manuals: 0 },
      { kind: 'language', valueId: 'de', modules: 1, manuals: 0 },
      { kind: 'language', valueId: 'fr', modules: 0, manuals: 0 },
    ]);
  });

  it('needs content.read', async () => {
    await expect(
      action.handle({
        actor: actorWith([]),
        snapshot: readable({ config }),
        page: { number: 1, size: 10 },
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});
