import { sampleConfig } from '../fixtures/config.js';
import { ProjectConfig } from './config.js';
import {
  definitionText,
  isTermId,
  parseTerm,
  printDefinition,
  printTerm,
  Term,
  TermParseError,
  termLanguages,
  termMatches,
  validateTerm,
} from './term.js';

const text = [
  'schemaVersion: 1',
  'status: approved',
  'domain: charging',
  'languages:',
  '  de:',
  '    preferred: Ladegerät',
  '  en:',
  '    preferred: charger',
  '    allowed:',
  '      - term: charging unit',
  '    forbidden:',
  '      - term: loader',
  '        note: means something else',
  '    definition: The device that charges the battery.',
  '',
].join('\n');

describe('terms', () => {
  it('refuses a file naming another term than its file name', () => {
    expect(() => parseTerm(`id: other\n${text}`, { id: 'charger' })).toThrow(
      TermParseError,
    );
    expect(parseTerm(`id: charger\n${text}`, { id: 'charger' }).id).toBe(
      'charger',
    );
  });

  it('round-trips canonically, the ID from the file name', () => {
    const term = parseTerm(text, { id: 'charger' });
    expect(term.id).toBe('charger');
    expect(termLanguages(term)).toEqual(['de', 'en']);
    expect(term.languages['de']?.allowed).toEqual([]);
    expect(term.languages['en']?.definition).toEqual([
      { type: 'text', text: 'The device that charges the battery.' },
    ]);
    expect(printTerm(term)).toBe(text);
  });

  it('reads a definition as inline content with marks and line breaks', () => {
    const source = [
      'schemaVersion: 1',
      'status: deprecated',
      'replacedBy: charger',
      'languages:',
      '  en:',
      '    preferred: loader',
      '    definition: |-',
      '      A **device**, see link:https://example.com[the site] +',
      '      or ``code``.',
      '    usage: Do not use.',
      '',
    ].join('\n');
    const term = parseTerm(source, { id: 'loader' });
    expect(term.replacedBy).toBe('charger');
    expect(term.languages['en']?.definition).toEqual([
      { type: 'text', text: 'A ' },
      { type: 'text', text: 'device', marks: [{ type: 'strong' }] },
      { type: 'text', text: ', see ' },
      {
        type: 'text',
        text: 'the site',
        marks: [{ type: 'link', href: 'https://example.com' }],
      },
      { type: 'hardBreak' },
      { type: 'text', text: 'or ' },
      { type: 'text', text: 'code', marks: [{ type: 'code' }] },
      { type: 'text', text: '.' },
    ]);
    expect(definitionText(term.languages['en']?.definition)).toBe(
      'A device, see the site or code.',
    );
    expect(printTerm(term)).toBe(source);
  });

  it('round-trips definitions whose text looks like markup', () => {
    for (const text of [
      'a **b** c',
      '* starts like a list',
      '{product-name} is no attribute here',
      'ends with +',
      'x ~y~ ^z^ ``w`` [.ui]##v## #u#',
      '. a dot',
      'link:https://example.com[not a link]',
    ]) {
      const term = Term.parse({
        schemaVersion: 1,
        id: 'x',
        languages: {
          en: { preferred: 'x', definition: [{ type: 'text', text }] },
        },
      });
      const printed = printTerm(term);
      expect(parseTerm(printed, { id: 'x' })).toEqual(term);
      expect(printTerm(parseTerm(printed, { id: 'x' }))).toBe(printed);
    }
    expect(printDefinition([{ type: 'text', text: 'a' }])).toBe('a');
  });

  it('refuses a definition holding what depends on a manual', () => {
    for (const definition of [
      'see {product-name}',
      'see xref:charging.adoc[charging]',
      'press kbd:[Ctrl+S]',
      '**open',
    ]) {
      expect(() =>
        parseTerm(
          `schemaVersion: 1\nlanguages:\n  en:\n    preferred: a\n    definition: "${definition}"\n`,
          { id: 'x' },
        ),
      ).toThrow(/languages\.en\.definition/);
    }
    expect(() =>
      parseTerm(
        `schemaVersion: 1\nlanguages:\n  en:\n    preferred: a\n    definition: ${'x'.repeat(20_001)}\n`,
        { id: 'x' },
      ),
    ).toThrow(/at most 10000 characters/);
    expect(
      Term.safeParse({
        schemaVersion: 1,
        id: 'x',
        languages: {
          en: {
            preferred: 'a',
            definition: [{ type: 'text', text: 'a'.repeat(10_001) }],
          },
        },
      }).success,
    ).toBe(false);
  });

  it('replaces only a deprecated term, never by itself', () => {
    const base = {
      schemaVersion: 1,
      id: 'old',
      languages: { en: { preferred: 'a' } },
    };
    expect(Term.safeParse({ ...base, replacedBy: 'new' }).success).toBe(false);
    expect(
      Term.safeParse({ ...base, status: 'deprecated', replacedBy: 'old' })
        .success,
    ).toBe(false);
    expect(
      Term.safeParse({ ...base, status: 'deprecated', replacedBy: 'new' })
        .success,
    ).toBe(true);
  });

  it('reserves the IDs of routes', () => {
    expect(isTermId('export')).toBe(false);
    expect(isTermId('exports')).toBe(true);
    expect(() =>
      parseTerm('schemaVersion: 1\nlanguages:\n  en:\n    preferred: a\n', {
        id: 'export',
      }),
    ).toThrow(/reserved/);
  });

  it('matches a query in any variant and the definition, folded', () => {
    const term = parseTerm(text, { id: 'charger' });
    expect(termMatches(term, 'LOADER')).toBe(true);
    expect(termMatches(term, 'ladegerat')).toBe(true);
    expect(termMatches(term, '  charges   the ')).toBe(true);
    expect(termMatches(term, 'charging unit')).toBe(true);
    expect(termMatches(term, 'loader', ['de'])).toBe(false);
    expect(termMatches(term, 'nothing')).toBe(false);
    expect(termMatches(term, '   ')).toBe(false);
  });

  it('prints languages sorted and leaves empty lists out', () => {
    const term = Term.parse({
      schemaVersion: 1,
      id: 'x',
      languages: { fr: { preferred: 'b' }, en: { preferred: 'a' } },
    });
    expect(printTerm(term)).toBe(
      'schemaVersion: 1\nstatus: proposed\nlanguages:\n  en:\n    preferred: a\n  fr:\n    preferred: b\n',
    );
  });

  it('refuses what is no term', () => {
    expect(() => parseTerm('a: [', { id: 'x' })).toThrow(TermParseError);
    expect(() => parseTerm('- a', { id: 'x' })).toThrow(/mapping/);
    expect(() =>
      parseTerm('schemaVersion: 1\nlanguages: {}\n', { id: 'x' }),
    ).toThrow(/at least one language/);
    expect(() =>
      parseTerm(
        'schemaVersion: 1\nlanguages:\n  en:\n    preferred: a\n    colour: red\n',
        {
          id: 'x',
        },
      ),
    ).toThrow(/invalid term/);
    expect(() =>
      parseTerm('schemaVersion: 1\nlanguages:\n  EN:\n    preferred: a\n', {
        id: 'x',
      }),
    ).toThrow(/languages\.EN/);
    expect(() =>
      parseTerm('schemaVersion: 1\nlanguages:\n  en:\n    preferred: a\n', {
        id: 'Not An Id',
      }),
    ).toThrow(/id/);
  });

  it('checks its languages against the configuration', () => {
    const config = ProjectConfig.parse(sampleConfig);
    const term = Term.parse({
      schemaVersion: 1,
      id: 'x',
      languages: { en: { preferred: 'a' }, it: { preferred: 'b' } },
    });
    expect(validateTerm(term, config)).toEqual([
      expect.objectContaining({ code: 'unknown-language', at: 'it' }),
    ]);
  });
});
