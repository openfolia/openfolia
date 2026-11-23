import { describe, expect, it } from 'vitest';
import {
  MAX_STYLE_PATTERN_STATES,
  prepareText,
  StylePattern,
  StylePatternError,
  stylePatternProblem,
  type WritingBudget,
} from './style-pattern.js';

/** The matches of `source` in `text`, as the text they cover. */
function find(
  source: string,
  text: string,
  options: { matchCase?: boolean; budget?: WritingBudget } = {},
): string[] {
  const t = prepareText(text);
  const out: string[] = [];
  const done = new StylePattern(source, options).matches(
    t,
    options.budget ?? { steps: 10_000_000 },
    (s, e) => {
      out.push(text.slice(t.offsets[s], t.offsets[e]));
    },
  );
  expect(done).toBe(true);
  return out;
}

describe('StylePattern', () => {
  it('finds characters, classes, groups and alternatives, without case by default', () => {
    expect(find('utili[sz]e', 'Utilise it, utilize that')).toEqual([
      'Utilise',
      'utilize',
    ]);
    expect(find('utili[sz]e', 'Utilise it', { matchCase: true })).toEqual([]);
    expect(
      find('(?:was|were) \\w+ed', 'It was opened and were closed'),
    ).toEqual(['was opened', 'were closed']);
    expect(find('\\d{2,3}', '1 22 4444')).toEqual(['22', '444']);
    expect(find('[^ ]+', 'ab cd')).toEqual(['ab', 'cd']);
    expect(find('a.c', 'abc aéc')).toEqual(['abc', 'aéc']);
  });

  it('takes the longest match from the leftmost start, never overlapping', () => {
    expect(find('ab|abcd|c', 'abcd c')).toEqual(['abcd', 'c']);
    expect(find('a+', 'aaa baa')).toEqual(['aaa', 'aa']);
    expect(find('aa', 'aaaaa')).toEqual(['aa', 'aa']);
  });

  it('holds \\b, \\B, ^ and $ to words of any script and the text’s ends', () => {
    expect(find('\\bvery\\b', 'very everyday Very')).toEqual(['very', 'Very']);
    expect(find('\\bstraße\\b', 'die Straße, Straßen')).toEqual(['Straße']);
    expect(find('^go', 'go go')).toEqual(['go']);
    expect(find('go$', 'go go')).toEqual(['go']);
    expect(find('\\Bing\\b', 'ing doing')).toEqual(['ing']);
  });

  it('counts code points, so a character outside the basic plane is one', () => {
    expect(find('a.b', 'a😀b')).toEqual(['a😀b']);
  });

  it('never matches into a blocked stretch', () => {
    const text = 'use {x} use it';
    const t = prepareText(text, [{ start: 4, end: 7 }]);
    const out: string[] = [];
    new StylePattern('use.+').matches(t, { steps: 1e6 }, (s, e) => {
      out.push(text.slice(t.offsets[s], t.offsets[e]));
    });
    expect(out).toEqual(['use ', 'use it']);
  });

  it('refuses what is outside the subset, saying why', () => {
    for (const [source, why] of [
      ['(a)\\1', 'back-references'],
      ['(?=a)b', 'lookaround'],
      ['(?<n>a)', 'lookaround'],
      ['a*?', 'lazy'],
      ['a++', 'possessive'],
      ['a**', 'repeated'],
      ['a{21}', 'above 20'],
      ['a{3,2}', 'below its minimum'],
      ['a{', 'starts no count'],
      ['\\p{L}', 'not supported'],
      ['[]', 'empty class'],
      ['[a', 'without its "]"'],
      ['(a', 'without its ")"'],
      ['a)', 'unbalanced'],
      ['*a', 'repetition of nothing'],
      ['\\b*', 'repeated assertion'],
      ['a*', 'matches empty text'],
      ['\\b', 'matches empty text'],
      ['', 'empty pattern'],
      ['x'.repeat(201), 'longer than 200'],
      ['(?:(?:a{20}){20})', 'too large'],
    ] as const) {
      expect([source, stylePatternProblem(source)]).toEqual([
        source,
        expect.stringContaining(why),
      ]);
    }
    expect(() => new StylePattern('a{20}'.repeat(20))).toThrow(
      StylePatternError,
    );
    expect(stylePatternProblem('\\butili[sz]e\\b')).toBeUndefined();
  });

  it('keeps every program within its states', () => {
    // Below the limit: 20 × 14 states, the rest one instruction.
    const pattern = new StylePattern('(?:abcdefghijklmn){20}');
    expect(pattern.size).toBeLessThanOrEqual(MAX_STYLE_PATTERN_STATES);
  });

  /**
   * The patterns that make a backtracking engine take exponential or polynomial time take
   * linear time here: each character is looked at once per state, so the steps are counted,
   * never timed, and bounded by the text's length times the program's size.
   */
  it('charges every position it reads and every start set it tries, also beyond ASCII', () => {
    // Many alternatives beyond ASCII that the text never starts: no thread runs, yet the work
    // is paid for (#55 security review), and each code point's answer is worked out once.
    const letters = Array.from({ length: 60 }, (_, i) =>
      String.fromCodePoint(0x100 + i),
    );
    const pattern = new StylePattern(letters.join('|'));
    const t = prepareText('жщ'.repeat(100_000));
    const budget = { steps: 10_000_000 };
    expect(pattern.matches(t, budget, () => undefined)).toBe(true);
    const spent = 10_000_000 - budget.steps;
    expect(spent).toBeGreaterThanOrEqual(t.n / 8);
    expect(spent).toBeLessThan(t.n / 8 + pattern.size + 2 * 60 + 10);
    const small = { steps: 1_000 };
    expect(pattern.matches(t, small, () => undefined)).toBe(false);
  });

  it('finds a match a dropped thread stood in for (#55 review)', () => {
    // `b\w*c` from 2 and from 3 meet in one state; reporting "ab" drops the one from 2, and
    // the one from 3 is found by looking again from the end of "ab".
    expect(find('q\\w*!|ab|b\\w*c', 'qabbbcz')).toEqual(['ab', 'bbc']);
    // A short match pending behind the dropped thread is not reported before the restart.
    expect(find('q[ab]*!|ab|b\\w*c|d', 'qabbdc')).toEqual(['ab', 'bdc']);
    expect(find('x\\w*!|ab|b+c', 'xabbbbc abbc')).toEqual([
      'ab',
      'bbbc',
      'ab',
      'bc',
    ]);
  });

  it('stops when told it has found enough', () => {
    const t = prepareText('a '.repeat(1_000));
    let found = 0;
    expect(
      new StylePattern('a').matches(t, { steps: 1_000_000 }, () => ++found < 3),
    ).toBe(true);
    expect(found).toBe(3);
  });

  it('matches a hostile pattern in steps linear in the text (catastrophic backtracking)', () => {
    const text = `${'a'.repeat(50_000)}!`;
    for (const source of [
      '(a+)+$',
      '(a|a)*b',
      '(?:a*)*b',
      '\\w*\\w*\\w*\\w*x',
    ]) {
      const pattern = new StylePattern(source);
      const budget = { steps: 1e9 };
      const out: number[] = [];
      expect(
        pattern.matches(prepareText(text), budget, (s) => {
          out.push(s);
        }),
      ).toBe(true);
      const steps = 1e9 - budget.steps;
      expect([source, steps <= text.length * pattern.size * 4]).toEqual([
        source,
        true,
      ]);
      expect(out).toEqual([]);
    }
  });

  it('stops when the budget runs out, and says so', () => {
    const pattern = new StylePattern('(a|a)*b');
    const budget = { steps: 1_000 };
    expect(
      pattern.matches(prepareText('a'.repeat(10_000)), budget, () => undefined),
    ).toBe(false);
  });

  it('finds every match exactly as a search of every span would, after each match’s end', () => {
    const sources = [
      'q[ab]*!|ab|b[ab]*c',
      'a+b|b+',
      '(?:a|b)c|cb*|bcc',
      'q.*!|ba|a',
    ];
    const alphabet = ['a', 'b', 'c', 'q'];
    let seed = 11;
    const random = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed >> 8;
    };
    for (let round = 0; round < 300; round++) {
      const text = Array.from(
        { length: 1 + (random() % 12) },
        () => alphabet[random() % alphabet.length],
      ).join('');
      for (const source of sources) {
        const anchored = new RegExp(`^(?:${source})$`);
        const expected: string[] = [];
        let from = 0;
        while (from < text.length) {
          let hit: [number, number] | undefined;
          outer: for (let s = from; s < text.length; s++) {
            for (let e = text.length; e > s; e--) {
              if (anchored.test(text.slice(s, e))) {
                hit = [s, e];
                break outer;
              }
            }
          }
          if (!hit) break;
          expected.push(text.slice(hit[0], hit[1]));
          from = hit[1];
        }
        expect([source, text, find(source, text)]).toEqual([
          source,
          text,
          expected,
        ]);
      }
    }
  });

  it('finds the first match exactly as a search of every span would', () => {
    // A small brute force: the leftmost start, and the longest end from there.
    const sources = ['ab*', 'a|ab|b', '(?:ab|a)(?:c|bc)', '[ab]+c?', 'b\\b'];
    const alphabet = ['a', 'b', 'c', ' '];
    let seed = 7;
    const random = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed;
    };
    for (let round = 0; round < 300; round++) {
      const text = Array.from(
        { length: 1 + (random() % 10) },
        () => alphabet[random() % alphabet.length],
      ).join('');
      for (const source of sources) {
        const anchored = new RegExp(`^(?:${source})$`);
        let expected: string | undefined;
        outer: for (let s = 0; s < text.length; s++) {
          for (let e = text.length; e > s; e--) {
            const span = text.slice(s, e);
            // `\b` reads the character after the span: test it in place (only a trailing one).
            const inPlace = source.includes('\\b')
              ? new RegExp(`^(?:${source})`).test(text.slice(s)) &&
                text.slice(s).match(new RegExp(`^(?:${source})`))?.[0] === span
              : anchored.test(span);
            if (inPlace) {
              expected = span;
              break outer;
            }
          }
        }
        expect([source, text, find(source, text)[0]]).toEqual([
          source,
          text,
          expected,
        ]);
      }
    }
  });
});
