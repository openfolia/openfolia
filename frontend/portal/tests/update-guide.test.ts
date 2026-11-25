import {
  choiceForStep,
  choiceQuery,
  guideDefaults,
  type GuideShape,
  parseChoice,
} from '../src/lib/update-guide.ts';

/** An update guide's choice in the address (#907): defaults, parsing, and back. */
const GUIDE: GuideShape = {
  versions: ['1.0', '1.1', '2.0', '2.10'],
  levels: ['public', 'internal'],
  options: [
    { id: 'cluster', values: ['yes', 'no'] },
    { id: 'db', values: ['pg', 'my', 'lite'] },
  ],
};
const parse = (query: string) => parseChoice(GUIDE, new URLSearchParams(query));

describe('an update guide’s choice', () => {
  it('opens from the second-newest version to the newest, at the first level, options at their defaults', () => {
    expect(guideDefaults(GUIDE)).toEqual({
      from: '2.0',
      to: '2.10',
      level: 'public',
      options: {},
    });
    expect(parse('')).toEqual({ choice: guideDefaults(GUIDE), invalid: false });
  });

  it('reads a choice back from the query it writes', () => {
    const choice = {
      from: '1.0',
      to: '2.0',
      level: 'internal',
      options: { cluster: 'yes', db: 'lite' },
    };
    const query = choiceQuery(GUIDE, choice);
    expect(query).toBe(
      '?from=1.0&to=2.0&level=internal&opt=cluster%3Ayes&opt=db%3Alite',
    );
    expect(parse(query.slice(1))).toEqual({ choice, invalid: false });
    expect(choiceQuery(GUIDE, guideDefaults(GUIDE))).toBe('');
  });

  it('matches versions numerically', () => {
    expect(parse('from=1.0.0&to=2.10').choice).toMatchObject({
      from: '1.0',
      to: '2.10',
    });
  });

  it('falls back to the default for each part the guide does not offer, and says so', () => {
    for (const query of [
      'from=2.10',
      'from=2.0&to=1.1',
      'from=9.9&to=2.0',
      'to=x',
      'level=nobody',
      'opt=nothing',
      'opt=db',
      'opt=cluster',
      'opt=cluster:maybe',
    ]) {
      const { choice, invalid } = parse(query);
      expect(invalid, query).toBe(true);
      expect(choice, query).toEqual(guideDefaults(GUIDE));
    }
    // A "to" alone before the default "from" starts at the version before it.
    expect(parse('to=1.1')).toEqual({
      choice: { ...guideDefaults(GUIDE), from: '1.0', to: '1.1' },
      invalid: false,
    });
    // The valid parts stay.
    expect(parse('from=1.0&to=2.0&level=nobody')).toEqual({
      choice: { ...guideDefaults(GUIDE), from: '1.0', to: '2.0' },
      invalid: true,
    });
  });

  it('shows a step: the jump to its version, its level, the options its condition names', () => {
    const base = guideDefaults(GUIDE);
    expect(
      choiceForStep(GUIDE, base, {
        version: '1.1',
        level: 'internal',
        when: { op: 'in', attr: 'cluster', values: ['yes'] },
      }),
    ).toEqual({
      from: '1.0',
      to: '1.1',
      level: 'internal',
      options: { cluster: 'yes' },
    });
    // A step at the first version is never part of a jump: the choice stays.
    expect(
      choiceForStep(GUIDE, base, {
        version: '1.0',
        level: undefined,
        when: undefined,
      }),
    ).toEqual(base);
  });
});
