import { describe, expect, it } from 'vitest';
import {
  defaultDirection,
  directionOf,
  languageDirection,
  languageDirectionIssues,
} from './direction.js';
import { parseConfig, printConfig } from './config-yaml.js';
import { ProjectConfig } from './config.js';

describe('defaultDirection', () => {
  it.each([
    ['ar', 'rtl'],
    ['ar-EG', 'rtl'],
    ['he', 'rtl'],
    ['fa', 'rtl'],
    ['ur', 'rtl'],
    ['ps', 'rtl'],
    ['ckb', 'rtl'],
    ['yi', 'rtl'],
    ['dv', 'rtl'],
    ['syr', 'rtl'],
    ['az-Arab', 'rtl'],
    ['pa-Arab', 'rtl'],
    ['en', 'ltr'],
    ['de', 'ltr'],
    ['pt-BR', 'ltr'],
    ['ku', 'ltr'],
    ['az', 'ltr'],
    ['zh-Hant', 'ltr'],
    ['ja', 'ltr'],
    ['ar-Latn', 'ltr'],
  ])('%s is %s, from its script', (tag, dir) => {
    expect(defaultDirection(tag)).toBe(dir);
  });

  it('is left to right for a tag Intl cannot read', () => {
    expect(defaultDirection('not a tag')).toBe('ltr');
    expect(defaultDirection('')).toBe('ltr');
  });
});

describe('languageDirection', () => {
  const config = {
    languages: { direction: { ar: 'ltr', 'de-CH': 'rtl' } as const },
  };

  it('takes the configured direction over the script', () => {
    expect(languageDirection('ar', config)).toBe('ltr');
    expect(languageDirection('de-CH', config)).toBe('rtl');
  });

  it("falls back to the script's without one", () => {
    expect(languageDirection('he', config)).toBe('rtl');
    expect(languageDirection('de', config)).toBe('ltr');
    expect(languageDirection('he')).toBe('rtl');
    expect(languageDirection('he', null)).toBe('rtl');
    expect(languageDirection('he', { languages: {} })).toBe('rtl');
  });
});

describe('directionOf', () => {
  it("reads the manual's directions, else the script's", () => {
    const manual = { directions: { ar: 'ltr' as const } };
    expect(directionOf(manual, 'ar')).toBe('ltr');
    expect(directionOf(manual, 'he')).toBe('rtl');
    expect(directionOf({}, 'ar')).toBe('rtl');
  });
});

describe('languages.direction in the configuration', () => {
  const base = [
    'languages:',
    '  source: en',
    '  targets:',
    '    - ar',
    '    - he',
    'moduleTypes:',
    '  - id: concept',
    '    label: Concept',
    'audiences:',
    '  - id: public',
    '    label: Public',
    '',
  ].join('\n');

  it('is optional: adding a right-to-left target needs nothing else', () => {
    const config = parseConfig(base);
    expect(config.languages.direction).toBeUndefined();
    expect(languageDirection('ar', config)).toBe('rtl');
    expect(printConfig(config)).toBe(base);
  });

  it('round-trips, sorted by tag, the tags canonical', () => {
    const text = base.replace(
      '    - he\n',
      '    - he\n  direction:\n    HE: ltr\n    ar: rtl\n',
    );
    const config = parseConfig(text);
    expect(config.languages.direction).toEqual({ he: 'ltr', ar: 'rtl' });
    const printed = printConfig(config);
    expect(printed).toContain('  direction:\n    ar: rtl\n    he: ltr\n');
    expect(printConfig(parseConfig(printed))).toBe(printed);
  });

  it('leaves out a direction for a language not configured, and reports it', () => {
    const config = parseConfig(
      base.replace(
        '    - he\n',
        '    - he\n  direction:\n    ur: rtl\n    ar: ltr\n    fa: rtl\n',
      ),
    );
    expect(printConfig(config)).toBe(
      base.replace('    - he\n', '    - he\n  direction:\n    ar: ltr\n'),
    );
    expect(languageDirectionIssues(config)).toEqual([
      {
        code: 'unknown-direction-language',
        path: 'languages.direction.fa',
        message: expect.stringContaining('"fa"'),
      },
      {
        code: 'unknown-direction-language',
        path: 'languages.direction.ur',
        message: expect.stringContaining('"ur"'),
      },
    ]);
  });

  it('reports nothing when every direction is for a configured language', () => {
    expect(languageDirectionIssues(parseConfig(base))).toEqual([]);
    const config = parseConfig(
      base.replace(
        '    - he\n',
        '    - he\n  direction:\n    EN: rtl\n    he: ltr\n',
      ),
    );
    expect(languageDirectionIssues(config)).toEqual([]);
  });

  it('refuses a direction that is neither ltr nor rtl, and a bad tag', () => {
    const languages = (direction: unknown) => ({
      languages: { source: 'en', targets: ['ar'], direction },
      moduleTypes: [{ id: 'concept', label: 'Concept' }],
      audiences: [{ id: 'public', label: 'Public' }],
    });
    expect(ProjectConfig.safeParse(languages({ ar: 'rtl' })).success).toBe(
      true,
    );
    expect(ProjectConfig.safeParse(languages({ ar: 'auto' })).success).toBe(
      false,
    );
    expect(ProjectConfig.safeParse(languages({ '1x': 'rtl' })).success).toBe(
      false,
    );
  });
});

describe('a direction from elsewhere', () => {
  it('is only ever ltr or rtl, never an inherited member', () => {
    const odd = { directions: { ar: 'sideways', en: '"><x' } } as never;
    expect(directionOf(odd, 'ar')).toBe('rtl');
    expect(directionOf(odd, 'en')).toBe('ltr');
    expect(directionOf({ directions: {} }, 'constructor')).toBe('ltr');
    expect(
      languageDirection('toString', { languages: { direction: {} } }),
    ).toBe('ltr');
  });
});
