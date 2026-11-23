import { describe, expect, it } from 'vitest';
import type { Block } from './blocks.js';
import { parseConfig } from './config-yaml.js';
import type { Inline } from './inline.js';
import type { Module } from './module.js';
import { plainTextOf } from './plain-text.js';
import { parseTerm, type Term } from './term.js';
import {
  adaptCase,
  checkWriting,
  checkWritingText,
  compileWritingRules,
  MAX_WRITING_FINDINGS,
  type StyleRule,
  type WritingRulesInput,
} from './writing-check.js';

const term = (id: string, yaml: string): Term =>
  parseTerm(`schemaVersion: 1\n${yaml}`, { id });

const CHARGER = term(
  'charger',
  `status: approved
languages:
  en:
    preferred: charger
    allowed:
      - term: charging unit
    forbidden:
      - term: loader
        note: Reads as a machine that loads goods.
      - term: power  brick
  de:
    preferred: Ladegerät
    forbidden:
      - term: Lader
`,
);
const BATTERY = term(
  'battery',
  `status: approved
languages:
  en:
    preferred: battery
`,
);
const POWER_PACK = term(
  'power-pack',
  `status: deprecated
replacedBy: battery
languages:
  en:
    preferred: power pack
    allowed:
      - term: charging unit
`,
);
const HOUSING = term(
  'housing',
  `status: proposed
languages:
  en:
    preferred: housing
    forbidden:
      - term: casing
`,
);
const TERMS = [CHARGER, BATTERY, POWER_PACK, HOUSING];

const text = (value: string): Inline => ({ type: 'text', text: value });
const para = (id: string, ...content: Inline[]): Block => ({
  type: 'paragraph',
  id,
  content,
});
const moduleOf = (blocks: Block[], lang = 'en'): Module => ({
  schemaVersion: 1,
  id: 'sample',
  meta: {
    title: 'Sample',
    type: 'concept',
    lang,
    audience: 'public',
    facets: {},
  },
  blocks,
});

const check = (
  blocks: Block[],
  input: Partial<WritingRulesInput> = {},
  lang = 'en',
) => checkWriting(moduleOf(blocks, lang), { terms: TERMS, lang, ...input });

describe('checkWriting: terms', () => {
  it('finds a forbidden variant of an approved term as a whole word, without case, with the preferred variant to write', () => {
    const result = check([
      para('p1', text('Plug the Loader in. Loaders and downloader are fine.')),
    ]);
    expect(result).toEqual({
      complete: true,
      findings: [
        {
          code: 'forbidden-term',
          severity: 'warning',
          blockId: 'p1',
          field: 'content',
          start: 9,
          end: 15,
          text: 'Loader',
          rule: {
            kind: 'term',
            termId: 'charger',
            status: 'forbidden',
            note: 'Reads as a machine that loads goods.',
          },
          message:
            '"Loader" is a forbidden variant of the term "charger": write "charger".',
          replacement: 'Charger',
        },
      ],
    });
  });

  it('matches a phrase across any white space, never across an inline node or code', () => {
    const result = check([
      para('p1', text('A power  brick, a power brick.')),
      para(
        'p2',
        text('A power '),
        { type: 'attribute', name: 'x' },
        text(' brick and '),
        { type: 'text', text: 'loader', marks: [{ type: 'code' }] },
        text('.'),
      ),
    ]);
    expect(result.findings.map((f) => [f.blockId, f.text])).toEqual([
      ['p1', 'power  brick'],
      ['p1', 'power brick'],
    ]);
  });

  it('is a blocking check when the configuration says so', () => {
    const result = check([para('p1', text('the loader'))], {
      terminology: { forbiddenIsBlocking: true },
    });
    expect(result.findings[0]?.severity).toBe('blocking');
  });

  it('reads only the module’s language', () => {
    expect(
      check([para('p1', text('the loader, der Lader'))], {}, 'de').findings.map(
        (f) => f.text,
      ),
    ).toEqual(['Lader']);
    expect(check([para('p1', text('the loader'))], {}, 'fr').findings).toEqual(
      [],
    );
  });

  it('warns of a deprecated term’s variants with its replacement’s preferred variant, but not of a variant another term uses', () => {
    const result = check([
      para('p1', text('POWER PACK and the charging unit.')),
    ]);
    expect(result.findings).toEqual([
      expect.objectContaining({
        code: 'forbidden-term',
        severity: 'warning',
        text: 'POWER PACK',
        rule: { kind: 'term', termId: 'power-pack', status: 'deprecated' },
        replacement: 'BATTERY',
      }),
    ]);
  });

  it('leaves a proposed term out: it is not in force yet', () => {
    expect(check([para('p1', text('the casing'))]).findings).toEqual([]);
  });

  it('checks every translatable text, and never literal or passthrough blocks', () => {
    const result = check([
      { type: 'section', id: 's', title: [text('Loader')], blocks: [] },
      {
        type: 'list',
        id: 'l',
        ordered: false,
        items: [{ id: 'i1', content: [text('a loader')], blocks: [] }],
      },
      {
        type: 'image',
        id: 'img',
        asset: `sha256:${'a'.repeat(64)}`,
        alt: 'The loader',
      },
      { type: 'literal', id: 'lit', text: 'loader' },
      { type: 'passthrough', id: 'pass', text: 'loader' },
    ] as Block[]);
    expect(result.findings.map((f) => [f.blockId, f.field, f.text])).toEqual([
      ['s', 'title', 'Loader'],
      ['i1', 'content', 'loader'],
      ['img', 'alt', 'loader'],
    ]);
  });
});

describe('checkWriting: style rules', () => {
  const rules = (list: StyleRule[], maxSentenceWords?: number) => ({
    styleRules: {
      en: { rules: list, ...(maxSentenceWords && { maxSentenceWords }) },
    },
  });

  it('finds a phrase, with its message and fix, in the case found', () => {
    const result = check(
      [para('p1', text('In order to start, press it in order to stop.'))],
      rules([
        {
          id: 'in-order-to',
          words: 'in order to',
          message: 'Write “to”.',
          replacement: 'to',
        },
      ]),
    );
    expect(result.findings).toEqual([
      expect.objectContaining({
        code: 'style-rule',
        severity: 'warning',
        start: 0,
        end: 11,
        text: 'In order to',
        rule: { kind: 'style', ruleId: 'in-order-to' },
        message: 'Write “to”.',
        replacement: 'To',
      }),
      expect.objectContaining({ text: 'in order to', replacement: 'to' }),
    ]);
  });

  it('finds a pattern, with its severity, in the case written only when it says so', () => {
    const result = check(
      [para('p1', text('Utilise it. utilize that.'))],
      rules([
        {
          id: 'use',
          pattern: '\\butili[sz]e\\b',
          message: 'Write “use”.',
          replacement: 'use',
          severity: 'blocking',
        },
        { id: 'cased', words: 'Utilise', matchCase: true, message: 'Cased.' },
      ]),
    );
    expect(result.findings.map((f) => [f.rule, f.text, f.severity])).toEqual([
      [{ kind: 'style', ruleId: 'cased' }, 'Utilise', 'warning'],
      [{ kind: 'style', ruleId: 'use' }, 'Utilise', 'blocking'],
      [{ kind: 'style', ruleId: 'use' }, 'utilize', 'blocking'],
    ]);
  });

  it('finds a sentence longer than the house style allows', () => {
    const long = Array.from({ length: 7 }, (_, i) => `w${i}`).join(' ');
    const result = check(
      [para('p1', text(`Short one. ${long}. Short again!`))],
      rules([], 6),
    );
    expect(result.findings).toEqual([
      expect.objectContaining({
        code: 'style-rule',
        text: `${long}.`,
        rule: { kind: 'sentence-length', words: 7, max: 6 },
        message: 'The sentence has 7 words; the house style allows 6.',
      }),
    ]);
  });

  it('ends a sentence at a line break', () => {
    const result = check(
      [
        para(
          'p1',
          text('one two three four five'),
          { type: 'hardBreak' },
          text('six seven eight nine ten'),
        ),
      ],
      rules([], 5),
    );
    expect(result.findings).toEqual([]);
  });

  it('reads the rules from the configuration, so a rule taken out finds nothing', () => {
    const config = (rule: string) =>
      parseConfig(`languages: { source: en, targets: [] }
moduleTypes: [{ id: concept, label: Concept }]
audiences: [{ id: public, label: Public }]
styleRules:
  en:
    rules:
${rule}`);
    const blocks = [para('p1', text('Do it in order to win.'))];
    const withRule = config(
      '      - { id: in-order-to, words: in order to, message: Write to. }\n',
    );
    expect(
      check(blocks, { styleRules: withRule.styleRules }).findings,
    ).toHaveLength(1);
    expect(
      check(blocks, { styleRules: config('      []\n').styleRules }).findings,
    ).toEqual([]);
  });
});

describe('checkWriting: bounds', () => {
  it('reports at most MAX_WRITING_FINDINGS findings, and says it stopped', () => {
    const result = check([
      para('p1', text('loader '.repeat(MAX_WRITING_FINDINGS + 5))),
    ]);
    expect(result.findings).toHaveLength(MAX_WRITING_FINDINGS);
    expect(result).toMatchObject({ complete: false, stopped: 'findings' });
  });

  it('holds no more than the findings it reports, however broad a rule (#55 security review)', () => {
    // A pattern matching every character and a phrase matching every word, on one long part:
    // a part never holds more than the allowance left, plus one to tell there were more.
    const rules = compileWritingRules({
      terms: TERMS,
      lang: 'en',
      styleRules: {
        en: {
          rules: [
            { id: 'any', pattern: '\\w', message: 'Any.' },
            ...Array.from({ length: 20 }, (_, i) => ({
              id: `a${i}`,
              words: 'a',
              message: 'A.',
            })),
          ],
        },
      },
    });
    let found = 0;
    const done = rules.check(
      [text('a '.repeat(200_000))],
      { steps: 60_000_000 },
      () => found++,
      10,
    );
    expect(done).toBe(true);
    expect(found).toBe(11);
    const result = checkWriting(
      moduleOf([para('p1', text('a '.repeat(200_000)))]),
      rules,
    );
    expect(result.findings).toHaveLength(MAX_WRITING_FINDINGS);
    expect(result).toMatchObject({ complete: false, stopped: 'findings' });
    // The first ones, in order.
    expect(result.findings[0]).toMatchObject({ start: 0, end: 1 });
  });

  it('stops a hostile pattern at its step budget instead of hanging', () => {
    const result = check(
      Array.from({ length: 40 }, (_, i) =>
        para(`p${i}`, text('a'.repeat(25_000))),
      ),
      {
        styleRules: {
          en: {
            rules: Array.from({ length: 10 }, (_, i) => ({
              id: `r${i}`,
              pattern: '(?:a{0,10}){0,10}b',
              message: 'Never.',
            })),
          },
        },
      },
    );
    expect(result).toMatchObject({ complete: false, stopped: 'steps' });
  });
});

describe('checkWritingText', () => {
  it('gives offsets in the plain text of the content, as the editor maps them', () => {
    const content: Inline[] = [
      { type: 'attribute', name: 'product-name' },
      text(' has a loader.'),
    ];
    const rules = compileWritingRules({ terms: TERMS, lang: 'en' });
    const { findings } = checkWritingText(content, rules);
    const plain = plainTextOf(content).text;
    expect(findings.map((f) => plain.slice(f.start, f.end))).toEqual([
      'loader',
    ]);
  });
});

describe('adaptCase', () => {
  it('writes a fix in the case found', () => {
    expect(adaptCase('Loader', 'charger')).toBe('Charger');
    expect(adaptCase('LOADER', 'charger')).toBe('CHARGER');
    expect(adaptCase('loader', 'Ladegerät')).toBe('Ladegerät');
    expect(adaptCase('L', 'charger')).toBe('Charger');
  });
});
