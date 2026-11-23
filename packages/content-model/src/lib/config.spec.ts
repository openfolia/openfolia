import { z } from 'zod';
import { sampleConfig } from '../fixtures/config.js';
import {
  DEFAULT_MAX_HEADING_LEVEL,
  DEFAULT_PDF_STANDARD,
  productFacet,
  ProjectConfig,
  StrictProjectConfig,
} from './config.js';
import { ConfigParseError, parseConfig, printConfig } from './config-yaml.js';
import { MAX_SECTION_DEPTH } from './structure.js';

describe('ProjectConfig', () => {
  it('accepts the sample configuration and applies defaults', () => {
    const config = ProjectConfig.parse(sampleConfig);
    expect(
      config.moduleTypes.find((t) => t.id === 'procedure')?.restricted,
    ).toBe(false);
    expect(config.moduleTypes.find((t) => t.id === 'safety')?.restricted).toBe(
      true,
    );
  });

  it('accepts a minimal configuration', () => {
    const minimal = {
      languages: { source: 'en', targets: [] },
      moduleTypes: [{ id: 'topic', label: 'Topic' }],
      audiences: [{ id: 'internal', label: 'Internal' }],
    };
    expect(ProjectConfig.safeParse(minimal).error).toBeUndefined();
  });

  it('rejects duplicate ids', () => {
    const config = {
      ...sampleConfig,
      audiences: [...sampleConfig.audiences, { id: 'public', label: 'Again' }],
    };
    expect(ProjectConfig.safeParse(config).success).toBe(false);
  });

  it('rejects the source language as a target', () => {
    const config = {
      ...sampleConfig,
      languages: { source: 'en', targets: ['en', 'de'] },
    };
    expect(ProjectConfig.safeParse(config).success).toBe(false);
  });

  it("caps the heading levels at 3 unless configured, within the model's section depth", () => {
    expect(ProjectConfig.parse(sampleConfig).maxHeadingLevel).toBe(
      DEFAULT_MAX_HEADING_LEVEL,
    );
    expect(DEFAULT_MAX_HEADING_LEVEL).toBe(3);
    const withCap = (maxHeadingLevel: unknown) =>
      ProjectConfig.safeParse({ ...sampleConfig, maxHeadingLevel });
    expect(withCap(5).data?.maxHeadingLevel).toBe(5);
    expect(withCap(1).data?.maxHeadingLevel).toBe(1);
    expect(withCap(0).success).toBe(false);
    expect(withCap(MAX_SECTION_DEPTH + 1).success).toBe(false);
    expect(withCap(2.5).success).toBe(false);
  });

  it('makes PDFs to PDF/UA-1 unless configured otherwise, and knows only its standards', () => {
    expect(DEFAULT_PDF_STANDARD).toBe('ua-1');
    expect(ProjectConfig.parse(sampleConfig).pdf).toEqual({ standard: 'ua-1' });
    const withPdf = (pdf: unknown) =>
      StrictProjectConfig.safeParse({ ...sampleConfig, pdf });
    expect(withPdf({}).data?.pdf).toEqual({ standard: 'ua-1' });
    expect(withPdf({ standard: 'none' }).data?.pdf).toEqual({
      standard: 'none',
    });
    expect(withPdf({ standard: 'a-2b' }).success).toBe(false);
    expect(withPdf({ standard: 'ua-1', tagged: false }).success).toBe(false);
    const off = printConfig(
      ProjectConfig.parse({ ...sampleConfig, pdf: { standard: 'none' } }),
    );
    expect(off).toContain('pdf:\n  standard: none');
    expect(parseConfig(off).pdf.standard).toBe('none');
    expect(
      printConfig(
        ProjectConfig.parse({ ...sampleConfig, pdf: { standard: 'ua-1' } }),
      ),
    ).not.toContain('pdf:');
  });

  it('takes the smallest callout legend size from 4 to 12 points, 6 left out (#548)', () => {
    const withPdf = (pdf: unknown) =>
      StrictProjectConfig.safeParse({ ...sampleConfig, pdf });
    expect(withPdf({}).data?.pdf.calloutLabelMinSize).toBeUndefined();
    expect(withPdf({ calloutLabelMinSize: 7.5 }).data?.pdf).toEqual({
      standard: 'ua-1',
      calloutLabelMinSize: 7.5,
    });
    expect(withPdf({ calloutLabelMinSize: 3 }).success).toBe(false);
    expect(withPdf({ calloutLabelMinSize: 13 }).success).toBe(false);
    const seven = printConfig(
      ProjectConfig.parse({ ...sampleConfig, pdf: { calloutLabelMinSize: 7 } }),
    );
    expect(seven).toContain('pdf:\n  calloutLabelMinSize: 7');
    expect(parseConfig(seven).pdf.calloutLabelMinSize).toBe(7);
    expect(
      printConfig(
        ProjectConfig.parse({
          ...sampleConfig,
          pdf: { calloutLabelMinSize: 6 },
        }),
      ),
    ).not.toContain('pdf:');
  });

  it('takes extra code languages, each one word the code block stores', () => {
    const withLanguages = (codeLanguages: unknown) =>
      ProjectConfig.safeParse({ ...sampleConfig, codeLanguages });
    expect(ProjectConfig.parse(sampleConfig).codeLanguages).toEqual([]);
    expect(
      withLanguages([{ id: 'fortran', label: 'Fortran' }]).data?.codeLanguages,
    ).toEqual([{ id: 'fortran', label: 'Fortran' }]);
    expect(withLanguages([{ id: 'two words', label: 'X' }]).success).toBe(
      false,
    );
    expect(withLanguages([{ id: 'x', label: '' }]).success).toBe(false);
    expect(
      withLanguages([
        { id: 'x', label: 'X' },
        { id: 'x', label: 'Y' },
      ]).success,
    ).toBe(false);
  });

  it('names the product facet of releases: the configured one, else the first', () => {
    const parse = (release: unknown, facets = sampleConfig.facets) =>
      ProjectConfig.safeParse({ ...sampleConfig, facets, release });
    const twoFacets = [
      ...(sampleConfig.facets ?? []),
      { id: 'site', label: 'Site', values: [{ id: 'a', label: 'A' }] },
    ];
    expect(productFacet(ProjectConfig.parse(sampleConfig))?.id).toBe(
      'product-line',
    );
    const configured = parse({ productFacet: 'site' }, twoFacets);
    expect(configured.data && productFacet(configured.data)?.id).toBe('site');
    expect(parse({ productFacet: 'nope' }, twoFacets).success).toBe(false);
    expect(parse({ productFacet: 'Not A Key' }).success).toBe(false);
    const none = ProjectConfig.parse({ ...sampleConfig, facets: [] });
    expect(productFacet(none)).toBeUndefined();
  });
});

describe('the manufacturer details (#395)', () => {
  const manufacturer = {
    name: 'Example Works Ltd',
    address: ['1 Sample Street', '12345 Sample Town'],
    contact: 'info@example.com',
    website: 'https://example.com',
  };
  const parse = (extra: Record<string, unknown>) =>
    ProjectConfig.safeParse({ ...sampleConfig, ...extra });

  it('takes a name, address lines, a contact and a website, and prints them back', () => {
    const config = parse({
      manufacturer,
      release: { checkManufacturer: true },
    });
    expect(config.error).toBeUndefined();
    expect(config.data?.manufacturer).toEqual(manufacturer);
    const text = printConfig(config.data as ProjectConfig);
    expect(text).toContain('manufacturer:\n  name: Example Works Ltd');
    expect(text).toContain('release:\n  checkManufacturer: true');
    expect(parseConfig(text).manufacturer).toEqual(manufacturer);
    expect(parseConfig(text).release?.checkManufacturer).toBe(true);
    // Only the name is needed; the check is off unless turned on.
    const named = parse({ manufacturer: { name: 'Example Works Ltd' } });
    expect(named.data?.manufacturer).toEqual({
      name: 'Example Works Ltd',
      address: [],
    });
    expect(printConfig(named.data as ProjectConfig)).not.toContain('release:');
  });

  it('refuses a name of several lines, too many address lines and a website that is no link', () => {
    expect(parse({ manufacturer: { name: 'A\nB' } }).success).toBe(false);
    expect(parse({ manufacturer: { name: '' } }).success).toBe(false);
    expect(
      parse({
        manufacturer: {
          name: 'A',
          address: Array.from({ length: 11 }, (_, i) => `Line ${i}`),
        },
      }).success,
    ).toBe(false);
    expect(
      parse({ manufacturer: { name: 'A', website: 'javascript:alert(1)' } })
        .success,
    ).toBe(false);
    expect(
      parse({ manufacturer: { name: 'A', website: 'example.com' } }).success,
    ).toBe(false);
    expect(
      parse({
        manufacturer: {
          name: 'A',
          website: `https://example.com/${'a'.repeat(2000)}`,
        },
      }).success,
    ).toBe(false);
  });
});

describe('the writing checks’ rules (#55)', () => {
  const parse = (extra: Record<string, unknown>) =>
    ProjectConfig.safeParse({ ...sampleConfig, ...extra });
  const rule = {
    id: 'in-order-to',
    words: 'in order to',
    message: 'Write “to”.',
    replacement: 'to',
  };

  it('defaults to warnings and no rules, and prints back only what differs', () => {
    const config = ProjectConfig.parse(sampleConfig);
    expect(config.terminology).toBeUndefined();
    expect(config.styleRules).toBeUndefined();
    const printed = printConfig(
      ProjectConfig.parse({
        ...sampleConfig,
        terminology: { forbiddenIsBlocking: true },
        styleRules: {
          en: {
            maxSentenceWords: 25,
            rules: [
              rule,
              {
                id: 'use',
                pattern: '\\butili[sz]e\\b',
                matchCase: false,
                message: 'Write “use”.',
                severity: 'blocking',
              },
              {
                id: 'warned',
                words: 'very',
                message: 'Cut it.',
                severity: 'warning',
              },
            ],
          },
          de: { rules: [] },
        },
      }),
    );
    expect(printed).toContain('terminology:\n  forbiddenIsBlocking: true\n');
    expect(printed).toContain('styleRules:\n  en:\n    maxSentenceWords: 25\n');
    expect(printed).not.toContain('matchCase');
    expect(printed).not.toContain('severity: warning');
    expect(printed).not.toMatch(/^ {2}de:/m);
    expect(printConfig(parseConfig(printed))).toBe(printed);
    expect(parseConfig(printed).styleRules?.['en']?.rules[1]?.pattern).toBe(
      '\\butili[sz]e\\b',
    );
  });

  it('refuses a pattern outside the subset, a rule with both or neither of words and pattern, and a language not configured', () => {
    const issues = (extra: Record<string, unknown>) =>
      (parse(extra).error?.issues ?? []).map(
        (i) => `${i.path.join('.')}: ${i.message}`,
      );
    expect(
      issues({
        styleRules: {
          en: { rules: [{ ...rule, words: undefined, pattern: '(a)\\1' }] },
        },
      }),
    ).toEqual([
      expect.stringMatching(
        /^styleRules\.en\.rules\.0\.pattern: not a supported pattern: .*back-references/,
      ),
    ]);
    expect(
      issues({ styleRules: { en: { rules: [{ ...rule, pattern: 'x' }] } } }),
    ).toEqual(['styleRules.en.rules.0: give exactly one of words and pattern']);
    expect(
      issues({ styleRules: { en: { rules: [{ id: 'x', message: 'm' }] } } }),
    ).toEqual(['styleRules.en.rules.0: give exactly one of words and pattern']);
    expect(issues({ styleRules: { xx: { rules: [rule] } } })).toEqual([
      'styleRules: styleRules: each language must be a configured one',
    ]);
    expect(issues({ styleRules: { en: { rules: [rule, rule] } } })).toEqual([
      'styleRules.en.rules: duplicate style rule id',
    ]);
    expect(
      issues({
        styleRules: {
          en: { rules: [{ ...rule, id: 'max-sentence-words' }] },
        },
      }),
    ).toEqual([
      'styleRules.en.rules: "max-sentence-words" is the ID of the sentence length’s findings',
    ]);
    expect(issues({ styleRules: { en: { maxSentenceWords: 2 } } })).toEqual([
      expect.stringMatching(/^styleRules\.en\.maxSentenceWords: /),
    ]);
  });
});

describe('archived variant values', () => {
  it('keeps an archived value valid and marks it', () => {
    const config = ProjectConfig.parse({
      ...sampleConfig,
      variantAttributes: [
        {
          id: 'model',
          label: 'Model',
          kind: 'enum',
          values: [
            { id: 'l-200', label: 'L-200', archived: true },
            { id: 'l-400', label: 'L-400' },
          ],
        },
      ],
    });
    const model = config.variantAttributes[0];
    expect(model?.kind === 'enum' && model.values[0]?.archived).toBe(true);
    expect(model?.kind === 'enum' && model.values[1]?.archived).toBeUndefined();
  });
});

describe('StrictProjectConfig', () => {
  it('accepts what ProjectConfig accepts, with the same output', () => {
    expect(StrictProjectConfig.parse(sampleConfig)).toEqual(
      ProjectConfig.parse(sampleConfig),
    );
  });

  it('refuses unknown keys at every level, where ProjectConfig drops them', () => {
    const nested = {
      ...sampleConfig,
      audiences: [{ id: 'public', label: 'Public', colour: 'red' }],
    };
    expect(ProjectConfig.safeParse(nested).success).toBe(true);
    expect(StrictProjectConfig.safeParse(nested).success).toBe(false);
    expect(
      StrictProjectConfig.safeParse({ ...sampleConfig, extra: 1 }).success,
    ).toBe(false);
    const value = {
      ...sampleConfig,
      variantAttributes: [
        {
          id: 'model',
          label: 'Model',
          kind: 'enum',
          values: [{ id: 'a', label: 'A', note: 'x' }],
        },
      ],
    };
    expect(StrictProjectConfig.safeParse(value).success).toBe(false);
    const languages = {
      ...sampleConfig,
      languages: { source: 'en', targets: [], fallback: 'en' },
    };
    expect(StrictProjectConfig.safeParse(languages).success).toBe(false);
  });
});

describe('parseConfig and printConfig', () => {
  it('round-trips canonically', () => {
    const text = printConfig(ProjectConfig.parse(sampleConfig));
    expect(printConfig(parseConfig(text))).toBe(text);
    expect(parseConfig(text)).toEqual(ProjectConfig.parse(sampleConfig));
  });

  it('marks snippet types, false by default, and prints only a true one', () => {
    const config = ProjectConfig.parse({
      languages: { source: 'en', targets: [] },
      moduleTypes: [
        { id: 'topic', label: 'Topic' },
        { id: 'phrase', label: 'Phrase', snippet: true },
      ],
      audiences: [{ id: 'internal', label: 'Internal' }],
    });
    expect(config.moduleTypes.map((t) => t.snippet)).toEqual([false, true]);
    const text = printConfig(config);
    expect(text).toContain('    label: Phrase\n    snippet: true\n');
    expect(text).not.toContain('snippet: false');
    expect(printConfig(parseConfig(text))).toBe(text);
  });

  it('leaves defaults out and keeps what differs from them', () => {
    const text = printConfig(
      ProjectConfig.parse({
        languages: { source: 'en', targets: [] },
        moduleTypes: [{ id: 'topic', label: 'Topic' }],
        audiences: [{ id: 'internal', label: 'Internal' }],
      }),
    );
    expect(text).toBe(
      [
        'languages:',
        '  source: en',
        '  targets: []',
        'moduleTypes:',
        '  - id: topic',
        '    label: Topic',
        'audiences:',
        '  - id: internal',
        '    label: Internal',
        '',
      ].join('\n'),
    );
    const full = printConfig(
      ProjectConfig.parse({
        ...sampleConfig,
        maxHeadingLevel: 4,
        outputLabels: { de: { tip: 'Tipp', danger: 'GEFAHR' } },
        codeLanguages: [{ id: 'fortran', label: 'Fortran' }],
        release: { productFacet: 'product-line' },
        styleGuide: 'Write short sentences.\nAddress the reader as "you".',
        variantAttributes: [
          {
            id: 'model',
            label: 'Model',
            kind: 'enum',
            values: [{ id: 'a', label: 'A', archived: true }],
          },
        ],
      }),
    );
    expect(full).toContain('restricted: true');
    expect(full).not.toContain('restricted: false');
    expect(full).toContain('archived: true');
    expect(full).toContain('maxHeadingLevel: 4');
    expect(full).toContain('release:\n  productFacet: product-line');
    expect(parseConfig(full).styleGuide).toBe(
      'Write short sentences.\nAddress the reader as "you".',
    );
    expect(full).toMatch(/de:\n {4}danger: GEFAHR\n {4}tip: Tipp/);
    expect(printConfig(parseConfig(full))).toBe(full);
  });

  it('refuses what is not a configuration', () => {
    expect(() => parseConfig('a: [')).toThrow(ConfigParseError);
    expect(() => parseConfig('- 1')).toThrow(/invalid configuration/);
    expect(() => parseConfig('languages: 1')).toThrow(/languages/);
  });
});

describe('the openfolia.yaml reference', () => {
  /** Each key below `schema` without a description (`a.b`, `a[]`, `a.<key>`). */
  function undescribed(schema: unknown, path = ''): string[] {
    if (typeof schema !== 'object' || schema === null) return [];
    const s = schema as Record<string, unknown>;
    const out: string[] = [];
    const check = (child: unknown, at: string) => {
      if (!(child as { description?: string }).description) out.push(at);
      out.push(...undescribed(child, at));
    };
    for (const [name, child] of Object.entries(
      (s['properties'] as Record<string, unknown>) ?? {},
    )) {
      check(child, path ? `${path}.${name}` : name);
    }
    const values = s['additionalProperties'];
    if (typeof values === 'object' && values !== null) {
      const v = values as Record<string, unknown>;
      // A map of plain values is described by the map itself.
      if (
        v['properties'] ||
        v['type'] === 'array' ||
        v['anyOf'] ||
        v['oneOf']
      ) {
        check(values, `${path}.<key>`);
      }
    }
    if (s['items']) out.push(...undescribed(s['items'], `${path}[]`));
    for (const variant of [
      ...((s['anyOf'] as unknown[]) ?? []),
      ...((s['oneOf'] as unknown[]) ?? []),
    ]) {
      out.push(...undescribed(variant, path));
    }
    return out;
  }

  it('describes every key, so the generated reference explains each one', () => {
    for (const schema of [ProjectConfig, StrictProjectConfig]) {
      expect(
        undescribed(
          z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }),
        ),
      ).toEqual([]);
    }
  });
});
