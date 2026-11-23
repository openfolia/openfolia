import {
  groupTree,
  languagesOf,
  statesOf,
  statusOf,
  filtersOf,
  summaryQuery,
  translationsOf,
  valuesOf,
  type BrowserValues,
  variantLabels,
  type ModuleSummary,
  type ProjectConfig,
} from './browser-model';
import { moduleIdOf } from './module-id';

const config: ProjectConfig = {
  languages: { source: 'en', targets: ['de', 'fr'] },
  moduleTypes: [
    { id: 'concept', label: 'Concept', restricted: false, snippet: false },
    { id: 'procedure', label: 'Procedure', restricted: false, snippet: false },
  ],
  audiences: [{ id: 'public', label: 'Public' }],
  facets: [
    {
      id: 'region',
      label: 'Region',
      values: [
        { id: 'north', label: 'North' },
        { id: 'south', label: 'South' },
      ],
    },
  ],
  variantAttributes: [
    {
      id: 'model',
      label: 'Model',
      kind: 'enum',
      values: [{ id: 'large', label: 'Large' }],
    },
  ],
  textAttributes: [],
  safetySymbols: [],
  outputLabels: {},
  maxHeadingLevel: 3,
  codeLanguages: [],
  pdf: { standard: 'ua-1' },
  delivery: {
    access: 'signed-in',
    missingLanguage: 'picker',
    pdfQrCode: 'none',
    manuals: {},
  },
};

const summary = (languages: string[]): ModuleSummary => ({
  type: 'ModuleSummary',
  id: 'a',
  attributes: {
    moduleId: 'a',
    title: 'A',
    titleLang: 'en',
    moduleType: 'concept',
    facets: {},
    keywords: [],
    languages,
    variants: [],
  },
  meta: { changed: false, text: '' },
});

const defaults: BrowserValues = {
  q: '',
  type: undefined,
  facet: undefined,
  lang: undefined,
  audience: undefined,
  status: undefined,
  keyword: [],
  show: [],
  page: 1,
  size: 50,
};

describe('content browser model', () => {
  it('turns filters and the page into the API query, leaving out what is All', () => {
    expect(summaryQuery({}, { number: 2, size: 25 })).toEqual({
      'page[number]': 2,
      'page[size]': 25,
      'filter[deprecated]': 'false',
    });
    expect(
      summaryQuery(
        {
          lang: 'de',
          type: 'concept',
          audience: 'public',
          facet: { id: 'region', value: 'north' },
          status: 'released',
          keywords: ['maintenance', 'Wärme'],
          q: '  charge ',
        },
        { number: 1, size: 50 },
      ),
    ).toEqual({
      'page[number]': 1,
      'page[size]': 50,
      'filter[lang]': 'de',
      'filter[type]': 'concept',
      'filter[audience]': 'public',
      'filter[facet]': 'region:north',
      'filter[keyword]': ['maintenance', 'Wärme'],
      'filter[changed]': 'false',
      'filter[q]': 'charge',
      'filter[deprecated]': 'false',
    });
    expect(
      summaryQuery({ status: 'changed', q: '   ' }, { number: 1, size: 50 }),
    ).toEqual({
      'page[number]': 1,
      'page[size]': 50,
      'filter[changed]': 'true',
      'filter[deprecated]': 'false',
    });
  });

  it('leaves deprecated modules out unless "Show deprecated" is on (#266)', () => {
    expect(
      summaryQuery({ show: ['deprecated'] }, { number: 1, size: 50 }),
    ).toEqual({ 'page[number]': 1, 'page[size]': 50 });
    expect(filtersOf({ ...defaults, show: ['deprecated'] }).show).toEqual([
      'deprecated',
    ]);
    expect(filtersOf(defaults).show).toBeUndefined();
    expect(valuesOf({ show: undefined })).toEqual({ show: [] });
  });

  it('adds the deleted modules to the list when "Show deleted" is on (#320)', () => {
    expect(
      summaryQuery({ show: ['deleted'] }, { number: 1, size: 50 }),
    ).toEqual({
      'page[number]': 1,
      'page[size]': 50,
      'filter[deprecated]': 'false',
      'filter[status]': 'any',
    });
    expect(
      filtersOf({ ...defaults, show: ['deleted', 'deprecated'] }).show,
    ).toEqual(['deleted', 'deprecated']);
  });

  it('gives a changed module the change set’s state and the rest Released', () => {
    expect(statusOf(false, 'draft')).toBe('released');
    expect(statusOf(true, undefined)).toBe('released');
    expect(statusOf(true, 'draft')).toBe('draft');
    expect(statusOf(true, 'in-review')).toBe('in-review');
    expect(statusOf(true, 'approved')).toBe('approved');
  });

  it('marks each configured language translated or not, a state only where it is known (#694)', () => {
    expect(languagesOf(config)).toEqual(['en', 'de', 'fr']);
    // No translation status for this reader: a translation is there, nothing more is said.
    expect(translationsOf(summary(['en', 'fr']), config)).toEqual([
      { lang: 'en', state: 'up-to-date' },
      { lang: 'de', state: 'not-translated' },
      { lang: 'fr', state: 'translated' },
    ]);
  });

  it('gives each translation its state from the translation status (#694)', () => {
    const states = statesOf([
      { attributes: { moduleId: 'a', lang: 'de', state: 'outdated' } },
      { attributes: { moduleId: 'a', lang: 'fr', state: 'at-provider' } },
      { attributes: { moduleId: 'b', lang: 'de', state: 'up-to-date' } },
    ]);
    expect(translationsOf(summary(['en', 'de']), config, states)).toEqual([
      { lang: 'en', state: 'up-to-date' },
      { lang: 'de', state: 'outdated' },
      { lang: 'fr', state: 'at-agency' },
    ]);
    expect(
      translationsOf(
        summary(['en', 'de', 'fr']),
        config,
        statesOf([
          { attributes: { moduleId: 'a', lang: 'de', state: 'up-to-date' } },
          { attributes: { moduleId: 'a', lang: 'fr', state: 'missing' } },
        ]),
      ),
    ).toEqual([
      { lang: 'en', state: 'up-to-date' },
      { lang: 'de', state: 'up-to-date' },
      // The status says missing: the reader sees no file of it.
      { lang: 'fr', state: 'not-translated' },
    ]);
    // Read, but no status for a language (the reader would see no translation in it).
    expect(translationsOf(summary(['en', 'fr']), config, statesOf([]))).toEqual(
      [
        { lang: 'en', state: 'up-to-date' },
        { lang: 'de', state: 'not-translated' },
        { lang: 'fr', state: 'translated' },
      ],
    );
  });

  it('labels variant conditions from the configuration', () => {
    expect(
      variantLabels(['model=large', 'model=tiny', 'software>=2.3'], config),
    ).toEqual(['Large', 'tiny', 'software>=2.3']);
  });

  it('groups by module type, then by the first facet’s values', () => {
    const tree = groupTree(config);
    expect(tree.map((n) => n.label)).toEqual(['Concept', 'Procedure']);
    expect(tree[0]?.children.map((c) => [c.label, c.facet])).toEqual([
      ['North', { id: 'region', value: 'north' }],
      ['South', { id: 'region', value: 'south' }],
    ]);
  });

  it('makes module IDs from titles', () => {
    expect(moduleIdOf('Laden und Entladen')).toBe('laden-und-entladen');
    expect(moduleIdOf('  Über Größe: 2.0 ')).toBe('ueber-groesse-2-0');
    expect(moduleIdOf('Café crème')).toBe('cafe-creme');
    expect(moduleIdOf('!!!')).toBe('');
    expect(moduleIdOf('x'.repeat(150))).toHaveLength(100);
  });
});
