import { CONFIG } from './testing/config-fixture';
import {
  configProblem,
  contentFilter,
  idProblem,
  isProductFacet,
  keyFromLabel,
  languageProblem,
  manufacturerForm,
  manufacturerProblem,
  setCheckManufacturer,
  setFacets,
  setManufacturer,
  setOptions,
  setOutputLabel,
  setSource,
  setTargets,
  usageKey,
  usagePlaces,
} from './config-model';

describe('config model', () => {
  it('keeps a module type marked safety when the types are set (#451)', () => {
    const types = [
      { id: 'concept', label: 'Concept' },
      { id: 'safety', label: 'Safety', restricted: true, safety: true },
    ];
    expect(setOptions(CONFIG, 'moduleTypes', types).moduleTypes).toEqual([
      { id: 'concept', label: 'Concept', restricted: false, snippet: false },
      {
        id: 'safety',
        label: 'Safety',
        restricted: true,
        snippet: false,
        safety: true,
      },
    ]);
  });

  it('makes a key from a label', () => {
    expect(keyFromLabel('Product Line')).toBe('product-line');
    expect(keyFromLabel('Größe  XL!')).toBe('grosse-xl');
    expect(keyFromLabel('12 Volt')).toBe('volt');
    expect(keyFromLabel('***')).toBe('');
  });

  it('says why an ID cannot be taken', () => {
    expect(idProblem('audiences', '', [])).toBe(
      'editor.admin.settings.problems.idRequired',
    );
    expect(idProblem('audiences', 'Bad', [])).toBe(
      'editor.admin.settings.problems.key',
    );
    expect(idProblem('audiences', 'public', ['public'])).toBe(
      'editor.admin.settings.problems.taken',
    );
    expect(idProblem('textAttributes', 'empty', [])).toBe(
      'editor.admin.settings.problems.reserved',
    );
    expect(idProblem('codeLanguages', 'C++', [])).toBeNull();
    expect(idProblem('codeLanguages', 'two words', [])).toBe(
      'editor.admin.settings.problems.codeLanguageId',
    );
    // The picker matches code languages whatever their case.
    expect(idProblem('codeLanguages', 'JSON', ['json'])).toBe(
      'editor.admin.settings.problems.taken',
    );
    expect(idProblem('audiences', 'Public', ['public'])).toBe(
      'editor.admin.settings.problems.key',
    );
  });

  it('says why a language cannot be added', () => {
    expect(languageProblem('fr', CONFIG)).toBeNull();
    expect(languageProblem('DE', CONFIG)).toBe(
      'editor.admin.settings.problems.languageTaken',
    );
    expect(languageProblem('not a tag', CONFIG)).toBe(
      'editor.admin.settings.problems.languageTag',
    );
  });

  it('makes a translation language the source, keeping the old one as a target', () => {
    const next = setSource(CONFIG, 'de');
    expect(next.languages).toEqual({ source: 'de', targets: ['en'] });
    expect(setSource(CONFIG, 'fr')).toBe(CONFIG);
  });

  it('keeps the languages’ directions, and drops a removed language’s (#458)', () => {
    const withDirections = {
      ...CONFIG,
      languages: {
        source: 'en',
        targets: ['de', 'ar'],
        direction: { ar: 'ltr', de: 'rtl' } as const,
      },
    };
    expect(setSource(withDirections, 'de').languages.direction).toEqual({
      ar: 'ltr',
      de: 'rtl',
    });
    expect(setTargets(withDirections, ['ar']).languages).toEqual({
      source: 'en',
      targets: ['ar'],
      direction: { ar: 'ltr' },
    });
    expect(setTargets(withDirections, []).languages).toEqual({
      source: 'en',
      targets: [],
    });
  });

  it('sets and clears an output label', () => {
    const set = setOutputLabel(CONFIG, 'de', 'contents', ' Inhalt ');
    expect(set.outputLabels).toEqual({ de: { contents: 'Inhalt' } });
    expect(setOutputLabel(set, 'de', 'contents', '').outputLabels).toEqual({});
  });

  it('checks a configuration by the content model’s schema', () => {
    expect(configProblem(CONFIG)).toBeNull();
    expect(configProblem({ ...CONFIG, audiences: [] })).toMatch(/^audiences/);
  });

  it('names usages and the content filter for a value', () => {
    expect(usageKey({ kind: 'audience', valueId: 'public' })).toBe(
      'audience/public',
    );
    expect(
      usageKey({ kind: 'facetValue', valueId: 'eu', parentId: 'region' }),
    ).toBe('facetValue/region/eu');
    expect(
      contentFilter({ kind: 'facetValue', valueId: 'eu', parentId: 'region' }),
    ).toEqual({ facet: 'region:eu' });
    expect(contentFilter({ kind: 'moduleType', valueId: 'task' })).toEqual({
      type: 'task',
    });
    expect(contentFilter({ kind: 'variantValue', valueId: 'x' })).toBeNull();
  });

  it('reads the places of a config-in-use refusal, skipping what it does not know', () => {
    expect(
      usagePlaces([
        {
          code: 'config-in-use',
          meta: {
            subject: { type: 'module', lang: 'en', moduleId: 'a' },
            issue: 'unknown-audience',
            at: 'p1',
          },
        },
        {
          code: 'config-in-use',
          meta: {
            subject: { type: 'term', termId: 't' },
            issue: 'unknown-language',
          },
        },
        {
          code: 'config-in-use',
          meta: { subject: { type: 'odd' }, issue: 'x' },
        },
        { code: 'other', meta: {} },
      ]),
    ).toEqual([
      {
        subject: { type: 'module', lang: 'en', moduleId: 'a' },
        issue: 'unknown-audience',
        at: 'p1',
      },
      { subject: { type: 'term', termId: 't' }, issue: 'unknown-language' },
    ]);
  });
});

describe('the releases’ product facet', () => {
  const facets = [
    { id: 'product', label: 'Product', values: [{ id: 'a', label: 'A' }] },
    { id: 'region', label: 'Region', values: [{ id: 'eu', label: 'EU' }] },
  ];
  const config = { ...CONFIG, facets };

  it('stays the one releases name when another facet becomes the first', () => {
    const next = setFacets(config, [facets[1]!, facets[0]!]);
    expect(next.release).toEqual({ productFacet: 'product' });
    expect(setFacets(config, facets).release).toBeUndefined();
  });

  it('is the named facet, else the first', () => {
    expect(isProductFacet(config, 'product')).toBe(true);
    expect(isProductFacet(config, 'region')).toBe(false);
    expect(
      isProductFacet(
        { ...config, release: { productFacet: 'region' } },
        'region',
      ),
    ).toBe(true);
  });
});

describe('the manufacturer details (#395)', () => {
  const form = {
    name: '  Example  Works Ltd ',
    address: '1 Sample Street\n\n 12345 Sample Town \n',
    contact: 'info@example.com',
    website: 'https://example.com',
  };

  it('reads the details into the form and writes them back as the schema keeps them', () => {
    expect(manufacturerForm(CONFIG)).toEqual({
      name: '',
      address: '',
      contact: '',
      website: '',
    });
    const next = setManufacturer(CONFIG, form);
    expect(next.manufacturer).toEqual({
      name: 'Example Works Ltd',
      address: ['1 Sample Street', '12345 Sample Town'],
      contact: 'info@example.com',
      website: 'https://example.com',
    });
    expect(configProblem(next)).toBeNull();
    expect(manufacturerForm(next).address).toBe(
      '1 Sample Street\n12345 Sample Town',
    );
    // Emptied: no details at all; optional fields left out.
    expect(
      setManufacturer(next, { name: '', address: '', contact: '', website: '' })
        .manufacturer,
    ).toBeUndefined();
    expect(
      setManufacturer(CONFIG, { ...form, contact: ' ', website: '' })
        .manufacturer,
    ).toEqual({
      name: 'Example Works Ltd',
      address: ['1 Sample Street', '12345 Sample Town'],
    });
  });

  it('says what the configuration would refuse', () => {
    const empty = { name: '', address: '', contact: '', website: '' };
    expect(manufacturerProblem(empty)).toBeNull();
    expect(manufacturerProblem(form)).toBeNull();
    expect(manufacturerProblem({ ...empty, contact: 'x' })).toBe(
      'editor.admin.settings.manufacturer.problems.name',
    );
    expect(manufacturerProblem({ ...form, name: 'x'.repeat(201) })).toBe(
      'editor.admin.settings.manufacturer.problems.tooLong',
    );
    expect(
      manufacturerProblem({
        ...form,
        address: Array.from({ length: 11 }, (_, i) => `Line ${i}`).join('\n'),
      }),
    ).toBe('editor.admin.settings.manufacturer.problems.address');
    for (const website of [
      'example.com',
      'javascript:alert(1)',
      'https://',
      'https://exa mple.com',
    ]) {
      expect(manufacturerProblem({ ...form, website })).toBe(
        'editor.admin.settings.manufacturer.problems.website',
      );
    }
    expect(
      manufacturerProblem({ ...form, website: 'mailto:info@example.com' }),
    ).toBeNull();
  });

  it('turns the check on and off, keeping the other release settings', () => {
    const on = setCheckManufacturer(CONFIG, true);
    expect(on.release?.checkManufacturer).toBe(true);
    expect(configProblem(on)).toBeNull();
    const off = setCheckManufacturer(on, false);
    expect(off.release?.checkManufacturer).toBeUndefined();
    expect(off.release).toEqual(CONFIG.release);
  });
});
