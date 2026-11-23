import {
  definitionText,
  isTermId,
  listQuery,
  newTerm,
  termIdOf,
  variantProblem,
  variantsOf,
  withDomain,
  withLanguage,
  withStatus,
  type TermContent,
} from './terms-model';

const term: TermContent = {
  schemaVersion: 1,
  id: 'charger',
  status: 'approved',
  domain: 'charging',
  languages: {
    en: {
      preferred: 'charger',
      allowed: [{ term: 'charging unit', note: 'In short texts.' }],
      forbidden: [{ term: 'loader' }],
    },
  },
};

describe('the terms model', () => {
  it('asks GET /terms for the filters and the page only', () => {
    expect(
      listQuery({
        lang: 'de',
        domain: 'charging',
        status: 'deprecated',
        q: 'lad',
        page: 2,
        size: 50,
        term: 'charger',
      }),
    ).toEqual({
      'filter[lang]': 'de',
      'filter[domain]': 'charging',
      'filter[status]': 'deprecated',
      'filter[q]': 'lad',
      'page[number]': 2,
      'page[size]': 50,
    });
    expect(
      listQuery({
        lang: undefined,
        domain: '',
        status: undefined,
        q: '',
        page: 1,
        size: 25,
        term: undefined,
      }),
    ).toEqual({ 'page[number]': 1, 'page[size]': 25 });
  });

  it('derives an ID from the preferred term, never a reserved one', () => {
    expect(termIdOf('Ladegerät für Fahrzeuge')).toBe(
      'ladegeraet-fuer-fahrzeuge',
    );
    expect(termIdOf('  Safety  Stop! ')).toBe('safety-stop');
    expect(termIdOf('Export')).toBe('export-term');
    expect(termIdOf('充电器')).toBe('');
    expect(isTermId('charger')).toBe(true);
    expect(isTermId('export')).toBe(false);
    expect(isTermId('Charger')).toBe(false);
    expect(isTermId('a--b')).toBe(false);
  });

  it('keeps the notes of variants that stay', () => {
    expect(
      variantsOf(
        ['charging unit', 'power unit'],
        term.languages['en']!.allowed,
      ),
    ).toEqual([
      { term: 'charging unit', note: 'In short texts.' },
      { term: 'power unit' },
    ]);
  });

  it('refuses a variant that is too long, one too many, or a control character', () => {
    expect(variantProblem('x'.repeat(201), [])).toBe(
      'editor.terminology.variants.tooLong',
    );
    expect(
      variantProblem(
        'x',
        Array.from({ length: 50 }, (_, i) => `v${i}`),
      ),
    ).toBe('editor.terminology.variants.tooMany');
    expect(variantProblem('a\u0007b', [])).toBe(
      'editor.terminology.variants.invalid',
    );
    expect(variantProblem('fine', [])).toBeNull();
  });

  it('adds and removes languages, never the last one', () => {
    const both = withLanguage(term, 'de', {
      preferred: 'Ladegerät',
      allowed: [],
      forbidden: [],
    });
    expect(Object.keys(both!.languages)).toEqual(['en', 'de']);
    expect(Object.keys(withLanguage(both!, 'de', null)!.languages)).toEqual([
      'en',
    ]);
    expect(withLanguage(term, 'en', null)).toBeNull();
  });

  it('keeps a replacement on a deprecated term only, never itself', () => {
    const old = withStatus(term, 'deprecated', 'charging-station');
    expect(old.replacedBy).toBe('charging-station');
    expect(withStatus(old, 'approved').replacedBy).toBeUndefined();
    expect(
      withStatus(term, 'deprecated', 'charger').replacedBy,
    ).toBeUndefined();
  });

  it('tidies the domain, empty taking it away', () => {
    expect(withDomain(term, '  power   supply ').domain).toBe('power supply');
    expect('domain' in withDomain(term, '  ')).toBe(false);
  });

  it('makes a new term proposed, in one language', () => {
    expect(newTerm('pump', 'en', 'pump', '')).toEqual({
      schemaVersion: 1,
      id: 'pump',
      status: 'proposed',
      languages: { en: { preferred: 'pump', allowed: [], forbidden: [] } },
    });
  });

  it('reads a definition as plain text', () => {
    expect(
      definitionText([
        { type: 'text', text: 'The device that charges the ' },
        { type: 'text', text: 'battery', marks: [{ type: 'strong' }] },
        { type: 'hardBreak' },
        { type: 'text', text: 'Also: dock.' },
      ]),
    ).toBe('The device that charges the battery Also: dock.');
    expect(definitionText(undefined)).toBe('');
  });
});
